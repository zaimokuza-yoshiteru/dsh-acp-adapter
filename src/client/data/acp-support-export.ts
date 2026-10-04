import type { AcpAuditTimelineEntry, AcpRemoteLike } from './acp-remote.ts'
import type { AcpActivityView, AcpRecoveryView } from '../../contract/remote.ts'

export const ACP_SUPPORT_EXPORT_SCHEMA = 'dsh-acp-support'
export const ACP_SUPPORT_EXPORT_SCHEMA_VERSION = 1
export const ACP_SUPPORT_EXPORT_PAGE_SIZE = 100
export const ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS = 5_000
export const ACP_SUPPORT_EXPORT_MAX_ACTIVITY_ROWS = 5_000
const supportExportReadRetryDelays = [250, 500, 1_000, 2_000, 4_000, 8_000] as const
const stableSupportExportReadCodes = new Set([
  'dsh-acp/config',
  'dsh-acp/not-installed',
  'dsh-acp/auth-required',
  'dsh-acp/protocol-incompatible',
  'dsh-acp/user-rejected',
  'gateway/bad-request',
])

const safeStatuses = new Set([
  'ok',
  'error',
  'aborted',
  'timeout',
  'concurrent-change',
  'selected',
  'cancelled',
  'auto-approved',
  'approval-required',
  'policy-unavailable',
  'bridge-unavailable',
  'inactive-connection',
  'inactive-prompt',
  'identity-unmatched',
  'invalid-tool-name',
  'not-coordination',
  'allow-once-unavailable',
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
  'inherited',
  'blank',
  'agent-does-not-advertise-fork',
  'parent-not-idle',
  'parent-recovery-required',
  'parent-binding-unavailable',
  'parent-binding-mismatch',
  'seed-not-latest-semantic-boundary',
  'candidate-not-available',
  'started',
  'running',
  'exited',
  'killed',
  'released',
  'output-summary',
  'stop-requested',
  'exit-unverified',
])
const safeAuditKinds = new Set([
  'binding',
  'permission',
  'reconciliation',
  'replay-assessment',
  'degradation',
  'session-fork',
  'filesystem',
  'terminal',
])

const safeRecoveryCauses = new Set([
  'cwd-changed',
  'profile-changed',
  'agent-changed',
  'protocol-changed',
  'capability-missing',
  'id-not-found',
  'load-failed',
  'replay-overflow',
  'replay-diverged',
  'dsh-log-diverged',
  'dsh-log-truncated',
  'binding-in-use',
  'binding-missing',
  'binding-outdated',
  'backend-conflict',
])
const safeRecoveryLocalStatuses = new Set(['finishing-tools', 'saving-results', 'storage-error'])

/** Bounded, content-free audit row for a user-selected ACP session. */
export interface AcpSupportAuditRow {
  readonly session: 'session-1'
  readonly sequence: number
  readonly time: number
  readonly kind: string
  readonly severity: AcpAuditTimelineEntry['severity']
  readonly category: AcpAuditTimelineEntry['category']
  readonly summaryCode: AcpAuditTimelineEntry['summaryCode']
  readonly status: string | null
}

/** Safe summary of one activity revision; tool text, paths, and raw ids are omitted. */
export interface AcpSupportActivityRow {
  readonly session: 'session-1'
  readonly activity: string
  readonly revision: number
  readonly time: number
  readonly kind: AcpActivityView['kind']
  readonly status: AcpActivityView['status']
}

export interface AcpSupportExport {
  readonly schema: typeof ACP_SUPPORT_EXPORT_SCHEMA
  readonly schemaVersion: typeof ACP_SUPPORT_EXPORT_SCHEMA_VERSION
  readonly adapterVersion: string
  readonly captureStartedAt: number
  readonly exportedAt: number
  readonly runtimeHostVersion: null
  readonly sessionAlias: 'session-1'
  readonly recovery: {
    readonly status: 'available' | 'unavailable'
    readonly capturedAt: number
    readonly kind: AcpRecoveryView['kind'] | null
    readonly cause: string | null
    readonly localStatus: NonNullable<AcpRecoveryView['localStatus']> | null
    readonly updatedAt: number | null
  }
  readonly audit: {
    readonly snapshotHead: number
    readonly rows: readonly AcpSupportAuditRow[]
    readonly unreadableRecords: number
    readonly storedRecordsReachedHead: boolean
    readonly truncated: boolean
    readonly possibleHistoricalLoss: true
  }
  readonly activity: {
    readonly snapshotHead: number
    readonly rows: readonly AcpSupportActivityRow[]
    readonly storedRecordsReachedHead: boolean
    readonly truncated: boolean
    readonly historicalLoss: 'unknown'
  }
  readonly unavailable: {
    readonly providerPromptTrace: true
    readonly providerUsage: true
    readonly nativeSessionLog: true
    readonly crossMemberCorrelation: true
  }
}

export class AcpSupportExportError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid-page' | 'session-changed') {
    super(code)
    this.name = 'AcpSupportExportError'
  }
}

function assertCurrent(isCurrent: () => boolean, signal?: AbortSignal): void {
  if (signal?.aborted || !isCurrent()) throw new AcpSupportExportError('session-changed')
}

