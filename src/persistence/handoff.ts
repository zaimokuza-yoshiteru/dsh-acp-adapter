import { z } from 'zod'

export const handoffRecordSchema = z.object({
  id: z.string().uuid(),
  sourceSessionId: z.string().min(1),
  destinationSessionId: z.string().nullable(),
  destinationUnavailable: z.literal(true).optional(),
  requestedDestinationId: z.string().min(1),
  automatic: z.literal(true).optional(),
  creationAttempted: z.literal(true).optional(),
  target: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }),
  sourceProvider: z.string(),
  sourceModel: z.string(),
  sourceIdentity: z.string().min(1).nullable(),
  targetIdentity: z.string().min(1).nullable(),
  workspaceId: z.string().nullable(),
  sourceCwd: z.string().min(1),
  throughSeq: z.number().int().nonnegative(),
  phase: z.enum(['summarizing', 'draft', 'queued', 'completed', 'cancelled', 'interrupted']),
  document: z.string().max(65536),
  instruction: z.string().max(32768),
  allowHistory: z.boolean(),
  locale: z.enum(['en', 'zh']),
  revision: z.number().int().nonnegative(),
})
export type HandoffRecord = z.infer<typeof handoffRecordSchema>
