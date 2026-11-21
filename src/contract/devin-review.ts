import { reviewPeerStatus } from './review-peer.ts'
import type { AcpAgentConfig } from './agent-config.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from './config-options.ts'

export const DEFAULT_DEVIN_REVIEW_MODEL = 'swe-2-high'

export function isDevinReviewModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ACP_CONFIG_IDENTIFIER_MAX &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** Only explicit local ACP invocations can create an independent tool-free Devin. */
export function isLocalDevinReviewProfile(config: Pick<AcpAgentConfig, 'command' | 'args'>): boolean {
  if (!/^devin(?:\.exe)?$/i.test(config.command.split(/[\\/]/).at(-1) ?? '')) return false
  let acp = false
  for (let i = 0; i < config.args.length; i++) {
    const flag = config.args[i]
    if (flag === 'acp' && !acp) {
      acp = true
      continue
    }
    const value = config.args[++i]
    if (flag === '--model' && isDevinReviewModel(value)) continue
    if (flag === '--process-model' && (value === 'daemon' || value === 'in-process')) continue
    if (flag === '--permission-mode' && !acp && value && ['auto', 'accept-edits', 'smart', 'dangerous'].includes(value))
      continue
    return false
  }
  return acp
}

/** Only this CLI build's extension-registry layout and session/new timing have been verified. */
export function isDevinReviewerAgent(info: Parameters<typeof reviewPeerStatus>[1]): boolean {
  return reviewPeerStatus('devin', info) === 'verified'
}
