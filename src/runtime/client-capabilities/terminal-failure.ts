/// <reference types="node" />

import type { AcpTerminalFailureFacts } from '../../domain/policy/events.ts'

const failureCodes = new Set([
  'ENOENT',
  'EACCES',
  'ENOEXEC',
  'ENAMETOOLONG',
  'E2BIG',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'EINVAL',
])

/** Never retain argv, environment values, paths from errors, or OS display text. */
export function terminalFailureFacts(
  error: unknown,
  command: string,
  args: readonly string[],
  attempt: AcpTerminalFailureFacts['attempt'],
  phase: AcpTerminalFailureFacts['phase'],
): AcpTerminalFailureFacts {
  let code: AcpTerminalFailureFacts['code'] = 'other'
  let syscall: AcpTerminalFailureFacts['syscall'] = 'other'
  try {
    const value =
      typeof error === 'object' && error !== null ? (error as { code?: unknown; syscall?: unknown }) : undefined
    const rawCode = value?.code
    if (typeof rawCode === 'string' && failureCodes.has(rawCode)) code = rawCode as AcpTerminalFailureFacts['code']
    const rawSyscall = value?.syscall
    if (typeof rawSyscall === 'string') {
      if (rawSyscall === 'spawn' || rawSyscall.startsWith('spawn ')) syscall = 'spawn'
      else if (rawSyscall === 'execve') syscall = 'execve'
    }
  } catch {
    // Diagnostic property access must not replace the actual process failure.
  }
  const argLengths = args.map((arg) => Buffer.byteLength(arg, 'utf8'))
  const components = command.split(process.platform === 'win32' ? /[\\/]/ : /\//)
  return {
    phase,
    attempt,
    code,
    syscall,
    platform:
      process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
        ? process.platform
        : 'other',
    commandBytes: Buffer.byteLength(command, 'utf8'),
    commandMaxPathComponentBytes: components.reduce((max, part) => Math.max(max, Buffer.byteLength(part, 'utf8')), 0),
    argCount: args.length,
    argBytes: argLengths.reduce((total, length) => total + length, 0),
    maxArgBytes: argLengths.reduce((max, length) => Math.max(max, length), 0),
  }
}
