import type { AcpOwnedRoutesView } from '../../../src/contract/remote.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'
import type { AgentControlChoice } from '../../../src/client/ui/agent-session-controls.ts'

const runtime = vi.hoisted(() => ({
  cursor: 0,
  cells: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  streamEvents: [] as string[],
  agentReadFailed: undefined as (() => void) | undefined,
  managed: false,
  withdrawn: false,
}))

// Run the component's actual handlers and effect cleanup around a held RPC.
// The browser scenario owns native React rendering and navigation geometry.
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, children },
  }),
  useLayoutEffect: () => {},
  useState: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.cells)) runtime.cells[index] = typeof initial === 'function' ? initial() : initial
    return [
      runtime.cells[index],
      (value: unknown) => {
        runtime.cells[index] = typeof value === 'function' ? value(runtime.cells[index]) : value
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.cells)) runtime.cells[index] = { current: initial }
    return runtime.cells[index]
  },
  useEffect: (effect: () => (() => void) | undefined, dependencies: readonly unknown[]) => {
    const index = runtime.cursor++
    const previous = runtime.cells[index] as readonly unknown[] | undefined
    if (previous !== undefined && dependencies.every((value, position) => Object.is(value, previous[position]))) return
    runtime.cells[index] = dependencies
    runtime.effects.push(() => {
      runtime.cleanups.get(index)?.()
      const cleanup = effect()
      if (cleanup === undefined) runtime.cleanups.delete(index)
      else runtime.cleanups.set(index, cleanup)
    })
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))

const agentSnapshot = (sessionId: string): AcpAgentSessionSnapshotView => ({
  sessionId,
  profileId: 'codex',
  freshness: 'live',
  editable: true,
  modes: [
    { id: 'code', name: 'Code' },
    { id: 'plan', name: 'Plan' },
  ],
  currentModeId: 'code',
  configOptions: runtime.managed
    ? [
        {
          type: 'select',
          category: 'model',
          id: 'engine',
          name: 'Engine',
          currentValue: 'a',
          options: [
            { value: 'a', name: 'Large' },
            { value: 'b', name: 'Small' },
          ],
        },
      ]
    : null,
  ...(runtime.managed
    ? {
        managedModel: {
          optionId: 'engine',
          confirmed: 'a',
          capacityRisks: [{ model: 'b', lastUsed: 16280, targetSize: 12288 }],
        },
      }
    : {}),
  contextUsage: null,
  note: null,
})

vi.mock('../../../src/client/data/agent-session-stream.ts', () => ({
  agentSessionStream: (
    _remote: unknown,
    _factory: unknown,
    target: string | { sessionId: string; provider: string },
    changed: (value: unknown) => void,
    failed: () => void,
  ) => ({
    start: () => {
      const sessionId = typeof target === 'string' ? target : target.sessionId
      runtime.streamEvents.push(`agent:start:${sessionId}`)
      runtime.agentReadFailed = failed
      const snapshot = agentSnapshot(sessionId)
      changed(
        typeof target === 'string'
          ? snapshot
          : {
              ...snapshot,
              freshness: 'stale',
              preselection: true,
              preselectionRevision: 1,
              preselected: [{ kind: 'mode', id: 'plan' }],
              modes: runtime.withdrawn ? [] : snapshot.modes,
            },
      )
    },
    dispose: async () => {
      runtime.streamEvents.push(`agent:dispose:${typeof target === 'string' ? target : target.sessionId}`)
    },
  }),
}))
import { AcpAgentControl } from '../../../src/client/ui/AcpAgentControl.ts'
import { AgentSessionMenu } from '../../../src/client/ui/AgentSessionMenu.ts'
import { AcpOutcomeToast } from '../../../src/client/ui/AcpOutcomeToast.ts'
import { AcpUiFeedback } from '../../../src/client/data/feedback.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

type Props = ComponentProps<typeof AcpAgentControl>
type Menu = {
  props: {
    disabled: boolean
    open: boolean
    onOpenChange(open: boolean): void
    footer: readonly { text: string }[]
    groups: readonly { choices: readonly AgentControlChoice[] }[]
    actions: readonly { id: string; run(anchor: HTMLElement | null): void }[]
    replacesPermission: boolean
    onSelect(choice: AgentControlChoice): void
  }
}
type Response = { ok: true; value: AcpAgentSessionSnapshotView } | { ok: false; error: { message: string } }

