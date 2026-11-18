/** CodeBuddy resets its remote session after cancelling a prompt. The shared
 * runtime still owns cancellation, replacement, and durable binding updates. */
export const codebuddySessionOptions = { refreshSessionAfterCancelledPrompt: true } as const

/** Handshake identity also covers manually configured generic profiles. */
export function codebuddyHasModelSpecificConfiguration(agentName: string | undefined): boolean {
  return agentName === 'codebuddy-code'
}
