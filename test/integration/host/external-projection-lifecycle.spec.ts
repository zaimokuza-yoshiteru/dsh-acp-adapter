import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { installInstalledProfileRegistry } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { ExternalSubagentProjector } from '../../../src/host/subagent/external-projector.ts'
import * as Sidecar from '../../../src/persistence/sidecar.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const observation = {
  profileKind: 'claude',
  vendorDelegationKey: 'child',
  vendorChildId: 'child',
  label: 'Source inspection',
  task: { text: 'Inspect source', source: 'structured-tool-input' as const },
  result: { text: 'Done', source: 'verbatim-child-final' as const, completeness: 'final-output' as const },
  status: 'completed' as const,
  timing: { observedStartedAt: 100, observedCompletedAt: 250, source: 'client-observed' as const },
  projectionEligible: true,
}

async function fixture(repair = false, catalogBarrier = false) {
  const home = mkdtempSync(join(tmpdir(), 'acp-projection-lifecycle-'))
  roots.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const parent = Session.create(SessionId('parent'), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('parent'),
    createdAt: 1,
    cwd: home,
    isSeeded: false,
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const catalogEntered = Promise.withResolvers<void>()
  const catalogRelease = Promise.withResolvers<void>()
  const records = new Map<string, { header: SessionHeader; events: SessionEvent[] }>([
    [parent.id, { header: parent.header, events: [] }],
  ])
  const order: string[] = []
  let generation = 0
  const liveGenerations = new Set<number>()
  const check = (owner: number) => {
    if (!liveGenerations.has(owner)) throw new Error(`persistence generation ${owner} already released`)
  }
  const handle = (id: string, owner: number, access: 'read' | 'write'): SessionHandle => ({
    id: SessionId(id),
    header: records.get(id)!.header,
    access,
    inheritedEventCount: SessionLogOffset(0),
    read: async () => {
      check(owner)
      return { eventState: 'detached', events: [...records.get(id)!.events] }
    },
    append: async (events) => {
      check(owner)
      records.get(id)!.events.push(...events)
      order.push(`append:${owner}`)
    },
    flush: async () => {
      check(owner)
      order.push(`flush:${owner}`)
    },
    close: async () => {
      check(owner)
      order.push(`close:${owner}`)
    },
    [Symbol.asyncDispose]: async () => {
      check(owner)
      order.push(`close:${owner}`)
    },
  })
  const mountPersistence = async (): Promise<Fiber> => {
    const owner = ++generation
    const provider = ctx.plugin({
      name: `projection-persistence-${owner}`,
      apply(scope: Context) {
        scope.effect(function* () {
          liveGenerations.add(owner)
          yield scope.effect(() => () => {
            liveGenerations.delete(owner)
            order.push(`released:${owner}`)
          })
          yield scope.provide('sessionPersistence', {
            create: async (header: SessionHeader) => {
              check(owner)
              if (repair) {
                entered.resolve()
                await release.promise
                check(owner)
              }
              order.push(`create:${owner}`)
              if (records.has(header.id)) throw new SessionAlreadyExistsError(header.id)
              records.set(header.id, { header, events: [] })
              return handle(header.id, owner, 'write')
            },
            open: async (id: string, access: 'read' | 'write') => {
              check(owner)
              return handle(id, owner, access)
            },
          } as never)
        })
      },
    })
    await provider
    return provider
  }
  ctx.provide('sessions', {
    get: (id: string) => (id === parent.id ? parent : undefined),
    flush: async () => {
      if (catalogBarrier && parent.snapshotEvents().some((event) => event.type === 'subagent/catalog')) {
        catalogEntered.resolve()
        await catalogRelease.promise
        check(1)
        order.push('catalog-flush')
      } else {
        if (!repair) {
          entered.resolve()
          await release.promise
        }
        order.push('parent-flush')
      }
      records.set(parent.id, { header: parent.header, events: [...parent.snapshotEvents()] })
      return true
    },
  } as never)
  ctx.provide('llm', {
    registerAdapter: (_routes: readonly string[], adapter: AcpProfileAdapter) => {
      adapters.push(adapter)
      return Object.assign(() => undefined, { replace: () => undefined })
    },
  } as never)
  ctx.provide('dshHomePath', (...parts: string[]) => join(home, ...parts))
  const adapters: AcpProfileAdapter[] = []
  const projectionContext = {
    profileId: 'claude',
    bindingGeneration: 1,
    rootAcpSessionId: 'root',
    parentDshSessionId: parent.id,
    parentCwd: home,
  }
  if (repair) {
    const seed = Sidecar.createAcpSidecar({ root: join(home, 'dsh-acp') })
    try {
      const projector = new ExternalSubagentProjector(
        {
          create: async () => {
            throw new Error('unused')
          },
          open: async () => {
            throw new Error('unused')
          },
        },
        seed,
      )
      await expect(
        projector.project(observation, { ...projectionContext, flushParent: async () => false }),
      ).rejects.toThrow('PARENT_NOT_DURABLE')
      await projector.close()
    } finally {
      await seed.dispose()
    }
  }
  let sidecar: Sidecar.AcpSidecar | undefined
  const install = Sidecar.installAcpSidecar
  vi.spyOn(Sidecar, 'installAcpSidecar').mockImplementation((scope) => {
    sidecar = install(scope)
    return sidecar
  })
  const repairStarted = vi.spyOn(ExternalSubagentProjector.prototype, 'repairInterrupted')
  const drainStarted = Promise.withResolvers<void>()
  const closeProjector = ExternalSubagentProjector.prototype.close
  vi.spyOn(ExternalSubagentProjector.prototype, 'close').mockImplementation(function (this: ExternalSubagentProjector) {
    drainStarted.resolve()
    return closeProjector.call(this)
  })
  const provider = await mountPersistence()
  if (catalogBarrier) {
    // The public native runtime owns the actual catalog fold; no private module import or mock projection.
    ctx.provide('workingDirectory', { get: () => home } as never)
    await ctx.plugin(SubagentRuntime)
    await vi.waitFor(() =>
      expect(ctx.sessionProjections.snapshot(parent, ['subagentCatalog']).values.subagentCatalog).toEqual([]),
    )
  }
  const adapter = ctx.plugin({
    name: 'external-projection-composition',
    inject: ['sessionProjections', 'llm', 'sessions', 'dshHomePath'],
    apply(scope: Context) {
      installInstalledProfileRegistry(scope, {
        agents: { get: () => ({ claude: { name: 'Claude fixture', command: 'unused', args: [], env: {} } }) },
        toolApprovalDefault: { get: () => 'auto' },
      })
    },
  })
  await adapter
  await vi.waitFor(() => expect(adapters).toHaveLength(1))
  await vi.waitFor(() => expect(repairStarted).toHaveBeenCalled())
  const projectorMethod = Reflect.get(adapters[0]!, 'projectExternalDelegation') as NonNullable<
    ConstructorParameters<typeof import('../../../src/host/composition/profile-adapter.ts').AcpProfileAdapter>[10]
  >
  const start = async (count = 1) => {
    let child: string | undefined
    await projectorMethod(async (project) => {
      for (let index = 0; index < count; index++) {
        child = await project({ ...observation, vendorDelegationKey: `child-${index}` }, projectionContext)
      }
    })
    return child
  }
  return {
    ctx,
    adapter,
    provider,
    parent,
    entered,
    release,
    start,
    sidecar: sidecar!,
    records,
    order,
    liveGenerations,
    mountPersistence,
    drainStarted,
    catalogEntered,
    catalogRelease,
  }
}

it.each(['composition', 'root'] as const)(
  'drains an accepted parent-flush transaction before %s releases Sidecar',
  async (scope) => {
    const f = await fixture()
    const pending = f.start(2)
    await f.entered.promise
    const db = (f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db!
    let disposed = false
    const closing = (scope === 'root' ? f.ctx.fiber.dispose() : f.adapter.dispose()).then(() => {
      disposed = true
    })
    try {
      await f.drainStarted.promise
      expect(disposed).toBe(false)
      expect(db.isOpen).toBe(true)
      expect(f.liveGenerations.has(1)).toBe(true)
    } finally {
      f.release.resolve()
    }
    const child = await pending
    await closing
    expect(child).toMatch(/^session-dsh-acp-/)
    expect(f.records.get(child!)!.events.at(-1)?.type).toBe('turn/end')
    expect(db.isOpen).toBe(false)
    expect((f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db).toBeUndefined()
  },
)

it('retains the original persistence instance through provider withdrawal and repairs through its replacement', async () => {
  const f = await fixture()
  const pending = f.start(2)
  await f.entered.promise
  let disposed = false
  const closing = f.provider.dispose().then(() => {
    disposed = true
  })
  try {
    await f.drainStarted.promise
    expect(disposed).toBe(false)
    expect(f.liveGenerations.has(1)).toBe(true)
  } finally {
    f.release.resolve()
  }
  const child = await pending
  await closing
  expect(f.order.indexOf('released:1')).toBeGreaterThan(f.order.indexOf('close:1'))
  expect(f.records.get(child!)!.events.at(-1)?.type).toBe('turn/end')
  await expect(f.start()).rejects.toThrow('PERSISTENCE_UNAVAILABLE')
  await f.mountPersistence()
  await vi.waitFor(() => expect(f.order).toContain('create:2'))
  expect(f.order.filter((event) => event === 'create:1')).toHaveLength(2)
  await f.adapter.dispose()
  expect((f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db).toBeUndefined()
})

it.each(['composition', 'provider'] as const)(
  'drains startup repair at the child-commit barrier before %s disposal',
  async (scope) => {
    const f = await fixture(true)
    await f.entered.promise
    const db = (f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db!
    let disposed = false
    const closing = (scope === 'provider' ? f.provider.dispose() : f.adapter.dispose()).then(() => {
      disposed = true
    })
    try {
      await f.drainStarted.promise
      expect(disposed).toBe(false)
      expect(f.liveGenerations.has(1)).toBe(true)
      expect(db.isOpen).toBe(true)
    } finally {
      f.release.resolve()
    }
    await closing
    const child = [...f.records].find(([id]) => id !== f.parent.id)
    expect(child?.[1].events.at(-1)?.type).toBe('turn/end')
    if (scope === 'provider') await f.adapter.dispose()
    expect(db.isOpen).toBe(false)
    expect((f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db).toBeUndefined()
  },
)

it.each(['root', 'provider'] as const)(
  'retains native catalog append and accepted flush through %s withdrawal',
  async (scope) => {
    const f = await fixture(false, true)
    f.release.resolve()
    const pending = f.start()
    await f.catalogEntered.promise
    const catalog = f.parent.snapshotEvents().find((event) => event.type === 'subagent/catalog')
    expect(catalog?.data).toMatchObject({ mode: 'one-shot', label: observation.label })
    const db = (f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db!
    let disposed = false
    const closing = (scope === 'root' ? f.ctx.fiber.dispose() : f.provider.dispose()).then(() => {
      disposed = true
    })
    try {
      await f.drainStarted.promise
      expect(disposed).toBe(false)
      expect(f.liveGenerations.has(1)).toBe(true)
      expect(db.isOpen).toBe(true)
    } finally {
      f.catalogRelease.resolve()
    }
    const child = await pending
    await closing
    expect(f.records.get(f.parent.id)!.events).toContainEqual(
      expect.objectContaining({ type: 'subagent/catalog', data: expect.objectContaining({ childId: child }) }),
    )
    expect(f.order.indexOf('released:1')).toBeGreaterThan(f.order.indexOf('catalog-flush'))
    if (scope === 'provider') await f.adapter.dispose()
    expect(db.isOpen).toBe(false)
    expect((f.sidecar as Sidecar.AcpSidecar & { db?: DatabaseSync }).db).toBeUndefined()
  },
)
