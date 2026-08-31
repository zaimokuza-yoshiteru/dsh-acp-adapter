import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../../../src/host/composition/index.ts'

class NativeAdapter extends LlmAdapter {
  readonly calls: string[] = []

  override providerInfo(provider: string) { return { id: provider, name: `Native ${provider}` } }

  override providerRetryPolicy() {
    return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.provider)
    yield { type: 'text-delta', index: 0, text: `native:${options.provider}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('third-party host coexistence', () => {
  it('keeps a real llm/stream observer and native route intact after ACP registration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-acp-coexistence-'))
    const ctx = new Context()
    const settings = {
      register: () => ({
        get: () => ({ agents: { codex: { name: 'Codex', command: 'codex-acp', args: [], env: {} } } }),
        watch: () => () => undefined,
      }),
    }
    const subprocess = {
      resolveExecutable: async (command: string) => command,
      spawn: () => { throw new Error('ACP spawn must not occur on the native path') },
    }
    const attachments = {
      imageLimits: {
        maxImageBytes: 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 4096,
        maxImagePixels: 1_000_000,
        maxImageDimension: 4096,
        mediaTypes: ['image/png'],
      },
      readImage: async () => { throw new Error('not used') },
    }
    ctx.provide('settings', settings)
    ctx.provide('sessions', {})
    ctx.provide('subprocess', subprocess)
    ctx.provide('attachments', attachments)
    ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
    await ctx.plugin(LlmRuntime)

    const observerProviders: string[] = []
    ctx.on('llm/stream', (options, next) => {
      observerProviders.push(options.provider)
      return next()
    })
    const native = new NativeAdapter()
    const disposeNative = ctx.llm.registerAdapter(['native'], native)
    const fiber = ctx.plugin({ name: 'third-party-acp-coexistence', inject: [...inject], apply })
    await fiber.await()

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'native', model: 'native-model', messages: [] })) chunks.push(chunk)
    expect(chunks[0]).toMatchObject({ type: 'text-delta', text: 'native:native' })
    expect(native.calls).toEqual(['native'])
    expect(observerProviders).toEqual(['native'])
    expect(ctx.llm.listProviders().map(({ id }) => id)).toEqual(['native', 'acp-codex'])
    expect(existsSync(join(home, 'dsh-acp', 'sidecar.sqlite'))).toBe(false)

    await fiber.dispose()
    disposeNative()
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
})
