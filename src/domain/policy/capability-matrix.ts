/**
 * 端到端能力矩阵：Agent 在 initialize 握手广告的能力不等于
 * 产品端到端能力——adapter 的 prompt 路径只发文本块（src/domain/session/agent.ts
 * `toAcpPrompt()` 对非文本块抛 AcpPromptContentError，发送被阻止并解释），
 * mcpServers 固定为空（D10：Agent 用自带工具），沙箱 enforcement 是宿主平台
 * 事实。本模块把每行能力的三列事实（Agent advertisement / adapter path /
 * host seam）折成三值状态（supported | degraded | unsupported），host 侧计算
 * （src/remote/service.ts 的 health probe-ok 分支）、wire 传输
 * （src/contract/remote.ts `AcpCapabilityMatrixRow`）、client 渲染
 * （src/client/ui/AcpSection.ts 健康卡能力区）。
 *
 * 零 import 叶子（分层守卫见 test/contracts/architecture.spec.ts）：输入是 contract
 * `AcpCapabilityFacts` / `AcpSandboxPosture` 的结构镜像（本模块自带源形状
 * 声明，TS 结构兼容，不反向 import contract）。note 是 host 侧事实陈述
 * （与 `AcpProbeCleanupView.message` 同款口径：原始英文事实文本过线，
 * client 只做次级展示，不过 locale）。
 *
 * 广告数据缺席（caps 为 null = 未 probe/未握手）时矩阵不空缺：每行
 * advertised=null，status 仍按 adapter/host 事实如实给出（例如 promptImage
 * 行恒 unsupported——adapter path 决定，与广告无关）。
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/capability-matrix
 */

/** 能力矩阵一行的端到端状态词表（恒定三值）。 */
export type AcpCapabilityMatrixStatus = 'supported' | 'degraded' | 'unsupported'

/**
 * 矩阵的一行：三列事实（advertised = Agent initialize 广告值，无广告数据归
 * null；adapterPath = adapter 实现路径的短事实词；hostSeam = 参与该能力的
 * 宿主 seam 短事实词，无 host seam 参与归 null）+ 派生的三值 status + 可选
 * note（降级/不支持的原因或设计决策出处）。
 */
export interface AcpCapabilityMatrixRow {
  readonly id: string
  readonly advertised: boolean | null
  readonly adapterPath: string
  readonly hostSeam: string | null
  readonly status: AcpCapabilityMatrixStatus
  readonly note?: string
}

/** initialize 握手广告能力的源形状（结构镜像 contract `AcpCapabilityFacts`）。 */
export interface AcpCapabilityAdvertisement {
  readonly loadSession: boolean
  readonly sessionList: boolean
  readonly sessionClose: boolean
  readonly sessionDelete: boolean
  readonly promptImage: boolean
  readonly promptAudio: boolean
  readonly promptEmbeddedContext: boolean
  readonly mcpHttp: boolean
  readonly mcpSse: boolean
}

/** 本平台沙箱强制级别的源形状（结构镜像 contract `AcpSandboxPosture`）。 */
export interface AcpSandboxPostureFact {
  readonly platform: string
  readonly enforcement: 'full' | 'partial'
  readonly note: string | null
}

/** caps 为 null（无握手数据）时广告门控行的统一说明。 */
const UNKNOWN_ADVERTISEMENT_NOTE = 'agent capabilities unknown (no successful probe handshake)'

/** session/close、session/delete 未广告时的兜底说明（既定降级口径）。 */
const CLEANUP_FALLBACK_NOTE =
  'not advertised; probe session leftovers fall back to process teardown'

/** MCP 行的设计决策说明（D10：mcpServers 固定 []，Agent 用自带工具）。 */
const MCP_BY_DESIGN_NOTE = 'by design the agent uses its own tools; the adapter sends mcpServers: [] (D10)'

/**
 * 广告门控行：advertised === true → supported；false → unsupported（带该行
 * 专属的未广告说明）；null（无握手数据）→ unsupported + 统一未知说明。
 */
