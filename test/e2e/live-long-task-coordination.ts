/** Lead discovery may precede relay; the current member's discovery and Lead waiting require relay success. */
export function isMemberApprovalCoordination({
  scene,
  phase,
  owner,
  lead,
  member,
  toolName,
  args,
  relaySucceeded,
}: {
  scene: string
  phase: string
  owner: string
  lead: string | undefined
  member?: string | undefined
  toolName: string
  args: unknown
  relaySucceeded: boolean
}): boolean {
  if (scene !== 'C' || (phase !== 'C:member-allow' && phase !== 'C:member-reject') || lead === undefined) return false
  const isLead = owner === lead
  if (!isLead && (member === undefined || owner !== member || !relaySucceeded)) return false
  const input = args === undefined ? {} : args
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const values = input as Record<string, unknown>
  if (toolName === 'list_agents') return Object.keys(values).length === 0
  if (
    toolName !== 'wait_agent' ||
    !isLead ||
    !relaySucceeded ||
    Object.keys(values).some((key) => key !== 'timeout_ms')
  )
    return false
  const timeout = values.timeout_ms === undefined ? 30_000 : values.timeout_ms
  return typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout >= 10_000 && timeout <= 60_000
}

/** Parse only the public Host approval reason; malformed or unrelated requests remain denied. */
export function memberCoordinationArguments(toolName: string, reason: string | undefined): unknown {
  if (
    !['list_agents', 'wait_agent'].includes(toolName) ||
    typeof reason !== 'string' ||
    !reason.startsWith(`${toolName}\n`)
  )
    return null
  try {
    return JSON.parse(reason.slice(toolName.length + 1)) as unknown
  } catch {
    return null
  }
}
