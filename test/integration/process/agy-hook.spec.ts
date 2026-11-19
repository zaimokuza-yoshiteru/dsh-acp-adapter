import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { openAgyHookWorkspace } from '../../../src/runtime/process/agy-hook-workspace.ts'
import { HOOK_KEY_ENV, HOOK_SOCKET_ENV, HOOK_UNAVAILABLE } from '../../../src/runtime/process/agy-hook-wire.ts'
import type { AgyPreToolUseInput, AgyPreToolUseReply } from '../../../src/runtime/process/agy-hook-wire.ts'
import { prepareAgyPreToolUseLaunch } from '../../../src/runtime/process/agy-pre-tool-use.ts'

const payload = {
  hookEventName: 'PreToolUse',
  conversationId: 'real-session',
  cwd: '/user/workspace',
  lastUserInput: 'private prompt',
  transcriptPath: '/private/transcript',
  toolCall: { name: 'run_command', args: { CommandLine: 'printf receipt' } },
}
const facts = {
  sessionId: payload.conversationId,
  cwd: payload.cwd,
  toolName: 'run_command',
  args: payload.toolCall.args,
}

function runHook(env: Record<string, string>, input: unknown = payload): Promise<unknown> {
  const clientPath = fileURLToPath(new URL('../../../src/runtime/process/agy-hook-client.ts', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [clientPath],
      { env: { ...process.env, ...env }, timeout: 5000 },
      (err, stdout) => {
        if (err) reject(err)
        else {
          try {
            resolve(JSON.parse(stdout))
          } catch (error) {
            reject(error)
          }
        }
      },
    )
    child.stdin!.end(JSON.stringify(input))
  })
}

describe('official agy PreToolUse bridge', () => {
  it.each([
    ['wrapper', ['antigravity-acp', 'acp']],
    ['shell', ['sh', '-c', 'agy acp']],
    ['unsafe override', ['agy', 'acp', '--dangerously-skip-permissions']],
    ['custom workspace or worker', ['agy', 'acp', '--add-dir', '/extra']],
  ])('leaves %s launches alone before resolving any executable', async (_name, argv) => {
    const resolveExecutable = vi.fn()
    await expect(
      prepareAgyPreToolUseLaunch({ argv, cwd: process.cwd(), env: {}, resolveExecutable, onPreToolUse: vi.fn() }),
    ).resolves.toBeUndefined()
    expect(resolveExecutable).not.toHaveBeenCalled()
  })

  it('keeps a differently built executable on the native path', async () => {
    const resolveExecutable = vi.fn(async () => process.execPath)
    await expect(
      prepareAgyPreToolUseLaunch({
        argv: ['agy', 'acp'],
        cwd: process.cwd(),
        env: {},
        resolveExecutable,
        onPreToolUse: vi.fn(),
      }),
    ).resolves.toBeUndefined()
    if (process.platform === 'darwin' && process.arch === 'arm64') expect(resolveExecutable).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')(
    'isolates the hook and returns only machine denials; manual and fallback paths remain native',
    async () => {
      const evaluate = vi.fn<(value: AgyPreToolUseInput, signal: AbortSignal) => Promise<AgyPreToolUseReply>>()
      evaluate.mockResolvedValueOnce({ decision: 'deny', reason: 'Rule 127' })
      evaluate.mockResolvedValueOnce({ decision: 'delegate' })
      evaluate.mockRejectedValueOnce(new Error('Policy unavailable'))
      const env = { EXISTING: 'yes' }
      const lease = await openAgyHookWorkspace(['agy', 'acp'], env, evaluate)
      try {
        const dir = lease.argv.at(-1)!
        expect(lease.argv).toEqual(['agy', 'acp', '--add-dir', dir])
        expect(lease.env.EXISTING).toBe('yes')
        expect(env).toEqual({ EXISTING: 'yes' })
        const config = await readFile(join(dir, '.agents', 'hooks.json'), 'utf8')
        expect(config).toContain('^run_command$')
        expect(config).not.toContain(lease.env[HOOK_KEY_ENV]!)
        expect(config).not.toContain(lease.env[HOOK_SOCKET_ENV]!)
        expect((await stat(dirname(dir))).mode & 0o777).toBe(0o700)
        expect((await stat(lease.env[HOOK_SOCKET_ENV]!)).mode & 0o777).toBe(0o600)
        await expect(runHook(lease.env)).resolves.toEqual({ decision: 'deny', reason: 'Rule 127' })
        await expect(runHook(lease.env)).resolves.toEqual({ decision: 'allow' })
        await expect(runHook(lease.env)).resolves.toEqual(HOOK_UNAVAILABLE)
        await expect(runHook({ ...lease.env, [HOOK_KEY_ENV]: 'different connection' })).resolves.toEqual(
          HOOK_UNAVAILABLE,
        )
        await expect(runHook(lease.env, { ...payload, hookEventName: 'PostToolUse' })).resolves.toEqual(
          HOOK_UNAVAILABLE,
        )
        await expect(runHook(lease.env, { ...payload, toolCall: { name: 'other', args: {} } })).resolves.toEqual(
          HOOK_UNAVAILABLE,
        )
        expect(evaluate).toHaveBeenCalledTimes(3)
        expect(evaluate).toHaveBeenCalledWith(facts, expect.any(AbortSignal))
        await Promise.all([lease.close(), lease.close()])
        await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(runHook(lease.env)).resolves.toEqual(HOOK_UNAVAILABLE)
      } finally {
        await lease.close()
      }
    },
  )

  it.skipIf(process.platform === 'win32')('aborts an in-flight decision when its ACP connection closes', async () => {
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const lease = await openAgyHookWorkspace(['agy', 'acp'], {}, async (_input, signal) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve()
            resolve()
          },
          { once: true },
        ),
      )
      await settled.promise
      return { decision: 'deny', reason: 'late' }
    })
    try {
      const reply = runHook(lease.env)
      await entered.promise
      const closing = lease.close()
      await aborted.promise
      await expect(access(lease.argv.at(-1)!)).resolves.toBeUndefined()
      settled.resolve()
      await closing
      await expect(reply).resolves.toEqual(HOOK_UNAVAILABLE)
    } finally {
      settled.resolve()
      await lease.close()
    }
  })
})
