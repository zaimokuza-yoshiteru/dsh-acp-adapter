import { expect } from 'vitest'
import type { AcpActivityView } from '../../src/contract/remote.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'

export interface ReviewedDevinCall {
  readonly callId: string
  readonly tool: string
}

/** Read only the isolated actor's public activity. No observation grants permission. */
export async function captureDevinDiscovery(
  service: AcpRemoteService,
  sessionId: string,
  tempDirectory: string,
  reviewed: readonly ReviewedDevinCall[],
  afterRevision = 0,
) {
  let page = await service.activityPage(sessionId, { afterRevision, limit: 100, captureSnapshot: true })
  const latest = new Map<string, AcpActivityView>()
  for (;;) {
    for (const row of page.activities) if (row.kind === 'tool') latest.set(row.activityId, row)
    if (!page.hasMore) break
    if (page.nextCursor === null || page.nextCursor <= afterRevision) throw new Error('Devin activity page gap')
    afterRevision = page.nextCursor
    page = await service.activityPage(sessionId, { afterRevision, limit: 100, snapshotHead: page.head })
  }
  const rows = await Promise.all([...latest.values()].map((row) => service.activityDetail(sessionId, row)))
  return observeDevinDiscovery(rows, tempDirectory, reviewed)
}

export function observeDevinDiscovery(
  rows: readonly AcpActivityView[],
  tempDirectory: string,
  reviewed: readonly ReviewedDevinCall[] = [],
) {
  const catalogs: { activityId: string; activitySeq: number; paths: string[] }[] = []
  const reads: {
    activityId: string
    path: string
    kind: 'read' | 'grep'
    fields: ReturnType<typeof readArgumentEvidence>
    catalogActivityId?: string
  }[] = []
  const violations: { activityId: string; reason: string; fields?: ReturnType<typeof readArgumentEvidence> }[] = []
  const truncatedOutputs: string[] = []
  const unreadableActivities: string[] = []
  for (const row of [...rows].sort((left, right) => left.activitySeq - right.activitySeq)) {
    if (row.kind !== 'tool') continue
    const { activityId } = row
    const reject = (reason: string) => violations.push({ activityId, reason })
    const prefix = `${row.promptAnchorMessageId}:tool:`
    const callId = activityId.startsWith(prefix) ? activityId.slice(prefix.length) : activityId.replace(/^tool:/, '')
    const method = callId.split(':')[0]
    const reviewedCall = method === 'mcp_call_tool' ? reviewed.find((call) => call.callId === callId) : undefined
    const detail = publicToolDetail(row.rawDetail)
    if (!detail) {
      // A rejected or cancelled request can have only its original verified
      // permission identity. Its Host side effects are checked by the caller.
      if (
        reviewedCall === undefined ||
        (row.status !== 'cancelled' && row.status !== 'failed' && row.status !== 'unfinished')
      )
        unreadableActivities.push(activityId)
      continue
    }
    if (detail.truncated) truncatedOutputs.push(activityId)
    const { toolName } = detail.value
    const input = record(detail.value.rawInput)
    if (method === 'exec' || method === 'bash' || (input && 'command' in input)) {
      reject('native-command')
      continue
    }
    if (method === 'mcp_call_tool') {
      // Original ACP request IDs are distinct from the Host execution IDs. The
      // caller supplies only requests verified on this actor's permission route.
      if (reviewedCall === undefined || (toolName !== undefined && reviewedCall.tool !== toolName))
        reject('unreviewed-mcp-call')
      else if (catalogs.length === 0) reject('mcp-call-before-discovery')
      continue
    }
    if (method === 'mcp_list_servers' && input && Object.keys(input).length === 0) continue
    if (method === 'mcp_list_tools' && input?.server_name === 'dsh') {
      if (row.status === 'completed')
        catalogs.push({
          activityId,
          activitySeq: row.activitySeq,
          paths: [...new Set(artifactPaths([detail.value.rawOutput, detail.value.content], tempDirectory))],
        })
      continue
    }
    if (method !== 'grep' && method !== 'read') {
      reject('unexpected-native-tool')
      continue
    }
    const path = method === 'grep' ? input?.path : input?.file_path
    if (typeof path !== 'string' || artifactPaths(path, tempDirectory)[0] !== canonicalPath(path)) {
      reject('outside-isolated-catalog')
      continue
    }
    const fields = readArgumentEvidence(input)
    if (!validReadArguments(method, input)) {
      violations.push({ activityId, reason: 'unverified-read-arguments', fields })
      continue
    }
    const catalog = catalogs.findLast((entry) => entry.paths.includes(canonicalPath(path))) ?? catalogs.at(-1)
    if (!catalog || (catalog.paths.length > 0 && !catalog.paths.includes(canonicalPath(path)))) {
      reject('unrelated-catalog-read')
      continue
    }
    // Some Devin versions expose names only in the ACP list result. The clean
    // per-run temp root proves isolation, but cannot prove an exact returned path.
    if (row.status === 'completed')
      reads.push({
        activityId,
        kind: method,
        fields,
        path: canonicalPath(path),
        ...(catalog.paths.length ? { catalogActivityId: catalog.activityId } : {}),
      })
  }
  return {
    source: 'persisted-acp-activity' as const,
    catalogs,
    reads,
    violations,
    unreadableActivities,
    truncatedOutputs,
    unprovenReads: reads.filter((read) => read.catalogActivityId === undefined).map((read) => read.activityId),
    unretrievedCatalogs: catalogs
      .filter(
        (catalog, index) =>
          index === catalogs.length - 1 &&
          catalog.paths.length > 0 &&
          !reads.some((read) => read.catalogActivityId !== undefined),
      )
      .map((catalog) => catalog.activityId),
  }
}

