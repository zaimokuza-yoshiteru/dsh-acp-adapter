import type { AcpNativeForkRejection } from '../../contract/remote.ts'

/** Expected refusal; the native child is preserved and no provenance is replaced. */
export class AcpNativeForkError extends Error {
  override readonly name = 'AcpNativeForkError'

  constructor(
    readonly reason: AcpNativeForkRejection,
    message: string,
  ) {
    super(message)
  }
}
