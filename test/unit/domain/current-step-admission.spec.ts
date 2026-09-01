import { describe, expect, it } from 'vitest'
import { markAgentLoopRequest, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { admitCurrentStep, AcpAdmissionError } from '../../../src/domain/session/current-step-admission.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return markAgentLoopRequest({ provider: 'acp-devin', model: 'm', messages })
}

describe('current-step ACP admission', () => {
  it('uses durable order and records only a bounded filtering fact for old/plugin context', () => {
    const old = user('old')
    const current = user('current')
    const injected = { ...user('skill'), source: { kind: 'plugin' as const, plugin: 'skill' } }
    const session = {
      header: { cwd: '/workspace' },
      events: [
        { type: 'user/message', seq: 0, data: old },
        { type: 'step/start', seq: 1, data: { turn: 2, step: 0 } },
        { type: 'user/message', seq: 2, data: injected },
        { type: 'user/message', seq: 3, data: current },
      ],
    }
    const proof: Array<{
      acceptedMessageIds: readonly string[]
      anchorMessageId: string
      projectionFiltered: boolean
    }> = []
    expect(admitCurrentStep(request([current, old, injected]), session, value => proof.push(value))).toEqual([current])
    expect(proof[0]?.acceptedMessageIds).toEqual([String(current.id)])
    expect(proof[0]?.anchorMessageId).toBe(String(current.id))
    expect(proof[0]?.projectionFiltered).toBe(true)
  })

  it('fails closed when no step is open', () => {
    const message = user('current')
    expect(() => admitCurrentStep(request([message]), {
      header: { cwd: '/workspace' },
      events: [{ type: 'user/message', seq: 0, data: message }],
    })).toThrowError(new AcpAdmissionError('ACP_NO_OPEN_STEP'))
  })

  it('admits a copied request after DSH finalizes adapter options', () => {
    const message = user('current')
    const original = request([message])
    // DSH may replace the request envelope while resolving defaults, projecting
    // images, or filtering replay state. Admission therefore relies on durable
    // session/message evidence rather than process-local object identity.
    const copied: GenerateOptions = { ...original, messages: [...original.messages] }
    const proofs: Array<{ projectionFiltered: boolean }> = []
    expect(admitCurrentStep(copied, {
      header: { cwd: '/workspace' },
      events: [
        { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
        { type: 'user/message', seq: 2, data: message },
      ],
    }, proof => proofs.push(proof))).toEqual([message])
    expect(proofs[0]?.projectionFiltered).toBe(false)
  })

  it('旁路 auxiliary purpose before provenance and does not inspect/send ACP input', () => {
    expect(admitCurrentStep({ provider: 'acp-devin', model: 'm', purpose: 'session-title', messages: [] }, undefined)).toEqual([])
  })

  it('keeps proof bounded for long history', () => {
    const old = Array.from({ length: 1000 }, (_, index) => user(`old-${index}`))
    const injected = { ...user('skill'), source: { kind: 'plugin' as const, plugin: 'skill' } }
    const first = user('first')
    const second = user('second')
    const events = [
      ...old.map((message, index) => ({ type: 'user/message', seq: index + 1, data: message })),
      { type: 'step/start', seq: 2001, data: { turn: 2, step: 0 } },
      { type: 'user/message', seq: 2002, data: injected },
      { type: 'user/message', seq: 2003, data: second },
      { type: 'user/message', seq: 2004, data: first },
    ]
    const proofs: any[] = []
    const admitted = admitCurrentStep(request([first, ...old, injected, second]), { header: { cwd: '/workspace' }, events }, proof => proofs.push(proof))
    expect(admitted).toEqual([second, first])
    expect(proofs[0]?.projectionFiltered).toBe(true)
    expect(JSON.stringify(proofs[0])).not.toContain(String(old[0]?.id))
  })
})
