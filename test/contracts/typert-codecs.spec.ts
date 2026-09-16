import { describe, expect, it } from 'vitest'
import { withCodecFactories } from '../../scripts/typert-codec-compat.mjs'
import { TYPERT } from '../../lib/typert.host.js'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'

interface Codec {
  mode: string
  schema: { parse(value: unknown): unknown }
  create(): Codec['schema']
}

interface Descriptor {
  method: string
  parameters: { codec: Codec }[]
  result: Codec
}

describe('generated RPC codecs across the alpha.1 schema/factory transition', () => {
  const host = TYPERT as { schemas: unknown[]; invocations: Descriptor[] }
  const remote = TYPERT_REMOTE as unknown as { descriptors: Descriptor[] }

  it('does not introduce named schema exports requiring a separate migration', () => {
    expect(host.schemas).toEqual([])
    expect(remote.descriptors.map((d) => d.method)).toEqual(host.invocations.map((d) => d.method))
  })

  for (const [face, descriptors] of [['host', host.invocations], ['remote', remote.descriptors]] as const) {
    it(`${face}: provides the same strict validator to released and factory-based hosts`, () => {
      expect(descriptors.length).toBeGreaterThan(0)
      for (const descriptor of descriptors) {
        for (const codec of [...descriptor.parameters.map((p) => p.codec), descriptor.result]) {
          if (codec.mode !== 'strict') continue
          expect(codec.create()).toBe(codec.schema)
          expect(codec.create()).toBe(codec.create())
          expect(typeof codec.schema.parse).toBe('function')
        }
      }
    })

    it(`${face}: accepts valid requests/results and rejects malformed payloads through both accessors`, () => {
      const descriptor = descriptors.find((d) => d.method === 'backendOf')!
      for (const access of [(c: Codec) => c.schema, (c: Codec) => c.create()]) {
        const input = access(descriptor.parameters[0]!.codec)
        const output = access(descriptor.result)
        expect(input.parse('session-1')).toBe('session-1')
        expect(() => input.parse({ sessionId: 'session-1' })).toThrow()
        expect(output.parse({ state: 'established', provider: 'acp:devin' }))
          .toEqual({ state: 'established', provider: 'acp:devin' })
        expect(() => output.parse({ state: 'established' })).toThrow()
        expect(() => output.parse({ state: 'unknown' })).toThrow()
      }
    })
  }

  it('leaves src-json and schema definitions untouched, and fails on a changed generator contract', () => {
    const source = "const validator = z.string(); export const codecs = [{ mode: 'strict', schema: validator }, { mode: 'src-json' }];"
    const output = withCodecFactories(source)
    expect(output).toContain("const validator = z.string();")
    expect(output).toContain("{ mode: 'src-json' }")
    expect(() => withCodecFactories(output)).toThrow('Unexpected strict Typert codec')
    expect(() => withCodecFactories("const c = {mode: 'strict', schema: z.string()}")).toThrow()
    expect(() => withCodecFactories("const c = {mode: 'strict', create: () => validator}")).toThrow()
    expect(() => withCodecFactories('export const codecs = []')).toThrow('No strict Typert codecs')
  })
})
