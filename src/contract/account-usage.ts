import { effectiveRuntimeOf, retiredAgentReason, type AcpAgentConfig } from './agent-config.ts'
import { isAnonymousCodeBuddyLaunch } from './codebuddy-profile.ts'
import { isLocalOpenCodeReviewProfile, isOpenCodeReviewModel } from './opencode-review.ts'
import { isLocalDevinReviewProfile } from './devin-review.ts'

import type { AcpAccountProvider } from './remote.ts'

export type { AcpAccountUsageView, AcpAccountWindow, AcpAccountProvider } from './remote.ts'

/** Only direct, local launches with an unambiguous login context support account reads. */
export function accountUsageProvider(
  id: string,
  config: Pick<AcpAgentConfig, 'command' | 'args' | 'env' | 'runtime'>,
  platform?: string,
): AcpAccountProvider | undefined {
  // A relative path belongs to the Agent's workspace. A settings-page query has no such cwd.
  if (/[\\/]/.test(config.command) && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(config.command)) return undefined
  if (retiredAgentReason(id, config)) return undefined
  const runtime = effectiveRuntimeOf(id, config)
  const file = config.command.split(/[\\/]/).at(-1)?.toLowerCase()
  if ((runtime === undefined || runtime === 'devin') && isLocalDevinReviewProfile(config)) return 'devin'
  if (
    (runtime === undefined || runtime === 'codex') &&
    /^codex-acp(?:\.(?:cmd|exe))?$/.test(file ?? '') &&
    config.args.length === 0 &&
    !['DEFAULT_AUTH_REQUEST', 'MODEL_PROVIDER', 'CODEX_CONFIG'].some((key) => config.env[key])
  )
    return 'codex'
  if (
    (runtime === undefined || runtime === 'antigravity') &&
    (platform === undefined || platform === 'darwin') &&
    file === 'agy' &&
    config.args[0] === 'acp' &&
    (config.args.length === 1 || (config.args.length === 2 && config.args[1] === '--stdio'))
  )
    return 'antigravity'
  return undefined
}

interface AcpAccountUsageLink {
  readonly url: string
  readonly site: 'cn' | 'intl' | 'provider'
}

const codeBuddySites = {
  cn: { site: 'cn', url: 'https://www.codebuddy.cn/docs/ide/Account/usage' },
  intl: { site: 'intl', url: 'https://www.codebuddy.ai/docs/ide/Account/usage' },
} as const

function codeBuddyUsageLinks(env: AcpAgentConfig['env']): readonly AcpAccountUsageLink[] {
  const edition = env.CODEBUDDY_INTERNET_ENVIRONMENT
  if (edition && edition !== 'internal') return [] // iOA, managed and private deployments have their own account portals.
  const endpoint = env.CODEBUDDY_BASE_URL
  if (endpoint) {
    if (/^https:\/\/(?:copilot\.tencent\.com|(?:www\.)?codebuddy\.cn)(?:\/|$)/i.test(endpoint))
      return [codeBuddySites.cn]
    if (!edition && /^https:\/\/(?:www\.)?codebuddy\.ai(?:\/|$)/i.test(endpoint)) return [codeBuddySites.intl]
    return []
  }
  return edition === 'internal' ? [codeBuddySites.cn] : [codeBuddySites.cn, codeBuddySites.intl]
}

function launchArgs(
  config: Pick<AcpAgentConfig, 'command' | 'args'>,
  binary: string,
  registryPackage: RegExp,
): readonly string[] | undefined {
  const file = config.command
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(cmd|exe)$/, '')
  if (file === binary) return config.args
  if (file !== 'npx') return undefined
  const index = config.args[0] === '-y' || config.args[0] === '--yes' ? 1 : 0
  return registryPackage.test(config.args[index] ?? '') ? config.args.slice(index + 1) : undefined
}

/** These guides can be opened without sharing CLI credentials or initiating an account query. */
export function accountUsageLinks(
  id: string,
  config: Pick<AcpAgentConfig, 'command' | 'args' | 'env' | 'runtime'>,
  model?: string,
): readonly AcpAccountUsageLink[] {
  if (retiredAgentReason(id, config)) return []
  const runtime = effectiveRuntimeOf(id, config)
  if ((runtime === 'codebuddy' || !runtime) && isAnonymousCodeBuddyLaunch(config))
    return codeBuddyUsageLinks(config.env)
  if (!runtime && isLocalOpenCodeReviewProfile(config)) {
    const provider = isOpenCodeReviewModel(model) ? model.split('/')[0] : undefined
    const billedByOpenCode = provider === 'opencode' || provider === 'opencode-go'
    return [
      {
        site: 'provider',
        url: billedByOpenCode ? 'https://opencode.ai/docs/console/billing/' : 'https://opencode.ai/docs/providers/',
      },
    ]
  }
  const claude = launchArgs(config, 'claude-agent-acp', /^@agentclientprotocol\/claude-agent-acp(?:@[\w.+-]+)?$/)
  if ((!runtime || runtime === 'claude') && claude?.length === 0) {
    return [{ site: 'provider', url: 'https://code.claude.com/docs/en/costs' }]
  }
  const qwen = launchArgs(config, 'qwen', /^@qwen-code\/qwen-code(?:@[\w.+-]+)?$/)
  if (
    !runtime &&
    qwen?.[0] === '--acp' &&
    (qwen.length === 1 || (qwen.length === 2 && qwen[1] === '--experimental-skills'))
  ) {
    // The same model ID can be billed by Qwen, Model Studio, or a custom provider.
    return [{ site: 'provider', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/' }]
  }
  return []
}
