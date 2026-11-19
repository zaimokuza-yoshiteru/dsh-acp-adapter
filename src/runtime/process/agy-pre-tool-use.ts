/** The hook protocol and permission behavior were verified on Google's 1.5.12 Darwin arm64 distribution. */
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { openAgyHookWorkspace } from './agy-hook-workspace.ts'
import type { AgyHookLaunch } from './agy-hook-workspace.ts'
import type { AgyPreToolUseInput, AgyPreToolUseReply } from './agy-hook-wire.ts'

export type { AgyPreToolUseInput, AgyPreToolUseReply } from './agy-hook-wire.ts'

const VERIFIED_BINARY_SHA256 = 'ef265356c3e5d3c6c241509cf71187bae086ac935ef5c5c037dadf62d5876835'
const VERIFIED_BINARY_BYTES = 226_575_952

export function isAgyPreToolUseCandidate(argv: readonly string[]): boolean {
  return (
    process.platform === 'darwin' &&
    process.arch === 'arm64' &&
    basename(argv[0] ?? '') === 'agy' &&
    argv[1] === 'acp' &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--stdio'))
  )
}

export async function prepareAgyPreToolUseLaunch(options: {
  argv: readonly string[]
  env: Record<string, string>
  cwd: string
  resolveExecutable: (command: string, env: Record<string, string>) => Promise<string>
  onPreToolUse: (input: AgyPreToolUseInput, signal: AbortSignal) => Promise<AgyPreToolUseReply>
}): Promise<AgyHookLaunch | undefined> {
  const { argv, env, cwd } = options
  const command = argv[0]
  if (!command || !isAgyPreToolUseCandidate(argv)) return undefined
  let path: string
  try {
    // Resolve through the same Host subprocess provider that would launch a bare PATH command.
    const candidate = command.includes('/') ? resolve(cwd, command) : await options.resolveExecutable(command, env)
    if (!isAbsolute(candidate)) return undefined
    path = await realpath(candidate)
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== VERIFIED_BINARY_BYTES) return undefined
      const hash = createHash('sha256')
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
      if (hash.digest('hex') !== VERIFIED_BINARY_SHA256) return undefined
    } finally {
      await file.close()
    }
  } catch {
    // Discovery, wrappers and unverified builds keep their ordinary native ACP launch.
    return undefined
  }
  return openAgyHookWorkspace([path, ...argv.slice(1)], env, options.onPreToolUse)
}
