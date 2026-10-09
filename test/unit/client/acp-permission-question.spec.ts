import { beforeEach, expect, it, vi } from 'vitest'

const stateUpdates = vi.hoisted(() => ({ hookIndex: 0, values: [] as { slot: number; value: unknown }[] }))

vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }),
  useEffect: () => undefined,
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
    return { type: 'markdown', props }
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

function renderQuestion(pending: ReturnType<typeof candidate>, chosen?: string) {
  const actions = { select: vi.fn(), clear: vi.fn(), prune: vi.fn() }
  const tree = AcpPermissionQuestion({
    matched: pending,
    t: (key: string) => key,
    useStore: (select: (state: { byRequest: Record<string, unknown> }) => unknown) =>
      select({
        byRequest:
          chosen === undefined
            ? {}
            : {
                [pending.key]: { selectedByQuestion: { [pending.questions[0]!.id]: chosen } },
              },
      }),
    actions,
  } as never)
  return { tree, actions }
}

beforeEach(() => {
  vi.clearAllMocks()
  stateUpdates.hookIndex = 0
  stateUpdates.values.length = 0
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
  expect(isAcpPermissionQuestion(candidate('acp-permission:permission-1', { liveKeys: undefined }))).toBe(false)
})

it('keeps drafts separate by pending key and prunes requests that are no longer live', () => {
  type Draft = { byRequest: Record<string, { selectedByQuestion: Record<string, string | undefined> }> }
  const store = createAcpPermissionQuestionStore() as unknown as {
    init: () => Draft
    actions: {
      select: (draft: Draft, key: string, id: string, label: string) => void
      prune: (draft: Draft, keep: readonly string[]) => void
    }
  }
  const draft = store.init()
  store.actions.select(draft, 'session-a:request', 'acp-permission:a', 'ALPHA')
  store.actions.select(draft, 'session-b:request', 'acp-permission:b', 'BETA')
  expect(draft.byRequest['session-a:request']?.selectedByQuestion['acp-permission:a']).toBe('ALPHA')
  expect(draft.byRequest['session-b:request']?.selectedByQuestion['acp-permission:b']).toBe('BETA')
  store.actions.prune(draft, ['session-b:request'])
  expect(draft.byRequest).toEqual({
    'session-b:request': { selectedByQuestion: { 'acp-permission:b': 'BETA' } },
  })
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
  expect(actions.select).toHaveBeenLastCalledWith(pending.key, 'acp-permission:permission-1', 'BETA')
  expect(press(radios[1]!, 'ArrowRight')).toBe(true)
  expect(alphaFocus).toHaveBeenCalledOnce()
  expect(actions.select).toHaveBeenLastCalledWith(pending.key, 'acp-permission:permission-1', 'ALPHA')
  expect(press(radios[1]!, 'Home')).toBe(true)
  expect(press(radios[0]!, 'End')).toBe(true)
  expect(actions.select).toHaveBeenLastCalledWith(pending.key, 'acp-permission:permission-1', 'BETA')
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
