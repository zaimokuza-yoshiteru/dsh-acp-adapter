/** Test-only projection of this run's isolated Devin history. Never writes raw history. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type { DevinLiveTrace } from './devin-live-trace.ts'

export const DEVIN_HISTORY_TIMEOUT_MS = 5_000
export const DEVIN_HISTORY_MAX_DATABASE_BYTES = 64 * 1024 * 1024
export const DEVIN_HISTORY_MAX_NODES = 512
export const DEVIN_HISTORY_MAX_PROJECTED_BYTES = 1024 * 1024
const MAX_CALLS = 64
const MAX_VALUE_BYTES = 64 * 1024
const labels = new Set(['lead-0', 'lead-1', 'member-0', 'member-1'])

export interface DevinHistoryScope {
  readonly isolatedRoot: string
  readonly workspace: string
  readonly sidecarPath: string
  readonly databaseRoots: readonly string[]
  readonly databasePaths: readonly string[]
  readonly actors: readonly { readonly sessionId: string; readonly label: string }[]
}

type HistoryStatus = 'captured' | 'unavailable' | 'unsupported' | 'limited' | 'timed-out'
type HistoryReason =
  | 'none'
  | 'scope-rejected'
  | 'binding-unavailable'
  | 'database-unavailable'
  | 'session-unavailable'
  | 'schema-unavailable'
  | 'history-limit'
  | 'receipt-unavailable'
  | 'worker-timeout'
  | 'worker-failed'

interface HistoryNode {
  readonly id: string
  readonly parent: string | undefined
  readonly role: 'assistant' | 'tool' | 'user' | 'system' | 'unknown'
  readonly request: string | undefined
  readonly model: string | undefined
  readonly finish: string | undefined
}
interface HistorySend {
  readonly node: string
  readonly call: string
  readonly args: Record<string, unknown>
}
interface HistoryReceipt {
  readonly node: string
  readonly call: string
  readonly content: string
}
interface HistorySession {
  readonly dshSession: string
  readonly acpSession: string
  readonly label: string
  readonly nodes: readonly HistoryNode[]
  readonly sends: readonly HistorySend[]
  readonly receipts: readonly HistoryReceipt[]
}
/** Internal worker data stays in memory; only emitDevinHistory may publish it. */
export interface DevinHistorySnapshot {
  readonly status: HistoryStatus
  readonly reason: HistoryReason
  readonly sessions: readonly HistorySession[]
}
const snapshot = (status: HistoryStatus, reason: HistoryReason): DevinHistorySnapshot => ({
  status,
  reason,
  sessions: [],
})
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const identity = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : undefined
const nodeId = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : identity(value)
const within = (root: string, value: string): boolean => {
  const path = relative(resolve(root), resolve(value))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Windows known-folder paths are admitted only for the disposable CI account. */
export function devinHistoryLocations(
  isolatedRoot: string,
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
  username: string,
): Pick<DevinHistoryScope, 'databaseRoots' | 'databasePaths'> {
  const roots = [join(isolatedRoot, 'native-data'), join(isolatedRoot, 'native-home', '.local', 'share')]
  if (platform === 'win32' && username === 'dsh-acp-ci' && environment.USERPROFILE !== undefined) {
    for (const candidate of [environment.APPDATA, environment.LOCALAPPDATA]) {
      if (candidate !== undefined && within(environment.USERPROFILE, candidate)) roots.push(candidate)
    }
    roots.push(join(environment.USERPROFILE, '.local', 'share'))
  }
  return { databaseRoots: roots, databasePaths: roots.map((root) => join(root, 'devin', 'cli', 'sessions.db')) }
}

function checkedDatabase(
  path: string,
  roots: readonly string[],
  isolatedRoot: string,
  allowDisposableWindowsProfile = false,
): DatabaseSync {
  if (!roots.some((root) => within(root, path)) || lstatSync(path).isSymbolicLink()) throw new Error('scope-rejected')
  const canonical = realpathSync(path)
  const isolation = realpathSync(isolatedRoot)
  const disposableUser = allowDisposableWindowsProfile && process.platform === 'win32' ? userInfo() : undefined
  const disposableHome = disposableUser?.username === 'dsh-acp-ci' ? disposableUser.homedir : undefined
  const allowedRoot = (root: string): boolean => {
    if (!within(root, path)) return false
    const canonicalRoot = realpathSync(root)
    if (!within(canonicalRoot, canonical)) return false
    if (within(isolation, canonicalRoot)) return true
    // Only the existing disposable account's fixed known-folder locations may
    // live outside this run's temporary root. A junction must not escape its profile.
    return (
      disposableHome !== undefined &&
      [
        join(disposableHome, 'AppData', 'Roaming'),
        join(disposableHome, 'AppData', 'Local'),
        join(disposableHome, '.local', 'share'),
      ].some((known) => relative(resolve(known), resolve(root)) === '') &&
      within(realpathSync(disposableHome), canonicalRoot)
    )
  }
  if (!roots.some(allowedRoot)) throw new Error('scope-rejected')
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error('scope-rejected')
      if (statSync(file).size > DEVIN_HISTORY_MAX_DATABASE_BYTES) throw new Error('history-limit')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const database = new DatabaseSync(canonical, { readOnly: true })
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250')
  return database
}

/** Run only in the bounded worker, or with an entirely synthetic database in unit tests. */
export function readDevinHistory(scope: DevinHistoryScope): DevinHistorySnapshot {
  if (
    scope.actors.length === 0 ||
    scope.actors.length > 4 ||
    new Set(scope.actors.map((actor) => actor.sessionId)).size !== scope.actors.length ||
    scope.actors.some((actor) => identity(actor.sessionId) === undefined || !labels.has(actor.label)) ||
    resolve(scope.workspace) !== join(resolve(scope.isolatedRoot), 'workspace') ||
    !within(scope.isolatedRoot, scope.sidecarPath) ||
    scope.databasePaths.length > 5 ||
    scope.databaseRoots.length > 5
  )
    return snapshot('unavailable', 'scope-rejected')
  const selected: Array<{ dshSession: string; acpSession: string; label: string }> = []
  let sidecar: DatabaseSync | undefined
  try {
    sidecar = checkedDatabase(scope.sidecarPath, [scope.isolatedRoot], scope.isolatedRoot)
    const lookup = sidecar.prepare(
      'SELECT acp_session_id FROM bindings WHERE dsh_session_id = ? AND acp_provider_id = ?',
    )
    for (const actor of scope.actors) {
      const row = lookup.get(actor.sessionId, 'acp-devin')
      const acpSession = identity(row?.acp_session_id)
      if (acpSession === undefined) return snapshot('unavailable', 'binding-unavailable')
      selected.push({ dshSession: actor.sessionId, acpSession, label: actor.label })
    }
    if (new Set(selected.map((actor) => actor.acpSession)).size !== selected.length)
      return snapshot('unavailable', 'binding-unavailable')
  } catch {
    return snapshot('unavailable', 'binding-unavailable')
  } finally {
    sidecar?.close()
  }
  const sessions: HistorySession[] = []
  let status: HistoryStatus = 'unavailable'
  let reason: HistoryReason = 'database-unavailable'
  for (const path of scope.databasePaths) {
    let database: DatabaseSync | undefined
    try {
      database = checkedDatabase(path, scope.databaseRoots, scope.isolatedRoot, true)
      reason = 'session-unavailable'
      for (const actor of selected) {
        if (sessions.some((session) => session.acpSession === actor.acpSession)) continue
        const session = database.prepare('SELECT working_directory FROM sessions WHERE id = ?').get(actor.acpSession)
        if (session === undefined) continue
        if (
          typeof session.working_directory !== 'string' ||
          !isAbsolute(session.working_directory) ||
          ![resolve(scope.workspace), realpathSync(scope.workspace)].some(
            (expected) => relative(expected, resolve(session.working_directory as string)) === '',
          )
        )
          return snapshot('unavailable', 'scope-rejected')
        const oversized = database
          .prepare('SELECT 1 FROM message_nodes WHERE session_id = ? AND length(chat_message) > ? LIMIT 1')
          .get(actor.acpSession, DEVIN_HISTORY_MAX_PROJECTED_BYTES)
        if (oversized !== undefined) return snapshot('limited', 'history-limit')
        // Do not select chat_message itself: prompts, reasoning and ordinary output stay inside SQLite.
        const rawNodes = database
          .prepare(
            `SELECT node_id, parent_node_id,
            json_extract(chat_message, '$.role') AS role,
            json_extract(chat_message, '$.metadata.request_id') AS request_id,
            json_extract(chat_message, '$.metadata.generation_model') AS model,
            json_extract(chat_message, '$.metadata.finish_reason') AS finish
            FROM message_nodes WHERE session_id = ? ORDER BY node_id LIMIT ?`,
          )
          .all(actor.acpSession, DEVIN_HISTORY_MAX_NODES + 1)
        if (rawNodes.length > DEVIN_HISTORY_MAX_NODES) return snapshot('limited', 'history-limit')
        const nodes: HistoryNode[] = rawNodes.map((node) => ({
          id: nodeId(node.node_id) ?? '',
          parent: nodeId(node.parent_node_id),
          role: ['assistant', 'tool', 'user', 'system'].includes(String(node.role))
            ? (node.role as HistoryNode['role'])
            : 'unknown',
          request: identity(node.request_id),
          model: identity(node.model),
          finish: identity(node.finish),
        }))
        if (nodes.length === 0) continue
        if (nodes.some((node) => node.id === '') || new Set(nodes.map((node) => node.id)).size !== nodes.length)
          return snapshot('unsupported', 'schema-unavailable')
        for (const node of nodes) {
          const seen = new Set<string>()
          let current: HistoryNode | undefined = node
          while (current !== undefined) {
            if (seen.has(current.id)) return snapshot('unsupported', 'schema-unavailable')
            seen.add(current.id)
            current = nodes.find((candidate) => candidate.id === current?.parent)
          }
        }
        const rawSends = database
          .prepare(
            `SELECT mn.node_id, json_extract(tc.value, '$.id') AS call_id,
            json_extract(tc.value, '$.arguments.arguments') AS arguments
            FROM message_nodes mn, json_each(mn.chat_message, '$.tool_calls') tc
            WHERE mn.session_id = ? AND json_extract(mn.chat_message, '$.role') = 'assistant'
            AND json_extract(tc.value, '$.arguments.tool_name') = 'send_message' LIMIT ?`,
          )
          .all(actor.acpSession, MAX_CALLS + 1)
        if (rawSends.length > MAX_CALLS) return snapshot('limited', 'history-limit')
        const sends: HistorySend[] = []
        for (const send of rawSends) {
          if (typeof send.arguments !== 'string') return snapshot('unsupported', 'schema-unavailable')
          if (Buffer.byteLength(send.arguments) > MAX_VALUE_BYTES) return snapshot('limited', 'history-limit')
          const args: unknown = JSON.parse(send.arguments)
          const call = identity(send.call_id)
          const node = nodeId(send.node_id)
          if (
            call === undefined ||
            node === undefined ||
            !record(args) ||
            typeof args.target !== 'string' ||
            typeof args.message !== 'string'
          )
            return snapshot('unsupported', 'schema-unavailable')
          sends.push({ node, call, args })
        }
        if (new Set(sends.map((send) => send.call)).size !== sends.length)
          return snapshot('unsupported', 'schema-unavailable')
        const receipts: HistoryReceipt[] = []
        const receiptQuery = database.prepare(`SELECT node_id,
          json_extract(chat_message, '$.content') AS content
          FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.role') = 'tool'
          AND json_extract(chat_message, '$.tool_call_id') = ? LIMIT 2`)
        for (const send of sends) {
          const matches = receiptQuery.all(actor.acpSession, send.call)
          if (matches.length !== 1) continue
          const receipt = matches[0]!
          const node = nodeId(receipt.node_id)
          if (node === undefined || typeof receipt.content !== 'string') continue
          if (Buffer.byteLength(receipt.content) > MAX_VALUE_BYTES) return snapshot('limited', 'history-limit')
          // A result joins only to the exact call and its actual parent node.
          if (!nodes.some((candidate) => candidate.id === node && candidate.parent === send.node)) continue
          receipts.push({ node, call: send.call, content: receipt.content })
        }
        sessions.push({ ...actor, nodes, sends, receipts })
        if (Buffer.byteLength(JSON.stringify(sessions)) > DEVIN_HISTORY_MAX_PROJECTED_BYTES)
          return snapshot('limited', 'history-limit')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof Error && error.message === 'scope-rejected') {
          status = 'unavailable'
          reason = 'scope-rejected'
        } else {
          status = error instanceof Error && error.message === 'history-limit' ? 'limited' : 'unsupported'
          reason = status === 'limited' ? 'history-limit' : 'schema-unavailable'
        }
      }
    } finally {
      database?.close()
    }
  }
  if (sessions.length !== selected.length) return { status, reason, sessions }
  const sendCount = sessions.reduce((total, session) => total + session.sends.length, 0)
  const receiptCount = sessions.reduce((total, session) => total + session.receipts.length, 0)
  if (
    sendCount === 0 ||
    sessions.some((session) =>
      session.sends.some((send) => session.nodes.find((node) => node.id === send.node)?.request === undefined),
    )
  )
    return { status: 'unsupported', reason: 'schema-unavailable', sessions }
  return {
    status: sendCount === receiptCount ? 'captured' : 'unavailable',
    reason: sendCount === receiptCount ? 'none' : 'receipt-unavailable',
    sessions,
  }
}