function gatedRow(
  id: string,
  advertised: boolean | null,
  adapterPath: string,
  notAdvertisedNote?: string,
): AcpCapabilityMatrixRow {
  if (advertised === true) return { id, advertised, adapterPath, hostSeam: null, status: 'supported' }
  const note = advertised === null ? UNKNOWN_ADVERTISEMENT_NOTE : notAdvertisedNote
  return {
    id,
    advertised,
    adapterPath,
    hostSeam: null,
    status: 'unsupported',
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * 非文本 prompt 输入行：adapter v1 只发文本块，广告与否端到端恒 unsupported；
 * advertised === true 时 note 点破「Agent 广告了但发送会被阻止并解释」。
 */
function textOnlyRow(id: string, advertised: boolean | null, blockKind: string): AcpCapabilityMatrixRow {
  return {
    id,
    advertised,
    adapterPath: 'text-only-block',
    hostSeam: null,
    status: 'unsupported',
    ...(advertised === true
      ? {
          note:
            `the agent advertises ${blockKind} input, but adapter v1 prompts are text-only; ` +
            'sending is blocked with an explanation (ACP_UNSUPPORTED_CONTENT)',
        }
      : {}),
  }
}

/** MCP 行：D10 固定 mcpServers: []，广告与否端到端恒 unsupported，note 恒带设计决策出处。 */
function mcpRow(id: string, advertised: boolean | null): AcpCapabilityMatrixRow {
  return { id, advertised, adapterPath: 'mcpServers-empty', hostSeam: null, status: 'unsupported', note: MCP_BY_DESIGN_NOTE }
}

/**
 * 沙箱行（hostSeam 行；非 Agent 广告能力，advertised 恒 null）：enforcement
 * full → supported；partial → degraded（note 带平台）；posture 缺席（host 未
 * 接线）→ degraded + 「沙箱事实未接线」说明——不拿缺席冒充 full。
 */
function sandboxRow(posture: AcpSandboxPostureFact | null): AcpCapabilityMatrixRow {
  const base = { id: 'sandbox', advertised: null, adapterPath: 'confined-spawn', hostSeam: 'sandbox-enforcement' } as const
  if (posture === null) {
    return { ...base, status: 'degraded', note: 'sandbox facts not wired on this host' }
  }
  if (posture.enforcement === 'full') {
    return { ...base, status: 'supported' }
  }
  return {
    ...base,
    status: 'degraded',
    note: posture.note === null ? `${posture.platform}: partial enforcement` : `${posture.platform}: ${posture.note}`,
  }
}

/**
 * 计算端到端能力矩阵（每行三列事实齐备，行集与顺序恒定）：
 * 九个 Agent 广告能力行 + 一个 sandbox host seam 行。caps 为 null 时广告列
 * 全 null，status 按 adapter/host 事实照常给出（矩阵不因缺广告数据而空缺）。
 */
export function acpCapabilityMatrix(
  caps: AcpCapabilityAdvertisement | null,
  sandbox: AcpSandboxPostureFact | null,
): readonly AcpCapabilityMatrixRow[] {
  const advertised = (key: keyof AcpCapabilityAdvertisement): boolean | null => (caps === null ? null : caps[key])
  return [
 // 对账恢复的前提（resume-staging）；resume 前的查重/列举消费 sessionList
    gatedRow('loadSession', advertised('loadSession'), 'resume-staging'),
    gatedRow('sessionList', advertised('sessionList'), 'resume-precheck'),
 // probe 会话清理；未广告 = 探测会话可能残留，进程拆除兜底
    gatedRow('sessionClose', advertised('sessionClose'), 'probe-cleanup', CLEANUP_FALLBACK_NOTE),
    gatedRow('sessionDelete', advertised('sessionDelete'), 'probe-cleanup', CLEANUP_FALLBACK_NOTE),
    textOnlyRow('promptImage', advertised('promptImage'), 'image'),
    textOnlyRow('promptAudio', advertised('promptAudio'), 'audio'),
    textOnlyRow('promptEmbeddedContext', advertised('promptEmbeddedContext'), 'embedded-context'),
    mcpRow('mcpHttp', advertised('mcpHttp')),
    mcpRow('mcpSse', advertised('mcpSse')),
    sandboxRow(sandbox),
  ]
}
