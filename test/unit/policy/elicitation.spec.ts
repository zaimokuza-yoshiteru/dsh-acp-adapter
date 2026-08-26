import { describe, expect, it } from 'vitest'
import { InMemoryAcpElicitationBroker } from '../../../src/domain/policy/elicitation.ts'

const form = (properties: Record<string, unknown>, required: string[] = []) => ({
  mode: 'form' as const,
  sessionId: 'acp-session',
  message: 'Choose a deployment target',
  requestedSchema: { type: 'object' as const, properties, required },
})

describe('InMemoryAcpElicitationBroker', () => {
  it('keeps a valid primitive form pending and returns exact accepted values', async () => {
    const audits: unknown[] = []
    const broker = new InMemoryAcpElicitationBroker(() => 1, (_session, audit) => { audits.push(audit) })
    const pending = broker.open({ sessionId: 'dsh-1', params: form({ target: { type: 'string', minLength: 2 }, count: { type: 'integer', minimum: 1, maximum: 3 }, ok: { type: 'boolean' }, tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } } }, ['target', 'count', 'ok', 'tags']) })
    expect(broker.list('dsh-1')[0]?.fields.map((field) => field.name)).toEqual(['target', 'count', 'ok', 'tags'])
    await broker.answer('dsh-1', { requestId: broker.list('dsh-1')[0]!.requestId, action: 'accept', values: [
      { name: 'target', value: 'prod' }, { name: 'count', value: 2 }, { name: 'ok', value: true }, { name: 'tags', value: ['a'] },
    ] })
    await expect(pending).resolves.toEqual({ action: 'accept', content: { target: 'prod', count: 2, ok: true, tags: ['a'] } })
    expect(JSON.stringify(audits)).not.toContain('prod')
  })

  it('declines sensitive or unknown schemas before showing a form', async () => {
    const broker = new InMemoryAcpElicitationBroker()
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ api_token: { type: 'string' } }, ['api_token']) })).resolves.toEqual({ action: 'decline' })
    expect(broker.list('dsh-1')).toHaveLength(0)
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ nested: { type: 'object' } }) })).resolves.toEqual({ action: 'decline' })
  })

  it('declines incomplete enums, invalid constraints, and invalid defaults', async () => {
    const broker = new InMemoryAcpElicitationBroker()
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ tags: { type: 'array', items: { type: 'string' } } }) })).resolves.toEqual({ action: 'decline' })
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ target: { type: 'string', enum: ['a', 1] } }) })).resolves.toEqual({ action: 'decline' })
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ target: { type: 'string', pattern: '[' } }) })).resolves.toEqual({ action: 'decline' })
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ count: { type: 'integer', minimum: 3, maximum: 1 } }) })).resolves.toEqual({ action: 'decline' })
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ target: { type: 'string', enum: ['a'], default: 'b' } }) })).resolves.toEqual({ action: 'decline' })
    await expect(broker.open({ sessionId: 'dsh-1', params: form({ target: { type: 'string', format: 'hostname' } }) })).resolves.toEqual({ action: 'decline' })
  })

  it('validates supported string formats before returning an accepted answer', async () => {
    const broker = new InMemoryAcpElicitationBroker()
    const pending = broker.open({ sessionId: 'dsh-1', params: form({ email: { type: 'string', format: 'email' }, date: { type: 'string', format: 'date' } }, ['email', 'date']) })
    const requestId = broker.list('dsh-1')[0]!.requestId
    await expect(broker.answer('dsh-1', { requestId, action: 'accept', values: [{ name: 'email', value: 'invalid' }, { name: 'date', value: '2026-02-30' }] })).rejects.toThrow()
    await broker.answer('dsh-1', { requestId, action: 'accept', values: [{ name: 'email', value: 'user@example.com' }, { name: 'date', value: '2026-02-28' }] })
    await expect(pending).resolves.toEqual({ action: 'accept', content: { email: 'user@example.com', date: '2026-02-28' } })
  })

  it('validates numeric and multi-select limits and cancels on abort', async () => {
    const audits: { phase: string; result?: string }[] = []
    const broker = new InMemoryAcpElicitationBroker(Date.now, (_session, audit) => { audits.push(audit) })
    const pending = broker.open({ sessionId: 'dsh-1', params: form({ n: { type: 'number', minimum: 2, maximum: 4 }, tags: { type: 'array', minItems: 2, items: { type: 'string', enum: ['a', 'b'] } } }, ['n', 'tags']) })
    const requestId = broker.list('dsh-1')[0]!.requestId
    await expect(broker.answer('dsh-1', { requestId, action: 'accept', values: [{ name: 'n', value: 1 }, { name: 'tags', value: ['a'] }] })).rejects.toThrow()
    const controller = new AbortController()
    const cancelled = broker.open({ sessionId: 'dsh-2', params: form({ x: { type: 'string' } }), signal: controller.signal })
    controller.abort()
    await expect(cancelled).resolves.toEqual({ action: 'cancel' })
    expect(audits.some((audit) => audit.phase === 'decided' && audit.result === 'cancel')).toBe(true)
    await broker.cancel('dsh-1', requestId)
    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })

  it('accepts only http(s) URL without userinfo and keeps query out of audit', async () => {
    const audits: unknown[] = []
    const broker = new InMemoryAcpElicitationBroker(Date.now, (_session, audit) => { audits.push(audit) })
    const pending = broker.open({ sessionId: 'dsh-1', params: { mode: 'url', sessionId: 'acp-session', elicitationId: 'el-1', message: 'Continue login', url: 'https://example.com/continue?token=secret' } })
    expect(broker.list('dsh-1')[0]?.url).toContain('?token=secret')
    await broker.answer('dsh-1', { requestId: 'el-1', action: 'accept' })
    await expect(pending).resolves.toEqual({ action: 'accept', content: {} })
    expect(JSON.stringify(audits)).not.toContain('token=secret')
    await expect(broker.open({ sessionId: 'dsh-2', params: { mode: 'url', sessionId: 'acp-session', elicitationId: 'el-2', message: 'bad', url: 'https://user:pass@example.com/' } })).resolves.toEqual({ action: 'decline' })
  })
})
