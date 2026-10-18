import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'
import type { AgentControlChoice } from '../../../src/client/ui/agent-session-controls.ts'

const runtime = vi.hoisted(() => ({
  cursor: 0,
  cells: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
}))

// Run the component's actual handlers and effect cleanup around a held RPC.
// The browser scenario owns native React rendering and navigation geometry.
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props }),
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
  configOptions: null,
  contextUsage: null,
  note: null,
})

vi.mock('../../../src/client/data/agent-session-stream.ts', () => ({
  agentSessionStream: (_remote: unknown, _factory: unknown, sessionId: string, changed: (value: unknown) => void) => ({
    start: () => changed(agentSnapshot(sessionId)),
    dispose: async () => {},
  }),
}))
vi.mock('../../../src/client/data/tool-approval-policy-stream.ts', () => ({
  toolApprovalPolicyStream: (
    _remote: unknown,
    _factory: unknown,
    sessionId: string,
    changed: (value: unknown) => void,
  ) => ({
    start: () => changed({ sessionId, policy: 'auto', source: 'session', editable: true }),
    dispose: async () => {},
  }),
}))

import { AcpAgentControl } from '../../../src/client/ui/AcpAgentControl.ts'
import { AcpOutcomeToast } from '../../../src/client/ui/AcpOutcomeToast.ts'
import { AcpUiFeedback } from '../../../src/client/data/feedback.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

type Props = ComponentProps<typeof AcpAgentControl>
type Menu = {
  props: {
    disabled: boolean
    footer: readonly { text: string }[]
    groups: readonly { choices: readonly AgentControlChoice[] }[]
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

function setup() {
  let resolve!: (response: Response) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<Response>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  const remote = {
    setAgentSessionOption: vi.fn((_sessionId: string, _request: unknown) => pending),
    setToolApprovalPolicy: vi.fn((_sessionId: string, _request: unknown) => pending),
  }
  const feedback = new AcpUiFeedback()
  const report = vi.spyOn(feedback, 'report')
  let permitted = true
  const props = {
    sessionId: 'session-source',
    useProjection: (key: string) =>
      key === 'title'
        ? 'Source conversation'
        : { lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } },
    useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running: false }),
    useAccess: () => permitted,
    sessionAccessSource: () => ({ getSnapshot: () => permitted }),
    t: english,
    remote,
    streamFactory: {},
    ownsRoute: (provider: string | undefined) => provider === 'acp-codex',
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

function choice(menu: Menu, operation: 'option' | 'policy'): AgentControlChoice {
  return menu.props.groups
    .flatMap((group) => group.choices)
    .find((entry) => entry.id === (operation === 'option' ? 'mode:plan' : 'tool-approval:ask'))!
}

beforeEach(() => {
  runtime.cursor = 0
  runtime.cells = []
  runtime.effects = []
  runtime.cleanups.clear()
})
afterEach(() => {
  for (const cleanup of runtime.cleanups.values()) cleanup()
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

describe.each(['option', 'policy'] as const)('late %s write feedback', (operation) => {
  it.each([
    ['session', 'response'],
    ['session', 'rejection'],
    ['locale', 'response'],
    ['locale', 'rejection'],
  ] as const)('survives a %s change and a %s failure without updating the new view', async (change, failure) => {
    const fixture = setup()
    const initial = render(fixture.props)
    const selected = choice(initial, operation)
    expect(selected.disabled).toBe(false)
    initial.props.onSelect(selected)
    const rpc = operation === 'option' ? fixture.remote.setAgentSessionOption : fixture.remote.setToolApprovalPolicy
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
    render(next)
    expect(fixture.report).not.toHaveBeenCalled()
    if (failure === 'response') fixture.resolve({ ok: false, error: { message: 'PRIVATE_RPC_FAILURE' } })
    else fixture.reject(new Error('PRIVATE_RPC_FAILURE'))
    await vi.waitFor(() => expect(fixture.report).toHaveBeenCalledOnce())

    const current = render(next)
    expect(current.props.disabled).toBe(false)
    expect(current.props.footer.some((entry) => entry.text.includes('PRIVATE_RPC_FAILURE'))).toBe(false)
    expect(choice(current, operation).current).toBe(false)
    expect(fixture.feedback.getSnapshot()).toMatchObject({
      outcome: operation === 'option' ? 'session-option-failed' : 'tool-approval-failed',
      sourceSession: { id: 'session-source', title: 'Source conversation' },
    })
    const toast = AcpOutcomeToast({ feedback: fixture.feedback, t: next.t }) as { props: { text: string } }
    expect(toast.props.text).toContain('Source conversation')
    expect(toast.props.text).toContain(
      change === 'locale' ? '请重试' : operation === 'option' ? 'Try again' : 'Please retry',
    )
    expect(toast.props.text).not.toContain('PRIVATE_RPC_FAILURE')
    expect(render(fixture.props).props.footer.some((entry) => entry.text.includes('PRIVATE_RPC_FAILURE'))).toBe(false)
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rechecks native write access before sending the selected operation', () => {
    const fixture = setup()
    const menu = render(fixture.props)
    fixture.revoke()
    menu.props.onSelect(choice(menu, operation))
    expect(fixture.remote.setAgentSessionOption).not.toHaveBeenCalled()
    expect(fixture.remote.setToolApprovalPolicy).not.toHaveBeenCalled()
    expect(fixture.report).not.toHaveBeenCalled()
  })
})