function valueOf<T>(result: {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string }
}): T {
  if (!result.ok) throw Object.assign(new Error('ACP support export read failed'), { code: result.error?.code })
  if (result.value === undefined) throw new AcpSupportExportError('invalid-page')
  return result.value
}

function stableReadFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    stableSupportExportReadCodes.has(error.code)
  )
}

function waitForReadRetry(delayMs: number, isCurrent: () => boolean, signal?: AbortSignal): Promise<void> {
  assertCurrent(isCurrent, signal)
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (failure?: AcpSupportExportError): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure === undefined) resolve()
      else reject(failure)
    }
    const abort = (): void => finish(new AcpSupportExportError('session-changed'))
    timer = setTimeout(() => {
      if (signal?.aborted || !isCurrent()) abort()
      else finish()
    }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted || !isCurrent()) abort()
  })
}

async function readPageWithRetry<T>(
  read: () => Promise<{ readonly ok: boolean; readonly value?: T; readonly error?: { readonly code?: string } }>,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0
  while (true) {
    assertCurrent(isCurrent, signal)
    try {
      const result = await read()
      assertCurrent(isCurrent, signal)
      return valueOf(result)
    } catch (error) {
      assertCurrent(isCurrent, signal)
      if (error instanceof AcpSupportExportError && error.code !== 'unavailable') throw error
      if (stableReadFailure(error)) throw new AcpSupportExportError('unavailable')
      const delay = supportExportReadRetryDelays[Math.min(attempt, supportExportReadRetryDelays.length - 1)]!
      attempt++
      await waitForReadRetry(delay, isCurrent, signal)
    }
  }
}

function safeAuditRow(entry: AcpAuditTimelineEntry): AcpSupportAuditRow {
  return {
    session: 'session-1',
    sequence: entry.seq,
    time: entry.time,
    kind: safeAuditKinds.has(entry.kind) ? entry.kind : 'other',
    severity: entry.severity,
    category: entry.category,
    summaryCode: entry.summaryCode,
    status: entry.status !== null && safeStatuses.has(entry.status) ? entry.status : null,
  }
}

function safeActivityRow(entry: AcpActivityView): AcpSupportActivityRow {
  return {
    session: 'session-1',
    activity: `activity-${String(entry.activitySeq)}`,
    revision: entry.revisionSeq,
    time: entry.time,
    kind: entry.kind,
    status: entry.status,
  }
}

function safeRecovery(recovery: AcpRecoveryView | undefined, capturedAt: number): AcpSupportExport['recovery'] {
  if (recovery === undefined)
    return { status: 'unavailable', capturedAt, kind: null, cause: null, localStatus: null, updatedAt: null }
  return {
    status: 'available',
    capturedAt,
    kind: recovery.kind,
    cause: recovery.cause !== null && safeRecoveryCauses.has(recovery.cause) ? recovery.cause : null,
    localStatus:
      recovery.localStatus !== undefined && safeRecoveryLocalStatuses.has(recovery.localStatus)
        ? recovery.localStatus
        : null,
    updatedAt: recovery.updatedAt,
  }
}

