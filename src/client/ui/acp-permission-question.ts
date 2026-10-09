/** Fixed-choice composer for ACP permission questions carried by DSH. */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import css from './AcpPermissionQuestion.module.css'

interface AcpPermissionQuestionOption {
  readonly label: string
}

interface AcpPermissionQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly options?: readonly AcpPermissionQuestionOption[]
  readonly multiSelect?: boolean
}

interface AcpPermissionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[]
}

interface AcpPermissionSnapshot {
  readonly channel: 'waterfall' | 'rpc' | 'none'
  readonly closed: boolean
}

/** Public capability surface used here; no PendingQuestion class dependency. */
interface AcpPermissionPendingQuestion extends SessionPendingInteractionBase {
  readonly kind: 'question'
  readonly questions: readonly AcpPermissionQuestionItem[]
  readonly callId: unknown
  readonly review: unknown
  subscribe(listener: () => void): () => void
  snapshot(): AcpPermissionSnapshot
  liveKeys(): readonly string[]
  answer(answer: AcpPermissionAnswer): Promise<void>
  dismiss(): Promise<void>
}

interface PermissionQuestionDraft {
  selectedByQuestion: Record<string, string | undefined>
}

interface PermissionQuestionState {
  byRequest: Record<string, PermissionQuestionDraft>
}

type PermissionQuestionActions = {
  select: (draft: PermissionQuestionState, requestKey: string, questionId: string, label: string) => void
  clear: (draft: PermissionQuestionState, requestKey: string) => void
  prune: (draft: PermissionQuestionState, keep: readonly string[]) => void
}

/** Keep choices while the user switches between DSH sessions. */
export function createAcpPermissionQuestionStore(): EngineStoreHandle<
  PermissionQuestionState,
  PermissionQuestionActions
> {
  return defineStore({
    init: (): PermissionQuestionState => ({ byRequest: {} }),
    persist: 'dsh.acp-permission.questions.v1',
    actions: {
      select: (draft, requestKey, questionId, label) => {
        const request = draft.byRequest[requestKey] ?? { selectedByQuestion: {} }
        request.selectedByQuestion[questionId] = label
        draft.byRequest[requestKey] = request
      },
      clear: (draft, requestKey) => {
        delete draft.byRequest[requestKey]
      },
      prune: (draft, keep) => {
        const live = new Set(keep)
        draft.byRequest = Object.fromEntries(Object.entries(draft.byRequest).filter(([key]) => live.has(key)))
      },
    },
  })
}

/** Match only the blocking, fixed-option questions created by this adapter. */
export function isAcpPermissionQuestion(value: unknown): value is AcpPermissionPendingQuestion {
  if (typeof value !== 'object' || value === null) return false
  const pending = value as Partial<AcpPermissionPendingQuestion>
  const isRecord = (input: unknown): input is Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
  return (
    pending.kind === 'question' &&
    typeof pending.key === 'string' &&
    pending.key.length > 0 &&
    Array.isArray(pending.questions) &&
    pending.questions.length === 1 &&
    pending.questions.every((question: unknown) => {
      if (!isRecord(question) || typeof question.id !== 'string' || !question.id.startsWith('acp-permission:'))
        return false
      if (!Array.isArray(question.options) || question.options.length === 0 || question.multiSelect === true)
        return false
      return question.options.every(
        (option: unknown) => isRecord(option) && typeof option.label === 'string' && option.label.length > 0,
      )
    }) &&
    pending.callId === undefined &&
    pending.review === undefined &&
    typeof pending.subscribe === 'function' &&
    typeof pending.snapshot === 'function' &&
    typeof pending.answer === 'function' &&
    typeof pending.dismiss === 'function' &&
    typeof pending.liveKeys === 'function'
  )
}

type Props = PropsRuntime<'conversation.composer'> &
  PropsStore<ReturnType<typeof createAcpPermissionQuestionStore>> &
  PropsLocale<'acpActivity'> & { matched: AcpPermissionPendingQuestion }

function answerable(pending: AcpPermissionPendingQuestion): boolean {
  const snapshot = pending.snapshot()
  return snapshot.channel !== 'none' && !snapshot.closed && pending.review === undefined
}

/** An explicit, fixed-option answer surface; no free-text or implicit choice. */
export function AcpPermissionQuestion(props: Props) {
  return h('div', { className: css.frame }, h(PermissionQuestionSurface, { ...props, key: props.matched.key }))
}

