/**
 * 端到端能力矩阵：Agent 在 initialize 握手广告的能力不等于
 * 产品端到端能力——图片输入还要求 DSH durable attachment seam。本模块把每行能力的三列事实（Agent advertisement / adapter path /
 * host seam）折成三值状态（supported | degraded | unsupported），host 侧计算
 * （src/remote/service.ts 的 health probe-ok 分支）、wire 传输
 * （src/contract/remote.ts `AcpCapabilityMatrixRow`）、client 渲染
 * （src/client/ui/AcpSection.ts 健康卡能力区）。
 *
 * 零 import 叶子（分层守卫见 test/contracts/architecture.spec.ts）：输入是 contract
 * `AcpCapabilityFacts` 的结构镜像（本模块自带源形状
 * 声明，TS 结构兼容，不反向 import contract）。note 是 host 侧事实陈述
 * （与 `AcpProbeCleanupView.message` 同款口径：原始英文事实文本过线，
 * client 只做次级展示，不过 locale）。
 *
 * 广告数据缺席（caps 为 null = 未 probe/未握手）时矩阵不空缺：每行
 * advertised=null，status 仍按 adapter/host 事实如实给出。
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

/** Health probe 的临时沙箱事实；保留为兼容输入，但不作为正式会话能力展示。 */

/** Host/plugin seams that materially change end-to-end capability. */
export interface AcpCapabilityHostSeams {
  readonly imageInput: boolean
}

/** caps 为 null（无握手数据）时广告门控行的统一说明。 */
const UNKNOWN_ADVERTISEMENT_NOTE = 'agent capabilities unknown (no successful probe handshake)'

/** session/close、session/delete 未广告时的兜底说明（既定降级口径）。 */
const CLEANUP_FALLBACK_NOTE =
  'not advertised; probe session leftovers fall back to process teardown'

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
 * 尚无稳定 DSH 输入 seam 的 prompt 内容行。广告与否端到端均 unsupported；
 * advertised === true 时说明缺的是插件/宿主桥，而不是 Agent 能力。
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
            `the agent advertises ${blockKind} input, but DSH does not expose a stable typed input seam for it; ` +
            'sending is blocked before the Agent receives a prompt',
        }
      : {}),
  }
}

function imageRow(advertised: boolean | null, available: boolean): AcpCapabilityMatrixRow {
  if (advertised === true && available) {
    return {
      id: 'promptImage',
      advertised,
      adapterPath: 'durable-attachment-to-inline-image',
      hostSeam: 'attachments',
      status: 'supported',
    }
  }
  return {
    id: 'promptImage',
    advertised,
    adapterPath: 'durable-attachment-to-inline-image',
    hostSeam: available ? 'attachments' : null,
    status: 'unsupported',
    note: advertised === null
      ? UNKNOWN_ADVERTISEMENT_NOTE
      : advertised === false
        ? 'the agent did not advertise image prompt support'
        : 'DSH durable attachment storage is not available on this host',
  }
}

/**
 * ACP 传输广告只说明 Agent 能接收 client 传入的 MCP server。当前插件
 * 没有 DSH 可序列化 MCP registry seam，session/new 与 session/load 传空列表，
 * 因此不能把该广告标成端到端支持。Agent 自己的 MCP 配置仍由 Agent 管理。
 */
function mcpRow(id: string, advertised: boolean | null): AcpCapabilityMatrixRow {
  if (advertised === true) {
    return {
      id,
      advertised,
      adapterPath: 'mcpServers-empty',
      hostSeam: null,
      status: 'degraded',
      note: 'the Agent advertises this MCP transport, but DSH MCP servers are not injected; Agent-native MCP configuration remains authoritative',
    }
  }
  return {
    id,
    advertised,
    adapterPath: 'mcpServers-empty',
    hostSeam: null,
    status: 'unsupported',
    note: advertised === null ? UNKNOWN_ADVERTISEMENT_NOTE : 'the Agent did not advertise this MCP transport',
  }
}

/**
 * 计算端到端能力矩阵（每行三列事实齐备，行集与顺序恒定）：
 * 九个 Agent 广告能力行。caps 为 null 时广告列
 * 全 null，status 按 adapter/host 事实照常给出（矩阵不因缺广告数据而空缺）。
 */
export function acpCapabilityMatrix(
  caps: AcpCapabilityAdvertisement | null,
  host: AcpCapabilityHostSeams = { imageInput: false },
): readonly AcpCapabilityMatrixRow[] {
  const advertised = (key: keyof AcpCapabilityAdvertisement): boolean | null => (caps === null ? null : caps[key])
  return [
 // 对账恢复的前提（resume-staging）；resume 前的查重/列举消费 sessionList
    gatedRow('loadSession', advertised('loadSession'), 'resume-staging'),
    gatedRow('sessionList', advertised('sessionList'), 'resume-precheck'),
 // probe 会话清理；未广告 = 探测会话可能残留，进程拆除兜底
    gatedRow('sessionClose', advertised('sessionClose'), 'probe-cleanup', CLEANUP_FALLBACK_NOTE),
    gatedRow('sessionDelete', advertised('sessionDelete'), 'probe-cleanup', CLEANUP_FALLBACK_NOTE),
    imageRow(advertised('promptImage'), host.imageInput),
    textOnlyRow('promptAudio', advertised('promptAudio'), 'audio'),
    textOnlyRow('promptEmbeddedContext', advertised('promptEmbeddedContext'), 'embedded-context'),
    mcpRow('mcpHttp', advertised('mcpHttp')),
    mcpRow('mcpSse', advertised('mcpSse')),
  ]
}
