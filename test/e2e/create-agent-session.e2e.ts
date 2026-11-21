import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { handoffWorkspaces } from '../../src/host/handoff/destination.ts'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

class SessionCreator extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Session creator' }
  }
  override async listModels(provider: string) {
    return [{ provider, id: 'source', name: 'Source' }]
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolName = 'create_agent_session'
    if (!options.messages.some((message) => message.source?.kind === 'tool')) {
      expect(options.tools?.some((tool) => tool.name === toolName)).toBe(true)
      const block = {
        type: 'tool-call' as const,
        id: ToolCallId('request'),
        name: toolName,
        arguments: JSON.stringify({ agent: 'codex', model: 'mock-model-b', task: 'E2E independent task' }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    expect(JSON.stringify(options.messages.find((message) => message.source?.kind === 'tool')?.content)).toContain(
      'task-queued',
    )
    yield { type: 'text-delta', index: 0, text: 'Created the independent chat.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('lets an owner request an independent Agent chat and navigate to its first real plugin-sourced task', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  try {
    const provider = 'session-tool-fixture'
    const log = join(host.workspaceCwd, 'independent-target.log')
    host.ctx.effect(() => host.ctx.llm.registerAdapter([provider], new SessionCreator()))
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        codex: {
          name: 'Codex fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_PROFILE: 'codex', MOCK_SCENARIO: 'regression', MOCK_LOG: log },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((row) => row.id === 'acp-codex')).toBe(true)
    const original = { provider, model: 'source' }
    await host.ctx.agentDefaultModel.saveSelection(original)
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const source = await page
      .locator('[data-conversation-session]:visible')
      .first()
      .getAttribute('data-conversation-session')
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Ask Codex to work separately.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('Created the independent chat.', { exact: true }).waitFor()
    expect(
      await page.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session'),
    ).toBe(source)
    await page.getByRole('button', { name: 'Open codex chat', exact: true }).click()
    await page.getByText('E2E_DONE mock-model-b', { exact: true }).waitFor()
    const target = host.ctx.agents.list().find((agent) => agent.model.current()?.provider === 'acp-codex')
    expect(target?.session.header.origin).toBeUndefined()
    expect(target?.session.header.parentSession).toBeUndefined()
    const sourceAgent = host.ctx.agents.list().find((agent) => agent.id === source)
    const workspace = handoffWorkspaces(host.ctx)
      ?.list()
      .find((row) => sourceAgent && row.sessionIds.includes(sourceAgent.id))
    expect(workspace).toBeDefined()
    expect(workspace?.sessionIds).toContain(target?.id)
    expect(target?.session.header.cwd).toBe(workspace?.path)
    expect(target?.model.current()?.model).toBe('mock-model-b')
    expect(host.ctx.agentDefaultModel.currentSelection()).toEqual(original)
    const requests = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('regression prompt='))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('E2E independent task')
    expect(requests[0]).not.toContain('Ask Codex')
    const observation = await host.ctx.sessionQuery.readSession(target!.id)
    expect(
      observation.events.filter((event) => event.type === 'user/message').map((event) => event.data.source.kind),
    ).toContain('dsh-acp-adapter/agent-task')
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120000)
