/** Prepare native Agent process arguments and environment; MCP is negotiated after initialize. */
/// <reference types="node" />
import type { AcpAgentId, AcpStubAgentConfig } from '../../contract/agent-config.ts'
import { acpLaunchEnvironment } from '../../domain/session/launch-fingerprint.ts'
import { buildAcpSpawnPlan } from '../../domain/policy/sandbox.ts'
import type { AcpRuntimeLaunch } from '../../runtime/session/session-runtime.ts'

/** Python falls back to OS proxy settings only when no environment proxy wins. */
function hasExplicitProxyEnvironment(env: Record<string, string>): boolean {
  for (const name of ['http', 'https', 'all', 'no', 'ftp', 'ws', 'wss']) {
    const lower = env[`${name}_proxy`] ?? process.env[`${name}_proxy`]
    // Python gives lowercase values (including an explicit empty override)
    // precedence, and ignores uppercase HTTP_PROXY in a CGI environment.
    const upper =
      name === 'http' && (env.REQUEST_METHOD ?? process.env.REQUEST_METHOD) !== undefined
        ? undefined
        : (env[`${name.toUpperCase()}_PROXY`] ?? process.env[`${name.toUpperCase()}_PROXY`])
    if ((lower ?? upper ?? '') !== '') return true
  }
  return false
}

/** Exempt only the local endpoints required by the confirmed Agent runtime. */
function loopbackEnvironment(env: Record<string, string>, hosts: readonly string[]): Record<string, string> {
  // Read only these non-credential routing keys. The subprocess provider still
  // owns the scrubbed parent environment; profile overrides win per key.
  const parent = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
  const exclusions = new Set<string>()
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    for (const item of (env[key] ?? parent[key] ?? '').split(',')) {
      const exclusion = item.trim()
      if (exclusion !== '') exclusions.add(exclusion)
    }
  }
  for (const host of hosts) exclusions.add(host)
  // HTTP libraries differ in case precedence. Both must retain every effective
  // exclusion rather than a new lowercase value shadowing an existing list.
  const noProxy = [...exclusions].join(',')
  return { ...env, NO_PROXY: noProxy, no_proxy: noProxy }
}

export async function prepareAgentLaunch(
  runtime: AcpAgentId | undefined,
  config: AcpStubAgentConfig,
): Promise<AcpRuntimeLaunch> {
  let env = await acpLaunchEnvironment({ config })
  // Discovery can initialize this process before MCP tools become available;
  // the same connection needs the bypass when its first DSH session is opened.
  if (runtime === 'codex' || runtime === 'devin') env = loopbackEnvironment(env, ['127.0.0.1'])
  // Official Antigravity connects to its own local harness at these two hosts.
  // Sending that WebSocket through a system SOCKS proxy requires an optional
  // dependency the official server does not bundle, so session/new fails.
  // Do not create a proxy environment when Python would otherwise consult OS
  // settings: NO_PROXY alone would suppress that external proxy configuration.
  if (runtime === 'antigravity' && hasExplicitProxyEnvironment(env))
    env = loopbackEnvironment(env, ['localhost', '127.0.0.1'])
  const plan = buildAcpSpawnPlan({
    mode: 'danger-full-access',
    argv: [config.command, ...config.args],
    env,
  })
  return { argv: plan.argv, env: plan.env, spawnPlan: plan }
}
