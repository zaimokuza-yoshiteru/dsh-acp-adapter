/// <reference types="node" />
import { createHash } from 'node:crypto'
import {
  SESSION_FORMAT_VERSION, Session, SessionId,
  type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
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
  readonly version: 2 | 3
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
    kind: 'dsh-acp-external-subagent', version: 3,
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
  const events: readonly SessionEvent[] = [
    { type: 'subagent/descriptor', seq: 0, time: startedAt, data: snapshotSubagentDescriptor({ mode: 'one-shot', provider: EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER, label }) },
    { type: 'turn/start', seq: 1, time: startedAt, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 2, time: startedAt, data: user, surfaceOp: 'append' },
    { type: 'step/start', seq: 3, time: startedAt, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 4, time: completedAt,
      data: { turn: 1, step: 1, message: assistant, ...(usage === undefined ? {} : { usage }) },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 5, time: completedAt, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: completedAt, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as readonly SessionEvent[]
  const validated = Session.fromRestore(header.id, events, header)
  if (validated.deriveMessages().length !== 2) throw new Error('ACP_SUBAGENT_TRANSCRIPT_INVALID: projected task/result were not admitted')
  return { header, events }
}

function surfaceFreeLog(header: SessionHeader, label: string, startedAt: number, completedAt: number): {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
} {
  const events: readonly SessionEvent[] = [
    { type: 'subagent/descriptor', seq: 0, time: startedAt, data: snapshotSubagentDescriptor({ mode: 'one-shot', provider: EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER, label }) },
    { type: 'turn/start', seq: 1, time: startedAt, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: completedAt, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as readonly SessionEvent[]
  const validated = Session.fromRestore(header.id, events, header)
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
  return canonical(existing.meta) === canonical(expected.header) && canonical(existing.events) === canonical(expected.events)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedProjection(row: AcpActivityRecord): { readonly detail: ProjectedDetail; readonly expected: ReturnType<typeof projectionLog> } | undefined {
  if (row.rawDetail === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(row.rawDetail) } catch { return undefined }
  if (!object(value) || value.kind !== 'dsh-acp-external-subagent' || (value.version !== 2 && value.version !== 3) || value.childSessionId !== row.dshSessionId) return undefined
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
        })
  } catch { return undefined }
  if (value.projectionDigest !== digest(expected)) return undefined
  return { detail: value as unknown as ProjectedDetail, expected }
}

export interface ExternalProjectionRepairSummary {
  readonly committed: number
  readonly repaired: number
  readonly conflicted: number
}

/** Surface-free, idempotent one-shot bridge for evidence-complete external delegations. */
export class ExternalSubagentProjector {
  constructor(
    private readonly persistence: Pick<SessionPersistence, 'create' | 'append' | 'inspect'>
      & Partial<Pick<SessionPersistence, 'readRaw'>>,
    private readonly sidecar: Pick<AcpSidecar, 'upsertActivity'> & Partial<Pick<AcpSidecar, 'listProjectedSubagentActivities'>>,
  ) {}

  private async inspect(id: string): Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[] } | undefined> {
    try { return await this.persistence.inspect(SessionId(id)) } catch { return undefined }
  }

  /** JSONL may materialize the exact batch before an immediately borrowed
   * prepared view observes its new revision. The backend's decoded raw seam is
   * authoritative for this narrow write-after-read race. */
  private async rawMatches(expected: ReturnType<typeof projectionLog>): Promise<boolean> {
    if (this.persistence.readRaw === undefined) return false
    let raw: Awaited<ReturnType<SessionPersistence['readRaw']>>
    try { raw = await this.persistence.readRaw(expected.header.id) } catch { return false }
    if (raw === undefined || canonical(raw.meta) !== canonical(expected.header)) return false
    try {
      const records = raw.content.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      const [headerRecord, ...events] = records
      if (headerRecord?.type !== 'session') return false
      const { type: _type, ...header } = headerRecord
      return canonical(header) === canonical(expected.header) && canonical(events) === canonical(expected.events)
    } catch { return false }
  }

  private async commit(expected: ReturnType<typeof projectionLog>): Promise<boolean> {
    const id = expected.header.id as string
    const existing = await this.inspect(id)
    if (existing !== undefined) {
      if (!sameProjection(existing, expected) && !(await this.rawMatches(expected))) {
        throw new Error(`ACP_SUBAGENT_PROJECTION_CONFLICT: ${id}`)
      }
      return false
    }

    try { await this.persistence.create(expected.header) } catch {
      const raced = await this.inspect(id)
      if (raced !== undefined) {
        if (!sameProjection(raced, expected)) throw new Error(`ACP_SUBAGENT_PROJECTION_CONFLICT: ${id}`)
        return false
      }
      // A lazy create admission may already exist without a materialized
      // artifact. Continue with the exact first batch; append is the durable
      // identity check and will fail closed for every other condition.
    }

    let appendFailure: unknown
    try { await this.persistence.append(expected.header.id, expected.events) } catch (error) { appendFailure = error }
    let committed = await this.inspect(id)
    if (committed === undefined && appendFailure !== undefined) {
      // If append failed after create admission but before durability, retrying
      // the same complete first batch is safe. A committed first attempt rejects
      // the duplicate by seq and the following inspection proves the result.
      try { await this.persistence.append(expected.header.id, expected.events) } catch { /* inspect below is authoritative */ }
      committed = await this.inspect(id)
    }
    if (committed === undefined) throw appendFailure instanceof Error ? appendFailure : new Error(`ACP_SUBAGENT_PROJECTION_MISSING: ${id}`)
    if (!sameProjection(committed, expected) && !(await this.rawMatches(expected))) {
      throw new Error(`ACP_SUBAGENT_PROJECTION_CONFLICT: ${id}`)
    }
    return true
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
