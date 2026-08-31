import { describe, expect, it } from 'vitest'
import { apply, inject } from '../../src/host/composition/index.ts'

/** Small host-shaped fixture: this exercises the exported Cordis plugin body,
 * rather than only asserting the patch file's text. */
function hostFixture() {
  const registrations: Array<{ routes: string[]; adapter: unknown }> = []
  const settings = {
    register: () => ({
      get: () => ({
        agents: {
          devin: { name: 'Devin', command: 'devin', args: ['acp'], env: {} },
        },
      }),
      watch: () => () => undefined,
    }),
  }
  const context = {
    get: (name: string) => name === 'settings' ? settings : undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => callback({ get: context.get }),
    effect: () => undefined,
    llm: {
      registerAdapter: (routes: string[], adapter: unknown) => {
        registrations.push({ routes, adapter })
        return Object.assign(() => undefined, { replace: () => undefined })
      },
    },
    logger: { warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
  }
  return { context, registrations }
}

describe('additive Cordis composition', () => {
  it('requires settings at the composition boundary', () => {
    expect(inject).toContain('settings')
  })

  it('mounts the package contribution and registers one independent ACP route', () => {
    const { context, registrations } = hostFixture()
    apply(context as never)
    expect(registrations.map(({ routes }) => routes)).toEqual([['acp-devin']])
    // The package contribution is not the legacy AgentLoop subclass and the
    // stock loop/picker are therefore left to the host composition.
    expect(registrations[0]?.adapter).toBeDefined()
  })
})
