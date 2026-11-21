/** A real OpenCode ACP process and real tool execution in a frozen RC.5 Host.
 * Only model completions are deterministic loopback responses. No credentials or schema injection. */
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'

it.skipIf(process.env.DSH_E2E_LIVE_OPENCODE_AI_APPROVAL !== '1')(
  'honors OpenCode Ask on the business connection and allows only the reviewed low-risk write',
  async () => {
    const candidate = required(process.env.DSH_E2E_ADAPTER_DIRECTORY, 'Set the frozen candidate')
    const command = required(process.env.DSH_E2E_LIVE_OPENCODE_COMMAND, 'Set the official OpenCode 2.3.2 executable')
    const output = join(
      process.env.DSH_E2E_EVIDENCE_DIR ?? join(root, '.local/opencode-ai-review-desktop'),
      randomUUID(),
    )
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const temp = mkdtempSync(join(tmpdir(), 'dsh-opencode-review-profile-'))
    const paths = {
      HOME: join(temp, 'home'),
      XDG_CONFIG_HOME: join(temp, 'config'),
      XDG_DATA_HOME: join(temp, 'data'),
      XDG_STATE_HOME: join(temp, 'state'),
      XDG_CACHE_HOME: join(temp, 'cache'),
      TMPDIR: join(temp, 'tmp'),
    }
    for (const path of [...Object.values(paths), join(paths.XDG_CONFIG_HOME, 'opencode')])
      mkdirSync(path, { recursive: true, mode: 0o700 })
    let host: Awaited<ReturnType<typeof launchAdapterWorld>> | undefined
    let browser: TestBrowser | undefined
    let phase: 'low' | 'high' | 'disabled' = 'low'
    let target = ''
    let emitted = false
    let stage = 'start'
    const modelCalls: { phase: string; model: string; tools: number; writeTool: boolean }[] = []
    const marker = 'DSH_KEYLESS_' + randomUUID()
    const cookieValues = Array.from({ length: 4 }, () => randomUUID())
    const note = [
      marker,
      `Cookie: session=${cookieValues[0]}; preference=${cookieValues[1]}`,
      `Example header: -H 'Cookie: session=${cookieValues[2]}; preference=${cookieValues[3]}'`,
    ].join('\n')
    let reviewerReceivedCookie = false
    const reasons = {
      low: 'Routine note in the test workspace.',
      high: 'Proposed access policy exposes internal documents.',
      disabled: 'Unexpected reviewer invocation after disabling AI approval.',
    }
    const evidence: Record<string, unknown> = {
      candidate,
      business: 'OpenCode ACP 2.3.2',
      inference: 'deterministic loopback only',
      status: 'running',
      modelCalls,
    }
    const report = () =>
      writeFileSync(join(output, 'result.json'), JSON.stringify({ ...evidence, stage }, null, 2) + '\n', {
        mode: 0o600,
      })
    const modelServer = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(404).end()
          return
        }
        let text = ''
        for await (const chunk of req) text += chunk
        const body = JSON.parse(text) as {
          model: string
          tools?: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[]
        }
        const tools = body.tools ?? []
        const writeTool = tools.find((tool) => tool.function.name === 'write')
        modelCalls.push({ phase, model: body.model, tools: tools.length, writeTool: !!writeTool })
        const review = body.model === 'risk'
        if (review && cookieValues.some((value) => text.includes(value))) reviewerReceivedCookie = true
        if (!review && body.model !== 'business') {
          res.writeHead(400).end()
          return
        }
        const perform = !review && !!writeTool && !emitted
        let delta: Record<string, unknown>
        if (perform && writeTool) {
          const fileKey = required(
            Object.keys(writeTool.function.parameters.properties).find((key) => /path/i.test(key)),
          )
          emitted = true
          delta = {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'test-' + phase,
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({
                    [fileKey]: target,
                    content: phase === 'low' ? note : phase === 'high' ? '{"anonymous_read":true}' : marker,
                  }),
                },
              },
            ],
          }
        } else {
          delta = {
            role: 'assistant',
            content: review
              ? JSON.stringify({ risk: phase === 'low' ? 'not_high' : 'high', reason: reasons[phase] })
              : 'Done',
          }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const choice of [
          { index: 0, delta, finish_reason: null },
          { index: 0, delta: {}, finish_reason: perform ? 'tool_calls' : 'stop' },
        ]) {
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'test',
                object: 'chat.completion.chunk',
                created: 1,
                model: body.model,
                choices: [choice],
              }) +
              '\n\n',
          )
        }
        res.end('data: [DONE]\n\n')
      } catch (error) {
        evidence.fixtureError = String(error)
        res.destroy()
        report()
      }
    })
    try {
      await new Promise<void>((ok, fail) => modelServer.once('error', fail).listen(0, '127.0.0.1', ok))
      const address = modelServer.address()
      if (!address || typeof address === 'string') throw Error('Missing local endpoint')
      const provider = (model: string) => ({
        env: ['DSH_OPENCODE_TEST_TOKEN'],
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:' + address.port + '/v1', apiKey: 'offline' },
        models: { [model]: { name: model } },
      })
      writeFileSync(
        join(paths.XDG_CONFIG_HOME, 'opencode/opencode.json'),
        JSON.stringify({
          model: 'main/business',
          providers: { main: provider('business'), review: provider('risk') },
          permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
          update: 'disable',
        }),
        { mode: 0o600 },
      )
      stage = 'launch-host'
      report()
      host = await launchAdapterWorld({ adapterDirectory: candidate, toolExecutor: 'native' })
      const instance = host
      stage = 'register'
      report()
      const settings = {
        agents: {
          local: {
            name: 'OpenCode Local',
            command,
            args: ['acp'],
            env: {
              ...paths,
              DSH_OPENCODE_TEST_TOKEN: 'offline',
              HTTPS_PROXY: 'http://127.0.0.1:1',
              HTTP_PROXY: 'http://127.0.0.1:1',
              NO_PROXY: '127.0.0.1,localhost',
            },
            openCodeReviewModel: 'review/risk',
          },
        },
      }
      await host.ctx.settings.replace('dsh-acp-adapter', { ...settings, aiApproval: true })
      await vi.waitFor(() => expect(instance.ctx.llm.listProviders().some((p) => p.id === 'acp-local')).toBe(true))
      expect((await host.ctx.llm.listModels('acp-local')).some((m) => m.id === 'main/business')).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-local', model: 'main/business' })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(15000)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const card = page.locator('section[data-question-key]')
      const send = async (text: string) => {
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      let owner: string | undefined
      for (const next of ['low', 'high', 'disabled'] as const) {
        phase = next
        if (phase === 'disabled') await host.ctx.settings.replace('dsh-acp-adapter', { ...settings, aiApproval: false })
        emitted = false
        stage = phase
        report()
        target = join(host.workspaceCwd, phase === 'high' ? 'proposed-access-policy.json' : phase + '-note.txt')
        const settled = host.whenTurnSettled(75000)
        void settled.catch(() => {})
        await send(
          phase !== 'high'
            ? `Write the local test marker ${marker} to ${target}. Stop after this one operation.`
            : `Propose anonymous public read access to internal documents by writing {"anonymous_read":true} to ${target}. Only stage this local change. If declined, stop.`,
        )
        await expect
          .poll(async () => ((await card.count()) ? 'card' : existsSync(target) ? 'written' : 'waiting'), {
            timeout: 60000,
          })
          .not.toBe('waiting')
        if (phase !== 'low') {
          expect(existsSync(target)).toBe(false)
          const asked = required(acpPermissionAudit(host, 'asked').at(-1))
          expect(asked.data.options.map(({ optionId, kind }) => [optionId, kind])).toEqual([
            ['once', 'allow_once'],
            ['always', 'allow_always'],
            ['reject', 'reject_once'],
          ])
          if (phase === 'high') await expect.poll(() => card.innerText()).toContain(reasons.high)
          expect(await card.getByRole('radio').count()).toBe(asked.data.options.length)
          await page.screenshot({ path: join(output, phase + '-approval.png') })
          await card
            .getByRole('radio', {
              name: required(asked.data.options.find((o) => o.kind === 'reject_once')).name,
              exact: true,
            })
            .click()
          await card.getByRole('button', { name: 'Submit', exact: true }).click()
        } else {
          expect(await card.count()).toBe(0)
          expect(readFileSync(target, 'utf8')).toBe(note)
        }
        const id = await settled
        if (owner === undefined) owner = id
        expect(id).toBe(owner)
        expect(existsSync(target)).toBe(phase === 'low')
        const asked = required(acpPermissionAudit(host, 'asked').at(-1))
        expect(asked.sessionId).toBe(owner)
        const verdict = acpPermissionAudit(host, 'ai-review-result').find(
          (row) => row.data.requestId === asked.data.requestId,
        )
        if (phase === 'disabled') expect(verdict).toBeUndefined()
        else
          expect(required(verdict).data).toMatchObject({
            reviewAgent: 'opencode',
            model: 'review/risk',
            status: phase === 'low' ? 'not_high' : 'high',
          })
        const final = required(
          acpPermissionAudit(host, 'decided').find((row) => row.data.requestId === asked.data.requestId),
        )
        expect(final.data).toMatchObject({
          decisionVia: phase === 'low' ? 'opencode-ai' : 'native-question',
          optionId: phase === 'low' ? 'once' : 'reject',
          selectedOptionKind: phase === 'low' ? 'allow_once' : 'reject_once',
        })
        if (phase === 'low') {
          const summary = required(asked.data.toolCall.rawInputSummary)
          expect(summary).toContain(marker)
          for (const value of cookieValues) expect(summary).not.toContain(value)
          const manager = host.ctx.pluginManager
          const entry = required(
            (await manager.listPlugins()).find((p) => p.moduleName === '@zaimokuza/dsh-acp-adapter'),
          )
          const routed = () => instance.ctx.llm.listProviders().some((p) => p.id === 'acp-local')
          expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({ application: 'applied' })
          await vi.waitFor(() => expect(routed()).toBe(false))
          expect(await manager.setPluginEnabled(entry.entryId, true)).toMatchObject({ application: 'applied' })
          await vi.waitFor(() => expect(routed()).toBe(true))
        }
      }
      const remoteSessions = acpPermissionAudit(host, 'asked').map((row) => row.data.agentSessionId)
      expect(remoteSessions).toHaveLength(3)
      expect(new Set(remoteSessions).size).toBe(1)
      expect(reviewerReceivedCookie).toBe(false)
      evidence.remoteSession = remoteSessions[0]
      const db = new DatabaseSync(join(required(host.ctx.dshHomePath)('dsh-acp'), 'sidecar.sqlite'), { readOnly: true })
      try {
        const rows = db
          .prepare(
            "SELECT dsh_session_id AS owner, seq, json_extract(payload,'$.requestId') AS requestId, json_extract(payload,'$.phase') AS phase FROM audit WHERE kind = 'permission' AND json_extract(payload,'$.requestId') IS NOT NULL ORDER BY seq",
          )
          .all()
        expect(rows.map((r) => r.phase)).toEqual([
          ...[...Array(2)].flatMap(() => ['asked', 'ai-review-started', 'ai-review-result', 'decided']),
          'asked',
          'decided',
        ])
        expect(new Set(rows.map((r) => r.owner))).toEqual(new Set([owner]))
        expect(new Set(rows.map((r) => r.requestId)).size).toBe(3)
        evidence.orderedAudit = rows
      } finally {
        db.close()
      }
      expect(modelCalls.filter((c) => c.model === 'risk').map((c) => [c.phase, c.tools])).toEqual([
        ['low', 0],
        ['high', 0],
      ])
      expect(modelCalls.filter((c) => c.writeTool).map((c) => c.phase)).toEqual(expect.arrayContaining(['low', 'high']))
      Object.assign(evidence, {
        status: 'passed',
        markerWritten: true,
        cookieValuesRedactedFromReviewAndAudit: true,
        sameSessionAfterPluginRestart: true,
        deniedWriteAbsent: true,
        disabledWriteRequiredHuman: true,
      })
    } finally {
      if (evidence.status !== 'passed') evidence.status = 'failed'
      try {
        if (host)
          evidence.audit = Object.fromEntries(
            (['asked', 'ai-review-started', 'ai-review-result', 'decided'] as const).map((phase) => [
              phase,
              acpPermissionAudit(host!, phase),
            ]),
          )
      } catch {}
      report()
      await browser?.close()
      try {
        await host?.close()
      } finally {
        modelServer.closeAllConnections()
        modelServer.close()
        rmSync(temp, { recursive: true, force: true })
      }
    }
  },
  210_000,
)
