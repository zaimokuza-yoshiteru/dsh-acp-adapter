// capability-facts.ts — picker 三值词镜像（client selector-logic.ts
// `pickerCapabilityWords`）与 domain 能力矩阵（domain/policy/capability-matrix.ts
// `acpCapabilityMatrix`）的共有输入夹具。
//
// 分层纪律禁止 client import domain（test/contracts/architecture.spec.ts），因此 picker
// 披露区的三值词是矩阵行 status 的镜像纯函数；本夹具是「同一输入、两侧独立
// 实现」的漂移防线：capability-matrix.spec.ts 钉矩阵侧 + 两侧一致性，
// selector-logic.spec.ts 钉镜像侧词表。
//
// 形状同时结构兼容 domain `AcpCapabilityAdvertisement` 与 client
// `LiveCapabilityFacts`（同为 initialize 广告九键的收窄副本）。

/** 九键广告事实（initialize 握手 Agent capabilities 的收窄形状）。 */
export interface CapabilityFactsFixture {
  loadSession: boolean
  sessionList: boolean
  sessionClose: boolean
  sessionDelete: boolean
  promptImage: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean
  mcpHttp: boolean
  mcpSse: boolean
}

/** 全广告。 */
export const ALL_ADVERTISED: CapabilityFactsFixture = {
  loadSession: true,
  sessionList: true,
  sessionClose: true,
  sessionDelete: true,
  promptImage: true,
  promptAudio: true,
  promptEmbeddedContext: true,
  mcpHttp: true,
  mcpSse: true,
}

/** 全不广告。 */
export const NONE_ADVERTISED: CapabilityFactsFixture = {
  loadSession: false,
  sessionList: false,
  sessionClose: false,
  sessionDelete: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
}

/**
 * Devin 实证形态：load/list/close/delete 全广告，prompt 广告 image，
 * 但不广告 audio/embeddedContext，MCP 不广告。图片的端到端状态还需
 * 结合 DSH attachment seam 计算，不能只根据 Agent 广告判定。
 */
export const DEVIN_LIKE: CapabilityFactsFixture = {
  loadSession: true,
  sessionList: true,
  sessionClose: true,
  sessionDelete: true,
  promptImage: true,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
}

/** 全部夹具（一致性用例遍历）。 */
export const CAPABILITY_FIXTURES: readonly CapabilityFactsFixture[] = [ALL_ADVERTISED, NONE_ADVERTISED, DEVIN_LIKE]
