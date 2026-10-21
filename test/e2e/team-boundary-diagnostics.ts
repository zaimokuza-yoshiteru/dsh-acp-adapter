import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { ObservedEvent } from './types.ts'

function observe<T>(read: () => T) {
  try {
    return read()
  } catch (error) {
    return { unavailable: true, errorName: error instanceof Error ? error.name : 'UnknownError' }
  }
}

/** Fixture-only observations: never answers an approval or settles a product turn. */
export function teamBoundaryDiagnostics(directory: string, signal: AbortSignal) {
  mkdirSync(directory, { recursive: true })
  const logPath = join(directory, 'mock-agent.log')
  const eventsPath = join(directory, 'events.jsonl')
  const stagesPath = join(directory, 'stages.jsonl')
  for (const path of [logPath, eventsPath, stagesPath]) writeFileSync(path, '')
  let stage = 'setup',
    sequence = 0
  let inspect: (() => unknown) | undefined
  let disposed = false
  const diagnosticError = (trigger: string, error: unknown) => {
    // A broken evidence destination is reported without replacing the primary failure.
    try {
      appendFileSync(stagesPath, JSON.stringify({ stage, trigger, diagnosticError: String(error) }) + '\n')
    } catch {
      process.stderr.write('Teams boundary diagnostic write failed\n')
    }
  }
  const capture = (trigger: string) => {
    if (disposed) return
    try {
      const facts = { stage, trigger, at: new Date().toISOString(), eventCount: sequence, facts: inspect?.() }
      appendFileSync(stagesPath, JSON.stringify(facts) + '\n')
      writeFileSync(join(directory, 'latest.json'), JSON.stringify(facts, null, 2))
    } catch (error) {
      diagnosticError(trigger, error)
    }
  }
  const aborted = () => capture('test-aborted')
  signal.addEventListener('abort', aborted, { once: true })
  capture('begin')
  return {
    logPath,
    attach(host: AdapterWorld, setupRequestIds: () => ReadonlySet<string>) {
      inspect = () => ({
        owners: host.ctx.agents.list().map((agent) => {
          const member = host.ctx.agentTeams.tryMembership(agent)
          return {
            id: agent.id,
            status: agent.status,
            provider: agent.options.provider,
            model: agent.options.model,
            role: member?.role,
            rootId: member?.root.id,
            name: member?.name,
            approval: host.ctx.approval.overrideOf(agent.session),
          }
        }),
        permissions: {
          asked: observe(() =>
            acpPermissionAudit(host, 'asked').map(({ sessionId, data }) => ({
              sessionId,
              requestId: data.requestId,
              toolCallId: data.toolCall.toolCallId,
              title: data.toolCall.title,
              inputHash: data.toolCall.rawInputHash,
              setup: setupRequestIds().has(data.requestId),
            })),
          ),
          decided: observe(() =>
            acpPermissionAudit(host, 'decided').map(({ sessionId, data }) => ({
              sessionId,
              requestId: data.requestId,
              toolCallId: data.toolCallId,
              outcome: data.outcome,
              optionId: data.optionId,
              kind: data.selectedOptionKind,
              via: data.decisionVia,
              setup: setupRequestIds().has(data.requestId),
            })),
          ),
        },
      })
    },
    event(event: ObservedEvent) {
      if (disposed) return
      try {
        const data = JSON.stringify(event.data)
        appendFileSync(
          eventsPath,
          JSON.stringify({
            sequence: ++sequence,
            at: new Date().toISOString(),
            stage,
            sessionId: event.sessionId,
            type: event.type,
            sha256: createHash('sha256').update(data).digest('hex'),
            bytes: Buffer.byteLength(data),
            markers: [...new Set(data.match(/\bE2E_TEAM_[A-Z_]+\b/g) ?? [])],
            childSettled: data.includes('finished and will do no further work unless you send it more'),
            ...(event.type === 'request/header'
              ? { provider: event.data.header.config.provider, model: event.data.header.config.model }
              : {}),
            ...(event.type === 'turn/end' ? { reason: event.data.reason.kind } : {}),
          }) + '\n',
        )
      } catch (error) {
        diagnosticError('event', error)
      }
    },
    stage(value: string) {
      stage = value
      capture('stage')
    },
    capture,
    dispose() {
      disposed = true
      signal.removeEventListener('abort', aborted)
    },
  }
}
