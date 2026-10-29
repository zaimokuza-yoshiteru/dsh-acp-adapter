import type { Context } from '@deepseek-ai/cordis'
import { createLiveDiagnosticTrace, type LiveDiagnosticTrace } from '../../contract/live-diagnostic-trace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpLiveDiagnostics: LiveDiagnosticTrace
  }
}

/** A disabled observer owned by this Host, shared across adapter remounts. */
export function ensureHostLiveDiagnostics(ctx: Context): LiveDiagnosticTrace {
  const root = ctx.root
  root.fiber.assertActive()
  const existing = root.get('acpLiveDiagnostics', false)
  if (existing !== undefined) return existing
  const trace = createLiveDiagnosticTrace()
  root.effect(function* () {
    yield root.provide('acpLiveDiagnostics', trace)
    // Stop new delivery and await accepted sink writes before withdrawing the owner.
    yield root.effect(() => () => trace.dispose())
  }, 'dsh-acp: Host live diagnostics')
  return trace
}
