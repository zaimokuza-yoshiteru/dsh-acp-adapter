import { z } from 'zod'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../contract/config-options.ts'

/** The exact choices made by the user before this conversation's first Agent prompt. */
export const firstTurnOptionsRecord = 'plugin:dsh-acp-adapter/first-turn-options'
const id = z.string().min(1).max(ACP_CONFIG_IDENTIFIER_MAX)
export const firstTurnOptionsSchema = z.object({
  provider: z.string().min(1),
  generation: z.string().min(1),
  /** Only terminal settlement consumes the first-turn draft. An explicit clear remains observable until then. */
  consumed: z.literal(true).optional(),
  choices: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('config'), id, value: z.union([id, z.boolean()]) }),
      z.object({ kind: z.literal('mode'), id }),
    ]),
  ),
})
export type FirstTurnOptions = z.infer<typeof firstTurnOptionsSchema>
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    [firstTurnOptionsRecord]: FirstTurnOptions
  }
}
