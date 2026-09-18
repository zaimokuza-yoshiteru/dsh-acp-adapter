/** Narrow compatibility rules for confirmed vendor behavior; no catalog or launch defaults. */
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpAgentId } from '../../contract/agent-config.ts'

export function executableOverrideEnvFor(runtime: AcpAgentId | undefined): string | undefined {
  return runtime === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : undefined
}

/** Devin owns reasoning internally; exposing the option would promise unsupported control. */
export function exposesReasoningControl(runtime: AcpAgentId | undefined): boolean {
  return runtime !== 'devin'
}

/** These Agents advertise different reasoning choices after selecting each model. */
export function modelProbeOptions(runtime: AcpAgentId | undefined): { probeModelConfigOptions: boolean } {
  return { probeModelConfigOptions: runtime === 'kimi' || runtime === 'codex' }
}

/** Opt into Claude's draft subagent notifications only for an explicitly bound runtime. */
export function sessionProtocolExtensions(runtime: AcpAgentId | undefined): { enableClaudeDraftSubagents: boolean } {
  return { enableClaudeDraftSubagents: runtime === 'claude' }
}

/** Kimi may resume `high` as `on`; accept only the live Agent-confirmed equivalent.
 * All other values still require exact equality or normal option validation.
 */
export function reasoningRequestIsCurrent(
  runtime: AcpAgentId | undefined,
  option: Extract<acp.SessionConfigOption, { type: 'select' }>,
  requested: string,
): boolean {
  if (option.currentValue === requested) return true
  if (runtime !== 'kimi' || requested !== 'high' || option.currentValue !== 'on') return false
  const values = new Set(option.options.flatMap(entry => 'options' in entry ? entry.options : [entry]).map(entry => entry.value))
  return values.has('on') && !values.has('high')
}
