#!/usr/bin/env node
/**
 * Structured native install-gate assertion.  The gate feeds session.history
 * through stdin; this module intentionally never prints the history payload.
 * It accepts the rc.2 host result envelope.  `session.history` returns a value
 * shaped as `{events, hasMore, projections}`, where each event is wrapped as
 * `{event:{type,seq,data}}`; the wrapper is deliberately checked so an
 * unrelated projection or arbitrary string cannot make the gate green.
 */

function historyValueOf(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  const result = payload.result
  if (!result || typeof result !== 'object' || result.ok !== true) return undefined
  const value = result.value
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) return undefined
  return value
}

function eventEntriesOf(value) {
  return value.events
    .map((entry) => entry && typeof entry === 'object' ? entry.event : undefined)
    .filter((event) => event && typeof event === 'object' && Number.isInteger(event.seq) && typeof event.type === 'string')
}

function assistantText(event) {
  const data = event.data
  const message = data && typeof data === 'object' ? data.message : undefined
  const content = message && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function hasMarker(value, marker) {
  if (value === marker) return true
  if (Array.isArray(value)) return value.some((item) => hasMarker(item, marker))
  if (value && typeof value === 'object') return Object.values(value).some((item) => hasMarker(item, marker))
  return false
}

/** `pending` keeps the shell gate polling; terminal states never expose history. */
export function nativeHistoryStatus(payload, expectedNonce) {
  if (typeof expectedNonce !== 'string' || expectedNonce.length === 0) return 'fail'
  const history = historyValueOf(payload)
  if (history === undefined) return 'fail'
  const events = eventEntriesOf(history)
  const ends = events
    .filter((event) => event.type === 'turn/end' && event.data && typeof event.data === 'object')
    .filter((event) => Number.isInteger(event.data.turn) && event.data.reason && typeof event.data.reason === 'object')
  if (ends.length === 0) return 'pending'
  const target = ends.reduce((latest, event) => event.seq >= latest.seq ? event : latest)
  if (target.data.reason.kind !== 'completed') {
    return hasMarker(target.data.reason, 'MISSING_CREDENTIAL') ? 'missing-credential' : 'fail'
  }
  const targetTurn = target.data.turn
  const assistants = events
    .filter((event) => event.type === 'assistant/message' && event.data && typeof event.data === 'object')
    .filter((event) => event.data.turn === targetTurn)
  const final = assistants.length === 0
    ? undefined
    : assistants.slice(1).reduce((latest, event) => event.seq >= latest.seq ? event : latest, assistants[0])
  if (final === undefined) return 'fail'
  const text = assistantText(final)
  return text === expectedNonce || text.includes(expectedNonce) ? 'pass' : 'fail'
}

/** Return a boolean so tests can exercise all error/success branches without I/O. */
export function nativeHistoryCompletedWithNonce(payload, expectedNonce) {
  return nativeHistoryStatus(payload, expectedNonce) === 'pass'
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const statusMode = process.argv[2] === '--status'
  const expectedNonce = statusMode ? process.argv[3] : process.argv[2]
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input)
      const status = nativeHistoryStatus(payload, expectedNonce)
      if (statusMode) process.stdout.write(`${status}\n`)
      else if (status !== 'pass') process.exitCode = 1
    } catch {
      process.exitCode = 1
    }
  })
}
