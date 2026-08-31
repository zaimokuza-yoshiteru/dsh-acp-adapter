/** Provider-specific ACP delegation evidence normalized without creating UI or DSH sessions. */

import { nonTextContentFallback } from '../session/assistant-content.ts'
import type { AcpNonTextContent } from '../session/assistant-content.ts'

export type ExternalDelegationProfileKind = 'devin' | 'claude' | 'kimi' | 'codex' | string

export interface ExternalDelegationObservation {
  readonly profileKind: ExternalDelegationProfileKind
  readonly vendorDelegationKey: string
  readonly sourceToolCallId?: string
  readonly vendorChildId?: string
  readonly label: string
  readonly task: { readonly text: string; readonly source: 'structured-tool-input' | 'vendor-meta' }
  readonly result: {
    readonly text: string
    readonly source: 'verbatim-child-final' | 'agent-summary' | 'tool-result'
    readonly completeness: 'final-output' | 'summary'
  }
  readonly status: 'completed' | 'failed'
  readonly model?: { readonly id: string; readonly source: 'agent-structured-live' }
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly totalTokens?: number
    readonly source: 'agent-structured-live'
  }
  readonly timing: {
    readonly observedStartedAt: number
    readonly observedCompletedAt: number
    readonly agentReportedDurationMs?: number
    readonly source: 'client-observed' | 'agent-structured-live' | 'mixed'
  }
  /** Only observations whose identity contract has passed its product gate may be projected. */
  readonly projectionEligible: boolean
}

interface PendingDelegation {
  readonly startedAt: number
  readonly toolCallId?: string
  readonly label: string
  readonly task: string
  readonly vendorChildId?: string
  readonly resultChunks?: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(item => record(item) && text(item.text) !== undefined ? [item.text as string] : []).join('\n')
}

/** Keep native child output in protocol order while matching the root turn's
 * bounded, secret-safe fallback for content DSH cannot render directly. */
function nativeChildResultChunk(value: unknown): string | undefined {
  if (!record(value)) return undefined
  if (value.type === 'text') return text(value.text)
  if (value.type !== 'image' && value.type !== 'audio' && value.type !== 'resource_link' && value.type !== 'resource') return undefined
  try {
    return `\n\n${nonTextContentFallback(value as unknown as AcpNonTextContent)}\n\n`
  } catch {
    // Production notifications have already passed ACP validation. Preserve
    // this normalizer's defensive unknown-input contract for isolated callers.
    return undefined
  }
}

/** Stateful live-frame normalizer. Load/replay frames must never be fed here. */
export class ExternalDelegationNormalizer {
  private readonly pending = new Map<string, PendingDelegation>()

  constructor(readonly profileKind: ExternalDelegationProfileKind) {}

