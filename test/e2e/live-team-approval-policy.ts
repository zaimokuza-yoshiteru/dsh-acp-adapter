import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-tools'

/** A test-local sandbox precondition, not an approval answerer or a production permission setting. */
export function installLiveTeamApprovalPolicy(
  ctx: Context,
  { lead, memberName, command, token }: { lead: Agent; memberName: string; command: string; token: string },
) {
  const bash = ctx.tools.schemas(lead).find((tool) => tool.name === 'bash')
  const properties = bash?.parameters.properties
  const permissions =
    properties !== null && typeof properties === 'object' && 'sandbox_permissions' in properties
      ? properties.sandbox_permissions
      : undefined
  if (ctx.get('sandboxPolicy') === undefined || ctx.shell.sandboxMode === undefined || permissions === undefined)
    throw new Error('LIVE_TEAM_APPROVAL_REQUIRES_NATIVE_SANDBOX_BASH')

  let member: Agent | undefined
  let admittedCallId: ToolCallId | undefined
  let admissionPolicy: { previous: SandboxMode; effective: SandboxMode } | undefined
  const violations: string[] = []
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership?.role !== 'teammate' || membership.root !== lead || membership.name !== memberName) return
    if (member !== undefined) throw new Error('LIVE_TEAM_APPROVAL_DUPLICATE_MEMBER')
    // Identify the real child before its queued work starts. Its ACP setup can
    // still synchronize inherited Lead policy after this boundary, so the test
    // sandbox precondition belongs at exact tool admission below.
    member = agent
  })
  const disposeGuard = ctx.tools.guard((execution) => {
    const args = execution.arguments as Record<string, unknown> | undefined
    // An accidental Lead/other-member execution must not satisfy this test.
    if (member === undefined || execution.agent !== member) {
      if (execution.name !== 'bash' || args?.command !== command) return undefined
      violations.push('wrong-command-owner')
      return 'LIVE_TEAM_APPROVAL_WRONG_COMMAND_OWNER'
    }
    if (
      execution.name === 'send_message' &&
      args?.target === 'lead' &&
      typeof args.message === 'string' &&
      args.message.includes(token)
    )
      return undefined
    if (
      execution.name !== 'bash' ||
      args?.command !== command ||
      args.sandbox_permissions !== 'danger-full-access' ||
      typeof args.justification !== 'string' ||
      !args.justification.includes(token) ||
      args.run_in_background === true ||
      args.workdir !== undefined ||
      admittedCallId !== undefined
    ) {
      violations.push(`unexpected-member-call:${execution.name}`)
      return 'LIVE_TEAM_APPROVAL_EXPECTED_ONE_EXACT_ESCALATED_BASH'
    }
    const previous = ctx.sandboxPolicy.resolve({ session: member.session }).mode
    if (previous !== 'read-only') setSandboxMode(member.session, 'read-only')
    const effective = ctx.sandboxPolicy.resolve({ session: member.session }).mode
    if (effective !== 'read-only') {
      violations.push('sandbox-precondition-not-effective')
      return 'LIVE_TEAM_APPROVAL_SANDBOX_OVERRIDE_NOT_EFFECTIVE'
    }
    // This final native admission guard only establishes the isolated test
    // policy. Published tool-bash reads it next and owns approveEscalation;
    // the guard never fabricates or answers an approval request.
    admissionPolicy = { previous, effective }
    admittedCallId = execution.callId
    return undefined
  })
  return {
    get member() {
      return member
    },
    get admittedCallId() {
      return admittedCallId
    },
    get admissionPolicy() {
      return admissionPolicy
    },
    violations,
    dispose() {
      disposeGuard()
      disposeCreated()
    },
  }
}
