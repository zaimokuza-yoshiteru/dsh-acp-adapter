/** Explicit opt-in: real Devin inference and tools in an isolated temporary workspace. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

class NativeOwner extends LlmAdapter {
  providerInfo(id: string) {
    return { id, name: 'Native ownership control' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(): ReturnType<LlmAdapter['stream']> {
    const text = 'NATIVE_OWNER_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(process.env.DSH_E2E_LIVE_MANAGED_APPROVAL !== '1')(
  'handles a real Devin child permission from its native parent with Teams disabled',
  async () => {
    const host = await launchAdapterWorld({ toolsMode: 'native' })
    let browser: TestBrowser | undefined
    let activation: SubagentActivation | undefined
    let child: Agent | undefined
    const id = randomUUID()
    const directory = join(root, '.local/fork-approval-fix-20261021/live', id)
    mkdirSync(directory, { recursive: true })
    const marker = `MANAGED_APPROVAL_${id}`
    const path = join(host.workspaceCwd, 'workspace', 'managed-approval.txt')
    const evidence: Record<string, unknown> = {
      id,
      platform: process.platform,
      parentInference: 'scripted native LlmAdapter control',
      childInference: 'real Devin',
      model: 'swe-2-high',
      teams: false,
      status: 'running',
    }
    try {
      evidence.cliVersion = execFileSync('devin', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      host.ctx.effect(() => host.ctx.llm.registerAdapter(['live-native-owner'], new NativeOwner()))
      const keys = (process.env.DSH_E2E_LIVE_DEVIN_ENV_KEYS ?? '').split(',').filter(Boolean)
      const env = Object.fromEntries(
        keys.map((key) => {
          const value = process.env[key]
          if (value === undefined) throw new Error(`Missing explicitly selected environment key: ${key}`)
          return [key, value]
        }),
      )
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'ask',
        agents: {
          devin: { name: 'Devin live managed approval', command: 'devin', args: ['acp'], env },
        },
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-devin')).toBe(true))
      const models = await host.ctx.llm.listModels('acp-devin')
      expect(
        models.some((m) => m.id === 'swe-2-high'),
        'Use only the user-authorized exact model',
      ).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'live-native-owner', model: 'fixture' })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(15_000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const ready = host.whenTurnSettled(30_000)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'Prepare isolated child approval regression.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const parent = required(host.ctx.agents.get(await ready))
      host.ctx.permissionPresets.set(parent.session, 'workspace-write')
      expect(host.ctx.get('agentTeams', false)).toBeUndefined()
      host.ctx.on('subagent/start', (entry) => {
        child = host.ctx.agents.get(entry.id)
      })
      activation = await host.ctx.subagents.startActivation({
        provider: 'spawn',
        label: 'Devin approval verification',
        delivery: 'caller',
        request: {
          parent,
          agentOptions: { provider: 'acp-devin', model: 'swe-2-high' },
          prompt: [
            {
              type: 'text',
              text: `In this isolated temporary workspace, use the DSH MCP write tool exactly once to write ${JSON.stringify(marker)} to ${JSON.stringify(path)}. Use file_path and content arguments. Do not use your private shell, private file tools, other tools, or create subagents. Respect any human approval request and wait for the answer. After the tool succeeds, reply with ${marker} and finish. This test authorizes only that temporary marker file.`,
            },
          ],
        },
        signal: new AbortController().signal,
      })
      let outcome: Awaited<SubagentActivation['result']> | undefined
      void activation.result.then((result) => {
        outcome = result
      })
      const card = page.locator('[data-acp-team-approvals]')
      const question = page.locator('section[data-question-key]')
      await expect
        .poll(
          async () => {
            if (await card.getByRole('button', { name: 'Allow once', exact: true }).isVisible()) return 'pending'
            if (await question.getByRole('radio', { name: 'Allow', exact: true }).isVisible()) return 'pending'
            if (outcome !== undefined) return 'ended-without-one-time-request'
            return 'waiting'
          },
          { timeout: 120_000 },
        )
        .not.toBe('waiting')
      const asked = acpPermissionAudit(host, 'asked')
      evidence.asked = asked
      evidence.earlyOutcome = outcome
      expect(
        outcome,
        'Real child must produce a live permission, not merely finish or be denied upstream',
      ).toBeUndefined()
      expect(asked).toHaveLength(1)
      expect(JSON.stringify(asked)).toContain('managed-approval.txt')
      expect(existsSync(path)).toBe(false)
      expect(host.ctx.approval.overrideOf(required(child).session)).toBe('never')
      await page.screenshot({ path: join(directory, 'pending.png') })
      if ((asked[0]?.data.optionCount ?? 0) > 2) {
        expect(await question.getByRole('radio').count()).toBe(asked[0]?.data.optionCount)
        await question.getByRole('radio', { name: 'Allow', exact: true }).click()
        await question.getByRole('button', { name: 'Submit', exact: true }).click()
      } else {
        await card.getByRole('button', { name: 'Allow once', exact: true }).click()
      }
      await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 120_000 })
      expect(outcome?.stopReason).toBe('completed')
      expect(readFileSync(path, 'utf8')).toBe(marker)
      expect(host.ctx.approval.overrideOf(required(child).session)).toBe('never')
      evidence.result = outcome
      evidence.decided = acpPermissionAudit(host, 'decided')
      evidence.markerWritten = true
      evidence.sandboxMode = host.ctx.sandboxPolicy.resolve({ session: required(child).session }).mode
      evidence.nativeChildPolicy = host.ctx.approval.overrideOf(required(child).session)
      evidence.status = 'passed'
      await page.screenshot({ path: join(directory, 'completed.png') })
    } catch (error) {
      evidence.status = 'failed'
      evidence.error = String(error)
      evidence.asked = acpPermissionAudit(host, 'asked')
      evidence.decided = acpPermissionAudit(host, 'decided')
      evidence.markerWritten = existsSync(path)
      evidence.childEvents = child?.session
        .snapshotEvents()
        .filter((event) => ['assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type))
      throw error
    } finally {
      child?.cancel({ kind: 'user' })
      await activation?.dispose()
      await browser?.close()
      try {
        await host.close()
        evidence.cleaned = true
      } finally {
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
      }
    }
  },
  300_000,
)

it.skipIf(process.env.DSH_E2E_LIVE_MANAGED_APPROVAL !== '1')(
  'preserves all real Devin root permission options and executes only the selected one-time grant',
  async () => {
    const host = await launchAdapterWorld({ toolsMode: 'native' })
    let browser: TestBrowser | undefined
    const id = randomUUID()
    const directory = join(root, '.local/fork-approval-fix-20261021/live-root', id)
    mkdirSync(directory, { recursive: true })
    const marker = `ROOT_APPROVAL_${id}`
    const path = join(host.workspaceCwd, 'workspace', 'root-approval.txt')
    const evidence: Record<string, unknown> = {
      id,
      platform: process.platform,
      inference: 'real Devin',
      model: 'swe-2-high',
      status: 'running',
    }
    try {
      evidence.cliVersion = execFileSync('devin', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      const keys = (process.env.DSH_E2E_LIVE_DEVIN_ENV_KEYS ?? '').split(',').filter(Boolean)
      const env = Object.fromEntries(
        keys.map((key) => {
          const value = process.env[key]
          if (value === undefined) throw new Error(`Missing explicitly selected environment key: ${key}`)
          return [key, value]
        }),
      )
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'ask',
        agents: {
          devin: { name: 'Devin live root approval', command: 'devin', args: ['acp'], env },
        },
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-devin')).toBe(true))
      const models = await host.ctx.llm.listModels('acp-devin')
      expect(models.some((m) => m.id === 'swe-2-high')).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'swe-2-high' })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(15_000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const settled = host.whenTurnSettled(150_000)
      void settled.catch(() => undefined)
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        `Use the DSH MCP write tool exactly once to write ${JSON.stringify(marker)} to ${JSON.stringify(path)} in this isolated temporary workspace. You may discover the exact MCP tool schema and inspect truncated discovery output if necessary. Do not use private shell/file tools to perform the write, create other files or subagents, or request bypass. Wait for human approval. After a successful write, reply with ${marker} and finish. If approval is denied, report it and do not retry.`,
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const card = page.locator('section[data-question-key]')
      const allow = card.getByRole('radio', { name: 'Allow', exact: true })
      await allow.waitFor({ state: 'visible', timeout: 120_000 })
      const asked = acpPermissionAudit(host, 'asked')
      evidence.asked = asked
      expect(asked).toHaveLength(1)
      expect(asked[0]?.data.optionCount).toBeGreaterThan(2)
      expect(await card.getByRole('radio').count()).toBe(asked[0]?.data.optionCount)
      expect(existsSync(path)).toBe(false)
      await page.screenshot({ path: join(directory, 'seven-options.png') })
      await allow.click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      const owner = required(host.ctx.agents.get(await settled))
      expect(owner.session.snapshotEvents().findLast((event) => event.type === 'turn/end')?.data.reason.kind).toBe(
        'completed',
      )
      expect(readFileSync(path, 'utf8')).toBe(marker)
      const decided = acpPermissionAudit(host, 'decided')
      expect(decided).toHaveLength(1)
      expect(decided[0]?.data).toMatchObject({
        outcome: 'selected',
        optionId: 'allow_once',
        selectedOptionKind: 'allow_once',
        decisionVia: 'native-question',
      })
      evidence.decided = decided
      evidence.markerWritten = true
      evidence.status = 'passed'
      await page.screenshot({ path: join(directory, 'completed.png') })
    } catch (error) {
      evidence.status = 'failed'
      evidence.error = String(error)
      evidence.asked = acpPermissionAudit(host, 'asked')
      evidence.decided = acpPermissionAudit(host, 'decided')
      evidence.markerWritten = existsSync(path)
      throw error
    } finally {
      await browser?.close()
      try {
        await host.close()
        evidence.cleaned = true
      } finally {
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
      }
    }
  },
  240_000,
)
