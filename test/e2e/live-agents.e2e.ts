import { required } from './required.ts'
import type { TestBrowser } from './browser.ts'
import { launchBrowser, newEnglishPage } from './browser.ts'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AdapterWorld } from './scaffold.ts'
import type { BrowserServer, Page } from 'playwright'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { verifyLiveTeam } from './live-teams.ts'
import { verifyLiveTeamApproval } from './live-team-approval.ts'
import { verifyLiveSteering } from './live-steering.ts'
import { prepareLiveDevinEnvironment } from './live-devin-environment.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { readLiveDevinCliVersion } from './live-devin-version.ts'
import { verifyLiveDevinPermissionLifecycle } from './live-devin-permission-lifecycle.ts'

const profiles = [
  { id: 'claude', command: 'claude-agent-acp', args: [] },
  { id: 'codex', command: 'codex-acp', args: [] },
  { id: 'devin', command: 'devin', args: ['acp'] },
]
const selected = process.env.DSH_E2E_LIVE_PROFILES?.split(',')
const retain = process.env.DSH_E2E_RETAIN === '1'
if (retain && selected?.length !== 1) throw new Error('Retained review requires exactly one explicit live profile')
const teams = process.env.DSH_E2E_LIVE_TEAMS === '1'
const multimodel = process.env.DSH_E2E_LIVE_TEAMS_MULTIMODEL === '1'
const steering = process.env.DSH_E2E_LIVE_STEERING === '1'
const devinPermissions = process.env.DSH_E2E_LIVE_DEVIN_PERMISSIONS === '1'
const nativeTeamApproval = process.env.DSH_E2E_LIVE_TEAMS_APPROVAL === '1'
if (teams && steering) throw new Error('Choose either the live Teams or live steering scenario')
if (nativeTeamApproval && (!teams || devinPermissions))
  throw new Error('Choose Teams native sandbox approval or Devin ACP permission lifecycle as separate scenarios')
if (nativeTeamApproval && (selected === undefined || selected.includes('devin')))
  throw new Error(
    'The Devin native DSH bash sandbox escalation fixture does not handle the preceding ACP Ask request. ' +
      'DSH_E2E_LIVE_DEVIN_PERMISSIONS covers ACP Allow/Reject/Stop/continue separately, not native sandbox escalation.',
  )
if (devinPermissions && (!teams || multimodel || selected?.length !== 1 || selected[0] !== 'devin'))
  throw new Error('Devin permission lifecycle requires Teams and only the explicit Devin profile, without multimodel')
if (multimodel && (!teams || selected?.length !== 1 || selected[0] !== 'devin'))
  throw new Error('The two-model scenario requires Teams and exactly the explicit Devin profile')

