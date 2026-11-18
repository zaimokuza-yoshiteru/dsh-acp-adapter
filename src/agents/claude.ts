/** Explicit runtime binding enables Claude's draft notification extension. */
export const claudeCompatibility = {
  executableOverrideEnv: 'CLAUDE_CODE_EXECUTABLE',
  enableDraftSubagents: true,
} as const
