import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { installInstalledProfileRegistry } from '../../../src/host/composition/installed-profile-registry.ts'
import * as Sidecar from '../../../src/persistence/sidecar.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const home = mkdtempSync(join(tmpdir(), 'acp-registry-startup-'))
  homes.push(home)
  ctx.provide('dshHomePath', (...parts: string[]) => join(home, ...parts))
  await ctx.plugin(SessionProjectionRegistry)
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
  const sidecar = vi.spyOn(Sidecar, 'installAcpSidecar')
  const install = () =>
    ctx.plugin({
      name: 'registry-startup-fixture',
      inject: ['sessionProjections'],
      async apply(scope: Context) {
        await installInstalledProfileRegistry(scope, {
          agents: { get: () => ({}) },
          toolApprovalDefault: { get: () => 'auto' },
        })
      },
    })
  return { ctx, install, sidecar }
}

describe('ACP registry startup ownership', () => {
  it('does not acquire Sidecar when fork projection registration fails', async () => {
    const { ctx, install, sidecar } = await fixture()
    await ctx.sessionProjections.register({
      key: 'acpForkDelegation',
      stateVersion: 99,
      stateSchema: z.object({ completed: z.boolean(), active: z.boolean() }),
      init: () => ({ completed: false, active: false }),
      apply: (state) => state,
    })
    const loading = install()
    await expect(loading.await()).rejects.toThrow('already registered at stateVersion 99')
    expect(sidecar).not.toHaveBeenCalled()
    await loading.dispose()
  })

  it('does not acquire Sidecar after disposal during fork projection readiness', async () => {
    const { install, sidecar } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const register = SessionProjectionRegistry.prototype.register
    vi.spyOn(SessionProjectionRegistry.prototype, 'register').mockImplementation(
      new Proxy(register, {
        async apply(target, receiver, args) {
          const handle = await Reflect.apply(target, receiver, args)
          if (args[0].key === 'acpForkDelegation') {
            entered.resolve()
            await release.promise
          }
          return handle
        },
      }),
    )
    const loading = install()
    await entered.promise
    try {
      expect(sidecar).not.toHaveBeenCalled()
      const closing = loading.dispose()
      release.resolve()
      await closing
      expect(sidecar).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await loading.dispose()
    }
  })
})