// Explicitly opt in: these use the user's Agent login and may consume credits.
describe.skipIf(process.env.DSH_E2E_LIVE !== '1')('live ACP smoke', () => {
  it.each(profiles.filter((profile) => selected === undefined || selected.includes(profile.id)))(
    devinPermissions
      ? '$id preserves member permission decisions and cancellation'
      : teams
        ? '$id completes native shared tasks and member messaging'
        : steering
          ? '$id delivers steering after real generation begins'
          : '$id preserves host guidance and renders a real response',
    async (profile) => {
      let devinEnvironment: Awaited<ReturnType<typeof prepareLiveDevinEnvironment>> | undefined
      let host!: AdapterWorld
      let browser!: TestBrowser
      let browserServer!: BrowserServer
      let page!: Page
      let model!: string
      let settlement!: TurnEndReason
      const replies: { token: string; reply: string | undefined }[] = []
      const errors: string[] = []
      const started = Date.now()
      const teamEvidence: Record<string, unknown> & {
        secondModel?: string
        secondRun?: Record<string, unknown>
        approval?: Record<string, unknown> & { directory: string }
      } = {}
      const evidence = join(
        root,
        teams ? '.local/e2e-live-teams' : steering ? '.local/e2e-live-steering' : '.local/e2e-live',
      )
      mkdirSync(evidence, { recursive: true })
      try {
        const provider = `acp-${profile.id}`
        const explicitModel = process.env[`DSH_E2E_LIVE_${profile.id.toUpperCase()}_MODEL`]
        if (profile.id === 'devin' && (explicitModel === undefined || explicitModel.trim().length === 0))
          throw new Error('Choose an exact Devin MODEL after checking the current authenticated catalog and price')
        const secondModel = multimodel ? process.env.DSH_E2E_LIVE_TEAMS_SECOND_MODEL : undefined
        if (
          multimodel &&
          (secondModel === undefined || secondModel.trim().length === 0 || secondModel === explicitModel)
        )
          throw new Error('Choose a different exact TEAMS_SECOND_MODEL within the authorized model scope')
        host = await launchAdapterWorld({
          teams,
          ...(multimodel
            ? {
                extraPatches: [
                  `- id: subagent-model-selection-settings\n  config:\n    enabled: true\n    allowedModels: ${JSON.stringify([required(explicitModel), required(secondModel)].map((model) => ({ provider, model })))}\n`,
                ],
              }
            : {}),
        })
        const envKeys = (process.env[`DSH_E2E_LIVE_${profile.id.toUpperCase()}_ENV_KEYS`] ?? '')
          .split(',')
          .filter(Boolean)
        let env = Object.fromEntries(
          envKeys.map((key) => {
            const value = process.env[key]
            if (value === undefined) throw new Error(`Explicit live-test environment variable is absent: ${key}`)
            return [key, value]
          }),
        )
        if (profile.id === 'devin') {
          devinEnvironment = await prepareLiveDevinEnvironment(process.env.DEVIN_LIVE_AUTH, env)
          env = devinEnvironment.env
        }
        // Pin one resolved executable for both the CLI version check and the actual ACP process.
        const command =
          profile.id === 'devin' ? await host.ctx.subprocess.resolveExecutable(profile.command, env) : profile.command
        const devinCliVersion =
          teams && profile.id === 'devin' ? await readLiveDevinCliVersion(command, host.workspaceCwd, env) : undefined
        if (devinCliVersion !== undefined) teamEvidence.manualApprovalCliVersion = devinCliVersion
        await host.ctx.settings.replace('dsh-acp-adapter', {
          ...(devinPermissions ? { toolApprovalDefault: 'ask' } : {}),
          agents: { [profile.id]: { name: profile.id, command, args: profile.args, env } },
        })
        await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((entry) => entry.id === provider)).toBe(true))
        const models = await host.ctx.llm.listModels(provider)
        expect(models.length, 'Agent must return an authenticated model catalog').toBeGreaterThan(0)
        const preferences = profile.id === 'claude' ? [/^haiku$/i] : [/mini/i, /spark/i]
        const chosen =
          explicitModel === undefined
            ? preferences.map((pattern) => models.find((entry) => pattern.test(entry.id))).find(Boolean)
            : models.find((entry) => entry.id === explicitModel)
        // Keep discovery evidence even when a small model disappears from the catalog.
        writeFileSync(
          join(evidence, `${profile.id}-catalog.json`),
          JSON.stringify({ profile: profile.id, model: chosen?.id, models }, null, 2),
        )
        expect(
          chosen,
          'No approved small model found; specify an exact live-test MODEL instead of using an expensive default',
        ).toBeDefined()
        // Validate every authorized route before the first model request.
        if (multimodel)
          expect(
            models.some((entry) => entry.id === secondModel),
            'The selected second model is unavailable',
          ).toBe(true)
        model = required(chosen).id
        await host.ctx.agentDefaultModel.saveSelection({ provider, model })
        let token = `HOST_BRIDGE_${randomUUID()}`
        if (!teams && !steering)
          host.ctx.effect(() =>
            host.ctx.systemPrompt.section({
              name: 'e2e-live-instructions',
              order: 0,
              text: () =>
                `For this isolated verification, the current validation token is ${token}. It supersedes any earlier token. When asked, reply with this current token only. Do not use any tools.`,
            }),
          )
        const browserOptions = {
          headless: !retain,
          ...(retain ? { args: ['--window-size=1440,1000'] } : {}),
          ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
        }
        if (retain) {
          browserServer = await chromium.launchServer(browserOptions)
          browser = await chromium.connect(browserServer.wsEndpoint())
        } else browser = await launchBrowser(browserOptions)
        // Review windows should follow the real Chrome window instead of the fixed screenshot viewport.
        page = retain
          ? await browser.newPage({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
          : await newEnglishPage(browser)
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(host.authenticatedUrl)
        await connectFreshWorkspace(page, host.workspaceCwd)
        if (steering) {
          const result = await verifyLiveSteering({ host, page })
          expect(errors).toEqual([])
          await page.screenshot({ path: join(evidence, `${profile.id}.png`), fullPage: true })
          writeFileSync(
            join(evidence, `${profile.id}.json`),
            JSON.stringify(
              { status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, ...result },
              null,
              2,
            ),
          )
          return
        }
        if (teams) {
          // The cached ACP version is separate evidence; Devin currently reports 0.0.0-dev here.
          const probe =
            profile.id === 'devin'
              ? (await (host.ctx.get('dshAcp') as AcpRemoteService).health()).providers.find(
                  (entry) => entry.id === 'devin',
                )?.probe
              : undefined
          const devinManualApproval =
            devinCliVersion !== undefined && devinEnvironment !== undefined
              ? {
                  cliVersion: devinCliVersion,
                  assertIsolatedSessionMcp: devinEnvironment.assertIsolatedSessionMcp,
                }
              : undefined
          if (profile.id === 'devin')
            teamEvidence.manualApprovalAcpVersion = probe?.status === 'ok' ? (probe.agentInfo?.version ?? null) : null
          if (devinPermissions) {
            const lifecycleEvidence = { directory: evidence }
            teamEvidence.permissionLifecycle = lifecycleEvidence
            await verifyLiveDevinPermissionLifecycle({
              host,
              page,
              provider,
              model,
              evidence: lifecycleEvidence,
              context: required(devinManualApproval),
            })
          } else {
            const firstTeam = await verifyLiveTeam({
              host,
              page,
              provider,
              model,
              evidence: teamEvidence,
              evidenceDirectory: evidence,
              devinManualApproval,
            })
            if (multimodel) {
              const second = required(models.find((entry) => entry.id === secondModel))
              teamEvidence.secondModel = second.id
              teamEvidence.secondRun = {}
              const secondTeam = await verifyLiveTeam({
                host,
                page,
                provider,
                model: second.id,
                selectChildModel: true,
                evidence: teamEvidence.secondRun,
                evidenceDirectory: evidence,
                devinManualApproval,
                memberName: 'checker',
                expectedMembers: 3,
              })
              expect(secondTeam.lead).toBe(firstTeam.lead)
              expect(secondTeam.child).not.toBe(firstTeam.child)
              expect(firstTeam.lead.session.requestHeader()?.config).toMatchObject({ provider, model })
              expect(firstTeam.child.session.requestHeader()?.config).toMatchObject({ provider, model })
            }
            if (nativeTeamApproval) {
              teamEvidence.approval = { directory: evidence }
              await verifyLiveTeamApproval({ host, page, provider, evidence: teamEvidence.approval })
            }
          }
          expect(errors).toEqual([])
          await page.screenshot({ path: join(evidence, `${profile.id}.png`), fullPage: true })
          writeFileSync(
            join(evidence, `${profile.id}.json`),
            JSON.stringify(
              { status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, ...teamEvidence },
              null,
              2,
            ),
          )
          return
        }
        let sessionId
        for (let turn = 0; turn < 2; turn += 1) {
          if (turn > 0) token = `HOST_BRIDGE_${randomUUID()}`
          await writeComposerDraft(
            page,
            page.locator('[data-composer-input]').first(),
            'This is an isolated smoke test. Return the current validation token from the latest host instructions. Do not read or write files and do not use tools.',
          )
          const settled = host.whenTurnSettled(120_000)
          await page.getByRole('button', { name: 'Send message', exact: true }).click()
          const id = await settled
          if (sessionId !== undefined) expect(id).toBe(sessionId)
          sessionId = id
          const handle = await host.ctx.sessionPersistence.open(id, 'read')
          try {
            const log = (await handle.read()).events
            settlement = required(log.findLast((event) => event.type === 'turn/end')).data.reason
            expect(settlement).toMatchObject({ kind: 'completed' })
            const assistant = required(log.findLast((event) => event.type === 'assistant/message'))
            const reply = assistant?.data.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
            replies.push({ token, reply })
            expect(reply).toContain(token)
            expect(assistant.data.stream.length).toBeGreaterThan(0)
          } finally {
            await handle.close()
          }
          await page.getByText(token, { exact: false }).last().waitFor()
          await page.reload()
          await page.getByText(token, { exact: false }).last().waitFor()
        }
        expect(errors).toEqual([])
        await page.screenshot({ path: join(evidence, `${profile.id}.png`), fullPage: true })
        writeFileSync(
          join(evidence, `${profile.id}.json`),
          JSON.stringify(
            { status: 'passed', profile: profile.id, model, durationMs: Date.now() - started, replies },
            null,
            2,
          ),
        )
      } catch (error) {
        writeFileSync(
          join(evidence, `${profile.id}.json`),
          JSON.stringify(
            {
              status: 'failed',
              profile: profile.id,
              model,
              settlement,
              replies,
              ...teamEvidence,
              body: await page?.locator('body').innerText(),
              durationMs: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            null,
            2,
          ),
        )
        throw error
      } finally {
        if (retain && host && page) {
          const stopFile = join(evidence, `STOP_REVIEW_${process.pid}`)
          writeFileSync(
            join(evidence, 'review-instance.json'),
            JSON.stringify(
              {
                url: new URL(host.authenticatedUrl).origin,
                authenticatedUrl: host.authenticatedUrl,
                workspace: host.workspaceCwd,
                browserEndpoint: browserServer.wsEndpoint(),
                stopFile,
                profile: profile.id,
                model: teamEvidence.secondModel ?? model,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          )
          console.log(`REVIEW_READY: Chrome and the isolated DSH remain open; create ${stopFile} to stop.`)
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (existsSync(stopFile)) {
                clearInterval(timer)
                resolve()
              }
            }, 1000)
          })
        }
        try {
          await browser?.close()
          await browserServer?.close()
        } finally {
          try {
            await host?.close()
          } finally {
            await devinEnvironment?.dispose()
          }
        }
      }
    },
    retain ? 0 : teams ? 600_000 : 300_000,
  )
})
