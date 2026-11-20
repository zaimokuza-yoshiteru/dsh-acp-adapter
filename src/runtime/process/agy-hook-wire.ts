/** Private exchange between the Google hook client and its owning ACP connection. */
import type { Readable } from 'node:stream'

export interface AgyPreToolUseInput {
  readonly sessionId: string
  readonly cwd: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
}

export type AgyPreToolUseReply = { decision: 'delegate' } | { decision: 'deny'; reason: string }

export function isAgyHookInput(value: unknown): value is AgyPreToolUseInput {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Partial<AgyPreToolUseInput>
  return (
    typeof input.sessionId === 'string' &&
    input.sessionId.length > 0 &&
    typeof input.cwd === 'string' &&
    input.cwd.length > 0 &&
    input.toolName === 'run_command' &&
    typeof input.args === 'object' &&
    input.args !== null &&
    !Array.isArray(input.args)
  )
}

// A lost response might already be a denial. An approval prompt could honor an earlier grant.
export const HOOK_UNAVAILABLE = { decision: 'deny', reason: 'The tool policy could not be verified.' } as const
export const HOOK_DEADLINE_MS = 8_000
export const HOOK_SOCKET_ENV = 'DSH_ACP_AGY_HOOK_SOCKET'
export const HOOK_KEY_ENV = 'DSH_ACP_AGY_HOOK_KEY'

export async function readHookJson(stream: Readable): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 256 * 1024) throw new Error('ACP_AGY_HOOK_INPUT_TOO_LARGE')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
