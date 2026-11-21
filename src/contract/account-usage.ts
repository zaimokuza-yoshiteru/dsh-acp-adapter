import { effectiveRuntimeOf, retiredAgentReason, type AcpAgentConfig } from './agent-config.ts'
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
    config.args.length === 1 &&
    config.args[0] === 'acp'
  )
    return 'antigravity'
  return undefined
}
