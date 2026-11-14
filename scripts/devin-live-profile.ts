/** Shared published profile composition for the real run and zero-inference preflight. */
export const DEVIN_LIVE_BUNDLES = ['@deepseek-ai/dsh-base', '@zaimokuza/dsh-acp-adapter']

export function devinLiveProfilePatch(workspace: string) {
  return [
    ...[
      'session-title-llm',
      'llm-deepseek',
      'llm-pi-ai',
      'agent-instructions',
      'skill-filesystem',
      'session-telemetry-otel',
    ].map((id) => ({ id, disabled: true })),
    { id: 'agent-team', config: { defaultEnabled: true, maxTasks: 8 } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
  ]
}
