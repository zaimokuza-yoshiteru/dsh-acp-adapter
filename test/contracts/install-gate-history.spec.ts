import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const NONCE = 'dsh-install-gate-native-ok'

describe('install-gate structured assertions', () => {
  it('parses rc.2 event wrappers, chooses final seq, and checks final assistant/message', () => {
    const event = (type: string, seq: number, data: Record<string, unknown>) => ({ event: { type, seq, data } })
    const base = { result: { ok: true, value: {
      events: [
        event('assistant/message', 4, { turn: 1, message: { content: [{ type: 'text', text: 'old nonce' }] } }),
        event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
        event('assistant/message', 8, { turn: 2, message: { content: [{ type: 'text', text: 'first final' }] } }),
        event('assistant/message', 9, { turn: 2, message: { content: [{ type: 'text', text: `prefix ${NONCE} suffix` }] } }),
        event('turn/end', 10, { turn: 2, reason: { kind: 'completed' } }),
      ],
      hasMore: false,
      projections: {},
    } } }
    const invoke = (payload: unknown) => spawnSync('node', ['scripts/install-gate-history.mjs', NONCE], {
      cwd: path.resolve(import.meta.dirname, '..', '..'), input: JSON.stringify(payload), encoding: 'utf8',
    }).status === 0
    const statusOf = (payload: unknown) => spawnSync('node', ['scripts/install-gate-history.mjs', '--status', NONCE], {
      cwd: path.resolve(import.meta.dirname, '..', '..'), input: JSON.stringify(payload), encoding: 'utf8',
    }).stdout.trim()
    expect(invoke(base)).toBe(true)
    expect(statusOf(base)).toBe('pass')
    expect(statusOf({ result: { ok: true, value: { events: [], hasMore: true, projections: {} } } })).toBe('pending')
    expect(invoke({ ...base, result: { ok: true, value: {
      ...base.result.value,
      events: [...base.result.value.events, { event: { type: 'turn/end', seq: 11, data: { turn: 3, reason: { kind: 'error', message: NONCE } } } }],
    } } })).toBe(false)
    expect(statusOf({ result: { ok: true, value: {
      ...base.result.value,
      events: [...base.result.value.events, { event: { type: 'turn/end', seq: 12, data: { turn: 3, reason: { kind: 'error', code: 'MISSING_CREDENTIAL' } } } }],
    } } })).toBe('missing-credential')
    expect(invoke({ ...base, result: { ok: true, value: {
      ...base.result.value,
      events: base.result.value.events.map((entry) => entry.event.type === 'assistant/message' && (entry.event.data as { turn?: number }).turn === 2
        ? { event: { ...entry.event, data: { ...(entry.event.data as Record<string, unknown>), message: { content: [{ type: 'text', text: 'not nonce' }] } } } }
        : entry),
    } } })).toBe(false)
    // Out-of-order array position is fine when seq identifies the final turn.
    expect(invoke({ ...base, result: { ok: true, value: {
      ...base.result.value, events: [...base.result.value.events].reverse(),
    } } })).toBe(true)
    // Missing/invalid wrappers and the old projection shape must not pass.
    expect(invoke({ result: { ok: true, value: { events: [{ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }] } } })).toBe(false)
    expect(invoke({ result: { ok: true, value: { turnEnd: [{ turn: 2, reason: { kind: 'completed' } }] } } })).toBe(false)
    expect(invoke({ ...base, result: { ok: false, error: { message: NONCE } } })).toBe(false)
  })

  it('credential canary keeps a random secret out of streams and the saved artifact', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-install-gate-canary-'))
    const secret = `canary-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      const result = spawnSync('bash', ['scripts/install-gate.sh', '--self-test'], {
        cwd: path.resolve(import.meta.dirname, '..', '..'),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DEEPSEEK_API_KEY: secret, DSH_ACP_GATE_ROOT: root },
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain(secret)
      expect(result.stderr).not.toContain(secret)
      const artifact = readFileSync(path.join(root, 'install-gate-self-test.log'), 'utf8')
      expect(artifact).not.toContain(secret)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('native regression artifact stores metadata only, never the raw session history', () => {
    const script = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'install-gate.sh'), 'utf8')
    expect(script).toContain("printf 'sessionId=%s\\nstatus=%s\\ncredentialState=%s\\npolls=%s\\n'")
    expect(script).not.toContain('--- history ---')
    expect(script).not.toMatch(/\$hist[^\n]*>\s*"\$out"/)
  })

  it('native status reporting is mutually exclusive and rejects pending', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-install-gate-reporter-'))
    const invokeReporter = (status: string) => spawnSync('bash', ['-c', `source scripts/install-gate.sh; report_native_regression_status "$1" /tmp/gate-evidence`, 'report', status], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DSH_ACP_GATE_ROOT: root },
      encoding: 'utf8',
    })
    try {
      const pass = invokeReporter('pass')
      expect(pass.status).toBe(0)
      expect(pass.stdout).toContain('含真实 LLM 往返')
      expect(pass.stdout).not.toContain('MISSING_CREDENTIAL')
      const missing = invokeReporter('missing-credential')
      expect(missing.status).toBe(0)
      expect(missing.stdout).toContain('MISSING_CREDENTIAL')
      expect(missing.stdout).not.toContain('真实 LLM 往返')
      const pending = invokeReporter('pending')
      expect(pending.status).not.toBe(0)
      expect(pending.stdout).not.toContain('含真实 LLM 往返')
      expect(pending.stdout).not.toContain('MISSING_CREDENTIAL')
      expect(pending.stderr).toContain('90s 内未观察到终态')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
