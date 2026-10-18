import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectDevinHistory,
  DEVIN_HISTORY_MAX_DATABASE_BYTES,
  DEVIN_HISTORY_MAX_NODES,
  devinHistoryLocations,
  emitDevinHistory,
  readDevinHistory,
  type DevinHistoryScope,
} from '../../../scripts/devin-live-history.ts'
import { DevinLiveTrace } from '../../../scripts/devin-live-trace.ts'

const roots: string[] = []
const rawMarker = 'PRIVATE-SYNTHETIC-MARKER'
const secret = 'NEVER-PUBLISH-PROMPT-REASONING-CREDENTIAL-SENTINEL'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devin-history-test-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const data = join(root, 'native-data')
  const databasePath = join(data, 'devin', 'cli', 'sessions.db')
  const sidecarPath = join(root, 'sidecar.sqlite')
  mkdirSync(workspace)
  mkdirSync(join(data, 'devin', 'cli'), { recursive: true })
  const sidecar = new DatabaseSync(sidecarPath)
  sidecar.exec('CREATE TABLE bindings(dsh_session_id TEXT, acp_provider_id TEXT, acp_session_id TEXT)')
  sidecar.prepare('INSERT INTO bindings VALUES(?, ?, ?)').run('private-dsh-id', 'acp-devin', 'private-acp-id')
  sidecar.close()
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE sessions(id TEXT, working_directory TEXT);
    CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);`)
  database.prepare('INSERT INTO sessions VALUES(?, ?)').run('private-acp-id', workspace)
  database.close()
  const scope: DevinHistoryScope = {
    isolatedRoot: root,
    workspace,
    sidecarPath,
    databaseRoots: [data],
    databasePaths: [databasePath],
    actors: [{ sessionId: 'private-dsh-id', label: 'member-0' }],
  }
  const insert = (id: number, parent: number | null, message: unknown, session = 'private-acp-id') => {
    const writer = new DatabaseSync(databasePath)
    writer
      .prepare('INSERT INTO message_nodes VALUES(?, ?, ?, ?)')
      .run(session, id, parent, typeof message === 'string' ? message : JSON.stringify(message))
    writer.close()
  }
  const generation = (id: number, parent: number, request: string, call: string) =>
    insert(id, parent, {
      role: 'assistant',
      content: secret,
      reasoning: secret,
      metadata: { request_id: request, generation_model: 'swe-2-high', finish_reason: 'tool_calls' },
      tool_calls: [
        { id: call, arguments: { tool_name: 'send_message', arguments: { target: 'lead', message: rawMarker } } },
      ],
    })
  const receipt = (
    id: number,
    parent: number,
    call: string,
    content = JSON.stringify({ sent: true, private: secret }),
  ) => insert(id, parent, { role: 'tool', tool_call_id: call, content, reasoning: secret })
  const populate = () => {
    insert(1, null, { role: 'user', content: secret })
    generation(2, 1, 'private-request-one', 'private-call-one')
    receipt(3, 2, 'private-call-one')
    generation(4, 3, 'private-request-two', 'private-call-two')
    receipt(5, 4, 'private-call-two', 'Cancelled by test guard')
  }
  return { root, scope, insert, generation, receipt, populate, databasePath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('isolated Devin history evidence', () => {
  it('joins exact test bindings, successful stored receipt and a distinct child generation without publishing raw data', () => {
    const test = fixture()
    test.populate()
    // Poisoned unrelated history must never be parsed, even in this disposable database.
    test.insert(1, null, 'not-json-private-history', 'unrelated-session')
    const result = readDevinHistory(test.scope)
    expect(result).toMatchObject({ status: 'captured', reason: 'none' })
    expect(result.sessions).toHaveLength(1)
    const trace = new DevinLiveTrace({ directory: join(test.root, 'safe-trace'), key: Buffer.alloc(32, 8) })
    emitDevinHistory(trace, result)
    trace.finish('pass', {})
    const text = readFileSync(trace.filePath, 'utf8')
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const sends = rows.filter((row) => row.event === 'devin-history/send')
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({
      actorLabel: 'member-0',
      model: 'swe-2-high',
      historyFinishReason: 'tool_calls',
      historyParentIsReceipt: true,
      historyParentReceiptSaysSent: true,
      historyDistinctRequests: true,
      historySameArguments: true,
      clientReceiptStatus: 'unavailable',
    })
    expect(sends[0]?.providerModelCallId).not.toBe(sends[1]?.providerModelCallId)
    expect(sends[0]?.providerModelCallId).toBe(sends[1]?.historyParentRequestId)
    expect(sends[0]?.argsHmac).toBe(sends[1]?.argsHmac)
    const stored = rows.find((row) => row.event === 'devin-history/receipt')
    expect(stored).toMatchObject({
      historyReceiptStatus: 'stored',
      sendStatus: 'sent',
      clientReceiptStatus: 'unavailable',
    })
    expect(sends[0]?.historyToolCallId).toBe(stored?.historyToolCallId)
    expect(sends[1]?.historyParentNodeId).toBe(stored?.historyNodeId)
    for (const privateValue of [
      rawMarker,
      secret,
      'private-acp-id',
      'private-dsh-id',
      'private-request',
      'private-call',
      'not-json',
    ])
      expect(text).not.toContain(privateValue)
  })

  it('does not claim a receipt when the tool result has the wrong call identity or parent', () => {
    for (const mismatch of ['call', 'parent'] as const) {
      const test = fixture()
      test.insert(1, null, { role: 'user', content: secret })
      test.generation(2, 1, 'private-request', 'private-call')
      test.receipt(3, mismatch === 'parent' ? 1 : 2, mismatch === 'call' ? 'other-call' : 'private-call')
      const result = readDevinHistory(test.scope)
      expect(result).toMatchObject({ status: 'unavailable', reason: 'receipt-unavailable' })
      expect(result.sessions[0]?.receipts).toEqual([])
    }
  })

  it('does not invent generation identities or read unbound and foreign-workspace sessions', () => {
    const test = fixture()
    test.populate()
    expect(
      readDevinHistory({ ...test.scope, actors: [{ sessionId: 'other-dsh-session', label: 'member-0' }] }),
    ).toMatchObject({ status: 'unavailable', reason: 'binding-unavailable', sessions: [] })
    const writer = new DatabaseSync(test.databasePath)
    writer.prepare('UPDATE sessions SET working_directory = ?').run(join(test.root, 'another-workspace'))
    writer.close()
    expect(readDevinHistory(test.scope)).toMatchObject({
      status: 'unavailable',
      reason: 'scope-rejected',
      sessions: [],
    })
  })

  it('rejects a missing generation identity, cyclic parents and ambiguous reused tool IDs', () => {
    const missing = fixture()
    missing.insert(1, null, {
      role: 'assistant',
      tool_calls: [
        { id: 'call', arguments: { tool_name: 'send_message', arguments: { target: 'lead', message: rawMarker } } },
      ],
    })
    missing.receipt(2, 1, 'call')
    expect(readDevinHistory(missing.scope)).toMatchObject({ status: 'unsupported', reason: 'schema-unavailable' })
    const cycle = fixture()
    cycle.generation(1, 2, 'request', 'call')
    cycle.receipt(2, 1, 'call')
    expect(readDevinHistory(cycle.scope)).toMatchObject({ status: 'unsupported', reason: 'schema-unavailable' })
    const duplicate = fixture()
    duplicate.insert(1, null, { role: 'user', content: secret })
    duplicate.generation(2, 1, 'request1', 'same-call')
    duplicate.receipt(3, 2, 'same-call')
    duplicate.generation(4, 3, 'request2', 'same-call')
    expect(readDevinHistory(duplicate.scope)).toMatchObject({ status: 'unsupported', reason: 'schema-unavailable' })
  })

  it('marks absent and unsupported databases explicitly rather than reporting capture success', () => {
    const test = fixture()
    rmSync(test.databasePath)
    expect(readDevinHistory(test.scope)).toMatchObject({ status: 'unavailable', reason: 'database-unavailable' })
    const database = new DatabaseSync(test.databasePath)
    database.exec('CREATE TABLE unsupported(value TEXT)')
    database.close()
    expect(readDevinHistory(test.scope)).toMatchObject({ status: 'unsupported', reason: 'schema-unavailable' })
  })

  it('does not open a database outside the test-owned locations', () => {
    const own = fixture()
    const foreign = fixture()
    foreign.populate()
    expect(readDevinHistory({ ...own.scope, databasePaths: [foreign.databasePath] })).toMatchObject({
      status: 'unavailable',
      reason: 'scope-rejected',
      sessions: [],
    })
  })

  it('rejects a database root or parent directory link escaping the isolated root', () => {
    for (const replaceRoot of [true, false]) {
      const own = fixture()
      const foreign = fixture()
      foreign.populate()
      // Make every database/session check otherwise valid, so this specifically
      // proves filesystem containment rather than merely rejecting a foreign cwd.
      const writer = new DatabaseSync(foreign.databasePath)
      writer.prepare('UPDATE sessions SET working_directory = ?').run(own.scope.workspace)
      writer.close()
      const ownLinked = join(own.root, 'native-data', ...(replaceRoot ? [] : ['devin']))
      const foreignTarget = join(foreign.root, 'native-data', ...(replaceRoot ? [] : ['devin']))
      rmSync(ownLinked, { recursive: true })
      symlinkSync(foreignTarget, ownLinked, process.platform === 'win32' ? 'junction' : 'dir')
      expect(readDevinHistory(own.scope)).toMatchObject({
        status: 'unavailable',
        reason: 'scope-rejected',
        sessions: [],
      })
    }
  })

  it('limits nodes, selected bytes and database bytes without silently returning partial success', () => {
    const nodes = fixture()
    for (let id = 0; id <= DEVIN_HISTORY_MAX_NODES; id++) nodes.insert(id, null, { role: 'user', content: '' })
    expect(readDevinHistory(nodes.scope)).toMatchObject({ status: 'limited', reason: 'history-limit' })
    const value = fixture()
    value.insert(1, null, { role: 'user', content: secret })
    value.generation(2, 1, 'request', 'call')
    value.receipt(3, 2, 'call', 'x'.repeat(70_000))
    expect(readDevinHistory(value.scope)).toMatchObject({ status: 'limited', reason: 'history-limit' })
    const database = fixture()
    truncateSync(database.databasePath, DEVIN_HISTORY_MAX_DATABASE_BYTES + 1)
    expect(readDevinHistory(database.scope)).toMatchObject({ status: 'limited', reason: 'history-limit' })
    const projection = fixture()
    projection.insert(1, null, { role: 'user', content: secret })
    for (let call = 0; call < 18; call++) {
      const node = 2 + call * 2
      projection.insert(node, node - 1, {
        role: 'assistant',
        metadata: { request_id: `request-${call}` },
        tool_calls: [
          {
            id: `call-${call}`,
            arguments: { tool_name: 'send_message', arguments: { target: 'lead', message: 'x'.repeat(60_000) } },
          },
        ],
      })
      projection.receipt(node + 1, node, `call-${call}`)
    }
    expect(readDevinHistory(projection.scope)).toMatchObject({ status: 'limited', reason: 'history-limit' })
  })

  it('reads entirely synthetic history through the real worker and enforces its deadline', async () => {
    const test = fixture()
    test.populate()
    expect(await collectDevinHistory(test.scope)).toMatchObject({ status: 'captured' })
    expect(await collectDevinHistory(test.scope, 0)).toMatchObject({ status: 'timed-out', reason: 'worker-timeout' })
  })

  it('admits Windows profile locations only for the disposable ordinary CI account', () => {
    const test = fixture()
    const profile = join(test.root, 'disposable-profile')
    const env = { USERPROFILE: profile, APPDATA: join(profile, 'Roaming'), LOCALAPPDATA: join(profile, 'Local') }
    expect(devinHistoryLocations(test.root, 'win32', env, 'personal-user').databaseRoots).not.toContain(env.APPDATA)
    const accepted = devinHistoryLocations(test.root, 'win32', env, 'dsh-acp-ci')
    expect(accepted.databaseRoots).toContain(env.APPDATA)
    expect(accepted.databasePaths).toContain(join(env.APPDATA, 'devin', 'cli', 'sessions.db'))
    expect(
      devinHistoryLocations(test.root, 'win32', { ...env, APPDATA: '/unrelated-user' }, 'dsh-acp-ci').databaseRoots,
    ).not.toContain('/unrelated-user')
  })
})
