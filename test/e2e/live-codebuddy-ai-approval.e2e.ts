import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { launchAdapterWorld } from './scaffold.ts'

// In 2.185.0 an ordinary Write and an explicit permissions.ask rule have the same
// ACP request. Only the person answering the original card can distinguish intent.
it.skipIf(process.env.DSH_E2E_LIVE_CODEBUDDY_AI_APPROVAL !== '1').each(['ordinary', 'explicit ask'] as const)(
  'keeps the CodeBuddy %s Write on the original card with adapter AI approval enabled',
  async (source) => {
    const command = required(process.env.DSH_E2E_LIVE_CODEBUDDY_COMMAND, 'Set the official CodeBuddy 2.185.0 command')
    const host = await launchAdapterWorld({
      adapterDirectory: required(process.env.DSH_E2E_ADAPTER_DIRECTORY, 'Set the frozen candidate'),
      toolExecutor: 'native',
    })
    const temp = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-live-ask-'))
    let browser: TestBrowser | undefined
    try {
      const env = { CODEBUDDY_CONFIG_DIR: join(temp, 'actor'), WORKBUDDY_CONFIG_DIR: join(temp, 'workbuddy') }
      for (const path of Object.values(env)) mkdirSync(path, { mode: 0o700 })
      const model = 'hy4flash-free'
      const explicitlyRequired = source === 'explicit ask'
      if (explicitlyRequired) {
        mkdirSync(join(host.workspaceCwd, '.codebuddy'), { recursive: true })
        writeFileSync(
          join(host.workspaceCwd, '.codebuddy/settings.json'),
          JSON.stringify({ permissions: { ask: ['Write', 'Edit'] } }),
        )
      }
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: { codebuddy: { name: 'CodeBuddy', runtime: 'codebuddy', command, args: ['--acp'], env } },
        aiApproval: true,
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === 'acp-codebuddy')).toBe(true))
      expect((await host.ctx.llm.listModels('acp-codebuddy')).some((m) => m.id === model)).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codebuddy', model })
      browser = await launchBrowser({ headless: true })
      const page = await newEnglishPage(browser)
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      const marker = 'REVIEW_' + randomUUID()
      const name = 'approval-test.txt'
      const file = join(host.workspaceCwd, name)
      const settled = host.whenTurnSettled(90000)
      void settled.catch(() => {})
      await writeComposerDraft(
        page,
        page.locator('[data-composer-input]').first(),
        'Use the built-in Write tool exactly once to create ' +
          file +
          '. Use this exact absolute path. Its only line must be ' +
          marker +
          '. Do not use any other tool. If denied stop without retrying.',
      )
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const card = page.locator('section[data-question-key]')
      await card.waitFor({ timeout: 60000 })
      const evidence = process.env.DSH_E2E_EVIDENCE_DIR
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        await card.screenshot({
          path: join(evidence, explicitlyRequired ? 'codebuddy-required-review.png' : 'codebuddy-ordinary-review.png'),
        })
      }
      expect(existsSync(file)).toBe(false)
      const [asked] = acpPermissionAudit(host, 'asked')
      const input = JSON.parse(required(required(asked).data.toolCall.rawInputSummary))
      expect(input.file_path).toBe(file)
      expect(input.content?.trimEnd()).toBe(marker)
      const options = required(asked).data.options
      expect(options.map((o) => [o.kind, o.optionId])).toEqual([
        ['allow_always', 'allow_always'],
        ['allow_once', 'allow'],
        ['reject_once', 'reject'],
      ])
      const offered = required(options.find((o) => o.kind === (explicitlyRequired ? 'reject_once' : 'allow_once')))
      await card.getByRole('radio', { name: offered.name, exact: true }).click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      const owner = await settled
      expect(acpPermissionAudit(host, 'decided')).toMatchObject([
        {
          sessionId: owner,
          data: {
            requestId: required(asked).data.requestId,
            decisionVia: 'native-question',
            selectedOptionKind: offered.kind,
            optionId: offered.optionId,
          },
        },
      ])
      expect(acpPermissionAudit(host, 'asked')).toHaveLength(1)
      expect(acpPermissionAudit(host, 'ai-review-started')).toHaveLength(0)
      expect(acpPermissionAudit(host, 'ai-review-result')).toHaveLength(0)
      expect(existsSync(file)).toBe(!explicitlyRequired)
      if (!explicitlyRequired) expect(readFileSync(file, 'utf8').trimEnd()).toBe(marker)
    } finally {
      try {
        await browser?.close()
      } finally {
        try {
          await host.close()
        } finally {
          rmSync(temp, { recursive: true, force: true })
        }
      }
    }
  },
  145000,
)
