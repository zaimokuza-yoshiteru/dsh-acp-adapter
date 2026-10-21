import { beforeEach, expect, it, vi } from 'vitest'

const stateUpdates = vi.hoisted(() => ({
  hookIndex: 0,
  values: [] as { slot: number; value: unknown }[],
  effects: [] as (() => void)[],
}))
const nativeViews = vi.hoisted(() => ({
  disclosures: [] as Record<string, unknown>[],
  markdown: [] as Record<string, unknown>[],
}))

vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }),
  useEffect: (effect: () => void) => stateUpdates.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const slot = stateUpdates.hookIndex++
    return [initial, (value: unknown) => stateUpdates.values.push({ slot, value })]
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: function Button(props: Record<string, unknown>) {
    return { type: 'button', props }
  },
  MarkdownText: function MarkdownText(props: Record<string, unknown>) {
    nativeViews.markdown.push(props)
    return { type: 'markdown', props }
  },
  IconInfoOutlineMedium: () => null,
  DisclosureRow: function DisclosureRow(props: Record<string, unknown>) {
    nativeViews.disclosures.push(props)
    return { type: 'div', props: { children: props.open ? props.children : null } }
  },
}))

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  defineStore: (declaration: unknown) => declaration,
}))

import {
  AcpPermissionQuestion,
  createAcpPermissionQuestionStore,
  isAcpPermissionQuestion,
} from '../../../src/client/ui/acp-permission-question.ts'

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'question',
    key: 'question:session:one',
    questions: [{ id, question: 'Choose a test label', options: [{ label: 'ALPHA' }, { label: 'BETA' }] }],
    callId: undefined,
    review: undefined,
    subscribe: () => () => {},
    snapshot: () => ({ channel: 'waterfall', closed: false }),
    answer: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => {}),
    liveKeys: () => ['question:session:one'],
    ...overrides,
  }
}

function buttons(tree: unknown): Array<{ props: Record<string, unknown>; text: string }> {
  const found: Array<{ props: Record<string, unknown>; text: string }> = []
  const render = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(render)
    if (typeof node !== 'object' || node === null) return node
    const element = node as { type?: unknown; props?: Record<string, unknown> }
    if (typeof element.type === 'function') {
      stateUpdates.hookIndex = 0
      return render(element.type(element.props ?? {}))
    }
    const children = render(element.props?.children)
    const rendered = { ...element, props: { ...(element.props ?? {}), children } }
    if (element.type === 'button') {
      found.push({ props: rendered.props, text: textContent(children) })
    }
    return rendered
  }
  const textContent = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(textContent).join('')
    if (typeof node !== 'object' || node === null) return ''
    return textContent((node as { props?: Record<string, unknown> }).props?.children)
  }
  render(tree)
  return found
}

type DraftState = { byRequest: Record<string, { selectedByQuestion: Record<string, string | undefined> }> }

function storeSpec() {
  return createAcpPermissionQuestionStore() as unknown as {
    init: () => DraftState
    actions: {
      select: (draft: DraftState, id: string, label: string) => void
      clear: (draft: DraftState, id: string) => void
    }
  }
}

function renderQuestion(pending: ReturnType<typeof candidate>, chosen?: string, stored?: DraftState) {
  const store = storeSpec()
  const state: DraftState = stored ?? {
    byRequest:
      chosen === undefined
        ? {}
        : { [pending.questions[0]!.id]: { selectedByQuestion: { [pending.questions[0]!.id]: chosen } } },
  }
  const actions = {
    select: vi.fn((id: string, label: string) => store.actions.select(state, id, label)),
    clear: vi.fn((id: string) => store.actions.clear(state, id)),
  }
  const tree = AcpPermissionQuestion({
    matched: pending,
    t: (key: string) => key,
    useStore: (select: (state: { byRequest: Record<string, unknown> }) => unknown) => select(state),
    actions,
  } as never)
  return { tree, actions, state }
}

beforeEach(() => {
  vi.clearAllMocks()
  stateUpdates.hookIndex = 0
  stateUpdates.values.length = 0
  stateUpdates.effects.length = 0
  nativeViews.disclosures.length = 0
  nativeViews.markdown.length = 0
})

