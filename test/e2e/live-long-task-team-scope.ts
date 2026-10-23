/** Test-only authorization for scene B's public source review, never a product policy. */
export interface TeamReviewScope {
  readonly role: 'lead' | 'runtime-reader' | 'teams-reader'
  readonly sources: Readonly<Record<'runtime-reader' | 'teams-reader', readonly string[]>>
  readonly reportMarkers: Readonly<Record<'runtime-reader' | 'teams-reader', string>>
  readonly tasks: readonly { readonly id: string; readonly ownerName?: string; readonly description?: string }[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function keys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((key) => allowed.includes(key))
}
function empty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}
const members = ['runtime-reader', 'teams-reader'] as const

export function permitsTeamReviewTool(tool: string, raw: unknown, scope: TeamReviewScope): boolean {
  const args = object(raw)
  if (args === undefined) return false
  const lead = scope.role === 'lead'
  const task = scope.tasks.find((entry) => entry.id === args.task_id)
  const assignment = (name: (typeof members)[number], value: unknown): boolean =>
    text(value) &&
    scope.sources[name].every((path) => value.includes(path)) &&
    value.includes(scope.reportMarkers[name])
  switch (tool) {
    case 'read': {
      const paths = lead ? members.flatMap((name) => scope.sources[name]) : scope.sources[scope.role]
      return (
        keys(args, ['file_path', 'offset', 'limit']) &&
        typeof args.file_path === 'string' &&
        paths.includes(args.file_path) &&
        [args.offset, args.limit].every(
          (value) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0),
        )
      )
    }
    case 'spawn_teammate':
      return (
        lead &&
        keys(args, ['name', 'description', 'prompt', 'context']) &&
        members.some((name) => args.name === name && assignment(name, args.prompt)) &&
        text(args.description) &&
        (args.context === undefined || args.context === 'fresh')
      )
    case 'team_task_create':
      return (
        lead &&
        keys(args, ['subject', 'description', 'blocked_by', 'write_scopes']) &&
        text(args.subject) &&
        members.some((name) => assignment(name, args.description)) &&
        empty(args.blocked_by) &&
        empty(args.write_scopes)
      )
    case 'team_task_get':
      return (
        keys(args, ['task_id']) &&
        task !== undefined &&
        (lead ||
          task.ownerName === scope.role ||
          (task.ownerName === undefined && assignment(scope.role, task.description)))
      )
    case 'team_task_list':
      return (
        lead &&
        keys(args, ['status', 'owner', 'ready', 'cursor', 'limit']) &&
        (args.status === undefined || ['pending', 'in_progress', 'completed'].includes(String(args.status))) &&
        (args.owner === undefined || [...members, 'unowned'].includes(String(args.owner))) &&
        (args.ready === undefined || typeof args.ready === 'boolean') &&
        (args.cursor === undefined || (Number.isSafeInteger(args.cursor) && Number(args.cursor) >= 0)) &&
        (args.limit === undefined ||
          (Number.isSafeInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 100))
      )
    case 'team_task_update':
      return (
        keys(args, ['task_id', 'expected_revision', 'action', 'subject', 'description', 'owner']) &&
        task !== undefined &&
        Number.isSafeInteger(args.expected_revision) &&
        Number(args.expected_revision) >= 0 &&
        (lead
          ? (args.action === 'reassign' && members.includes(args.owner as (typeof members)[number])) ||
            args.action === 'edit'
          : ((task.ownerName === scope.role && ['claim', 'edit', 'complete'].includes(String(args.action))) ||
              (args.action === 'claim' && task.ownerName === undefined && assignment(scope.role, task.description))) &&
            args.owner === undefined) &&
        (args.subject === undefined || text(args.subject)) &&
        (args.description === undefined || text(args.description))
      )
    case 'send_message':
      return (
        keys(args, ['target', 'message']) &&
        text(args.message) &&
        (lead ? members.includes(args.target as (typeof members)[number]) : args.target === 'lead')
      )
    case 'list_agents':
      return Object.keys(args).length === 0
    case 'wait_agent':
      return (
        lead &&
        keys(args, ['timeout_ms']) &&
        (args.timeout_ms === undefined ||
          (Number.isSafeInteger(args.timeout_ms) &&
            Number(args.timeout_ms) >= 10_000 &&
            Number(args.timeout_ms) <= 180_000))
      )
    default:
      return false
  }
}