function translate(dictionary: typeof en): Props['t'] {
  const hasKey = (key: string): key is keyof typeof dictionary => Object.hasOwn(dictionary, key)
  return (key, params) => {
    if (!hasKey(key)) throw new Error(`Missing ACP translation: ${key}`)
    let text = dictionary[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

const english = translate(en)
const chinese = translate(zh)

function render(props: Props): Menu {
  let menu: Menu
  // One pass commits changed effects; the second observes their stream baselines.
  for (let pass = 0; pass < 2; pass++) {
    runtime.cursor = 0
    menu = AcpAgentControl(props) as Menu
    for (const effect of runtime.effects.splice(0)) effect()
  }
  return menu!
}

function setup(dedicated = false) {
  let resolve!: (response: Response) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<Response>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  const remote = {
    setAgentSessionOption: vi.fn((_sessionId: string, _request: unknown) => pending),
    clearAgentPreselection: vi.fn(async () => ({ ok: true as const, value: undefined })),
    agentSessionSnapshot: vi.fn(async (sessionId: string) => ({ ok: true, value: agentSnapshot(sessionId) })),
  }
  const feedback = new AcpUiFeedback()
  const report = vi.spyOn(feedback, 'report')
  let permitted = true
  const props = {
    sessionId: 'session-source',
    useProjection: (key: string) =>
      key === 'agentPreset'
        ? dedicated
          ? 'acp-adapter'
          : 'standard'
        : key === 'title'
          ? 'Source conversation'
          : { lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } },
    useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running: false }),
    useAccess: () => permitted,
    sessionAccessSource: () => ({ getSnapshot: () => permitted }),
    t: english,
    remote,
    streamFactory: {},
    useNativePermissionSeat: () => true,
    openToolPermissions: vi.fn(async () => true),
    nativeStopLabel: () => 'Stop',
    useRouteOwnership: (select: (value: AcpOwnedRoutesView) => unknown) =>
      select({ providers: ['acp-codex'], historicalProviders: [] }),
    getDefaultProvider: async () => 'acp-codex',
    watchDefaultProvider: () => () => {},
    feedback,
  } as Props
  return {
    props,
    remote,
    feedback,
    report,
    resolve,
    reject,
    revoke: () => {
      permitted = false
    },
  }
}

function choice(menu: Menu): AgentControlChoice {
  return menu.props.groups.flatMap((group) => group.choices).find((entry) => entry.id === 'mode:plan')!
}

beforeEach(() => {
  runtime.cursor = 0
  runtime.cells = []
  runtime.effects = []
  runtime.cleanups.clear()
  runtime.streamEvents = []
  runtime.agentReadFailed = undefined
  runtime.managed = false
  runtime.withdrawn = false
})
afterEach(() => {
  for (const cleanup of runtime.cleanups.values()) cleanup()
})

it('keeps mode available without a second model selector on old conversations', () => {
  runtime.managed = true
  const fixture = setup()
  const menu = render(fixture.props)
  const choices = menu.props.groups.flatMap((group) => group.choices)
  expect(choices.some((choice) => choice.write.kind === 'mode')).toBe(true)
  expect(choices.some((choice) => choice.write.kind === 'config' && choice.write.id === 'engine')).toBe(false)
})

it('selects a reported choice even when another settings group and an action use the same ID', () => {
  const plan = {
    id: 'mode:plan',
    label: 'Plan',
    write: { kind: 'mode' as const, id: 'plan' },
    current: true,
    disabled: false,
  }
  const primary = { kind: 'mode' as const, id: 'mode', name: 'Mode', current: 'Plan', choices: [plan] }
  const onSelect = vi.fn()
  const run = vi.fn()
  const menu = AgentSessionMenu({
    groups: [primary, { ...primary, id: plan.id, name: 'Another setting' }],
    primaryGroup: primary,
    actions: [{ id: plan.id, label: 'Another action', run }],
    label: 'Plan',
    t: english,
    open: true,
    onOpenChange: vi.fn(),
    onSelect,
  }) as {
    props: { children: [{ props: { selectedId: string; items: { id: string }[]; onSelect(id: string): void } }] }
  }
  const native = menu.props.children[0].props
  expect(new Set(native.items.map(({ id }) => id)).size).toBe(native.items.length)
  native.onSelect(native.selectedId)
  expect(onSelect).toHaveBeenCalledWith(plan)
  expect(run).not.toHaveBeenCalled()
})

it('leaves a withdrawn first-turn choice clearable without hiding DSH permissions and rechecks access on click', () => {
  runtime.withdrawn = true
  const fixture = setup(true)
  const menu = render(fixture.props)
  expect(menu.props.replacesPermission).toBe(false)
  expect(menu.props.groups).toEqual([])
  const clear = menu.props.actions.find((action) => action.id === 'agent-defaults')!
  clear.run(null)
  expect(fixture.remote.clearAgentPreselection).toHaveBeenCalledWith(
    {
      sessionId: 'session-source',
      provider: 'acp-codex',
      preselectionRevision: 1,
    },
    expect.any(AbortSignal),
  )
  fixture.revoke()
  clear.run(null)
  expect(fixture.remote.clearAgentPreselection).toHaveBeenCalledOnce()
})

