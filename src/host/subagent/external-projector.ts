/// <reference types="node" />
import { createHash } from 'node:crypto'
import {
  SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq,
  type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionAlreadyExistsError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { AcpActivityRecord, AcpSidecar } from '../../persistence/sidecar.ts'
import type { ExternalDelegationObservation } from '../../domain/subagent/external-delegation.ts'
import { redactSecretText } from '../../domain/observability/redaction.ts'

export const EXTERNAL_SUBAGENT_ACTIVITY_ANCHOR = 'external-subagent-record'
export const EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER = 'dsh-acp-adapter'

export interface ExternalProjectionContext {
  readonly profileId: string
  readonly bindingGeneration: number
  readonly rootAcpSessionId: string
  readonly parentDshSessionId: string
  readonly parentCwd: string
  readonly parentDelegationDepth?: number
  readonly flushParent: () => Promise<boolean>
}

export interface ExternalProjectionResult {
  readonly childSessionId: string
  readonly created: boolean
}

interface ProjectedDetail {
  readonly kind: 'dsh-acp-external-subagent'
  readonly version: 2 | 3 | 4
  readonly childSessionId: string
  readonly parentDshSessionId: string
  readonly profileId: string
  readonly profileKind: string
  readonly task: ExternalDelegationObservation['task']
  readonly result: ExternalDelegationObservation['result']
  readonly model?: ExternalDelegationObservation['model']
  readonly usage?: ExternalDelegationObservation['usage']
  readonly timing: ExternalDelegationObservation['timing']
  readonly evidenceDigest: string
  /** Shallow canonical fields survive Activity redaction without granting the
   * renderer an opaque unredacted payload. The event batch is reconstructed by
   * one versioned schema, never from task/result display text. */
  readonly projectionHeader: SessionHeader
  readonly projectionLabel: string
  readonly projectionStartedAt: number
  readonly projectionCompletedAt: number
  readonly projectionDigest: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function bounded(value: string, limit = 4_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`
}

function childId(context: ExternalProjectionContext, observation: ExternalDelegationObservation): string {
  const key = {
    profileId: context.profileId,
    bindingGeneration: context.bindingGeneration,
    rootAcpSessionId: context.rootAcpSessionId,
    vendorDelegationKey: observation.vendorDelegationKey,
  }
  return `session-dsh-acp-${digest(key).slice(0, 32)}`
}

function recordDetail(
  childSessionId: string,
  context: ExternalProjectionContext,
  observation: ExternalDelegationObservation,
  projected: ReturnType<typeof projectionLog>,
): ProjectedDetail {
  const evidence = {
    profileId: context.profileId,
    bindingGeneration: context.bindingGeneration,
    rootAcpSessionId: context.rootAcpSessionId,
    vendorDelegationKey: observation.vendorDelegationKey,
    sourceToolCallId: observation.sourceToolCallId,
    vendorChildId: observation.vendorChildId,
    task: observation.task,
    result: observation.result,
    status: observation.status,
    model: observation.model,
    usage: observation.usage,
    timing: observation.timing,
  }
  return {
    kind: 'dsh-acp-external-subagent', version: 4,
    childSessionId, parentDshSessionId: context.parentDshSessionId,
    profileId: context.profileId, profileKind: observation.profileKind,
    task: { ...observation.task, text: bounded(observation.task.text) },
    result: { ...observation.result, text: bounded(observation.result.text) },
    ...(observation.model === undefined ? {} : { model: observation.model }),
    ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    timing: observation.timing,
    evidenceDigest: digest(evidence),
    projectionHeader: projected.header,
    projectionLabel: (projected.events[0]?.data as { label: string }).label,
    projectionStartedAt: projected.events[0]?.time ?? projected.header.createdAt,
    projectionCompletedAt: projected.events.at(-1)?.time ?? projected.header.createdAt,
    projectionDigest: digest(projected),
  }
}

function transcriptLog(
  header: SessionHeader,
  label: string,
  startedAt: number,
  completedAt: number,
  detail: Pick<ProjectedDetail, 'profileKind' | 'task' | 'result' | 'model' | 'usage'>,
  streamMode: 'current' | 'legacy' = 'current',
): { readonly header: SessionHeader; readonly events: readonly SessionEvent[] } {
  const user: UserMessage = {
    id: MessageId(`${header.id}:external-task`),
    role: 'user',
    content: [{ type: 'text', text: detail.task.text }],
    source: { kind: 'user' },
  }
  const reported = detail.result.completeness === 'summary'
    ? `Agent-reported summary:\n\n${detail.result.text}`
    : detail.result.text
  const assistant: AssistantMessage = {
    id: MessageId(`${header.id}:external-result`),
    role: 'assistant',
    content: [{ type: 'text', text: reported }],
    source: {
      kind: 'model',
      provider: EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER,
      model: detail.model?.id ?? `${detail.profileKind}-external-subagent`,
    },
  }
  const usage = detail.usage?.inputTokens !== undefined && detail.usage.outputTokens !== undefined
    ? {
        inputTokens: detail.usage.inputTokens,
        outputTokens: detail.usage.outputTokens,
        ...(detail.usage.totalTokens === undefined ? {} : { totalTokens: detail.usage.totalTokens }),
        ...(detail.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: detail.usage.cacheReadTokens }),
        ...(detail.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: detail.usage.cacheWriteTokens }),
      }
    : undefined
  // This is a projection of the reported result, not a reconstructed external
  // token timeline. All synthetic chunks use the result observation time.
  const stream = new AssistantStreamAccumulator()
  stream.push({ time: completedAt, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  stream.push({ time: completedAt, chunk: { type: 'text-delta', index: 0, text: reported } })
  stream.push({ time: completedAt, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: reported } } })
  if (usage !== undefined) stream.push({ time: completedAt, chunk: { type: 'usage', usage } })
  stream.push({ time: completedAt, chunk: { type: 'finish', reason: { kind: 'stop' } } })
  const events: readonly SessionEvent[] = [
    { type: 'subagent/descriptor', seq: SessionSeq(0), time: startedAt, data: snapshotSubagentDescriptor({ mode: 'one-shot', provider: EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER, label }) },
    { type: 'turn/start', seq: SessionSeq(1), time: startedAt, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: SessionSeq(2), time: startedAt, data: user, surfaceOp: 'append' },
    { type: 'step/start', seq: SessionSeq(3), time: startedAt, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: SessionSeq(4), time: completedAt,
      data: {
        turn: 1, step: 1, message: assistant, ...(usage === undefined ? {} : { usage }),
        ...(streamMode === 'legacy' ? {} : { stream: stream.snapshot() }),
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: SessionSeq(5), time: completedAt, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(6), time: completedAt, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as readonly SessionEvent[]
  // Legacy bytes are reconstructed only to verify the saved sidecar digest.
  // DSH's adjacent v1-to-v2 migration gives chunkless messages an empty stream.
  if (streamMode === 'legacy') return { header, events }
  const validated = Session.fromRestore(header.id, events, header, SessionLogOffset(0))
  if (validated.deriveMessages().length !== 2) throw new Error('ACP_SUBAGENT_TRANSCRIPT_INVALID: projected task/result were not admitted')
  return { header, events }
}

function surfaceFreeLog(header: SessionHeader, label: string, startedAt: number, completedAt: number): {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
} {
  const events: readonly SessionEvent[] = [
    { type: 'subagent/descriptor', seq: SessionSeq(0), time: startedAt, data: snapshotSubagentDescriptor({ mode: 'one-shot', provider: EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER, label }) },
    { type: 'turn/start', seq: SessionSeq(1), time: startedAt, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(2), time: completedAt, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as readonly SessionEvent[]
  if (header.version !== SESSION_FORMAT_VERSION) return { header, events }
  const validated = Session.fromRestore(header.id, events, header, SessionLogOffset(0))
  if (validated.deriveMessages().length !== 0) throw new Error('ACP_SUBAGENT_SURFACE_LEAK: projected record entered DSH model history')
  return { header, events }
}

function projectionLog(context: ExternalProjectionContext, observation: ExternalDelegationObservation, id: string): {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
} {
  const startedAt = Math.trunc(observation.timing.observedStartedAt)
  const completedAt = Math.max(startedAt, Math.trunc(observation.timing.observedCompletedAt))
  const label = bounded(redactSecretText(observation.label), 256)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id), createdAt: startedAt, cwd: context.parentCwd,
    parentSession: SessionId(context.parentDshSessionId), origin: 'subagent',
    delegationDepth: (context.parentDelegationDepth ?? 0) + 1,
  }
  return transcriptLog(header, label, startedAt, completedAt, {
    profileKind: observation.profileKind,
    task: { ...observation.task, text: bounded(observation.task.text) },
    result: { ...observation.result, text: bounded(observation.result.text) },
    ...(observation.model === undefined ? {} : { model: observation.model }),
    ...(observation.usage === undefined ? {} : { usage: observation.usage }),
  })
}

function sameProjection(existing: { readonly meta: SessionHeader; readonly events: readonly SessionEvent[] }, expected: { readonly header: SessionHeader; readonly events: readonly SessionEvent[] }): boolean {
  if (canonical(existing.meta) !== canonical(expected.header)) return false
  // A released v1 projection migrated by DSH has no observed token stream.
  // Admit it only when every other field equals this exact task/result log.
  const events = existing.events.map((event, index) => {
    const target = expected.events[index]
    if (event.type !== 'assistant/message' || target?.type !== 'assistant/message' || event.data.stream.length !== 0) return event
    return { ...event, data: { ...event.data, stream: target.data.stream } }
  })
  return canonical(events) === canonical(expected.events)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedProjection(row: AcpActivityRecord): { readonly detail: ProjectedDetail; readonly expected: ReturnType<typeof projectionLog> } | undefined {
  if (row.rawDetail === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(row.rawDetail) } catch { return undefined }
  if (!object(value) || value.kind !== 'dsh-acp-external-subagent' || (value.version !== 2 && value.version !== 3 && value.version !== 4) || value.childSessionId !== row.dshSessionId) return undefined
  if (!object(value.projectionHeader) || typeof value.projectionLabel !== 'string'
    || typeof value.projectionStartedAt !== 'number' || typeof value.projectionCompletedAt !== 'number'
    || typeof value.projectionDigest !== 'string') return undefined
  const header = value.projectionHeader as unknown as SessionHeader
  if (header.id !== row.dshSessionId || header.parentSession !== value.parentDshSessionId) return undefined
  let expected: ReturnType<typeof surfaceFreeLog>
  try {
    expected = value.version === 2
      ? surfaceFreeLog(header, value.projectionLabel, value.projectionStartedAt, value.projectionCompletedAt)
      : transcriptLog(header, value.projectionLabel, value.projectionStartedAt, value.projectionCompletedAt, {
          profileKind: String(value.profileKind),
          task: value.task as ProjectedDetail['task'],
          result: value.result as ProjectedDetail['result'],
          ...(object(value.model) ? { model: value.model as unknown as NonNullable<ProjectedDetail['model']> } : {}),
          ...(object(value.usage) ? { usage: value.usage as unknown as NonNullable<ProjectedDetail['usage']> } : {}),
        }, value.version === 3 ? 'legacy' : 'current')
  } catch { return undefined }
  if (value.projectionDigest !== digest(expected)) return undefined
  if (value.version !== 4) {
    if (Number(header.version) !== 1) return undefined
    expected = {
      header: { ...header, version: SESSION_FORMAT_VERSION },
      events: expected.events.map(event => event.type === 'assistant/message'
        ? { ...event, data: { ...event.data, stream: [] } }
        : event),
    }
    try { Session.fromRestore(header.id, expected.events, expected.header, SessionLogOffset(0)) } catch { return undefined }
  }
  return { detail: value as unknown as ProjectedDetail, expected }
}

export interface ExternalProjectionRepairSummary {
  readonly committed: number
  readonly repaired: number
  readonly conflicted: number
}

/** Idempotent read-only transcript projection for evidence-complete external delegations. */
export class ExternalSubagentProjector {
  constructor(
    private readonly persistence: Pick<SessionPersistence, 'create' | 'open'>,
    private readonly sidecar: Pick<AcpSidecar, 'upsertActivity'> & Partial<Pick<AcpSidecar, 'listProjectedSubagentActivities'>>,
  ) {}

  private async inspect(id: string): Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[] } | undefined> {
    let handle: SessionHandle
    try { handle = await this.persistence.open(SessionId(id), 'read') } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined
      throw error
    }
    await using reader = handle
    return { meta: reader.header, events: await reader.read() }
  }

  private async commit(expected: ReturnType<typeof projectionLog>): Promise<boolean> {
    let handle: SessionHandle
    let created = false
    try {
      handle = await this.persistence.create(expected.header)
      created = true
    } catch (error) {
      if (!(error instanceof SessionAlreadyExistsError)) throw error
      handle = await this.persistence.open(expected.header.id, 'write')
    }
    await using writer = handle
    const events = await writer.read()
    const prefix = { header: expected.header, events: expected.events.slice(0, events.length) }
    if (events.length > expected.events.length || !sameProjection({ meta: writer.header, events }, prefix)) {
      throw new Error(`ACP_SUBAGENT_PROJECTION_CONFLICT: ${expected.header.id}`)
    }
    const remaining = expected.events.slice(events.length)
    if (remaining.length > 0) await writer.append(remaining)
    // Read visibility does not imply crash durability. Publish the sidecar
    // completion only after this barrier and the writer's teardown succeed.
    await writer.flush()
    return created || remaining.length > 0
  }

  private async setProjectionStatus(row: AcpActivityRecord, status: 'completed' | 'failed'): Promise<void> {
    await this.sidecar.upsertActivity({
      dshSessionId: row.dshSessionId,
      ownerDshSessionId: row.ownerDshSessionId,
      promptAnchorMessageId: row.promptAnchorMessageId,
      activityId: row.activityId,
      time: Date.now(),
      kind: row.kind,
      status,
      presentation: row.presentation,
      ...(row.rawDetail === undefined ? {} : { rawDetail: row.rawDetail }),
      ...(row.rawDetailRef === undefined ? {} : { rawDetailRef: row.rawDetailRef }),
    })
  }

  /** Converge interrupted projection transactions after the persistence seam mounts. */
  async repairInterrupted(): Promise<ExternalProjectionRepairSummary> {
    const rows = await this.sidecar.listProjectedSubagentActivities?.() ?? []
    let committed = 0
    let repaired = 0
    let conflicted = 0
    for (const row of rows) {
      const stored = storedProjection(row)
      if (stored === undefined) {
        // Version-1 records predate a canonical repair payload. They remain
        // readable but are never guessed back into a DSH child log.
        continue
      }
      try {
        const parent = await this.inspect(stored.detail.parentDshSessionId)
        if (parent === undefined || parent.meta.id !== stored.expected.header.parentSession || parent.meta.cwd !== stored.expected.header.cwd) {
          throw new Error(`ACP_SUBAGENT_PARENT_NOT_DURABLE: ${stored.detail.parentDshSessionId}`)
        }
        const created = await this.commit(stored.expected)
        await this.setProjectionStatus(row, 'completed')
        committed += 1
        if (created) repaired += 1
      } catch {
        conflicted += 1
        await this.setProjectionStatus(row, 'failed').catch(() => undefined)
      }
    }
    return { committed, repaired, conflicted }
  }

  async project(observation: ExternalDelegationObservation, context: ExternalProjectionContext): Promise<ExternalProjectionResult | undefined> {
    if (!observation.projectionEligible || observation.status !== 'completed') return undefined
    const id = childId(context, observation)
    const expected = projectionLog(context, observation, id)
    const detail = recordDetail(id, context, observation, expected)

    // Stage the complete canonical transaction first. If the process crashes
    // at any later boundary, startup repair can converge without reconstructing
    // identity or display evidence from Agent text.
    const staged = await this.sidecar.upsertActivity({
      dshSessionId: id, ownerDshSessionId: id,
      promptAnchorMessageId: EXTERNAL_SUBAGENT_ACTIVITY_ANCHOR,
      activityId: 'external-subagent-record', time: Date.now(), kind: 'delegated', status: 'running',
      presentation: observation.label,
      rawDetail: JSON.stringify(detail),
    })

    // Parent durable history must precede child publication. A host without a
    // persistence listener cannot truthfully publish lineage.
    try {
      if (!(await context.flushParent())) throw new Error('ACP_SUBAGENT_PARENT_NOT_DURABLE')
      const created = await this.commit(expected)
      await this.setProjectionStatus(staged, 'completed')
      return { childSessionId: id, created }
    } catch (error) {
      await this.setProjectionStatus(staged, 'failed').catch(() => undefined)
      throw error
    }
  }
}
