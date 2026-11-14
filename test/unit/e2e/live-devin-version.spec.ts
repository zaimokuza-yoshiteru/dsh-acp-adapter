import { beforeEach, expect, it, vi } from 'vitest'
import { readLiveDevinCliVersion } from '../../e2e/live-devin-version.ts'
import { isKnownDevinManualTitleRequest } from '../../e2e/live-devin-team-scope.ts'
import { devinManualPermission } from '../../fixtures/devin-manual-permission.ts'

const runner = vi.hoisted(() => ({ output: '', error: null as Error | null, calls: [] as unknown[][] }))
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    runner.calls.push(args.slice(0, 3))
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(runner.error, runner.output, 'private stderr is never evidence')
  },
}))
beforeEach(() => {
  runner.calls.length = 0
  runner.error = null
  runner.output = '3000.12.43 (517d03d73926)\n'
})

// First sample is the captured output of this selected CLI, not ACP agentInfo.version.
it.each(['3000.12.43 (517d03d73926)\n', '3000.12.43\n', 'Devin CLI 3000.12.43\n'])(
  'parses one complete CLI version line %j without treating ACP agentInfo as the CLI',
  async (output) => {
    runner.output = output
    const cliVersion = await readLiveDevinCliVersion('/selected/devin', '/isolated/workspace', {})
    expect(cliVersion).toBe('3000.12.43')
    expect(isKnownDevinManualTitleRequest(cliVersion, devinManualPermission.asked, devinManualPermission.bridge)).toBe(
      true,
    )
    expect(isKnownDevinManualTitleRequest('0.0.0-dev', devinManualPermission.asked, devinManualPermission.bridge)).toBe(
      false,
    )
  },
)

it('uses the selected executable, finite output/deadline, private HOME and no credential environment', async () => {
  await readLiveDevinCliVersion('/selected/devin', '/isolated/workspace', {
    HOME: '/isolated/home',
    XDG_CONFIG_HOME: '/isolated/config',
    WINDSURF_API_KEY: 'private',
    DSH_ACP_TEAM_MCP_URL: 'private',
  })
  expect(runner.calls).toEqual([
    [
      '/selected/devin',
      ['--version'],
      expect.objectContaining({
        cwd: '/isolated/workspace',
        encoding: 'utf8',
        shell: false,
        timeout: 5_000,
        maxBuffer: 4_096,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env: expect.objectContaining({ HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/config' }),
      }),
    ],
  ])
  const options = runner.calls[0]![2] as { env: Record<string, string> }
  expect(options.env.WINDSURF_API_KEY).toBeUndefined()
  expect(options.env.DSH_ACP_TEAM_MCP_URL).toBeUndefined()
})

it.each(['', '3000.12.43 (private)', 'Devin CLI 3000.12.43\n3000.12.44', 'private 3000.12.43 payload'])(
  'rejects ambiguous/non-version output %j without disclosing it',
  async (output) => {
    runner.output = output
    await expect(readLiveDevinCliVersion('/selected/devin', '/isolated/workspace', {})).rejects.toThrow(
      'LIVE_DEVIN_CLI_VERSION_OUTPUT_INVALID',
    )
  },
)

it.each(['timeout', 'output-limit', 'nonzero-exit', 'spawn-failure'])(
  'keeps %s subprocess errors and their raw output out of evidence',
  async (reason) => {
    runner.error = new Error(`private ${reason}`)
    await expect(readLiveDevinCliVersion('/selected/devin', '/isolated/workspace', {})).rejects.toThrow(
      /^LIVE_DEVIN_CLI_VERSION_QUERY_FAILED$/,
    )
  },
)
