/** Convert ACP notifications into the activity records presented by the Host. */

import path from 'node:path'
import type { AcpHostToolControlOutcome } from '../../contract/tool-control-outcome.ts'
import { isSensitiveActivityField, redactSecretText } from '../../domain/observability/redaction.ts'
import { activityPresentation, type AcpActivityPresentation } from '../../domain/policy/activity-presentation.ts'
import type { ExternalDelegationLiveFact } from '../../domain/subagent/external-delegation.ts'
import { ACP_ACTIVITY_RAW_MAX, type AcpActivityKind, type AcpActivityStatus } from '../../persistence/sidecar.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import type { AcpToolCallSnapshot } from './tool-call-reducer.ts'

function redactActivityValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested value omitted]'
  if (typeof value === 'string') {
    const redacted = redactSecretText(value)
    return redacted.length > 4_096 ? `${redacted.slice(0, 4_096)}… [truncated]` : redacted
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactActivityValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      result[key] =
        redactSecretText(key).toLowerCase() !== key.toLowerCase() || isSensitiveActivityField(key, item)
          ? '[redacted]'
          : redactActivityValue(item, depth + 1)
    }
    return result
  }
  return value
}

export function activityRawDetail(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(redactActivityValue(value))
  } catch {
    return '[activity detail unavailable]'
  }
}

export function activityStatus(value: unknown): AcpActivityStatus {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'unfinished') return 'unfinished'
  return 'running'
}

export function isTerminalActivityStatus(value: AcpActivityStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'unfinished'
}

export interface NormalizedActivity {
  readonly display?: AcpActivityPresentation
  readonly activityId: string
  readonly kind: AcpActivityKind
  readonly status: AcpActivityStatus
  readonly presentation: string
  readonly rawDetail?: string
}

function normalizeActivityContent(
  parentId: string,
  content: unknown,
  status: AcpActivityStatus,
): NormalizedActivity | undefined {
  if (typeof content !== 'object' || content === null) return undefined
  const item = content as { type?: unknown; path?: unknown; terminalId?: unknown }
  if (item.type === 'diff') {
    const name = typeof item.path === 'string' ? path.basename(item.path) : 'file'
    const display = activityPresentation(content, 'diff')
    return {
      activityId: `${parentId}:diff`,
      kind: 'diff',
      status,
      presentation: `File change · ${name}`,
      rawDetail: activityRawDetail(content),
      ...(display === undefined ? {} : { display }),
    }
  }
  if (item.type === 'terminal')
    return {
      activityId: `${parentId}:terminal`,
      kind: 'terminal',
      status,
      presentation: 'Terminal activity',
      rawDetail: activityRawDetail(content),
    }
  if (item.type === 'resource' || item.type === 'resource_link' || item.type === 'image' || item.type === 'audio')
    return {
      activityId: `${parentId}:resource`,
      kind: 'resource',
      status,
      presentation: 'Agent resource',
      rawDetail: activityRawDetail(content),
    }
  return {
    activityId: `${parentId}:content`,
    kind: 'other',
    status,
    presentation: 'Tool output',
    rawDetail: activityRawDetail(content),
  }
}

export function activitiesForNotification(
  notification: AcpSessionNotification,
  fallbackId: string,
  toolCall?: AcpToolCallSnapshot,
  externalDelegations: readonly ExternalDelegationLiveFact[] = [],
  toolSource?: 'claude:Bash' | 'claude:Edit' | 'claude:Write',
  hostControlOutcome?: AcpHostToolControlOutcome,
): readonly NormalizedActivity[] {
  const update = notification.update as unknown as Record<string, unknown>
  const type = update.sessionUpdate
  if (type === 'tool_call' || type === 'tool_call_update') {
    const toolId = toolCall?.callId ?? (typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId)
    const status = activityStatus(toolCall?.status ?? update.status)
    const agentTitle =
      typeof toolCall?.title === 'string' && toolCall.title.length > 0
        ? toolCall.title
        : typeof toolCall?.name === 'string' && toolCall.name.length > 0
          ? toolCall.name
          : undefined
    const detail = toolCall ?? update
    const display = activityPresentation(
      { toolKind: detail.kind, rawInput: detail.rawInput, content: detail.content },
      'tool',
    )
    const result: NormalizedActivity[] = [
      {
        ...(display === undefined ? {} : { display }),
        activityId: `tool:${toolId}`,
        kind: 'tool',
        status,
        presentation: agentTitle ?? 'Agent tool activity',
        rawDetail: toolActivityRawDetail(
          {
            ...(agentTitle === undefined ? { titleSource: 'adapter-fallback' } : {}),
            toolKind: detail.kind,
            toolName: detail.name,
            ...(toolSource === undefined ? {} : { toolSource }),
            ...(hostControlOutcome === undefined ? {} : { hostControlOutcome }),
            rawInput: detail.rawInput,
            rawOutput: detail.rawOutput,
            locations: detail.locations,
            content: detail.content,
            ...(detail.providerStatus === undefined ? {} : { providerStatus: detail.providerStatus }),
          },
          externalDelegations,
        ),
      },
    ]
    if (Array.isArray(detail.content)) {
      for (const [index, content] of detail.content.entries()) {
        const normalized = normalizeActivityContent(`part:${toolId}:${String(index)}`, content, status)
        if (normalized !== undefined) result.push(normalized)
      }
    }
    return result
  }
  if (type === 'plan' || type === 'plan_update') {
    const entries = type === 'plan' && Array.isArray(update.entries) ? update.entries : undefined
    const plan = type === 'plan_update' ? update.plan : entries
    const planId =
      isPlainRecord(update._meta) && typeof update._meta.activityId === 'string' ? update._meta.activityId : 'session'
    const display = activityPresentation(plan, 'plan')
    const complete = display?.plan !== undefined && display.plan.every((entry) => entry.status === 'completed')
    return [
      {
        activityId: `plan:${planId}`,
        kind: 'plan',
        status: complete ? 'completed' : 'running',
        presentation: 'Agent plan',
        rawDetail: activityRawDetail(plan),
        ...(display === undefined ? {} : { display }),
      },
    ]
  }
  if (type === 'plan_removed') {
    const planId = typeof update.planId === 'string' ? update.planId : 'session'
    return [
      {
        activityId: `plan:${planId}`,
        kind: 'plan',
        status: 'completed',
        presentation: 'Agent plan',
        display: { plan: [] },
        rawDetail: activityRawDetail(update),
      },
    ]
  }
  if (type === 'delegated' || type === 'subagent')
    return [
      {
        activityId: `delegated:${typeof update.activityId === 'string' ? update.activityId : fallbackId}`,
        kind: 'delegated',
        status: activityStatus(update.status),
        presentation: 'Delegated Agent activity',
        rawDetail: activityRawDetail(update),
      },
    ]
  if (type === 'subagent_spawned')
    return [
      {
        activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
        kind: 'delegated',
        status: 'running',
        presentation: typeof update.name === 'string' && update.name.length > 0 ? update.name : 'Agent delegation',
        rawDetail: activityRawDetail({ task: update.task, capabilities: update.capabilities }),
      },
    ]
  if (type === 'subagent_state_update')
    return [
      {
        activityId: `delegated:${typeof update.subagentSessionId === 'string' ? update.subagentSessionId : fallbackId}`,
        kind: 'delegated',
        status: update.state === 'completed' ? 'completed' : update.state === 'cancelled' ? 'cancelled' : 'failed',
        presentation: 'Agent delegation',
        rawDetail: activityRawDetail({ state: update.state }),
      },
    ]
  if (
    type === 'agent_message_chunk' ||
    type === 'agent_thought_chunk' ||
    type === 'user_message_chunk' ||
    type === 'config_option_update' ||
    type === 'current_mode_update' ||
    type === 'available_commands_update' ||
    type === 'usage_update' ||
    type === 'session_info_update'
  )
    return []
  return [
    {
      activityId: `other:${fallbackId}`,
      kind: 'other',
      status: 'completed',
      presentation: 'Agent activity',
      rawDetail: activityRawDetail(update),
    },
  ]
}

