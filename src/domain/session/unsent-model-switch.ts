import { z } from 'zod'

/** Identifies one claimed input whose dedicated-preset model check stopped before request admission. */
export const unsentModelSwitchRecord = 'plugin:dsh-acp-adapter/unsent-model-switch'
export const unsentModelSwitchSchema = z.object({
  turn: z.number().int().positive(),
  step: z.number().int().positive(),
  messageId: z.string().min(1),
  requestId: z.string().min(1),
  bindingKey: z.string().min(1),
  /** Present only once the native user entry exists and its dispatch never entered the WAL. */
  committed: z.object({ inputSeq: z.number().int().nonnegative(), dispatchKey: z.string().min(1) }).optional(),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    [unsentModelSwitchRecord]: z.infer<typeof unsentModelSwitchSchema>
  }
}
