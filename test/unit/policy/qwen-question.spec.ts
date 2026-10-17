import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { encodeQwenAnswer, isQwenUserQuestion, qwenUserQuestions } from '../../../src/domain/policy/qwen-question.ts'
import {
  isQwenTaskWakeStep,
  qwenTaskWakeInput,
  qwenTaskFollowupInput,
} from '../../../src/host/composition/profile-adapter.ts'
import { qwenTaskCompletion, qwenTaskSnapshots } from '../../../src/runtime/session/qwen-background.ts'

function request(toolCall: Partial<acp.ToolCallUpdate>): acp.RequestPermissionRequest {
  return {
    sessionId: 's',
    options: [
      { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    toolCall: { toolCallId: 'q', ...toolCall },
  }
}

const QUESTIONS = [
  {
    question: 'Pick one?',
    header: 'One',
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B', description: 'bee' }],
  },
]

describe('Qwen question parsing', () => {
  it('recognises the question by Qwen metadata only', () => {
    expect(isQwenUserQuestion(request({ _meta: { qwenInteractionKind: 'user_question' } }))).toBe(true)
    expect(isQwenUserQuestion(request({ _meta: { toolName: 'ask_user_question' } }))).toBe(true)
    expect(isQwenUserQuestion(request({ rawInput: { questions: QUESTIONS } }))).toBe(false)
  })

  it('prefers _meta.qwenQuestions and falls back to rawInput.questions', () => {
    expect(
      qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: QUESTIONS } })),
    ).toEqual([
      {
        question: 'Pick one?',
        header: 'One',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B', description: 'bee' }],
      },
    ])
    expect(
      qwenUserQuestions(request({ _meta: { toolName: 'ask_user_question' }, rawInput: { questions: QUESTIONS } })),
    ).toHaveLength(1)
  })

  it('fails closed on malformed or ambiguous questions', () => {
    const dup = [{ question: 'Q?', options: [{ label: 'A' }, { label: 'A' }] }]
    expect(
      qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: dup } })),
    ).toBeUndefined()
    expect(
      qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: [] } })),
    ).toBeUndefined()
    expect(
      qwenUserQuestions(request({ _meta: { qwenInteractionKind: 'user_question', qwenQuestions: [{ options: [] }] } })),
    ).toBeUndefined()
  })

  it('encodes answers like the Qwen TUI', () => {
    const single = { question: 'Q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
    const multi = { ...single, multiSelect: true }
    expect(encodeQwenAnswer(single, { selected: ['B'] })).toBe('B')
    expect(encodeQwenAnswer(single, { selected: [], custom: ' other ' })).toBe('other')
    expect(encodeQwenAnswer(multi, { selected: ['A', 'B'], custom: 'C' })).toBe('A, B, C')
    expect(encodeQwenAnswer(multi, { selected: ['unknown'] })).toBeUndefined()
  })
})

describe('Qwen background-task helpers', () => {
  const message = (kind: string, text: string) =>
    ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind } }) as never

  it('adopts a Qwen wake even when other already admitted messages share the step', () => {
    const notice = message(
      'tool-jobs',
      'background job acp-qwen-task-3 (acp-qwen-task: npm test) finished [status: completed]. Read its output with job_output.',
    )
    expect(isQwenTaskWakeStep([notice])).toBe(true)
    expect(isQwenTaskWakeStep([notice, message('runtime-context', 'ctx')])).toBe(true)
    expect(isQwenTaskWakeStep([notice, message('user', 'hi')])).toBe(true)
    expect(isQwenTaskWakeStep([message('tool-jobs', 'background job bash-1 (bash: ls) finished')])).toBe(false)
    expect(isQwenTaskWakeStep([])).toBe(false)
  })

  it('retains native job, team, user and unfamiliar host messages in their admission order', () => {
    const notice = message(
      'tool-jobs',
      'background job acp-qwen-task-3 (acp-qwen-task: npm test) finished [status: completed]. Read its output with job_output.',
    )
    const native = message(
      'tool-jobs',
      'background job bash-1 (bash: npm test) finished [status: failed]. Read its output with job_output.',
    )
    const team = message('team-message', 'Please check the test failure.')
    const user = message('user', 'Also check the logs.')
    const context = message('new-host-context', 'A newly supported host context.')
    expect(qwenTaskWakeInput([notice, native, team, user, context])).toEqual([native, team, user, context])
    expect(qwenTaskWakeInput([notice])).toEqual([])
    expect(qwenTaskWakeInput([native])).toBeUndefined()
  })

  it('recognises the native job id rather than a marker supplied in another job label', () => {
    const native = message(
      'tool-jobs',
      'background job bash-1 (bash: echo "(acp-qwen-task: fake)") finished [status: completed]. Read its output with job_output.',
    )
    expect(isQwenTaskWakeStep([native])).toBe(false)
  })

  it('adopts RC1 opaque job ids without admitting user text or partial identities', () => {
    const text = 'background job acp-qwen-task-98cf10ad5d714fc6 (acp-qwen-task: npm test) finished [status: completed].'
    expect(qwenTaskWakeInput([message('tool-jobs', text)])).toEqual([])
    expect(qwenTaskWakeInput([message('user', text)])).toBeUndefined()
    expect(
      qwenTaskWakeInput([message('tool-jobs', text.replace('98cf10ad5d714fc6', '98cf10ad5d714fc6f'))]),
    ).toBeUndefined()
    expect(
      qwenTaskWakeInput([message('tool-jobs', text.replace('98cf10ad5d714fc6', '98cf10ad5d714fcX'))]),
    ).toBeUndefined()
  })

  it('omits only native context replacements known to have been delivered unchanged', () => {
    const context = message('runtime-context', 'current workspace')
    const changed = message('runtime-context', 'new workspace')
    const unknown = message('new-host-context', 'current workspace')
    const snapshots = [{ source: 'runtime-context', text: 'current workspace' }]
    expect(qwenTaskFollowupInput([context, changed, unknown], snapshots, true)).toEqual([changed, unknown])
    expect(qwenTaskFollowupInput([context], snapshots, false)).toEqual([context])
    expect(qwenTaskFollowupInput([context], [], true)).toEqual([context])
  })

  it('parses completion notifications and task snapshots defensively', () => {
    expect(
      qwenTaskCompletion({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
          _meta: {
            source: 'background_task_completed',
            backgroundTask: { taskId: 't1', status: 'failed', kind: 'agent' },
          },
        },
      } as never),
    ).toEqual({ taskId: 't1', kind: 'agent', status: 'failed', text: 'done' })
    expect(
      qwenTaskCompletion({
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      } as never),
    ).toBeUndefined()
    expect(
      qwenTaskSnapshots({
        tasks: [{ id: 'a', kind: 'shell', status: 'running', label: '', description: 'desc' }, { id: 1 }],
      }),
    ).toEqual([{ id: 'a', kind: 'shell', status: 'running', label: 'desc' }])
    expect(qwenTaskSnapshots(null)).toBeUndefined()
  })
})