export async function collectDevinHistory(
  scope: DevinHistoryScope,
  timeoutMs = DEVIN_HISTORY_TIMEOUT_MS,
): Promise<DevinHistorySnapshot> {
  return await new Promise((resolveCapture) => {
    const worker = new Worker(new URL('./devin-live-history-worker.ts', import.meta.url), {
      workerData: scope,
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (result: DevinHistorySnapshot): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().then(
        () => resolveCapture(result),
        () => resolveCapture(snapshot('unsupported', 'worker-failed')),
      )
    }
    const timer = setTimeout(() => finish(snapshot('timed-out', 'worker-timeout')), Math.min(timeoutMs, 5_000))
    worker.once('message', (result: DevinHistorySnapshot) => finish(result))
    worker.once('error', () => finish(snapshot('unsupported', 'worker-failed')))
    worker.once('exit', () => finish(snapshot('unsupported', 'worker-failed')))
  })
}

const sendStatus = (content: string): 'sent' | 'queued' | 'accepted' | 'unknown' => {
  try {
    const value: unknown = JSON.parse(content)
    if (!record(value)) return 'unknown'
    if (value.sent === true) return 'sent'
    return value.status === 'queued' || value.status === 'accepted' ? value.status : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The only output path: known enums/booleans/counts and this trace's per-run HMACs. */
export function emitDevinHistory(trace: DevinLiveTrace, result: DevinHistorySnapshot): void {
  let sends = 0
  let receipts = 0
  let nodes = 0
  for (const session of result.sessions) {
    const base = {
      sessionId: trace.id('dsh-session', session.dshSession),
      acpSessionId: trace.id('acp-session', session.acpSession),
      actorLabel: session.label,
      actorRole: session.label.startsWith('member-') ? 'teammate' : 'lead',
      historySource: 'isolated-sqlite',
      clientReceiptStatus: 'unavailable',
    }
    const id = (node: string | undefined): string =>
      node === undefined ? 'unavailable' : trace.id('devin-history-node', { session: session.acpSession, node })
    for (const node of session.nodes) {
      nodes += 1
      trace.record('devin-history/node', {
        ...base,
        historyNodeId: id(node.id),
        historyParentNodeId: id(node.parent),
        historyRole: node.role,
        providerModelCallId: trace.id('devin-generation-request', node.request),
        model: node.model === 'swe-2-high' ? 'swe-2-high' : 'other',
        historyFinishReason: node.finish === 'tool_calls' ? 'tool_calls' : 'unknown',
      })
    }
    for (const send of session.sends) {
      sends += 1
      const node = session.nodes.find((candidate) => candidate.id === send.node)
      const parent = session.receipts.find((candidate) => candidate.node === node?.parent)
      const previous = parent === undefined ? undefined : session.sends.find((call) => call.call === parent.call)
      const previousNode = session.nodes.find((candidate) => candidate.id === previous?.node)
      const args = trace.fingerprint('host-tool-arguments', send.args)
      const previousArgs = previous === undefined ? undefined : trace.fingerprint('host-tool-arguments', previous.args)
      trace.record('devin-history/send', {
        ...base,
        tool: 'send_message',
        historyNodeId: id(send.node),
        historyParentNodeId: id(node?.parent),
        historyToolCallId: trace.id('devin-history-tool-call', send.call),
        providerModelCallId: trace.id('devin-generation-request', node?.request),
        historyParentRequestId: trace.id('devin-generation-request', previousNode?.request),
        model: node?.model === 'swe-2-high' ? 'swe-2-high' : 'other',
        historyFinishReason: node?.finish === 'tool_calls' ? 'tool_calls' : 'unknown',
        argsHmac: args.hmac,
        argsBytes: args.bytes,
        argsFingerprintComplete: args.complete,
        bodyHmac: trace.fingerprint('team-message-body', send.args.message).hmac,
        historyParentIsReceipt: parent !== undefined,
        historyParentReceiptSaysSent: parent !== undefined && sendStatus(parent.content) !== 'unknown',
        historyDistinctRequests:
          node?.request !== undefined && previousNode?.request !== undefined
            ? node.request !== previousNode.request
            : null,
        historySameArguments: previousArgs?.complete === true && args.complete ? previousArgs.hmac === args.hmac : null,
      })
    }
    for (const receipt of session.receipts) {
      receipts += 1
      const content = trace.fingerprint('devin-history-tool-result', receipt.content)
      trace.record('devin-history/receipt', {
        ...base,
        historyNodeId: id(receipt.node),
        historyParentNodeId: id(session.nodes.find((node) => node.id === receipt.node)?.parent),
        historyToolCallId: trace.id('devin-history-tool-call', receipt.call),
        historyReceiptStatus: 'stored',
        sendStatus: sendStatus(receipt.content),
        historyResultHmac: content.hmac,
        historyResultBytes: content.bytes,
      })
    }
  }
  trace.record('devin-history/status', {
    historyStatus: result.status,
    historyReason: result.reason,
    historySessionCount: result.sessions.length,
    historyNodeCount: nodes,
    historySendCount: sends,
    historyReceiptCount: receipts,
    historySource: 'isolated-sqlite',
    clientReceiptStatus: 'unavailable',
  })
}
