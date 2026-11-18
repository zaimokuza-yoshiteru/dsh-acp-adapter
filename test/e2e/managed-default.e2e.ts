import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-subagent'
import { expect, it } from 'vitest'
import { ACP_AGENT_MANAGED_MODEL_ID } from '../../src/contract/model-selection.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it('uses the advertised first model for an inherited managed default in dedicated mode and in a native child', async () => {
  const host = await launchAdapterWorld()
  const provider = 'acp-default-fixture'
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        'default-fixture': {
          name: 'Default fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: { HOME: host.workspaceCwd, MOCK_AGENT_NAME: 'OpenCode', MOCK_SCENARIO: 'regression' },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((item) => item.id === provider)).toBe(true)
    const managed = { provider, model: ACP_AGENT_MANAGED_MODEL_ID }
    await host.ctx.agentDefaultModel.saveSelection(managed)
    const { sessionId } = await host.ctx.sessionController.create({
      cwd: host.workspaceCwd,
      agentPreset: 'acp-adapter',
    })
    const parent = required(host.ctx.agents.get(sessionId))
    const firstChoice = host.ctx.sessionProjections.snapshot(parent.session, ['modelSelection']).values.modelSelection
    const settled = host.whenTurnSettled()
    await host.ctx.sessionController.prompt(
      {
        sessionId,
        requestId: randomUUID() as SessionRequestId,
        mode: 'queue',
        content: [{ type: 'text', text: 'E2E_MESSAGE' }],
      },
      new AbortController().signal,
    )
    expect(await settled).toBe(sessionId)
    const reason = parent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')?.data.reason
    expect(reason?.kind, JSON.stringify({ reason, firstChoice, option: parent.options.model })).toBe('completed')
    expect(parent.session.requestHeader()?.config.model).toBe('mock-model-a')
    const child = await host.ctx.subagents.startActivation({
      provider: 'spawn',
      name: 'managed-default-child',
      label: 'Default model child',
      parent,
      delivery: 'caller',
      agentOptions: managed,
      prompt: [{ type: 'text', text: 'E2E_MESSAGE' }],
      signal: new AbortController().signal,
    })
    const result = await child.result
    expect(result.stopReason).toBe('completed')
    expect(JSON.stringify(result.output)).toContain('mock-model-a')
    expect(host.ctx.agentDefaultModel.currentSelection()).toMatchObject(managed)
  } finally {
    await host.close()
  }
})