it('keeps the full source identity and limits wrapping to source-session failure toasts', () => {
  const feedback = new AcpUiFeedback()
  const sourceSession = { id: 'session-source', title: 'W'.repeat(80) }
  type ToastView = { props: { text: string; tone?: string; icon?: { props: { className?: string } } } }
  feedback.report('session-option-failed', sourceSession)
  const source = AcpOutcomeToast({ feedback, t: english }) as ToastView
  expect(source.props.text).toContain(sourceSession.title)
  expect(feedback.getSnapshot()?.sourceSession).toEqual(sourceSession)
  expect(source.props.icon?.props.className).toBeTruthy()
  feedback.report('save-failed')
  const ordinary = AcpOutcomeToast({ feedback, t: english }) as ToastView
  expect(ordinary.props.icon?.props.className).toBeUndefined()
  feedback.report('saved')
  const success = AcpOutcomeToast({ feedback, t: english }) as ToastView
  expect(success.props.tone).toBe('success')
  expect(success.props.icon).toBeUndefined()
})

describe('late session option write feedback', () => {
  it.each([
    ['session', 'response'],
    ['session', 'rejection'],
    ['locale', 'response'],
    ['locale', 'rejection'],
  ] as const)('keeps a %s change and a %s failure scoped to the source session', async (change, failure) => {
    const fixture = setup()
    const initial = render(fixture.props)
    const selected = choice(initial)
    expect(selected.disabled).toBe(false)
    initial.props.onSelect(selected)
    const rpc = fixture.remote.setAgentSessionOption
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0]?.[0]).toBe('session-source')
    expect(render(fixture.props).props.disabled).toBe(true)

    const next =
      change === 'session'
        ? { ...fixture.props, sessionId: 'session-next' as Props['sessionId'] }
        : {
            ...fixture.props,
            t: chinese,
          }
    const changedMenu = render(next)
    expect(changedMenu.props.disabled).toBe(change === 'locale')
    if (change === 'locale') expect(runtime.streamEvents).toEqual(['agent:start:session-source'])
    expect(fixture.report).not.toHaveBeenCalled()
    if (failure === 'response')
      fixture.resolve({ ok: false, error: { message: 'PRIVATE_RPC_FAILURE ACP_SETTING_FAILED' } })
    else fixture.reject(new Error('PRIVATE_RPC_FAILURE ACP_SETTING_FAILED'))
    await vi.waitFor(() => expect(fixture.report).toHaveBeenCalledOnce())

    const current = render(next)
    expect(current.props.disabled).toBe(false)
    expect(current.props.footer.some((entry) => entry.text.includes('PRIVATE_RPC_FAILURE'))).toBe(false)
    expect(choice(current).current).toBe(false)
    expect(fixture.feedback.getSnapshot()).toMatchObject({
      outcome: 'session-option-failed',
      ...(change === 'session' ? { sourceSession: { id: 'session-source', title: 'Source conversation' } } : {}),
    })
    if (change === 'locale') {
      expect(fixture.feedback.getSnapshot()?.sourceSession).toBeUndefined()
      expect(current.props.footer.some((entry) => entry.text.includes('请重试'))).toBe(true)
      expect(current.props.footer.some((entry) => entry.text.includes('ACP_SETTING_FAILED'))).toBe(true)
    }
    const toast = AcpOutcomeToast({ feedback: fixture.feedback, t: next.t }) as { props: { text: string } }
    if (change === 'session') expect(toast.props.text).toContain('Source conversation')
    else expect(toast.props.text).not.toContain('Source conversation')
    expect(toast.props.text).toContain(change === 'locale' ? '请重试' : 'Try again')
    expect(toast.props.text).not.toContain('PRIVATE_RPC_FAILURE')
    expect(render(fixture.props).props.footer.some((entry) => entry.text.includes('PRIVATE_RPC_FAILURE'))).toBe(false)
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rechecks native write access before sending the selected operation', () => {
    const fixture = setup()
    const menu = render(fixture.props)
    fixture.revoke()
    menu.props.onSelect(choice(menu))
    expect(fixture.remote.setAgentSessionOption).not.toHaveBeenCalled()
    expect(fixture.report).not.toHaveBeenCalled()
  })
})

it('translates open control errors through a stable native translator without reconnecting the remote stream', () => {
  const fixture = setup()
  let locale = english
  const props = { ...fixture.props, t: ((key, params) => locale(key, params)) as Props['t'] }
  render(props).props.onOpenChange(true)
  runtime.agentReadFailed?.()
  const before = render(props)
  expect(before.props.open).toBe(true)
  expect(before.props.footer.map((entry) => entry.text)).toContain(en.agentControlUnavailable)
  locale = chinese
  const after = render(props)
  expect(after.props.open).toBe(true)
  expect(after.props.footer.map((entry) => entry.text)).toContain(zh.agentControlUnavailable)
  expect(after.props.footer.map((entry) => entry.text)).not.toContain(en.agentControlUnavailable)
  expect(runtime.streamEvents).toEqual(['agent:start:session-source'])
})