export function assertDevinDiscovery(evidence: ReturnType<typeof observeDevinDiscovery>) {
  expect(evidence.violations, 'Unexpected tool activity').toEqual([])
  expect(evidence.unreadableActivities, 'Unable to verify tool activity').toEqual([])
  expect(evidence.catalogs.length, 'Each actor must discover its own current MCP catalog').toBeGreaterThan(0)
  expect(evidence.unretrievedCatalogs, 'Overflowed catalogs must be retrieved').toEqual([])
}

// The installed CLI's read tool imposes a character/line cap with omitted
// offset/limit. ACP may expose grep's pattern as `query`. These fields change
// formatting or matching only; the exact, isolated target is checked above.
const readKeys = ['file_path', 'offset', 'limit', 'image_size']
const grepKeys = [
  'path',
  'pattern',
  'query',
  'glob_pattern',
  'output_mode',
  'case_insensitive',
  'max_results',
  'context_lines',
]
const numericKeys = ['offset', 'limit', 'image_size', 'max_results', 'context_lines']

function validReadArguments(method: 'read' | 'grep', input: Record<string, unknown> | undefined): boolean {
  if (!input) return false
  const keys = method === 'read' ? readKeys : grepKeys
  if (Object.keys(input).some((key) => !keys.includes(key))) return false
  // Serde optional scalar fields may be absent or explicitly null. No option
  // is allowed to carry a second path, command, object or file-list operand.
  for (const key of numericKeys) {
    const value = input[key]
    if (value == null || (key === 'image_size' && value === 'full')) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false
  }
  if (method === 'read') return true
  return (
    typeof (input.query ?? input.pattern) === 'string' &&
    [input.query, input.pattern, input.glob_pattern].every((value) => value == null || typeof value === 'string') &&
    (input.output_mode == null ||
      (typeof input.output_mode === 'string' &&
        ['content', 'files_with_matches', 'count'].includes(input.output_mode))) &&
    (input.case_insensitive == null || typeof input.case_insensitive === 'boolean')
  )
}

// Do not export search expressions, file contents, unusual field names or raw
// strings to disk. Retain types and range values so false failures are diagnosable.
function readArgumentEvidence(input: Record<string, unknown> | undefined) {
  return Object.entries(input ?? {}).map(([key, value]) => ({
    key: readKeys.includes(key) || grepKeys.includes(key) ? key : '<unrecognized>',
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    ...(numericKeys.includes(key) && typeof value === 'number' && Number.isFinite(value) ? { value } : {}),
  }))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function publicToolDetail(raw: string | undefined) {
  const parse = (text: string) => {
    try {
      return record(JSON.parse(text))
    } catch {
      return undefined
    }
  }
  if (!raw) return undefined
  const full = parse(raw)
  if (full) return { value: full, truncated: false }
  if (!raw.endsWith('… [truncated]')) return undefined
  // The adapter serializes rawInput before potentially oversized output. Only
  // accept a syntactically complete top-level input; never recover fragments.
  for (const key of [',"rawOutput":', ',"content":']) {
    const end = raw.indexOf(key)
    if (end < 0) continue
    const prefix = parse(`${raw.slice(0, end)}}`)
    if (prefix && record(prefix.rawInput)) return { value: prefix, truncated: true }
  }
  return undefined
}

function canonicalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/private\/var\//, '/var/')
}

function artifactPaths(value: unknown, tempDirectory: string): string[] {
  if (typeof value === 'string') {
    const root = canonicalPath(tempDirectory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${root}/devin-overflows-[\\w-]+/[\\w-]+/content\\.txt`, 'g')
    return [...value.replaceAll('\\', '/').replaceAll('/private/var/', '/var/').matchAll(pattern)].map(
      (match) => match[0],
    )
  }
  if (Array.isArray(value)) return value.flatMap((item) => artifactPaths(item, tempDirectory))
  const object = record(value)
  return object ? Object.values(object).flatMap((item) => artifactPaths(item, tempDirectory)) : []
}
