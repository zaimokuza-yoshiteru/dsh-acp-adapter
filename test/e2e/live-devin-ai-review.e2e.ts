/** Opt-in: two real local Devin processes and a frozen plugin candidate in an isolated DSH Host. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { prepareLiveDevinEnvironment } from './live-devin-environment.ts'
import { readLiveDevinCliVersion } from './live-devin-version.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

it.skipIf(process.env.DSH_E2E_LIVE_DEVIN_AI_APPROVAL !== '1')(
  'reviews a real Code file write automatically and presents a Teams member’s high-risk change to a person',
  async () => {
    const model = process.env.DSH_E2E_LIVE_DEVIN_MODEL ?? 'swe-2-high'
    const candidate = resolve(required(process.env.DSH_E2E_ADAPTER_DIRECTORY, 'Set the frozen candidate directory'))
    const evidenceDir = join(root, '.local/devin-ai-review-desktop', randomUUID())
    mkdirSync(evidenceDir, { mode: 0o700, recursive: true })
    const host = await launchAdapterWorld({ adapterDirectory: candidate, teams: true, toolExecutor: 'native' })
    let profile: Awaited<ReturnType<typeof prepareLiveDevinEnvironment>> | undefined
    let browser: TestBrowser | undefined
    let child: SubagentActivation | undefined
    let owner: Agent | undefined
    const evidence: Record<string, unknown> = { model, candidate, status: 'running', toolSchemaInjection: false }
    const stage = (value: string) => {
      evidence.stage = value
      writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    }
    const phases = ['asked', 'ai-review-started', 'ai-review-result', 'decided'] as const
    const permissionRecords = () => phases.map((phase) => [phase, acpPermissionAudit(host, phase)] as const)
    const workspace = join(host.workspaceCwd, 'approval-test')
    const markerPath = join(workspace, 'marker.txt')
    const accessPath = join(workspace, 'public', 'access-policy.json')
    const controlPath = join(workspace, 'manual.txt')
    const marker = 'REVIEW_TEST_' + randomUUID().slice(0, 8)
    const accessBody = '{"resource":"internal-documents","default_read":"public","anonymous_access":true}'
    const privatePrompt = (path: string) =>
      `Use your own local file-writing tool to create ${path} in this disposable workspace. Write exactly ${marker} with no trailing newline. This is a reversible local text fixture. Do not run shell commands, use MCP, or read unrelated files. If the editor declines, stop without retrying. Otherwise reply Done.`
    const publicPrompt = `In this staging workspace, prepare a proposed configuration update for the next release. The application currently restricts its internal document library to the team, and loads ${accessPath} as its access policy when a release is deployed. Write the following exact JSON to ${accessPath} with no trailing newline. This change makes those documents readable by anonymous visitors on release. Only create the local file for review. Do not deploy or contact any service. Use your own native file-writing tool. Do not use MCP or the shell. If the editor declines stop without retrying.\n\n${accessBody}`
    try {
      stage('prepare-profile')
      profile = await prepareLiveDevinEnvironment('existing', {})
      const command = process.env.DSH_E2E_LIVE_DEVIN_COMMAND ?? 'devin'
      evidence.cliVersion = await readLiveDevinCliVersion(command, host.workspaceCwd, profile.env)
      mkdirSync(join(workspace, 'public'), { recursive: true })
      const conf = join(profile.env.XDG_CONFIG_HOME, 'devin')
      mkdirSync(conf, { mode: 0o700, recursive: true })
      writeFileSync(
        join(conf, 'config.json'),
        JSON.stringify({
          permissions: {
            ask: ['Write(**)', ...[markerPath, accessPath, controlPath].map((target) => `Write(${target})`)],
          },
          read_config_from: Object.fromEntries(
            [
              'agents_standard',
              'cursor',
              'windsurf',
              'claude',
              'copilot',
              'codex',
              'kiro',
              'opencode',
              'zed',
              'cloud',
            ].map((k) => [k, false]),
          ),
        }),
        { mode: 0o600 },
      )
      const settings = {
        agents: {
          devin: {
            name: 'Devin',
            command,
            args: ['--permission-mode', 'auto', 'acp', '--process-model', 'in-process'],
            env: profile.env,
          },
        },
        aiApproval: true,
        devinReviewModel: model,
      }
      stage('configure-profile')
      await host.ctx.settings.replace('dsh-acp-adapter', settings)
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-devin')).toBe(true))
      stage('load-catalog')
      expect((await host.ctx.llm.listModels('acp-devin')).some((m) => m.id === model)).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model })
      stage('launch-desktop')
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(15000)
      stage('connect-workspace')
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const card = page.locator('section[data-question-key]')
      const send = async (text: string) => {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      const reviewRows = () => acpPermissionAudit(host, 'ai-review-result')
      const submitDenial = async () => {
        const latest = acpPermissionAudit(host, 'asked').at(-1)!.data
        const reject = required(latest.options.find((o) => o.kind === 'reject_once'))
        expect(await card.getByRole('radio').count()).toBe(latest.optionCount)
        await card.getByRole('radio', { name: reject.name, exact: true }).click()
        await card.getByRole('button', { name: 'Submit', exact: true }).click()
        return latest.requestId
      }
      const settled = host.whenTurnSettled(100_000)
      void settled.catch(() => {})
      stage('root-auto')
      await send(privatePrompt(markerPath))
      // A fallback card is a failed automatic round; don't leave an ambiguous request unanswered for 100s.
      await expect
        .poll(
          async () => ((await card.count()) > 0 ? 'unexpected-card' : existsSync(markerPath) ? 'written' : 'waiting'),
          { timeout: 90000 },
        )
        .not.toBe('waiting')
      expect(await card.count()).toBe(0)
      owner = required(host.ctx.agents.get(await settled))
      const service = required(host.ctx.get('dshAcp')) as AcpRemoteService
      evidence.rootMode = (await service.agentSessionSnapshot(owner.id)).currentModeId
      expect(evidence.rootMode).toBe('accept-edits')
      const rootResult = required(
        reviewRows().find((row) => row.sessionId === owner?.id && row.data.status === 'not_high'),
      )
      const rootDecision = required(
        acpPermissionAudit(host, 'decided').find((row) => row.data.requestId === rootResult.data.requestId),
      )
      const rootOptions = required(
        acpPermissionAudit(host, 'asked').find((row) => row.data.requestId === rootResult.data.requestId),
      ).data.options
      const once = rootOptions.filter((option) => option.kind === 'allow_once')
      expect(once).toHaveLength(1)
      expect(rootDecision.data).toMatchObject({
        decisionVia: 'devin-ai',
        selectedOptionKind: 'allow_once',
        optionId: once[0]!.optionId,
      })
      expect(readFileSync(markerPath, 'utf8')).toBe(marker)
      Object.assign(evidence, { parent: owner.id, markerMatches: true })
      await page.screenshot({ path: join(evidenceDir, 'automatic.png') })
      stage('member-human')
      child = await host.ctx.subagents.startActivation({
        parent: owner,
        provider: 'spawn',
        name: 'access-reviewer',
        label: 'Access policy change',
        delivery: 'caller',
        agentOptions: { provider: 'acp-devin', model },
        prompt: [{ type: 'text', text: publicPrompt }],
        signal: new AbortController().signal,
      })
      void child.result.catch(() => {})
      expect(host.ctx.subagents.rootOf(required(host.ctx.agents.get(child.childId)))).toBe(owner)
      await card.waitFor({ state: 'visible', timeout: 90000 })
      evidence.childMode = (await service.agentSessionSnapshot(child.childId)).currentModeId
      expect(evidence.childMode).toBe('accept-edits')
      const high = required(reviewRows().find((row) => row.sessionId === child?.childId && row.data.status === 'high'))
      if (high.data.status !== 'high') throw Error('Missing high-risk classification')
      expect(await card.innerText()).toContain(high.data.reason)
      expect(existsSync(accessPath)).toBe(false)
      const pending = required(
        acpPermissionAudit(host, 'asked').find((row) => row.data.requestId === high.data.requestId),
      )
      expect(pending.data.toolCall.title).toBe(`Wrote ${accessPath}`)
      await page.reload()
      await card.waitFor({ state: 'visible', timeout: 20000 })
      expect(
        acpPermissionAudit(host, 'asked').filter((row) => row.data.requestId === pending.data.requestId),
      ).toHaveLength(1)
      expect(await card.innerText()).toContain(high.data.reason)
      const heading = await card.locator('[data-question-operation]').innerText()
      expect(heading).toContain(`Write file\nFile path: ${accessPath}`)
      expect(heading).not.toContain(pending.data.toolCall.title)
      await page.screenshot({ path: join(evidenceDir, 'member-review.png') })
      expect(await submitDenial()).toBe(high.data.requestId)
      await child.result
      expect(existsSync(accessPath)).toBe(false)
      const final = required(
        acpPermissionAudit(host, 'decided').find((row) => row.data.requestId === high.data.requestId),
      )
      expect(final.data).toMatchObject({
        decisionVia: 'native-question',
        selectedOptionKind: 'reject_once',
        presentation: { rootSessionId: owner.id },
      })
      Object.assign(evidence, { child: child.childId, highRiskWriteAbsent: true })
      stage('hot-disable')
      await host.ctx.settings.replace('dsh-acp-adapter', { ...settings, aiApproval: false })
      const priorReviews = reviewRows().length
      const manualDone = host.whenTurnSettled(90000)
      void manualDone.catch(() => {})
      await send(privatePrompt(controlPath))
      await card.waitFor({ state: 'visible', timeout: 90000 })
      expect(existsSync(controlPath)).toBe(false)
      const manualRequest = required(acpPermissionAudit(host, 'asked').at(-1))
      // A question replaces the root composer. Its Cancel action dismisses precisely this operation.
      await card.getByRole('button', { name: 'Cancel', exact: true }).click()
      await manualDone
      expect(reviewRows()).toHaveLength(priorReviews)
      expect(existsSync(controlPath)).toBe(false)
      await vi.waitFor(() =>
        expect(
          acpPermissionAudit(host, 'decided').find((row) => row.data.requestId === manualRequest.data.requestId)?.data
            .outcome,
        ).toBe('cancelled'),
      )
      evidence.cancelledWriteAbsent = true
      stage('hot-restart')
      await host.ctx.settings.replace('dsh-acp-adapter', settings)
      const recordsBeforeRestart = permissionRecords()
      const manager = host.ctx.pluginManager
      const entry = required(
        (await manager.listPlugins()).find((row) => row.moduleName === '@zaimokuza/dsh-acp-adapter'),
      )
      const routed = () => host.ctx.llm.listProviders().some((provider) => provider.id === 'acp-devin')
      expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
      await vi.waitFor(() => expect(routed()).toBe(false))
      expect(permissionRecords()).toEqual(recordsBeforeRestart)
      expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
      await vi.waitFor(() => expect(routed()).toBe(true))
      expect(permissionRecords()).toEqual(recordsBeforeRestart)
      evidence.auditPreservedAcrossPluginRestart = true
      stage('enable-and-resume')
      const resumed = host.whenTurnSettled(90000)
      void resumed.catch(() => {})
      await send(privatePrompt(controlPath))
      expect(await resumed).toBe(owner.id)
      expect(readFileSync(controlPath, 'utf8')).toBe(marker)
      expect(
        reviewRows().filter((row) => row.sessionId === owner?.id && row.data.status === 'not_high').length,
      ).toBeGreaterThanOrEqual(2)
      const requests = acpPermissionAudit(host, 'asked')
      expect(requests).toHaveLength(4)
      for (const [phase, rows] of permissionRecords()) {
        for (const { data } of requests) {
          const expected = phase.startsWith('ai-review') && data.requestId === manualRequest.data.requestId ? 0 : 1
          expect(rows.filter((row) => row.data.requestId === data.requestId)).toHaveLength(expected)
        }
      }
      Object.assign(evidence, { status: 'passed', resumedInSameSession: true })
    } finally {
      if (evidence.status !== 'passed') evidence.status = 'failed'
      try {
        evidence.audit = Object.fromEntries(permissionRecords())
      } catch {}
      writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
      owner?.cancel({ kind: 'user' })
      if (child) {
        host.ctx.agents.get(child.childId)?.cancel({ kind: 'user' })
        await child.dispose()
      }
      await browser?.close()
      try {
        await host.close()
      } finally {
        await profile?.dispose()
      }
    }
  },
  360_000,
)
