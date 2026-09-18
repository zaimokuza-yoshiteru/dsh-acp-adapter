/**
 * Registry 快照的上游版本参考（host 半的消费面）。
 *
 * 数据源是 CI 同步进仓库的 assets/registry/*.json（与 client 半
 * src/client/data/catalog.ts 同一份快照）：executables.json sidecar 的
 * entries[agentId].version 即「该 registry agent 的上游版本事实」。host 半
 * 不 import client 模块（client bundle 目标 browser），这里独立内嵌同一份
 * 纯数据——两层消费同一快照文件，一致性由 CI 的
 * scripts/verify-registry-snapshot.ts 钉死。
 * @module @zaimokuza/dsh-acp-adapter/domain/session/registry-versions
 */

import executablesJson from '../../../assets/registry/executables.json' with { type: 'json' }

interface ExecutableEntry {
  readonly version: string
}

const executableEntries = (executablesJson as { readonly entries: { readonly [id: string]: ExecutableEntry } }).entries

/**
 * 按 registry agent id 查上游版本参考（readiness 比对的参考侧；
 * 无该 agent 的快照事实 → undefined，兼容状态诚实归 null/unknown）。
 */
export function registryVersionOf(registryAgentId: string): string | undefined {
  return executableEntries[registryAgentId]?.version
}