it('keeps current request details secondary without hiding legacy operations', () => {
  const detail = 'Command:\n\n```\nprintf exact-operation\n```'
  const pending = candidate('acp-permission:permission-1', {
    questions: [
      {
        id: 'acp-permission:permission-1',
        question: 'printf exact-operation',
        detail,
        header: 'Worker',
        options: [{ label: 'ALPHA' }],
      },
    ],
  })
  buttons(renderQuestion(pending).tree)
  expect(nativeViews.disclosures[0]).toMatchObject({ open: false, title: 'acpQuestionDetails', expandOnRowClick: true })
  expect(nativeViews.markdown).toEqual([])
  const legacy = candidate('acp-permission:permission-2', {
    questions: [
      { id: 'acp-permission:permission-2', question: 'Permission required', detail, options: [{ label: 'ALPHA' }] },
    ],
  })
  buttons(renderQuestion(legacy).tree)
  expect(nativeViews.disclosures[1]).toMatchObject({ open: true })
  expect(nativeViews.markdown[0]).toMatchObject({ text: detail, variant: 'compact' })
})

it('keys transient card state by the actual Host question when a native presentation slot is reused', () => {
  const root = candidate('acp-permission:root-spawn')
  const child = candidate('acp-permission:child-command', { key: root.key })
  const surfaceKey = (pending: ReturnType<typeof candidate>) =>
    (renderQuestion(pending).tree as unknown as { props: { children: { props: { key: string } } } }).props.children
      .props.key
  expect(surfaceKey(root)).toBe('acp-permission:root-spawn')
  expect(surfaceKey(child)).toBe('acp-permission:child-command')
})

it('claims only blocking ACP fixed-choice questions and leaves ordinary DSH questions to the native composer', () => {
  expect(isAcpPermissionQuestion(candidate('acp-permission:permission-1'))).toBe(true)
  expect(isAcpPermissionQuestion(candidate('ask_user_question:question-1'))).toBe(false)
  expect(isAcpPermissionQuestion(candidate('acp-permission:permission-1', { callId: 'call-1' }))).toBe(false)
  expect(
    isAcpPermissionQuestion(
      candidate('acp-permission:permission-1', {
        questions: [{ id: 'acp-permission:permission-1', question: 'Choose', options: [], multiSelect: true }],
      }),
    ),
  ).toBe(false)
  expect(
    isAcpPermissionQuestion(
      candidate('acp-permission:permission-1', {
        questions: [null],
      }),
    ),
  ).toBe(false)
  expect(
    isAcpPermissionQuestion(
      candidate('acp-permission:permission-1', {
        questions: [{ id: 'acp-permission:permission-1', question: 'Choose', options: [null] }],
      }),
    ),
  ).toBe(false)
  expect(isAcpPermissionQuestion(candidate('acp-permission:permission-1', { liveKeys: undefined }))).toBe(true)
})

it('keeps concurrent drafts separate by Host request ID and clears only the settled request', () => {
  const store = storeSpec()
  const draft = store.init()
  store.actions.select(draft, 'acp-permission:a', 'ALPHA')
  store.actions.select(draft, 'acp-permission:b', 'BETA')
  expect(draft.byRequest['acp-permission:a']?.selectedByQuestion['acp-permission:a']).toBe('ALPHA')
  expect(draft.byRequest['acp-permission:b']?.selectedByQuestion['acp-permission:b']).toBe('BETA')
  store.actions.clear(draft, 'acp-permission:a')
  expect(draft.byRequest).toEqual({
    'acp-permission:b': { selectedByQuestion: { 'acp-permission:b': 'BETA' } },
  })
})