/** Read a fixed, bounded snapshot of safe ACP diagnostics for local preview/export. */
export async function collectAcpSupportExport(
  remote: Pick<AcpRemoteLike, 'auditTimeline' | 'activityPage' | 'recoverySnapshot'>,
  sessionId: string,
  adapterVersion: string,
  isCurrent: () => boolean = () => true,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<AcpSupportExport> {
  assertCurrent(isCurrent, signal)
  const startedAt = now()
  const auditRows: AcpSupportAuditRow[] = []
  let auditCursor = 0
  let auditScannedRecords = 0
  let auditUnreadableRecords = 0
  let auditHead: number | undefined
  let auditComplete = false
  while (auditScannedRecords < ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS) {
    assertCurrent(isCurrent, signal)
    const request = {
      afterSeq: auditCursor,
      limit: Math.min(ACP_SUPPORT_EXPORT_PAGE_SIZE, ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS - auditScannedRecords),
      ...(auditHead === undefined ? { captureSnapshot: true as const } : { snapshotHead: auditHead }),
    }
    const page = await readPageWithRetry(() => remote.auditTimeline(sessionId, request), isCurrent, signal)
    assertCurrent(isCurrent, signal)
    if (
      page.sessionId !== sessionId ||
      page.entries.length > ACP_SUPPORT_EXPORT_PAGE_SIZE ||
      page.scannedRecords === null ||
      page.scannedRecords > ACP_SUPPORT_EXPORT_PAGE_SIZE ||
      page.entries.length + page.unreadableRecords !== page.scannedRecords ||
      page.scannedThrough < auditCursor ||
      (page.hasMore && page.scannedRecords === 0)
    )
      throw new AcpSupportExportError('invalid-page')
    if (auditHead === undefined) auditHead = page.snapshotHead ?? undefined
    if (auditHead === undefined || page.snapshotHead !== auditHead) throw new AcpSupportExportError('invalid-page')
    let previousAuditSeq = auditCursor
    for (const entry of page.entries) {
      if (entry.seq <= previousAuditSeq || entry.seq > auditHead || entry.seq > page.scannedThrough)
        throw new AcpSupportExportError('invalid-page')
      previousAuditSeq = entry.seq
      if (auditRows.length < ACP_SUPPORT_EXPORT_MAX_AUDIT_ROWS) auditRows.push(safeAuditRow(entry))
    }
    auditScannedRecords += page.scannedRecords
    auditUnreadableRecords += page.unreadableRecords
    if (page.scannedThrough > auditHead) throw new AcpSupportExportError('invalid-page')
    if (!page.hasMore) {
      auditCursor = page.scannedThrough
      auditComplete = true
      break
    }
    if (page.nextCursor === null || page.nextCursor !== page.scannedThrough || page.nextCursor <= auditCursor)
      throw new AcpSupportExportError('invalid-page')
    if (page.nextCursor > auditHead) throw new AcpSupportExportError('invalid-page')
    auditCursor = page.nextCursor
  }

  const activityRows: AcpSupportActivityRow[] = []
  let activityCursor = 0
  let activityPages = 0
  let activityHead: number | undefined
  let activityComplete = false
  const maxActivityPages = Math.ceil(ACP_SUPPORT_EXPORT_MAX_ACTIVITY_ROWS / ACP_SUPPORT_EXPORT_PAGE_SIZE)
  while (activityRows.length < ACP_SUPPORT_EXPORT_MAX_ACTIVITY_ROWS && activityPages < maxActivityPages) {
    assertCurrent(isCurrent, signal)
    const request = {
      afterRevision: activityCursor,
      limit: ACP_SUPPORT_EXPORT_PAGE_SIZE,
      ...(activityHead === undefined ? { captureSnapshot: true as const } : { snapshotHead: activityHead }),
    }
    const page = await readPageWithRetry(() => remote.activityPage(sessionId, request), isCurrent, signal)
    assertCurrent(isCurrent, signal)
    activityPages += 1
    if (page.sessionId !== sessionId || page.activities.length > ACP_SUPPORT_EXPORT_PAGE_SIZE)
      throw new AcpSupportExportError('invalid-page')
    if (activityHead === undefined) activityHead = page.head
    if (page.head !== activityHead) throw new AcpSupportExportError('invalid-page')
    let previousActivityRevision = activityCursor
    for (const entry of page.activities) {
      if (entry.revisionSeq <= previousActivityRevision || entry.revisionSeq > activityHead)
        throw new AcpSupportExportError('invalid-page')
      previousActivityRevision = entry.revisionSeq
      if (activityRows.length < ACP_SUPPORT_EXPORT_MAX_ACTIVITY_ROWS) activityRows.push(safeActivityRow(entry))
    }
    if (!page.hasMore) {
      activityComplete = true
      break
    }
    if (page.nextCursor === null || page.nextCursor <= activityCursor || page.nextCursor < previousActivityRevision)
      throw new AcpSupportExportError('invalid-page')
    if (page.nextCursor > activityHead) throw new AcpSupportExportError('invalid-page')
    activityCursor = page.nextCursor
  }

  assertCurrent(isCurrent, signal)
  const recoveryCapturedAt = now()
  const recoveryResult = await remote.recoverySnapshot(sessionId)
  assertCurrent(isCurrent, signal)
  const recovery = safeRecovery(recoveryResult.ok ? recoveryResult.value : undefined, recoveryCapturedAt)
  const exportedAt = now()
  const fixedAuditHead = auditHead ?? 0
  const fixedActivityHead = activityHead ?? 0
  return {
    schema: ACP_SUPPORT_EXPORT_SCHEMA,
    schemaVersion: ACP_SUPPORT_EXPORT_SCHEMA_VERSION,
    adapterVersion,
    captureStartedAt: startedAt,
    exportedAt,
    runtimeHostVersion: null,
    sessionAlias: 'session-1',
    recovery,
    audit: {
      snapshotHead: fixedAuditHead,
      rows: auditRows,
      unreadableRecords: auditUnreadableRecords,
      storedRecordsReachedHead: auditComplete && auditCursor >= fixedAuditHead,
      truncated: !auditComplete,
      possibleHistoricalLoss: true,
    },
    activity: {
      snapshotHead: fixedActivityHead,
      rows: activityRows,
      storedRecordsReachedHead: activityComplete && (activityRows.at(-1)?.revision ?? 0) >= fixedActivityHead,
      truncated: !activityComplete,
      historicalLoss: 'unknown',
    },
    unavailable: {
      providerPromptTrace: true,
      providerUsage: true,
      nativeSessionLog: true,
      crossMemberCorrelation: true,
    },
  }
}

/** JSON filename does not contain the host session id. */
export function acpSupportExportFilename(at: number): string {
  return `dsh-acp-diagnostics-${new Date(at).toISOString().replace(/[:.]/gu, '-')}.json`
}

/** Start a local browser download in response to the user's explicit export action. */
export function downloadAcpSupportExport(value: AcpSupportExport): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = acpSupportExportFilename(value.exportedAt)
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