function PermissionQuestionSurface(props: Props) {
  const pending = props.matched
  const snapshot = useSyncExternalStore(pending.subscribe, pending.snapshot, pending.snapshot)
  const draft = props.useStore((state) => state.byRequest[pending.key])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const canAnswer = snapshot.channel !== 'none' && !snapshot.closed && pending.review === undefined
  const selected = draft?.selectedByQuestion ?? {}
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const question = pending.questions[0]!
  const options = question.options ?? []
  const selectedIndex = options.findIndex((option) => selected[question.id] === option.label)
  const [focusedIndex, setFocusedIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0)
  const complete = pending.questions.every(
    (question) => question.options?.some((option) => option.label === selected[question.id]) === true,
  )

  useEffect(() => {
    if (snapshot.closed) {
      props.actions.clear(pending.key)
      setBusy(false)
    }
    props.actions.prune(pending.liveKeys())
  }, [pending, props.actions, snapshot.closed])

  const submit = async (): Promise<void> => {
    if (busy || !complete || !answerable(pending)) return
    const answers: AcpPermissionAnswer['answers'] = pending.questions.map((question) => ({
      id: question.id,
      selected: [selected[question.id] as string],
    }))
    setBusy(true)
    setFailed(false)
    try {
      await pending.answer({ answers })
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (busy || !answerable(pending)) return
    setBusy(true)
    setFailed(false)
    try {
      await pending.dismiss()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  const moveFocus = (index: number, event: { preventDefault(): void }) => {
    if (!canAnswer || busy || options.length === 0) return
    event.preventDefault()
    const next = (index + options.length) % options.length
    const option = options[next]!
    setFocusedIndex(next)
    props.actions.select(pending.key, question.id, option.label)
    setFailed(false)
    optionRefs.current[next]?.focus()
  }

  const onOptionKeyDown = (index: number, event: { key: string; preventDefault(): void }) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        moveFocus(index + 1, event)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        moveFocus(index - 1, event)
        break
      case 'Home':
        moveFocus(0, event)
        break
      case 'End':
        moveFocus(options.length - 1, event)
        break
    }
  }

  return h(
    'section',
    {
      className: css.card,
      'aria-label': pending.questions[0]!.question,
      'data-question-key': pending.key,
    },
    h('header', { className: css.header }, h('h2', { className: css.heading }, question.question)),
    h(
      'div',
      { className: css.content, 'data-question-scroll': '' },
      ...pending.questions.map((question) =>
        h(
          'div',
          { className: css.question, key: question.id },
          question.detail
            ? h(MarkdownText, {
                text: question.detail,
                labels: {
                  code: {
                    copyLabel: props.t('acpQuestionCopy'),
                    copiedLabel: props.t('acpQuestionCopied'),
                  },
                  footnotes: props.t('acpQuestionFootnotes'),
                },
              })
            : null,
          h(
            'div',
            { className: css.options, role: 'radiogroup', 'aria-label': question.question },
            ...(question.options ?? []).map((option, optionIndex) => {
              const checked = selected[question.id] === option.label
              return h(
                'button',
                {
                  key: `${option.label}:${optionIndex}`,
                  type: 'button',
                  className: css.option,
                  role: 'radio',
                  'aria-checked': checked,
                  'aria-label': option.label,
                  tabIndex: optionIndex === focusedIndex ? 0 : -1,
                  ref: (element: HTMLButtonElement | null) => {
                    optionRefs.current[optionIndex] = element
                  },
                  disabled: !canAnswer || busy,
                  onClick: () => {
                    setFocusedIndex(optionIndex)
                    props.actions.select(pending.key, question.id, option.label)
                    setFailed(false)
                  },
                  onFocus: () => setFocusedIndex(optionIndex),
                  onKeyDown: (event: { key: string; preventDefault(): void }) => onOptionKeyDown(optionIndex, event),
                },
                h('span', { className: css.number, 'aria-hidden': true }, String(optionIndex + 1)),
                h('span', { className: css.optionLabel }, option.label),
              )
            }),
          ),
        ),
      ),
    ),
    h(
      'footer',
      { className: css.footer },
      h(
        'p',
        { className: css.status, role: 'status' },
        failed ? props.t('acpQuestionFailed') : canAnswer ? '' : props.t('acpQuestionUnavailable'),
      ),
      h(
        'div',
        { className: css.actions },
        h(
          Button,
          { variant: 'ghost', disabled: !canAnswer || busy, onClick: () => void cancel() },
          props.t('acpQuestionCancel'),
        ),
        h(
          Button,
          {
            variant: 'primary',
            disabled: !canAnswer || busy || !complete,
            onClick: () => void submit(),
          },
          busy ? props.t('acpQuestionSubmitting') : props.t('acpQuestionSubmit'),
        ),
      ),
    ),
  )
}