it('restores the same Host request after a new native card key without answering or sharing its choice', () => {
  const store = storeSpec()
  const draft = store.init()
  store.actions.select(draft, 'acp-permission:a', 'ALPHA')
  store.actions.select(draft, 'acp-permission:b', 'BETA')
  const rehydrated = JSON.parse(JSON.stringify(draft)) as DraftState
  for (const [id, label] of [
    ['a', 'ALPHA'],
    ['b', 'BETA'],
  ]) {
    const pending = candidate(`acp-permission:${id}`, { key: `question:new-client:${id}` })
    const rendered = buttons(renderQuestion(pending, undefined, rehydrated).tree)
    expect(rendered.find((button) => button.props['aria-label'] === label)?.props['aria-checked']).toBe(true)
    expect(pending.answer).not.toHaveBeenCalled()
  }
  const unrelated = candidate('acp-permission:c', { key: 'question:new-client:a' })
  const rendered = buttons(renderQuestion(unrelated, undefined, rehydrated).tree)
  expect(
    rendered.filter((button) => button.props.role === 'radio').map((button) => button.props['aria-checked']),
  ).toEqual([false, false])
  expect(rendered.find((button) => button.text === 'acpQuestionSubmit')?.props.disabled).toBe(true)
  expect(unrelated.answer).not.toHaveBeenCalled()
})

it('retains only 128 most recently selected stable requests and drops legacy render-key records', () => {
  const store = storeSpec()
  const draft = store.init()
  draft.byRequest['question:old-client:1'] = { selectedByQuestion: { 'acp-permission:legacy': 'ALPHA' } }
  for (let index = 0; index < 128; index++) store.actions.select(draft, `acp-permission:${index}`, 'ALPHA')
  store.actions.select(draft, 'acp-permission:0', 'BETA')
  store.actions.select(draft, 'acp-permission:new', 'ALPHA')
  expect(Object.keys(draft.byRequest)).toHaveLength(128)
  expect(draft.byRequest).not.toHaveProperty('question:old-client:1')
  expect(draft.byRequest).not.toHaveProperty('acp-permission:1')
  expect(draft.byRequest['acp-permission:0']?.selectedByQuestion['acp-permission:0']).toBe('BETA')
  expect(Object.keys(draft.byRequest).at(-1)).toBe('acp-permission:new')
})

it('does not transfer a root choice to a child card with identical labels, even when its presentation key is reused', async () => {
  const root = candidate('acp-permission:root-spawn')
  const child = candidate('acp-permission:child-command', { key: root.key })
  const rootView = renderQuestion(root, 'BETA')
  const rootSubmit = buttons(rootView.tree).find((button) => button.text === 'acpQuestionSubmit')!
  const childView = renderQuestion(child, undefined, rootView.state)
  const childButtons = buttons(childView.tree)
  expect(
    childButtons.filter((button) => button.props.role === 'radio').map((button) => button.props['aria-checked']),
  ).toEqual([false, false])
  expect(childButtons.find((button) => button.text === 'acpQuestionSubmit')?.props.disabled).toBe(true)
  ;(rootSubmit.props.onClick as () => void)()
  await Promise.resolve()
  expect(root.answer).toHaveBeenCalledExactlyOnceWith({
    answers: [{ id: 'acp-permission:root-spawn', selected: ['BETA'] }],
  })
  expect(child.answer).not.toHaveBeenCalled()
  expect(child.dismiss).not.toHaveBeenCalled()
})

it('does not restore a saved label that the same request no longer offers', () => {
  const pending = candidate('acp-permission:a')
  const rendered = buttons(renderQuestion(pending, 'UNRECOGNIZED').tree)
  expect(
    rendered
      .filter((button) => button.props.role === 'radio')
      .every((button) => button.props['aria-checked'] === false),
  ).toBe(true)
  expect(rendered.find((button) => button.text === 'acpQuestionSubmit')?.props.disabled).toBe(true)
  expect(pending.answer).not.toHaveBeenCalled()
})

it.each(['submit', 'cancel'] as const)(
  'clears a successfully %s request before a subsequent request can restore a draft',
  async (action) => {
    const pending = candidate('acp-permission:a')
    const view = renderQuestion(pending, 'ALPHA')
    const rendered = buttons(view.tree)
    const label = action === 'submit' ? 'acpQuestionSubmit' : 'acpQuestionCancel'
    ;(rendered.find((button) => button.text === label)?.props.onClick as () => void)()
    await Promise.resolve()
    expect(view.actions.clear).toHaveBeenCalledWith('acp-permission:a')
    expect(view.state.byRequest).toEqual({})
    const next = candidate('acp-permission:new', { key: pending.key })
    const nextButtons = buttons(renderQuestion(next, undefined, view.state).tree)
    expect(nextButtons.find((button) => button.text === 'acpQuestionSubmit')?.props.disabled).toBe(true)
    expect(next.answer).not.toHaveBeenCalled()
  },
)

