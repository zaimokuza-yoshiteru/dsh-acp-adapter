import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { required } from './required.ts'
import type { AdapterWorld } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

/** Run the real timed native tool while an ACP prompt is active, then answer its pending call. */
it('times out the native timed question and steers its late answer into the active ACP session', async () => {
  let host: AdapterWorld | undefined
  let browser: TestBrowser | undefined
  try {
    host = await launchAdapterWorld({ timedAskUser: { timeout: 1 } })
    const events: (SessionEvent & { sessionId: string })[] = []
    host.ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }))
    const agentLog = join(host.workspaceCwd, 'timed-question-agent.log')
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        devin: {
          name: 'Timed question fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await expect.poll(() => host!.ctx.llm.listProviders().some((entry) => entry.id === 'acp-devin')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)

    const turn = host.whenTurnSettled(30_000)
    const composer = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, composer, 'E2E_STEERING_HOLD')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('E2E_STEERING_RUNNING', { exact: true }).waitFor()

    const inputEvent = events.findLast(
      (event) => event.type === 'user/message' && JSON.stringify(event.data).includes('E2E_STEERING_HOLD'),
    )
    if (inputEvent === undefined || inputEvent.type !== 'user/message') throw new Error('missing steering input')
    const agent = required(host.ctx.agents.get(SessionId(inputEvent.sessionId)))
    const schema = required(
      host.ctx.tools.schemas(agent).find((tool) => tool.name === 'ask_user_question'),
    ) as ToolSchema
    expect(schema.parameters).toHaveProperty('properties.timeout')
    const stepEvent = events.findLast((event) => event.type === 'step/start' && event.sessionId === agent.id)
    if (stepEvent === undefined || stepEvent.type !== 'step/start') throw new Error('missing active AgentLoop step')
    const { turn: turnNumber, step: stepNumber } = stepEvent.data
    const recordToolCall = (callId: ReturnType<typeof ToolCallId>, args: object) => {
      agent.session.append('tool/call', {
        turn: turnNumber,
        step: stepNumber,
        callId,
        name: 'ask_user_question',
        arguments: JSON.stringify(args),
      })
    }
    const recordToolResult = (callId: ReturnType<typeof ToolCallId>, content: ContentBlock[], isError: boolean) => {
      agent.session.append(
        'tool/result',
        {
          turn: turnNumber,
          step: stepNumber,
          message: createToolResultMessage({ callId, content, isError }),
        },
        { surfaceOp: 'append' },
      )
    }

    const callId = ToolCallId(`timed-late-${Date.now()}`)
    const args = {
      timeout: 1,
      questions: [{ id: 'continue', question: 'May I continue?', options: [{ label: 'Yes' }] }],
    }
    recordToolCall(callId, args)

    const pending = await host.ctx.tools.execute({
      callId,
      name: 'ask_user_question',
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    expect(pending.isError).toBe(false)
    if (pending.isError) throw pending.error
    expect(pending.value).toMatchObject({ pending: true, callId })
    recordToolResult(callId, pending.content, false)

    const answer = { answers: [{ id: 'continue', selected: ['Yes'], custom: 'E2E_INPUT_REWRITTEN' }] }
    const userQuestions = (
      host.ctx as typeof host.ctx & {
        userQuestions: { answer: (owner: object, id: ToolCallId, value: typeof answer) => boolean }
      }
    ).userQuestions
    expect(userQuestions.answer(agent, ToolCallId('unrelated-call'), answer)).toBe(false)
    expect(userQuestions.answer(agent, callId, answer)).toBe(true)
    expect(() => userQuestions.answer(agent, callId, answer)).toThrow(expect.objectContaining({ code: 'REPLY_QUEUED' }))

    const sessionId = await turn
    expect(sessionId).toBe(agent.id)
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    const mockLog = await readFile(agentLog, 'utf8')
    const promptRecords = [...mockLog.matchAll(/regression prompt=(.*) model=.* session=(\S+)/g)]
    expect(promptRecords).toHaveLength(2)
    expect(promptRecords[1]?.[2]).toBe(promptRecords[0]?.[2])
    const resumedPrompt = promptRecords[1]?.[1]
    expect(resumedPrompt).toContain(callId)
    expect(resumedPrompt).toContain('E2E_INPUT_REWRITTEN')
    expect(mockLog.match(/regression steering-cancelled/g) ?? []).toHaveLength(1)
    const reply = events.findLast(
      (event) =>
        event.type === 'user/message' &&
        event.sessionId === agent.id &&
        event.data.source.kind === 'user-question-reply' &&
        event.data.source.callId === callId,
    )
    if (reply === undefined || reply.type !== 'user/message') throw new Error('missing admitted timed question reply')
    expect(JSON.stringify(reply.data)).toContain('E2E_INPUT_REWRITTEN')
    expect(userQuestions.answer(agent, callId, answer)).toBe(false)
    expect(events.filter((event) => event.type === 'turn/start' && event.sessionId === agent.id)).toHaveLength(1)
    expect(events.filter((event) => event.type === 'step/start' && event.sessionId === agent.id)).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'assistant/message' && event.sessionId === agent.id).at(-1),
    ).toMatchObject({ data: { message: { content: [{ text: 'E2E_DONE mock-model-a' }] } } })
    expect(await page.locator('[data-question-key]').count()).toBe(0)

    const cancelId = ToolCallId(`timed-cancel-${Date.now()}`)
    const cancelArgs = { timeout: 30, questions: [{ id: 'cancel', question: 'Wait for cancellation?' }] }
    const cancelController = new AbortController()
    const cancelledPromise = host.ctx.tools.execute({
      callId: cancelId,
      name: 'ask_user_question',
      arguments: cancelArgs,
      agent,
      signal: cancelController.signal,
    })
    await page.locator('[data-question-key]').waitFor()
    cancelController.abort(new Error('E2E cancel timed question'))
    const cancelled = await cancelledPromise
    expect(cancelled.isError).toBe(true)
    if (!cancelled.isError) throw new Error('expected timed question cancellation')
    expect(JSON.stringify(cancelled.error)).toContain('ASK_ABORTED')
    await page.locator('[data-question-key]').waitFor({ state: 'detached' })
  } finally {
    try {
      await browser?.close()
    } finally {
      await host?.close()
    }
  }
}, 90_000)