export function withExternalDelegations(
  activity: NormalizedActivity,
  delegations: readonly ExternalDelegationLiveFact[],
): NormalizedActivity {
  if (activity.kind !== 'tool' || delegations.length === 0) return activity
  let detail: unknown = activity.rawDetail
  try {
    detail = JSON.parse(activity.rawDetail ?? 'null') as unknown
  } catch {
    /* Preserve the existing detail as a value if it was not valid JSON. */
  }
  const detailRecord = isPlainRecord(detail) ? detail : { toolDetail: detail }
  return {
    ...activity,
    rawDetail: toolActivityRawDetail(detailRecord, delegations),
  }
}

function toolActivityRawDetail(
  detail: Record<string, unknown>,
  delegations: readonly ExternalDelegationLiveFact[],
): string {
  if (delegations.length === 0) return activityRawDetail(detail)
  const externalDelegationDetails = compactExternalDelegationDetails(delegations)
  const rawDetail = activityRawDetail({ ...detail, externalDelegations: externalDelegationDetails })
  if (rawDetail.length <= ACP_ACTIVITY_RAW_MAX) return rawDetail
  const compact = (labelLimit: number, toolNameLimit: number, toolKindLimit: number): string =>
    activityRawDetail({
      ...(detail.titleSource === 'adapter-fallback' ? { titleSource: 'adapter-fallback' } : {}),
      ...(typeof detail.toolKind === 'string'
        ? { toolKind: boundedExternalPreview(detail.toolKind, toolKindLimit) }
        : {}),
      ...(typeof detail.toolName === 'string'
        ? { toolName: boundedExternalPreview(detail.toolName, toolNameLimit) }
        : {}),
      externalDelegations: compactExternalDelegationDetails(delegations, labelLimit),
      detailsOmitted: true,
    })
  for (const [labelLimit, toolNameLimit, toolKindLimit] of [
    [24, 96, 32],
    [8, 32, 16],
  ] as const) {
    const fallback = compact(labelLimit, toolNameLimit, toolKindLimit)
    if (fallback.length <= ACP_ACTIVITY_RAW_MAX) return fallback
  }
  // All bounded Agent-controlled strings can be omitted if escaping still made
  // the verbose fallback unexpectedly large; every child status remains.
  return activityRawDetail({
    ...(detail.titleSource === 'adapter-fallback' ? { titleSource: 'adapter-fallback' } : {}),
    externalDelegations: compactExternalDelegationDetails(delegations, 0),
    detailsOmitted: true,
  })
}

/** The row owns the exact source tool id, so its persisted child facts need only
 * the small fields the read-only presentation consumes. Keep Agent labels as
 * verbatim metadata until this display boundary, then cap them for both the
 * 16 KiB activity envelope and the native tool name. */
function compactExternalDelegationDetails(
  delegations: readonly ExternalDelegationLiveFact[],
  labelLimit = 96,
): readonly { readonly label: string; readonly status: ExternalDelegationLiveFact['status'] }[] {
  return delegations.map(({ label, status }) => ({
    label: boundedExternalPreview(label, labelLimit),
    status,
  }))
}

function boundedExternalPreview(value: string, maxCodePoints: number): string {
  const safe = redactSecretText(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return Array.from(safe, (point) =>
    point.length === 1 && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff ? '�' : point,
  )
    .slice(0, maxCodePoints)
    .join('')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
