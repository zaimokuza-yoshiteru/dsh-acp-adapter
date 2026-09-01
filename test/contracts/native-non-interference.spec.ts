import { readFileSync } from 'node:fs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../../src/host/composition/index.ts'

const root = new URL('../../', import.meta.url)
const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
const client = readFileSync(new URL('src/client/index.ts', root), 'utf8')
const activeClient = client

describe('native DSH non-interference contract', () => {
  it('does not disable or replace stock AgentLoop/ModelPicker rows', () => {
    expect(patch).not.toMatch(/id:\s+agent-loop[\s\S]*disabled:\s*true/)
    expect(patch).not.toMatch(/id:\s+ui-model-selection[\s\S]*disabled:\s*true/)
    expect(patch).not.toContain('agent-loop-acp')
    expect(patch).not.toContain('ui-model-selection')
    expect(activeClient).not.toContain("register({ name: 'model'")
    expect(activeClient).not.toContain('conversation.input.model')
  })

  it('keeps native A→A and A→B dispatch independent after ACP composition is installed', async () => {
    const nativeCalls: string[] = []
    class NativeAdapter extends LlmAdapter {
      override providerInfo(provider: string) { return { id: provider, name: provider } }
      override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        nativeCalls.push(options.provider)
        yield { type: 'text-delta', index: 0, text: `native:${options.provider}` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const routes = new Map<string, LlmAdapter>()
    const native = new NativeAdapter()
    const home = mkdtempSync(`${tmpdir()}/dsh-acp-native-`)
    const settings = { register: () => ({ get: () => ({ agents: { devin: { name: 'Devin', command: 'devin', args: ['acp'], env: {} } } }), watch: () => () => undefined }) }
    const context = {
      get: (name: string) => name === 'settings' ? settings : name === 'dshHomePath' ? ((...segments: string[]) => [home, ...segments].join('/')) : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => callback({ get: context.get, on: context.on }),
      on: () => () => undefined,
      effect: () => undefined,
      llm: {
        registerAdapter: (providers: string[], adapter: LlmAdapter) => {
          for (const provider of providers) routes.set(provider, adapter)
          return Object.assign(() => undefined, { replace: () => undefined })
        },
      },
      logger: { warn: () => undefined, error: () => undefined },
      fiber: { state: 2 },
    }
    context.llm.registerAdapter(['native-a', 'native-b'], native)
    apply(context as never)
    const sidecarBeforeNative = existsSync(`${home}/dsh-acp/sidecar.sqlite`)
    const dispatch = async (provider: string, model = 'm') => {
      const adapter = routes.get(provider)
      if (adapter === undefined) throw new Error(`missing native route ${provider}`)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({ provider, model, messages: [] })) chunks.push(chunk)
      return chunks
    }
    expect((await dispatch('native-a')).at(0)).toMatchObject({ type: 'text-delta', text: 'native:native-a' })
    expect((await dispatch('native-b')).at(0)).toMatchObject({ type: 'text-delta', text: 'native:native-b' })
    expect((await dispatch('native-a', 'model-b')).at(0)).toMatchObject({ type: 'text-delta', text: 'native:native-a' })
    expect(nativeCalls).toEqual(['native-a', 'native-b', 'native-a'])
    expect([...routes.keys()]).toEqual(['native-a', 'native-b', 'acp-devin'])
    expect(existsSync(`${home}/dsh-acp/sidecar.sqlite`)).toBe(sidecarBeforeNative)
    rmSync(home, { recursive: true, force: true })
  })
})
