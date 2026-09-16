import { z } from 'zod'
import { activityDiffsOf } from '../../contract/activity-diffs.ts'

/** Complete presentation data, kept separately from bounded diagnostic JSON. */
export const activityPresentationSchema = z.object({
  diffs: z.array(z.object({ path: z.string(), oldText: z.string().nullable(), newText: z.string() })).optional(),
  plan: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })).optional(),
  unavailable: z.enum(['too-large', 'invalid']).optional(),
})
export type AcpActivityPresentation = z.infer<typeof activityPresentationSchema>

/** Bound one presentation atomically; truncated file sides must never become a diff. */
export const ACTIVITY_PRESENTATION_BYTES = 2 * 1024 * 1024

export function boundedActivityPresentation(value: AcpActivityPresentation): AcpActivityPresentation {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength > ACTIVITY_PRESENTATION_BYTES
    ? { unavailable: 'too-large' } : value
}

/** Normalize only known ACP display fields. Transport details remain in the audit record. */
export function activityPresentation(value: unknown, kind: 'plan' | 'tool' | 'diff'): AcpActivityPresentation | undefined {
  if (kind === 'plan') {
    const parsed = activityPresentationSchema.shape.plan.safeParse(value)
    return parsed.success && parsed.data !== undefined ? boundedActivityPresentation({ plan: parsed.data }) : undefined
  }
  const diffs = activityDiffsOf(value)
  return diffs.length === 0 ? undefined : boundedActivityPresentation({ diffs })
}