  /** Normalize one complete notification. Claude's negotiated native child
   * lifecycle uses the notification session id to route child transcript
   * updates, so update-only normalization cannot represent it truthfully. */
  acceptNotification(notificationValue: unknown, observedAt: number): ExternalDelegationObservation | undefined {
    if (!record(notificationValue)) return undefined
    const sessionId = text(notificationValue.sessionId)
    const update = record(notificationValue.update) ? notificationValue.update : undefined
    if (update === undefined) return undefined
    if (this.profileKind !== 'claude') return this.accept(update, observedAt)
    if (update.sessionUpdate === 'subagent_spawned') {
      const childId = text(update.subagentSessionId)
      const task = text(update.task)
      if (childId === undefined || task === undefined) return undefined
      this.pending.set(childId, {
        startedAt: observedAt,
        label: text(update.name) ?? 'Agent delegation',
        task,
        vendorChildId: childId,
        resultChunks: [],
      })
      return undefined
    }
    if ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')
      && sessionId !== undefined) {
      const pending = this.pending.get(sessionId)
      const chunk = nativeChildResultChunk(update.content)
      if (pending !== undefined && chunk !== undefined && update.sessionUpdate === 'agent_message_chunk') {
        pending.resultChunks?.push(chunk)
      }
      return undefined
    }
    if (update.sessionUpdate === 'subagent_state_update') {
      const childId = text(update.subagentSessionId)
      const pending = childId === undefined ? undefined : this.pending.get(childId)
      if (childId === undefined || pending === undefined) return undefined
      this.pending.delete(childId)
      const state = text(update.state)
      const completed = state === 'completed'
      return {
        profileKind: 'claude', vendorDelegationKey: childId,
        vendorChildId: childId, label: pending.label,
        task: { text: pending.task, source: 'vendor-meta' },
        result: {
          text: pending.resultChunks?.join('') ?? '',
          source: 'verbatim-child-final', completeness: 'final-output',
        },
        status: completed ? 'completed' : 'failed',
        timing: { observedStartedAt: pending.startedAt, observedCompletedAt: observedAt, source: 'client-observed' },
        projectionEligible: completed,
      }
    }
    return this.accept(update, observedAt)
  }

  accept(updateValue: unknown, observedAt: number): ExternalDelegationObservation | undefined {
    if (!record(updateValue)) return undefined
    if (this.profileKind === 'devin') return this.acceptDevin(updateValue, observedAt)
    if (this.profileKind === 'claude') return this.acceptClaude(updateValue, observedAt)
    if (this.profileKind === 'kimi') return this.acceptKimi(updateValue, observedAt)
    return undefined
  }

  private acceptDevin(update: Record<string, unknown>, observedAt: number): ExternalDelegationObservation | undefined {
    const meta = record(update._meta) ? update._meta : undefined
    const started = record(meta?.['cognition.ai/subagent_started']) ? meta?.['cognition.ai/subagent_started'] as Record<string, unknown> : undefined
    if (started !== undefined) {
      const agentId = text(started.agentId)
      const task = text(started.task)
      if (agentId !== undefined && task !== undefined) {
        const toolCallId = text(update.toolCallId)
        this.pending.set(agentId, {
          startedAt: observedAt,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          label: text(started.title) ?? 'Agent delegation',
          task,
          vendorChildId: agentId,
        })
      }
      return undefined
    }
    const completed = record(meta?.['cognition.ai/subagent_completed']) ? meta?.['cognition.ai/subagent_completed'] as Record<string, unknown> : undefined
    if (completed === undefined) return undefined
    const agentId = text(completed.agentId)
    const pending = agentId === undefined ? undefined : this.pending.get(agentId)
    const summary = text(completed.summary)
    if (agentId === undefined || pending === undefined || summary === undefined) return undefined
    this.pending.delete(agentId)
    return {
      profileKind: 'devin', vendorDelegationKey: agentId,
      ...(pending.toolCallId === undefined ? {} : { sourceToolCallId: pending.toolCallId }),
      vendorChildId: agentId, label: pending.label,
      task: { text: pending.task, source: 'vendor-meta' },
      result: { text: summary, source: 'agent-summary', completeness: 'summary' },
      status: completed.success === false ? 'failed' : 'completed',
      timing: { observedStartedAt: pending.startedAt, observedCompletedAt: observedAt, source: 'client-observed' },
      projectionEligible: completed.success !== false,
    }
  }

  private acceptClaude(update: Record<string, unknown>, observedAt: number): ExternalDelegationObservation | undefined {
    const meta = record(update._meta) ? update._meta : undefined
    const claude = record(meta?.claudeCode) ? meta?.claudeCode as Record<string, unknown> : undefined
    const callId = text(update.toolCallId)
    const rawInput = record(update.rawInput) ? update.rawInput : undefined
    if (claude?.subagent === true && callId !== undefined && text(rawInput?.prompt) !== undefined) {
      this.pending.set(callId, {
        startedAt: this.pending.get(callId)?.startedAt ?? observedAt,
        toolCallId: callId,
        label: text(rawInput?.description) ?? text(update.title) ?? 'Agent delegation',
        task: text(rawInput?.prompt)!,
      })
      return undefined
    }
    const response = record(claude?.toolResponse) ? claude?.toolResponse as Record<string, unknown> : undefined
    if (response === undefined || callId === undefined) return undefined
    const pending = this.pending.get(callId)
    const agentId = text(response.agentId)
    const task = text(response.prompt) ?? pending?.task
    const result = contentText(response.content)
    if (pending === undefined || agentId === undefined || task === undefined || result.length === 0) return undefined
    this.pending.delete(callId)
    const usage = record(response.usage) ? response.usage : undefined
    const duration = number(response.totalDurationMs)
    const inputTokens = number(usage?.input_tokens)
    const outputTokens = number(usage?.output_tokens)
    const cacheReadTokens = number(usage?.cache_read_input_tokens)
    const cacheWriteTokens = number(usage?.cache_creation_input_tokens)
    const totalTokens = number(response.totalTokens)
    return {
      profileKind: 'claude', vendorDelegationKey: agentId, sourceToolCallId: callId,
      vendorChildId: agentId, label: pending.label,
      task: { text: task, source: 'structured-tool-input' },
      result: { text: result, source: 'verbatim-child-final', completeness: 'final-output' },
      status: response.status === 'failed' ? 'failed' : 'completed',
      ...(text(response.resolvedModel) === undefined ? {} : { model: { id: text(response.resolvedModel)!, source: 'agent-structured-live' as const } }),
      ...(usage === undefined && totalTokens === undefined ? {} : { usage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        source: 'agent-structured-live' as const,
      } }),
      timing: {
        observedStartedAt: pending.startedAt, observedCompletedAt: observedAt,
        ...(duration === undefined ? {} : { agentReportedDurationMs: duration }),
        source: duration === undefined ? 'client-observed' : 'mixed',
      },
      projectionEligible: response.status !== 'failed',
    }
  }

  private acceptKimi(update: Record<string, unknown>, observedAt: number): ExternalDelegationObservation | undefined {
    const callId = text(update.toolCallId)
    const rawInput = record(update.rawInput) ? update.rawInput : undefined
    const title = text(update.title)
    if (callId !== undefined && title?.startsWith('Launching ') === true && text(rawInput?.prompt) !== undefined) {
      this.pending.set(callId, {
        startedAt: observedAt, toolCallId: callId,
        label: text(rawInput?.description) ?? title,
        task: text(rawInput?.prompt)!,
      })
      return undefined
    }
    if (callId === undefined || update.status !== 'completed') return undefined
    const pending = this.pending.get(callId)
    const result = text(update.rawOutput)
    const child = result === undefined ? undefined : /^agent_id:\s*(\S+)/m.exec(result)?.[1]
    if (pending === undefined || result === undefined || child === undefined) return undefined
    this.pending.delete(callId)
    return {
      profileKind: 'kimi', vendorDelegationKey: callId, sourceToolCallId: callId,
      vendorChildId: child, label: pending.label,
      task: { text: pending.task, source: 'structured-tool-input' },
      result: { text: result, source: 'tool-result', completeness: 'summary' },
      status: 'completed',
      timing: { observedStartedAt: pending.startedAt, observedCompletedAt: observedAt, source: 'client-observed' },
      // Kimi changes the tool-call prefix on session/load. Until its collision
      // gate passes, the observation remains Activity-only.
      projectionEligible: false,
    }
  }
}
