import type { Context } from '@deepseek-ai/cordis'
import type {} from './service.ts'

/** The history tool derives its caller from the DSH execution context. */
export async function readGrantedHandoff(ctx: Context, destinationId: string) {
  return ctx.get('acpHandoffs', false)?.historyFor(destinationId)
}
