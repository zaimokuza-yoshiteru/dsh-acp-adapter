import { describe, expect, it } from 'vitest'
import { accountUsageLinks, accountUsageProvider } from '../../../src/contract/account-usage.ts'
import type { AcpAgentConfig } from '../../../src/contract/agent-config.ts'

const buddy: AcpAgentConfig = { name: 'My Agent', command: 'codebuddy', args: ['--acp'], env: {} }
const links = (config: Partial<AcpAgentConfig>, model?: string) =>
  accountUsageLinks('custom', { ...buddy, ...config }, model)

describe('manual account usage guides', () => {
  it('offers both CodeBuddy sites when login region is unknown, even with a localized CLI', () => {
    expect(links({ env: { LANG: 'zh_CN.UTF-8' } }).map((link) => link.site)).toEqual(['cn', 'intl'])
    expect(
      links({
        command: 'npx.cmd',
        args: ['--yes', '@tencent-ai/codebuddy-code@2.185.0', '--acp'],
        runtime: 'codebuddy',
      }),
    ).toEqual(links({}))
    expect(accountUsageProvider('custom', buddy)).toBeUndefined()
  })

  it('respects explicit public regions and omits unsuitable tenant or proxy guides', () => {
    expect(links({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } }).map((link) => link.site)).toEqual(['cn'])
    expect(links({ env: { CODEBUDDY_BASE_URL: 'https://www.codebuddy.ai/v1' } }).map((link) => link.site)).toEqual([
      'intl',
    ])
    const deployments: Record<string, string>[] = [
      { CODEBUDDY_INTERNET_ENVIRONMENT: 'selfhosted' },
      { CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' },
      { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', CODEBUDDY_BASE_URL: 'https://www.codebuddy.ai' },
      { CODEBUDDY_BASE_URL: 'https://www.codebuddy.ai.example.test/' },
      { CODEBUDDY_BASE_URL: 'https://www.codebuddy.ai@example.test/' },
    ]
    for (const env of deployments) expect(links({ env })).toEqual([])
  })

  it('only links OpenCode billing for a concrete OpenCode provider model', () => {
    const config = { command: '/installed/opencode', args: ['acp'] }
    for (const model of ['opencode-go/sample', 'opencode/sample'])
      expect(links(config, model)[0]?.url).toBe('https://opencode.ai/docs/console/billing/')
    for (const model of [undefined, 'opencode-go/', 'openrouter/vendor/model', 'dsh-acp:current-config'])
      expect(links(config, model)[0]?.url).toBe('https://opencode.ai/docs/providers/')
  })

  it('covers the official Qwen and Claude launchers without inferring billing from a model or login', () => {
    const qwen = links({ command: 'qwen', args: ['--acp'] })
    expect(qwen[0]?.url).toBe('https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/')
    expect(
      links(
        { command: 'npx', args: ['-y', '@qwen-code/qwen-code@0.28.0', '--acp', '--experimental-skills'] },
        'qwen-coder',
      ),
    ).toEqual(qwen)
    const claude = links({ command: 'C:\\bin\\claude-agent-acp.exe', args: [], runtime: 'claude' })
    expect(claude[0]?.url).toBe('https://code.claude.com/docs/en/costs')
    expect(links({ command: 'npx', args: ['@agentclientprotocol/claude-agent-acp@0.108.1'] })).toEqual(claude)
  })

  it('keeps unsupported, conflicting and lookalike launches out', () => {
    expect(links({ command: 'npx', args: ['@other/copilot', '--acp'] })).toEqual([])
    expect(links({ command: 'copilot', args: ['--acp'], runtime: 'devin' })).toEqual([])
    expect(links({ command: 'npx', args: ['-y', '@other/qwen-code@latest', '--acp'] })).toEqual([])
    expect(links({ command: 'sh', args: ['-c', 'codebuddy --acp'], runtime: 'codebuddy' })).toEqual([])
    expect(links({ command: 'qwen', args: ['--acp', '--unknown'] })).toEqual([])
    expect(links({ command: 'claude-agent-acp', args: [], runtime: 'devin' })).toEqual([])
    expect(links({ runtime: 'kimi' })).toEqual([])
  })

  it('shows the same billing guide for local and registry GitHub Copilot launches without querying an account', () => {
    const direct = { ...buddy, command: 'copilot', args: ['--acp'] }
    const expected = [
      {
        site: 'provider',
        url: 'https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage',
      },
    ]
    expect(links(direct)).toEqual(expected)
    expect(links({ command: 'npx.cmd', args: ['-y', '@github/copilot@1.0.114', '--acp'] })).toEqual(expected)
    expect(accountUsageProvider('github-copilot-cli', direct)).toBeUndefined()
  })
})