it('clears an observed closed request by its Host ID rather than its native presentation key', () => {
  const pending = candidate('acp-permission:a', { snapshot: () => ({ channel: 'none', closed: true }) })
  const view = renderQuestion(pending, 'ALPHA')
  buttons(view.tree)
  for (const effect of stateUpdates.effects) effect()
  expect(view.actions.clear).toHaveBeenCalledExactlyOnceWith('acp-permission:a')
  expect(view.state.byRequest).toEqual({})
})

it('waits for an explicit option and submits its exact offered label', async () => {
  const pending = candidate('acp-permission:permission-1')
  const initial = buttons(renderQuestion(pending).tree)
  expect(initial.map((button) => button.text)).toContain('acpQuestionSubmit')
  expect(initial.find((button) => button.text === 'acpQuestionSubmit')?.props.disabled).toBe(true)
  expect(initial.some((button) => button.text.includes('Other'))).toBe(false)
  ;(initial.find((button) => button.text.includes('BETA'))?.props.onClick as () => void)()
  expect(pending.answer).not.toHaveBeenCalled()

  const chosen = buttons(renderQuestion(pending, 'BETA').tree)
  ;(chosen.find((button) => button.text === 'acpQuestionSubmit')?.props.onClick as () => void)()
  await Promise.resolve()
  expect(pending.answer).toHaveBeenCalledWith({
    answers: [{ id: 'acp-permission:permission-1', selected: ['BETA'] }],
  })
})

it('uses one roving radio tab stop and moves focus/selection with arrows, Home, and End without submitting', () => {
  const pending = candidate('acp-permission:permission-1')
  const { tree, actions } = renderQuestion(pending)
  const radios = buttons(tree).filter((button) => button.props.role === 'radio')
  expect(radios.map((radio) => radio.props.tabIndex)).toEqual([0, -1])
  expect(radios.map((radio) => radio.props['aria-checked'])).toEqual([false, false])
  expect(radios.map((radio) => radio.props.type)).toEqual(['button', 'button'])
  expect(radios.map((radio) => radio.props['aria-label'])).toEqual(['ALPHA', 'BETA'])

  const alphaFocus = vi.fn()
  const betaFocus = vi.fn()
  ;(radios[0]!.props.ref as (element: unknown) => void)({ focus: alphaFocus })
  ;(radios[1]!.props.ref as (element: unknown) => void)({ focus: betaFocus })
  const press = (radio: (typeof radios)[number], key: string) => {
    let prevented = false
    ;(radio.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({
      key,
      preventDefault: () => {
        prevented = true
      },
    })
    return prevented
  }

  expect(press(radios[0]!, 'ArrowDown')).toBe(true)
  expect(betaFocus).toHaveBeenCalledOnce()
  expect(actions.select).toHaveBeenLastCalledWith('acp-permission:permission-1', 'BETA')
  expect(press(radios[1]!, 'ArrowRight')).toBe(true)
  expect(alphaFocus).toHaveBeenCalledOnce()
  expect(actions.select).toHaveBeenLastCalledWith('acp-permission:permission-1', 'ALPHA')
  expect(press(radios[1]!, 'Home')).toBe(true)
  expect(press(radios[0]!, 'End')).toBe(true)
  expect(actions.select).toHaveBeenLastCalledWith('acp-permission:permission-1', 'BETA')
  expect(pending.answer).not.toHaveBeenCalled()
})

it('shows localized failure feedback without exposing provider error messages', async () => {
  const pending = candidate('acp-permission:permission-1', {
    answer: vi.fn(async () => {
      throw new Error('provider secret detail')
    }),
  })
  const submit = buttons(renderQuestion(pending, 'ALPHA').tree).find((button) => button.text === 'acpQuestionSubmit')
  ;(submit?.props.onClick as () => void)()
  await Promise.resolve()
  await Promise.resolve()
  expect(stateUpdates.values).toContainEqual({ slot: 1, value: true })
  expect(stateUpdates.values).toContainEqual({ slot: 0, value: false })
  expect(stateUpdates.values.map((update) => update.value)).not.toContain('provider secret detail')
})
