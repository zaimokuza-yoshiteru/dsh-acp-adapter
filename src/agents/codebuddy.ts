import type { AcpStubAgentConfig } from '../contract/agent-config.ts'

/** CodeBuddy resets its remote session after cancelling a prompt. The shared
 * runtime still owns cancellation, replacement, and durable binding updates. */
export const codebuddySessionOptions = { refreshSessionAfterCancelledPrompt: true } as const

/** Handshake identity also covers manually configured generic profiles. */
export function codebuddyHasModelSpecificConfiguration(agentName: string | undefined): boolean {
  return agentName === 'codebuddy-code'
}

/** CodeBuddy 2.161.2 omits agentInfo. Only its documented direct or Registry launch qualifies. */
export function isAnonymousCodeBuddyLaunch(
  profile: Pick<AcpStubAgentConfig, 'command' | 'args' | 'runtime'> | undefined,
): boolean {
  if (!profile || (profile.runtime !== undefined && profile.runtime !== 'codebuddy')) return false
  const command = profile.command
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, '')
  const args = profile.args
  if (command === 'codebuddy' || command === 'codebuddy-code') return args.length === 1 && args[0] === '--acp'
  if (command !== 'npx' || profile.runtime !== 'codebuddy') return false
  const index = args[0] === '-y' || args[0] === '--yes' ? 1 : 0
  return (
    args.length === index + 2 &&
    /^@tencent-ai\/codebuddy-code(?:@[\w.+-]+)?$/u.test(args[index] ?? '') &&
    args[index + 1] === '--acp'
  )
}
