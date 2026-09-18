/** Prepare a native Agent process, including the optional Devin pre-launch MCP overlay. */
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpAgentId, AcpStubAgentConfig } from '../../contract/agent-config.ts'
import { acpLaunchEnvironment } from '../../domain/session/launch-fingerprint.ts'
import { buildAcpSpawnPlan } from '../../domain/policy/sandbox.ts'
import type { AcpRuntimeLaunch } from '../../runtime/session/session-runtime.ts'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'
import { prepareDevinTeamConfig } from '../teams/devin-config.ts'

export async function prepareAgentLaunch(
  runtime: AcpAgentId | undefined,
  config: AcpStubAgentConfig,
  cwd: string,
  createMcpLease: ((capabilities: acp.AgentCapabilities) => Promise<AcpMcpLease | undefined>) | undefined,
): Promise<AcpRuntimeLaunch> {
  let env = await acpLaunchEnvironment({ config })
  let mcpLease: AcpMcpLease | undefined
  // Devin reads MCP servers from its config at process startup, before ACP initialize.
  if (runtime === 'devin') {
    const lease = await createMcpLease?.({ mcpCapabilities: { http: true } })
    if (lease !== undefined) {
      const prepared = await prepareDevinTeamConfig(env, lease)
      env = prepared.env
      mcpLease = prepared.lease
    }
  }
  try {
    const plan = buildAcpSpawnPlan({ mode: 'danger-full-access', workspaceRoot: cwd, argv: [config.command, ...config.args], env })
    return { argv: plan.argv, env: plan.env, spawnPlan: plan, ...(mcpLease === undefined ? {} : { mcpLease }) }
  } catch (error) {
    await mcpLease?.close()
    throw error
  }
}
