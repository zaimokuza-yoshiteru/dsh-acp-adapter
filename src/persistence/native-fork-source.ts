import { z } from 'zod'

/** Explicit source accepted after proving a native ordinary fork's exact seed. */
export const nativeForkSourceSchema = z
  .object({
    dshSessionId: z.string().min(1).max(256),
    sourceSessionId: z.string().min(1).max(256),
    atSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export type AcpNativeForkSource = z.infer<typeof nativeForkSourceSchema>
