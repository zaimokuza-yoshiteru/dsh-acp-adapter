import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLiveActivitySummary, safeLiveDiagnostic, safeSpawnDiagnostic } from '../../../scripts/live-diagnostics.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('live Devin diagnostics', () => {
  it('keeps only structured error codes and protocol facts', () => {
    const diagnostic = safeLiveDiagnostic({
      code: 'ACP_PROMPT_FAILED',
      info: { code: 'TEAM_MEMBER_NOT_FOUND' },
      message: 'DO_NOT_LOG_PROMPT_SECRET JSON-RPC code 42',
    })
    expect(diagnostic).toEqual({ code: 'ACP_PROMPT_FAILED', toolCode: 'TEAM_MEMBER_NOT_FOUND', jsonRpcCode: 42 })
    expect(JSON.stringify(diagnostic)).not.toContain('DO_NOT_LOG_PROMPT_SECRET')
    expect(safeLiveDiagnostic({ info: { code: 'PASSWORD_SECRET_CODE' }, message: 'AUTH_TOKEN_SECRET' })).toEqual({ toolCode: 'other' })
  })

  it('summarizes spawn intent without retaining title, prompt, or other arguments', () => {
    const prompt = 'Please use send_message with expected marker MARKER_SECRET'
    const diagnostic = safeSpawnDiagnostic({
      name: 'TITLE_SECRET', description: 'DESCRIPTION_SECRET', prompt, context: 'fresh',
      unrelated: 'ARGUMENT_SECRET',
    }, 'MARKER_SECRET')
    expect(diagnostic).toEqual({ promptPresent: true, hasExpectedMarker: true, requestsSendMessage: true, context: 'fresh' })
    expect(JSON.stringify(diagnostic)).not.toMatch(/TITLE_SECRET|DESCRIPTION_SECRET|MARKER_SECRET|ARGUMENT_SECRET|send_message/u)
    expect(safeSpawnDiagnostic({ prompt, context: 'fork' }, undefined)).toEqual({
      promptPresent: true, hasExpectedMarker: false, requestsSendMessage: true, context: 'other',
    })
  })

  it('reads only bounded aggregate facts from SQLite and hides titles and raw arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-diagnostics-'))
    directories.push(directory)
    const path = join(directory, 'sidecar.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`CREATE TABLE activity_journal (
      dsh_session_id TEXT NOT NULL, revision_seq INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, presentation TEXT NOT NULL, raw_detail TEXT
    )`)
    const insert = database.prepare('INSERT INTO activity_journal VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('known-session', 1, 'tool', 'completed', 'send_message', JSON.stringify({
      toolName: 'send_message', rawInput: { message: 'ARGUMENT_SECRET' },
    }))
    insert.run('known-session', 2, 'tool', 'untrusted-status', 'send_message', '{RAW_DETAIL_SECRET')
    insert.run('known-session', 3, 'tool', 'running', 'TITLE_SECRET', JSON.stringify({ rawInput: { message: 'ARGUMENT_SECRET' } }))
    for (let revision = 4; revision <= 66; revision += 1) {
      insert.run('known-session', revision, 'other', 'running', 'OTHER_TITLE_SECRET', null)
    }
    database.close()

    const summary = readLiveActivitySummary(path, 'known-session')
    expect(summary).toEqual({
      available: true,
      activityRows: 64,
      truncated: true,
      toolStatuses: { running: 1, completed: 1, failed: 0, cancelled: 0, other: 1 },
      toolNames: { spawn_teammate: 0, send_message: 1, list_agents: 0, other: 2 },
    })
    expect(JSON.stringify(summary)).not.toMatch(/ARGUMENT_SECRET|TITLE_SECRET|RAW_DETAIL_SECRET/u)
    const check = new DatabaseSync(path, { readOnly: true })
    try { expect(check.prepare('SELECT COUNT(*) AS count FROM activity_journal').get()).toMatchObject({ count: 66 }) }
    finally { check.close() }
  })
})
