import { describe, expect, it } from 'vitest'
import { TYPERT } from '../../lib/typert.host.js'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'

interface Codec {
  mode: string
  create(): { parse(value: unknown): unknown }
}

interface Descriptor {
  method: string
  parameters: { codec: Codec }[]
  result: Codec
}

describe('generated RPC codecs from the alpha.2 factory generator', () => {
  const host = TYPERT as { schemas: unknown[]; invocations: Descriptor[] }
  const remote = TYPERT_REMOTE as unknown as { descriptors: Descriptor[] }

  it('does not introduce named schema exports requiring a separate migration', () => {
    expect(host.schemas).toEqual([])
    expect(remote.descriptors.map((d) => d.method)).toEqual(host.invocations.map((d) => d.method))
  })

  for (const [face, descriptors] of [['host', host.invocations], ['remote', remote.descriptors]] as const) {
    it(`${face}: provides native strict validator factories`, () => {
      expect(descriptors.length).toBeGreaterThan(0)
      for (const descriptor of descriptors) {
        for (const codec of [...descriptor.parameters.map((p) => p.codec), descriptor.result]) {
          if (codec.mode !== 'strict') continue
          expect(codec).not.toHaveProperty('schema')
          expect(typeof codec.create().parse).toBe('function')
        }
      }
    })

    it(`${face}: accepts valid requests/results and rejects malformed payloads through native factories`, () => {
      const descriptor = descriptors.find((d) => d.method === 'backendOf')!
      {
        const input = descriptor.parameters[0]!.codec.create()
        const output = descriptor.result.create()
        expect(input.parse('session-1')).toBe('session-1')
        expect(() => input.parse({ sessionId: 'session-1' })).toThrow()
        expect(output.parse({ state: 'established', provider: 'acp:devin' }))
          .toEqual({ state: 'established', provider: 'acp:devin' })
        expect(() => output.parse({ state: 'established' })).toThrow()
        expect(() => output.parse({ state: 'unknown' })).toThrow()
      }
    })
  }

})
