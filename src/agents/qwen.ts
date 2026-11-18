/** Qwen publishes reasoning choices only after selecting the corresponding model. */
export function qwenHasModelSpecificConfiguration(agentName: string | undefined): boolean {
  return agentName === 'qwen-code'
}
