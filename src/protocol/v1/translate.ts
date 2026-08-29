/**
 * `session/update` → dsh `SessionEvent` translation ( table).
 * This module performs the event mapping. Replay suppression during session/load lives in
 * src/domain/session/resume.ts (§5.7): whatever is fed here is logged, so the
 * caller must not feed replayed updates.
 *
 * Pure state machine: no I/O, no clocks, no randomness of its own. Events
 * enter the log only through the injected {@link SessionEventSink} append
 * port, so every returned event carries the real session-assigned `seq`/`time`
 * and `sourceEventSeqs` citations are real seqs by construction — interleaved
 * lifecycle appends owned by AcpAgent cannot desync the bookkeeping.
 *
 * Turn mapping (PresentationSegmenter): one ACP `session/prompt` = one DSH
 * turn. ACP does not expose model-loop step boundaries, so this adapter emits
 * **synthetic presentation steps** around each ordered assistant/tool phase.
 * These `step/start`/`step/end` pairs satisfy DSH's conversation lifecycle
 * contract (settled Assistant actions, trajectory grouping and session
 * invariants); they do not claim that ACP has native step semantics. The
 * `step` field is allocated per turn by {@link PresentationSegmenter} and is
 * DSH-side presentation identity ONLY
 * (upstream ui-conversation keys the assistant conversation node by
 * `turn:step` and anchors/sorts chat nodes by seq; see reference
 * ui-conversation conversation-nodes/assistant.ts + chat-snapshot-builder.ts).
 * ACP itself has no step semantics and this module does not claim otherwise.
 * Turn-level lifecycle events (`turn/start`, `user/message`,
 * `request/header`, `turn/end`) are NOT emitted here — AcpAgent owns them.
 * This translator owns the synthetic `step/start`/`step/end` pairs plus the
 * translated content (`assistant/chunk`, `assistant/message`, `tool/call`,
 * `tool/result`, `request/context`).
 *
 * segmentation（消息展示顺序 修复——Kimi 排序缺陷：正文流式期锚在 tool 卡片
 * 上方、endTurn 落 assistant/message 后又跳到下方）：一个 turn 的展示被切成
 * 有序段落 `none → assistant segment → tool segment(s) → assistant segment → …`，
 * 每段一个稳定递增的 synthetic presentation step：
 * - 文本（message/thought chunk、plan 折叠、非文本占位）聚合进当前 assistant
 *   segment；**tool/call 到达前先把积累的 assistant segment flush 成
 *   `assistant/message`**（落盘 seq 先于 tool/call —— settled 锚点因此恒在
 *   tool 卡片之上，不再跳变）；
 * - 同一并行 tool phase 的调用共享一个 step，其后的 update/result 复用；
 *   同 step 先落一个标准 assistant tool-call message 注册 DSH 的调用归属，
 *   再落独立 tool/call；否则完成态会被上游轨迹视为 orphan 并移到顶部；
 * - tool 之后的新文本开**新的** assistant segment（新 step、新
 *   `assistant/message`），绝不回写已提交的旧消息；
 * - `endTurn` flush 当前开放 segment 并关闭展示 step，不移动已提交消息；
 * - 不产空 assistant message（segment 无内容则 flush 无事件）。
 * 说明性 assistant 消息（resume.ts 的 notes 族，不经本翻译器）走专用
 * {@link ACP_NOTE_STEP} 泳道，不与内容 segment 共享 `turn:step` 节点身份。
 *
 * live 与 session/load 回放共用同一套翻译/分段：回放期更新经
 * {@link ReplayTranslator} 喂入同一个 {@link TurnTranslator}（staging sink
 * 记录事件，绝不落 session log），对账两侧因此由同一代码路径产出可见历史。
 *
 * Typical driver:
 * ```ts
 * const translator = new TurnTranslator({
 *   sink: sessionEventSink(session), provider: 'acp-devin', model: '<model>',
 * })
 * // per session/prompt:
 * translator.beginTurn(turn)               // turn numbers from 1, sequential
 * // ...each session/update notification:
 * translator.feed(notification)
 * // ...after the prompt response (or on crash/cancel, best effort):
 * translator.endTurn  * ```
 *
 * Out-of-turn discipline: updates fed outside a `beginTurn`/`endTurn` bracket
 * are still translated best-effort (lossless log philosophy) under the current
 * {@link TurnTranslator.turn} (`0` before the first `beginTurn`), and the call
 * is flagged in {@link TurnTranslator.warnings} with `'update-outside-turn'`.
 * Whether out-of-turn updates may reach the translator at all (e.g. during
 * session/load replay) is the discipline of src/domain/session/resume.ts, not this module's.
 *
 * Compatibility boundary: Claude nested subagent transcript 等 agent 私有 extension 不协商、
 * 不绑定基础发布——未协商时的既定行为就是 ACP 标准扁平 tool result 回退
 * （tool_call/tool_call_update 的 content 逐条映射，见 fidelity 段）；未知
 * `_meta` 与未知 sessionUpdate 变体由 SDK 校验层丢弃 + 本模块 switch default
 * 分支兜底（'unknown-session-update' warning），会话绝不因扩展流量失败。
 *
 * Tool presentation boundary: `tool/call` 的 `name` 恒为稳定名
 * `ACP_EXTERNAL_TOOL_NAME`（宿主 keyed `tool.call.toolview` 槽位按 wire tool
 * name 分发），动态 title/kind 移入 meta——首帧 title 随 `meta.acpToolCall`
 * 落盘，终态展示事实以版本化有界信封 `meta.acpToolPresentation` 随配对
 * `tool/result` 落盘（形状与界限见 ./tool-presentation.ts，本模块的唯一
 * 新增叶子依赖）。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；由于本模块需要
 * node:crypto（二进制内容占位摘要的 sha256-16），经下方 triple-slash reference
 * 显式引入 @types/node（src/protocol/v1/connection.ts 同款先例），不改动共享 tsconfig。
 */
/// <reference types="node" />

import type {
  AvailableCommand,
  ContentChunk,
  Plan,
  PlanEntry,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  UsageUpdate,
} from '@agentclientprotocol/sdk'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TextBlock } from '@deepseek-ai/dsh-llm'
import type {
  JsonValue,
  Session,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceEventType,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import {
  ACP_EXTERNAL_TOOL_NAME,
  ACP_TOOL_CONTENT_HASH_HEX_CHARS,
  ACP_TOOL_CONTENT_META_ITEMS_MAX,
  ACP_TOOL_CONTENT_TOTAL_MAX_CHARS,
  ACP_TOOL_TITLE_MAX_CHARS,
  acpToolInputSummary,
  acpToolPresentationMetaJson,
  acpToolPresentationPreview,
  boundAcpToolPresentationItems,
  boundAcpToolTitle,
} from './tool-presentation.ts'
import type { AcpAgentExtensionV1, AcpToolPresentationContentV1, AcpToolPresentationV1 } from './tool-presentation.ts'
import {
  countLines,
  hash16Of,
  headTailPreview,
  toolContentMetaJson,
} from './tool-content.ts'

// Tool content 的界限常量已移居 ./tool-presentation.ts（落盘 text 块
// 与展示信封共用的单一事实源）；此处 re-export 保持既有引用面（测试/文档）
// 不变。ACP_TOOL_TITLE_MAX_CHARS 只被本文件内部消费，不再 re-export。
export {
  ACP_TOOL_CONTENT_HASH_HEX_CHARS,
  ACP_TOOL_CONTENT_META_ITEMS_MAX,
  ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS,
  ACP_TOOL_CONTENT_TOTAL_MAX_CHARS,
} from './tool-presentation.ts'

/**
 * Value of the `step` field on the FIRST presentation segment a turn
 * allocates. `step` 不再是全 turn 常量：{@link PresentationSegmenter}
 * 按段分配稳定递增的 synthetic presentation step（assistant phase 与 tool
 * phase 各得一个，1 起编号、按到达序递增）。本常量是每 turn 的分配起点
 * （纯文本 turn 的全部事件因此仍是 step 1，与旧版本逐字节一致）。
 * synthetic step 只是 DSH 展示 identity，不携带 ACP step 语义（模块头）。
 */
export const ACP_STEP = 1

/**
 * 说明性 assistant 消息（resume.ts 的 notes 族：恢复/分叉/elicitation/空响应
 * 等说明）的专用 step 泳道。上游 ui-conversation 以 `turn:step` 为
 * assistant 会话节点身份（conversation-nodes/assistant.ts），说明消息若与
 * 内容 segment 共享 step 会折叠进同一节点并顶替其内容；step 0 恒不被
 * {@link PresentationSegmenter} 分配（内容段从 {@link ACP_STEP}=1 起编号），
 * 说明消息因此各自成节点、不动内容段的展示。仅是展示泳道，无协议语义。
 */
export const ACP_NOTE_STEP = 0

/**
 * 诊断保留上限（未支持/异常 update 的诊断必须**有界**——长跑会话里持续
 * 到来的 unknown/unsupported 更新不得让内存随流无限累积）。{@link TurnTranslator.warnings}
 * 只保留前这么多条（时间序证据样本）；全量审计摘要由
 * {@link TurnTranslator.warningCounts}（8 个码位的固定词表计数，本身有界）+
 * {@link TurnTranslator.droppedWarningCount} 承担。
 */
export const TRANSLATOR_WARNINGS_RETAINED_MAX = 64

/**
 * tool result fidelity 的界限常量（preview head/tail、总量上限、hash
 * hex 长度、meta items 上限）已移居 ./tool-presentation.ts 并经上方
 * re-export 保持本模块的既有导出面；落盘 text 块与展示信封
 * （`meta.acpToolPresentation`）共用同一组界限值。
 */
/** 单条 degradation 审计条目的 items 上限（payload 有界；超出部分由 warning 计数承担）。 */
export const ACP_DEGRADATION_ITEMS_MAX = 32

/**
 * 降级原因码（degradation 审计条目的 `code`；与 {@link TranslatorWarningCode}
 * 同名码位——事件源即同名 warning）。类型定义住本模块（生产方；protocol 层不得
 * import domain——架构白名单只许 domainPolicy → protocol，故
 * src/domain/policy/events.ts 以 re-export 暴露本类型，sidecar kind 常量
 * `ACP_DEGRADATION_AUDIT_KIND` 也住在那里）。
 *
 */
export type AcpDegradationCode = 'unsupported-tool-content' | 'unsupported-chunk-content'

/**
 * 单个被降级内容项的事实：只含标量（类型/有界短语原因/原始大小），
 * 不含内容字节——占位/摘要文本在 session log 的 tool/result 块里。
 */
export interface AcpDegradationItem {
  /** 内容类型（ACP wire 类型的有效归类：text/diff/terminal/image/audio/resource/resource_link/blob/unknown 等）。 */
  readonly type: string
  /** 降级原因（有界短语，如「v1 无附件 seam」「超界截断」「未知内容类型」）。 */
  readonly reason: string
  /** 原始大小（字符数或 wire 载荷字节数，按类型而定）；不可计时缺席。 */
  readonly originalSize?: number
}

/**
 * sidecar `degradation` 审计条目的 payload：一次降级事件一条（终端态
 * tool_call_update 的多个降级项合并为一条，不按 item 拆条；非文本消息 chunk
 * 占位落盘同样记一条）。`items` 封顶 {@link ACP_DEGRADATION_ITEMS_MAX}；全部标量/
 * 小数组，JSON 有界、无秘密。
 */
export interface AcpDegradationAuditData {
  readonly code: AcpDegradationCode
  /** 相关 toolCallId（tool result 降级恒在场；chunk 降级无归属 call 时缺席）。 */
  readonly toolCallId?: string
  readonly items: readonly AcpDegradationItem[]
  /** 落盘 text 块保留的内容字符合计（截断标记文本不计）。 */
  readonly keptPreviewChars: number
  /** 是否发生任何截断（单 item head/tail 截断或合计上限截断）。 */
  readonly truncated: boolean
}

/**
 * Agent 明确提供的累计成本事实（ACP `Cost` 收窄副本——`_meta` 不过线，
 * amount/currency 原样透传，adapter 不做汇率换算或跨会话聚合）。
 */
export interface AcpContextUsageCost {
  /** 累计成本金额（agent 提供的原值）。 */
  readonly amount: number
  /** ISO 4217 货币码（agent 提供的原值）。 */
  readonly currency: string
}

/**
 * 最新已知 ACP 上下文占用快照（「独立 ACP context 统计」的真源类型）：
 * `usage_update{used,size,cost?}` 的如实记录——ACP 报告的是上下文占用，
 * 不是 token 计费，因此绝不写 dsh `assistant/message.usage`（那会污染
 * tokenUsage projection 与成本报表）。latest-wins、跨 turn 存活（它是
 * 「最新已知占用」，不是 turn 量）；`cost` 为 null = agent 未提供。
 */
export interface AcpContextUsageSnapshot {
  /** 当前上下文占用（agent 报告的 used 原值）。 */
  readonly used: number
  /** 上下文窗口容量（agent 报告的 size 原值）。 */
  readonly size: number
  /** used/size 百分比（保留一位小数；size 为 0 时记 0——不做除零）。 */
  readonly percent: number
  /** agent 明确提供的累计成本；未提供为 null。 */
  readonly cost: AcpContextUsageCost | null
}

/** `error.name` on a `tool/result` synthesized for an ACP `failed` tool call. */
export const ACP_TOOL_ERROR_NAME = 'AcpToolError'
/** `error.code` on a `tool/result` synthesized for an ACP `failed` tool call. */
export const ACP_TOOL_ERROR_CODE = 'ACP_TOOL_FAILED'

/**
 * agent 未提供 tool name/title 时的回退标签里 callId 的保留上限
 * （用户可见面有界；超长截断加省略号）。
 */
export const ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS = 32

/**
 * agent 未提供 tool name/title 时的用户可见回退标签
 * （`Agent 工具请求 (<callId>)`）——不再让字面量 'unknown-tool' 或空 title
 * 抵达审批 UI / 展示信封。权限审批桥（domain/policy/permissions.ts）与
 * {@link TurnTranslator} 的信封 title 回退共用本函数。 tool/call
 * 落盘的 `name` 恒为稳定名 `ACP_EXTERNAL_TOOL_NAME`（keyed toolview 槽位
 * 分发需要稳定 wire name），本函数不再直接落 name 字段。
 */
export function acpUnknownToolName(callId: string): string {
  const id = callId.length > ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS
    ? `${callId.slice(0, ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS)}…`
    : callId
  return `Agent tool request (${id})`
}

/**
 * tool/call 事件的 ACP 侧摘要 meta（`{ acpToolCall: {...} }`）——`kind`
 * 与 `locations` 是恢复对账工具摘要的对称事实源（domain/session/resume.ts 的
 * expectedVisibleHistory 读回同一形状参与 canonical digest）。DSH
 * `SessionEventMap['tool/call']` 没有 meta 字段，追加侧经
 * {@link AcpToolCallEventData} 结构 widening 落盘：append 运行时只做
 * isJsonValue 校验，存储编码对未识别形状原样保留（chunk-rows 白名单只覆盖
 * assistant/chunk delta），读路径不校验 tool/call 形状
 * （assertMessageEventShape 只覆盖 user/assistant/tool-result 消息事件）——
 * 字段随日志 JSON round-trip 原样存活。仅在 kind/locations/title 至少一项
 * 在场时落（全缺则不带 meta，对账两侧同样归 null/空）。
 *
 * 增补 `title`：name 恒为稳定名后，首帧 wire title（有界，
 * {@link ACP_TOOL_TITLE_MAX_CHARS}）随本键落盘——它是 running 卡片标题与
 * 「pending 永不 settle」场景下 title 的唯一幸存通道（上游
 * RunningToolCall 不携带 meta 到 client，但 resume 的 expectedVisibleHistory
 * 读它做展示标题；信封 title 只随终态 tool/result 落盘）。title 是展示
 * 事实，不进对账 digest（被拒工具回放不对称 纪律不变）。
 */
export type AcpToolCallMeta = {
  acpToolCall: {
    /** 首帧 wire title（有界截断；展示用途，不进对账 digest）。 */
    title?: string
    /** ACP ToolKind（read/edit/execute/…；agent 未提供时缺席）。 */
    kind?: string
    /** tool_call 帧的 locations（path + 可选 line；保持 wire 顺序）。 */
    locations?: { path: string; line?: number }[]
  }
}

/**
 * 非对称工具回放（终态快照对账）：tool/result meta 的 `acpToolCall.terminal` 键。
 * Claude Agent ACP 0.70.0 实证（Claude ACP live evidence）：live 流的
 * tool_call 首帧可以是进行态占位（占位标题、rawInput/locations 缺席或空），终态
 * title/kind/locations/rawInput/content 经后续 tool_call_update 帧才到达；而
 * session/load 回放把终态全量事实合并进单条 tool_call 帧。tool/call 日志事件落盘
 * 即不可变（append-only），终态事实因此随配对 tool/result 的 meta 回写，resume
 * 对账（src/domain/session/resume.ts expectedVisibleHistory）优先读它构造期望
 * 条目，与回放侧的终态合并形态天然对称。
 *
 * 仅当某个 tool_call_update 帧实际携带过 title/kind/locations/rawInput（ACP patch
 * 语义：非 null 即更新）才落盘——首帧即全量的 Devin agent 不产生本键，
 * 日志形状与既有行为逐字节一致，resume 回退读 tool/call 首帧事实。
 *
 * `input` 是 rawInput 的 canonical JSON round-trip 值（未折叠；raw input 原文进
 * session log 与 tool/call `arguments` 同口径，但绝不新增进 sidecar）。有界折叠
 * （{@link ACP_TOOL_INPUT_SUMMARY_MAX_CHARS} 口径）由对账读取侧 resume.ts
 * boundToolInput 统一执行——同一函数服务两侧，digest 对称由构造保证，协议层不
 * 复制第二份折叠实现（架构白名单也不允许 protocol → persistence/domain）。
 */
export type AcpToolCallTerminalMeta = {
  acpToolCall: {
    terminal: {
      /** 终态标题（各帧 latest-wins 的 wire title；展示用途，不进对账 digest）。 */
      title?: string
      /** 终态 ACP ToolKind。 */
      kind?: string
      /** 终态 locations（path + 可选 line；保持 wire 顺序）。 */
      locations?: { path: string; line?: number }[]
      /** 终态 raw input（canonical JSON round-trip 值；有界折叠见类型注释）。 */
      input?: JsonValue
    }
  }
}

/**
 * tool/call 事件数据的落盘形状：核心 schema + 本适配器的 meta 扩展（结构
 * widening——宽类型值仍是 `SessionEventMap['tool/call']` 的合法结构超集，
 * 无需 cast 即可过 `SessionEventSink.append`；运行时校验见
 * {@link AcpToolCallMeta}）。
 */
type AcpToolCallEventData = SessionEventMap['tool/call'] & { readonly meta?: JsonValue }

/**
 * Honest sentinel persisted as `source.model` / `header.config.model` when the
 * ACP side never reported a model （unknown-model fallback）. The session seed validators
 * (`assertCurrentLlmShape` / `assertMessageEventShape` → `hasProviderModel`,
 * core/session) reject an empty provider or model at load time, so a single
 * persisted `model: ''` makes the session unresumable and unforkable forever
 * （恢复矩阵测试覆盖）。The sentinel does not
 * masquerade as a real model id — the UI renders it verbatim — and later
 * events switch to the real model as soon as one is known. Shared by
 * src/domain/session/resume.ts (explanatory notes) and src/domain/session/agent.ts
 * (`request/header`).
 */
export const ACP_UNKNOWN_MODEL = '(unknown)'

/**
 * The append port the translator writes through — a structural narrowing of
 * `Session.append`. Production wiring is {@link sessionEventSink}(session);
 * tests may supply a recording fake that assigns contiguous seqs from 0.
 */
export interface SessionEventSink {
  /**
   * Append one typed event, exactly as `Session.append` does.
   * @param type - the event type (key of `SessionEventMap`).
   * @param data - the event payload; must be JSON-serializable.
   * @param opts - surface intent, present exactly for `SurfaceEventType` types.
   * @returns the logged event with session-assigned `seq`/`time`.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>
}

/**
 * Adapt a dsh `Session` to the translator's append port.
 * @param session - the live session the translated events belong to.
 * @returns a {@link SessionEventSink} forwarding to `session.append`.
 */
export function sessionEventSink(session: Pick<Session, 'append'>): SessionEventSink {
  return {
    append: <T extends SessionEventType>(
      type: T,
      data: SessionEventMap[T],
      ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
    ): SessionEvent<T> => session.append(type, data, ...opts),
  }
}

/** Provider/model identity stamped on `assistant/message` sources and `request/context`. */
export interface TranslatorRoute {
  /** Provider route id, e.g. `acp-devin`. */
  provider: string
  /** ACP-side model id current at production time. */
  model: string
}

/** Anomaly codes recorded in {@link TurnTranslator.warnings}; translation still proceeds. */
export type TranslatorWarningCode =
  /** `feed` called with no active turn; events carry the last (or zero) turn number. */
  | 'update-outside-turn'
  /** `beginTurn` called while a turn was active; the previous turn was flushed implicitly. */
  | 'begin-turn-while-active'
  /** `endTurn` called with no active turn; still flushes any pending aggregation. */
  | 'end-turn-while-inactive'
  /** A second `tool_call` for an id whose first call never reached a terminal update. */
  | 'duplicate-tool-call'
  /** Terminal `tool_call_update` for an unknown id; a continuation call is registered before preserving the result. */
  | 'orphan-tool-result'
  /** A `sessionUpdate` value this build does not know; ignored. */
  | 'unknown-session-update'
 /** A message/thought chunk whose ACP content block is not `text`; the chunk is dropped (降级事实落 sidecar，). */
  | 'unsupported-chunk-content'
  /**
   * A tool result content item that could not be rendered verbatim
 * (diff/terminal/image/resource/unknown/truncated); 不再静默丢弃——
   * 按占位/摘要 text 块落盘，结构化事实进 tool/result `meta`，降级事实落
   * sidecar `degradation` 审计。
   */
  | 'unsupported-tool-content'

/** One non-fatal translation anomaly; translation always continues after recording it. */
export interface TranslatorWarning {
  /** Machine-readable anomaly kind. */
  code: TranslatorWarningCode
  /** Human-readable detail (update kind, tool call id, counts). */
  message: string
}

/** Construction options of {@link TurnTranslator}. */
export interface TurnTranslatorOptions {
  /** Append port the translated events are written through. */
  sink: SessionEventSink
 /** Initial provider route id ('s `acp-<id>`); later overridable via {@link TurnTranslator.setRoute}. */
  provider: string
  /** Initial ACP-side model id; later overridable via {@link TurnTranslator.setRoute}. */
  model: string
  /**
   * Seed for the {@link TurnTranslator.configOptions} slot, typically the
   * `configOptions` from the `session/new`/`session/load` response (those are
   * responses, not `session/update`s, so they never pass through `feed`).
   */
  configOptions?: SessionConfigOption[]
  /** Seed for the {@link TurnTranslator.currentModeId} slot, typically from the session response's `modes`. */
  currentModeId?: string
  /** Seed for the {@link TurnTranslator.availableCommands} slot. */
  availableCommands?: AvailableCommand[]
  /** Optional live terminal snapshot lookup. Missing IDs remain an explicit degradation. */
  terminalSnapshot?: (terminalId: string) => {
    readonly terminalId: string
    readonly command: string
    readonly output: string
    readonly truncated: boolean
    /** ACP's schema makes both exit fields optional on some terminal states. */
    readonly exitStatus: { readonly exitCode?: number | null; readonly signal?: string | null } | null
    readonly released: boolean
  } | undefined
  /**
 * 降级审计回调（同步 fire-and-forget）：每次终端态 tool_call_update 发生
   * 内容降级（非文本项按占位/摘要落盘，或超界截断）回调**一条**
   * `unsupported-tool-content` 条目；非文本消息 chunk 丢弃回调一条
   * `unsupported-chunk-content` 条目。生产接线（src/domain/session/agent.ts）
   * 经 recordAudit seam 落 sidecar `degradation` kind；测试注入记录型假回调。
   * 缺席 = 只留内存 warning，不落审计。
   */
  degradation?: (entry: AcpDegradationAuditData) => void
}

/** The two dsh content block kinds ACP chunks can translate to. */
type BlockKind = 'text' | 'reasoning'

/** One currently open (block-start emitted, block-end pending) chunk block. */
interface OpenBlock {
  /** Block index within the turn's synthesized assistant message. */
  index: number
  /** dsh block kind: `text` for `agent_message_chunk`, `reasoning` for `agent_thought_chunk` and `plan`. */
  kind: BlockKind
  /** ACP `messageId` the block belongs to (`null` when the agent omits it). */
  messageKey: string | null
  /** Text aggregated so far; becomes the block payload at close. */
  text: string
}

/** 终态快照的可变累积态（{@link AcpToolCallTerminalMeta} 的生产侧构件；各帧 latest-wins）。 */
interface TerminalSnapshotState {
  title?: string
  kind?: string
  locations?: { path: string; line?: number }[]
  rawInput?: JsonValue
  agentExtension?: AcpAgentExtensionV1
}

/** A pending (non-terminal) tool call's bookkeeping for its future `tool/result`. */
interface PendingToolCall {
  /** Seq of the emitted `tool/call` event; the result cites it in `sourceEventSeqs`. */
  callSeq: number
 /** 该 call 首次出现分配的 presentation step（终态 result 复用）。 */
  step: number
  /** 该 call 首次出现的 turn；迟到到后续 turn 时会建立新的展示归属。 */
  turn: number
  /**
   * Latest-wins 的 content 映射：初值是 tool_call 首帧的 content 映射，任何
 * tool_call_update 帧携带非 null `content` 即覆盖（非对称工具回放：claude 的
   * 终态 content 经进行中 update 帧到达、终态帧反而不带 content）。终态 update
   * 无 `content` 字段时回退到本字段（`null` 仍是显式空结果，不回退）。
   */
  fallback: ToolContentMapping
  /** 终态快照累积（tool_call 首帧为初值，tool_call_update 覆盖；见 {@link AcpToolCallTerminalMeta}）。 */
  snapshot: TerminalSnapshotState
  /** 是否有任何 update 帧携带过 title/kind/locations/rawInput（终态快照 meta 的落盘闸）。 */
  snapshotUpdated: boolean
}

/** Bounded, read-only identity facts available to permission correlation. */
export interface AcpToolCallPresentationSnapshot {
  readonly toolCallId: string
  readonly title?: string
  readonly kind?: string
  readonly locations?: readonly ToolCallLocation[]
  /** Raw tool arguments stay internal; only a bounded input summary is exposed here. */
  readonly inputSummary?: JsonValue
}

/**
 * tool/result `meta.acpToolContent.items[]` 的单项结构化事实。以 type 别名
 * 而非 interface 声明——赋进 `meta?: JsonValue` 需要隐含 index signature（interface
 * 没有）；构造侧经 {@link toolContentMetaJson} 逐字段落 `Record<string, JsonValue>`，
 * 可选字段缺席而非 undefined。全部标量，天然有界、无秘密（不含 patch/输出全文字节
 * ——那些有界 preview 在 text 块里）。
 */
export type AcpToolContentMetaItem = {
  /** 内容类型的有效归类：text/diff/terminal/image/audio/resource/resource_link/blob/unknown。 */
  type: string
  /** diff 的文件路径。 */
  path?: string
  /** resource / resource_link / image 的 uri。 */
  uri?: string
  /** resource_link 的 name。 */
  name?: string
  /** resource_link 的 title。 */
  title?: string
  mimeType?: string
  /** 字节数（二进制项 = base64 wire 载荷长度；resource_link = 对端报告的 size）。 */
  size?: number
  /** text 项的字符数。 */
  chars?: number
  /** 二进制 wire payload 或 diff 完整 newText 的 sha256 前 {@link ACP_TOOL_CONTENT_HASH_HEX_CHARS} hex（原始字节不落盘）。 */
  hash16?: string
  /** diff 操作类型（按 oldText/newText 可空推断）。 */
  operation?: 'create' | 'modify' | 'delete'
  /** diff 新内容行数（近似，按 `\n` 分段计数）。 */
  linesAdded?: number
  /** diff 原内容行数（新建为 0）。 */
  linesRemoved?: number
  /** 截断前原始长度（字符）。 */
  originalChars?: number
  /** 本项 preview 是否被截断。 */
  truncated?: boolean
  /** 占位/降级原因（有界短语）。 */
  reason?: string
  /** terminal 项的 terminalId。 */
  terminalId?: string
  /** unknown 项的原始 ACP type 字串。 */
  acpType?: string
}

/**
 * tool/result `meta` 的 `acpToolContent` 键形状（同为 type 别名，
 * 见 {@link AcpToolContentMetaItem} 的声明理由）。仅在有非平凡内容（占位/摘要项
 * 或截断）时随事件落盘。meta 可同时携带
 * {@link AcpToolCallTerminalMeta}（`acpToolCall.terminal` 终态快照键）与
 * 展示信封键 `acpToolPresentation`（./tool-presentation.ts），三键不相交。
 */
export type AcpToolResultMeta = {
  acpToolContent: {
    /** 逐项结构化事实（封顶 {@link ACP_TOOL_CONTENT_META_ITEMS_MAX} 条）。 */
    items: AcpToolContentMetaItem[]
    /** 是否发生任何截断（单 item head/tail 或总量上限）。 */
    truncated: boolean
    /** ACP 侧原始内容项总数（items 封顶时的全量计数）。 */
    originalItems: number
  }
}

/** 单个 ACP 内容项的映射产物（{@link mapToolContent} 的内部构件）。 */
interface MappedToolContentItem {
  /** 落盘 text 块的文本（原样文本 / 摘要 / 占位；未过总量上限）。 */
  text: string
  /** 结构化事实（meta items 条目）。 */
  meta: AcpToolContentMetaItem
 /** 展示信封的 content 项（与落盘 text 同源的展示形态；未过信封总量闸）。 */
  presentation: AcpToolPresentationContentV1
  /** 在场 = 本项是降级（占位/摘要/截断），值是 degradation 审计的 items 条目。 */
  degraded?: AcpDegradationItem
}

/**
 * 一次 tool result 内容集合的完整映射结果。`blocks` 已过
 * {@link ACP_TOOL_CONTENT_TOTAL_MAX_CHARS} 总量上限；`meta` 仅在内容非平凡
 * （有降级项）时在场。`presentation` 是 信封 content 的已封顶条目集
 * （空内容集合 → 空数组；双闸归一化见 boundAcpToolPresentationItems）。
 */
interface ToolContentMapping {
  readonly blocks: TextBlock[]
  readonly meta?: JsonValue
  /** 降级项（degradation 审计条目的 items 来源；写入侧按 {@link ACP_DEGRADATION_ITEMS_MAX} 封顶）。 */
  readonly degraded: readonly AcpDegradationItem[]
  /** 落盘 text 块保留的内容字符合计（截断标记文本不计）。 */
  readonly keptChars: number
  /** 是否发生任何截断（单 item head/tail 或总量上限）。 */
  readonly truncated: boolean
 /** 信封 content 项（已过条数 + 文本总量双闸）。 */
  readonly presentation: readonly AcpToolPresentationContentV1[]
}

/** 空内容集合的映射（孤儿终态 update / 无 stash 的兜底）。 */
const EMPTY_TOOL_CONTENT: ToolContentMapping = { blocks: [], degraded: [], keptChars: 0, truncated: false, presentation: [] }

/**
 * v1 无附件 seam：dsh `ImageBlock` 需要 attachment service 的 `ImageAttachmentRef`
 * （插件无此 seam），故 image/audio/blob 只落 mime/size/hash 占位，字节不落盘。
 */
const ACP_NO_ATTACHMENT_SEAM_REASON = 'v1 has no attachment seam; binary bytes are not persisted'
/** terminal 降级原因：协议能力已接线，但当前 DSH UI 没有实时终端渲染 seam。 */
const ACP_TERMINAL_UNAVAILABLE_REASON = 'DSH does not expose a live terminal view; the Agent reads output through ACP terminal/output'

/**
 * 逐 item 映射（设计：任何类型都不静默消失）——
 * text 原样；resource(embedded text) 原样 + 超界 head/tail 截断；resource_link
 * 全量记录引用元数据（本身很小，不算降级）；diff 摘要 + 有界新内容预览；
 * terminal / image / audio / blob 占位（mime/size/hash/原因）；未知类型占位点名。
 *
 * 每项同时产出展示信封的 content 项（`presentation` 字段）——与落盘
 * text 同源的展示形态：text 过无标记的 head/tail 预览；diff 的 patch 是
 * newText 的有界预览（operation/+/− 行数与 acpToolContent meta 同口径）；
 * terminal 是占位事实行；image 只留 ref（uri ?? sha256:hash16）+ 元数据；
 * audio 与未知类型折叠为 text 占位项（信封五变体无 audio/unknown）。
 */
function mapToolContentItem(
  item: ToolCallContent,
  terminalSnapshot?: TurnTranslatorOptions['terminalSnapshot'],
): MappedToolContentItem {
  if (item.type === 'content') {
    const block = item.content
    switch (block.type) {
      case 'text': {
        const preview = acpToolPresentationPreview(block.text)
        return {
          text: block.text,
          meta: { type: 'text', chars: block.text.length },
          presentation: {
            type: 'text',
            text: preview.text,
            ...(preview.truncated ? { originalChars: block.text.length, truncated: true as const } : {}),
          },
        }
      }
      case 'image':
      case 'audio': {
        const reason = ACP_NO_ATTACHMENT_SEAM_REASON
        const hash16 = hash16Of(block.data)
        const label = block.type === 'image' ? 'Image' : 'Audio'
        const placeholder = `[${label} placeholder] ${block.mimeType}, ${String(block.data.length)} wire bytes (base64), sha256:${hash16} — ${reason}`
        return {
          text: placeholder,
          meta: {
            type: block.type,
            mimeType: block.mimeType,
            size: block.data.length,
            hash16,
            ...(block.type === 'image' && block.uri != null ? { uri: block.uri } : {}),
            reason,
          },
          presentation: block.type === 'image'
            // 二进制只留 ref + 元数据（ref = uri ?? sha256:<hash16>），字节不进信封。
            ? {
              type: 'image',
              ref: block.uri ?? `sha256:${hash16}`,
              mimeType: block.mimeType,
              size: block.data.length,
              hash16,
            }
            // 信封五变体无 audio：折叠为 text 占位项（与落盘 text 同一行）。
            : { type: 'text', text: placeholder },
          degraded: { type: block.type, reason, originalSize: block.data.length },
        }
      }
      case 'resource_link': {
        const extras: string[] = []
        if (block.mimeType != null) extras.push(block.mimeType)
        if (block.size != null) extras.push(`${String(block.size)} bytes`)
        return {
          text: `[Resource link] ${block.name}${block.title == null ? '' : ` (${block.title})`} → ${block.uri}${extras.length === 0 ? '' : ` (${extras.join(', ')})`}`,
          meta: {
            type: 'resource_link',
            name: block.name,
            uri: block.uri,
            ...(block.title == null ? {} : { title: block.title }),
            ...(block.mimeType == null ? {} : { mimeType: block.mimeType }),
            ...(block.size == null ? {} : { size: block.size }),
          },
          presentation: {
            type: 'resource',
            uri: block.uri,
            name: block.name,
            ...(block.mimeType == null ? {} : { mimeType: block.mimeType }),
            ...(block.size == null ? {} : { size: block.size }),
            summary: extras.length === 0 ? (block.title ?? '') : extras.join(', '),
          },
        }
      }
      case 'resource': {
        const resource = block.resource
        const mime = resource.mimeType == null ? '' : ` (${resource.mimeType})`
        if ('text' in resource) {
          const preview = headTailPreview(resource.text)
          const presentationPreview = acpToolPresentationPreview(resource.text)
          return {
            text: `[Resource ${resource.uri}${mime}]\n${preview.text}`,
            meta: {
              type: 'resource',
              uri: resource.uri,
              ...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
              originalChars: resource.text.length,
              ...(preview.truncated ? { truncated: true } : {}),
            },
            presentation: {
              type: 'resource',
              uri: resource.uri,
              ...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
              summary: presentationPreview.text,
              ...(presentationPreview.truncated ? { truncated: true as const } : {}),
            },
            ...(preview.truncated
              ? { degraded: { type: 'resource', reason: 'truncated to a bounded head/tail preview', originalSize: resource.text.length } }
              : {}),
          }
        }
        const reason = ACP_NO_ATTACHMENT_SEAM_REASON
        const hash16 = hash16Of(resource.blob)
        const placeholder = `[Binary resource placeholder] ${resource.uri}${mime}, ${String(resource.blob.length)} wire bytes (base64), sha256:${hash16} — ${reason}`
        return {
          text: placeholder,
          meta: {
            type: 'blob',
            uri: resource.uri,
            ...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
            size: resource.blob.length,
            hash16,
            reason,
          },
          presentation: {
            type: 'resource',
            uri: resource.uri,
            ...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
            size: resource.blob.length,
            hash16,
            summary: placeholder,
          },
          degraded: { type: 'blob', reason, originalSize: resource.blob.length },
        }
      }
    }
  }
  if (item.type === 'diff') {
    const oldText = item.oldText ?? null
    const operation = oldText === null ? 'create' : item.newText === '' ? 'delete' : 'modify'
    const linesAdded = countLines(item.newText)
    const linesRemoved = oldText === null ? 0 : countLines(oldText)
    const preview = headTailPreview(item.newText)
    const patchPreview = acpToolPresentationPreview(item.newText)
    return {
      text: `[Diff summary] ${item.path} (${operation}): +${String(linesAdded)}/−${String(linesRemoved)} lines; new-content preview (${String(item.newText.length)} original characters${preview.truncated ? ', truncated' : ''}):\n${preview.text}`,
      meta: {
        type: 'diff',
        path: item.path,
        operation,
        linesAdded,
        linesRemoved,
        originalChars: item.newText.length,
        // 完整 newText 不落盘，但哈希必须保留：resume 对账可安全忽略 Devin
        // session/load 会省略的 rawInput.content，同时仍证明完整输出内容连续。
        hash16: hash16Of(item.newText),
        ...(preview.truncated ? { truncated: true } : {}),
      },
      // patch 是 newText 的有界 head/tail 预览（与落盘摘要同一 preview 纪律，
      // 无内嵌标记——截断事实由 truncated/originalChars 表达）；完整 patch
 // 字节从不落盘，oldText 不进信封（渲染侧以 oldText:null 绘制）。
      presentation: {
        type: 'diff',
        path: item.path,
        operation,
        linesAdded,
        linesRemoved,
        patch: patchPreview.text,
        originalChars: item.newText.length,
        ...(patchPreview.truncated ? { truncated: true as const } : {}),
      },
      degraded: {
        type: 'diff',
        reason: preview.truncated ? 'summary persisted; preview truncated' : 'summary persisted; full patch bytes are not logged',
        originalSize: item.newText.length + (oldText?.length ?? 0),
      },
    }
  }
  if (item.type === 'terminal') {
    const snapshot = terminalSnapshot?.(item.terminalId)
    if (snapshot !== undefined) {
      const output = acpToolPresentationPreview(snapshot.output)
      const status = snapshot.exitStatus === null
        ? 'running'
        : snapshot.exitStatus.exitCode === 0
          ? 'exited 0'
          : `exited ${snapshot.exitStatus.exitCode ?? snapshot.exitStatus.signal ?? 'unknown'}`
      const text = `[Terminal] ${snapshot.command} (${status})${output.text === '' ? '' : `\n${output.text}`}`
      return {
        text,
        meta: {
          type: 'terminal',
          terminalId: item.terminalId,
          chars: snapshot.output.length,
          ...(output.truncated || snapshot.truncated ? { truncated: true } : {}),
        },
        presentation: {
          type: 'terminal',
          terminalId: item.terminalId,
          text,
          ...(output.truncated || snapshot.truncated ? { truncated: true as const } : {}),
        },
        ...(output.truncated || snapshot.truncated
          ? { degraded: { type: 'terminal', reason: 'terminal output shown as a bounded preview', originalSize: snapshot.output.length } }
          : {}),
      }
    }
    const reason = ACP_TERMINAL_UNAVAILABLE_REASON
    const placeholder = `[Terminal placeholder] terminalId=${item.terminalId}: ${reason}`
    return {
      text: placeholder,
      meta: { type: 'terminal', terminalId: item.terminalId, reason },
      presentation: { type: 'terminal', terminalId: item.terminalId, text: placeholder },
      degraded: { type: 'terminal', reason },
    }
  }
  // SDK 升级 / vendor 扩展引入的未知内容类型：绝不静默消失（占位点名类型）
  const acpType = (item as { readonly type: string }).type
  const reason = 'unknown content type recorded as a placeholder'
  const placeholder = `[Unknown content type ${acpType}] ${reason}; original fields are not persisted`
  return {
    text: placeholder,
    meta: { type: 'unknown', acpType, reason },
    presentation: { type: 'text', text: placeholder },
    degraded: { type: acpType, reason },
  }
}

/** meta 落 `Record<string, JsonValue>`（可选字段缺席而非 undefined；`meta?: JsonValue` 的运行时校验是 Session.append 的 isJsonValue）。 */
/**
 * ACP tool-call 内容集合 → dsh 映射（替代旧的「只提取 text、其余计数丢弃」）：
 * 每个 item 经 {@link mapToolContentItem} 映射为可见 text 块 + 结构化 meta 条目，
 * 然后过 {@link ACP_TOOL_CONTENT_TOTAL_MAX_CHARS} 总量上限（超界块就地截断并标记，
 * 预算耗尽的后续项折叠为一条「另有 N 项未显示」占位）。`null`/`undefined`/空集合
 * 映射为空。meta 仅在有降级项时在场（纯文本无截断的结果不带 meta——形状与
 * 之前一致）。：每项同时产出展示信封 content 项，经
 * boundAcpToolPresentationItems 双闸归一化后随 `presentation` 返回（恒在场，
 * 空集合为空数组）。
 */
function mapToolContent(
  content: readonly ToolCallContent[] | null | undefined,
  terminalSnapshot?: TurnTranslatorOptions['terminalSnapshot'],
): ToolContentMapping {
  if (content == null || content.length === 0) return EMPTY_TOOL_CONTENT
  const blocks: TextBlock[] = []
  const metaItems: AcpToolContentMetaItem[] = []
  const degraded: AcpDegradationItem[] = []
  const presentationItems: AcpToolPresentationContentV1[] = []
  let keptChars = 0
  let truncated = false
  let omitted = 0
  for (const item of content) {
    const entry = mapToolContentItem(item, terminalSnapshot)
    if (entry.meta.truncated === true) truncated = true
    if (entry.degraded !== undefined) degraded.push(entry.degraded)
    presentationItems.push(entry.presentation)
    const remaining = ACP_TOOL_CONTENT_TOTAL_MAX_CHARS - keptChars
    if (remaining <= 0) {
      omitted += 1
      continue
    }
    if (entry.text.length <= remaining) {
      blocks.push({ type: 'text', text: entry.text })
      keptChars += entry.text.length
    } else {
      truncated = true
      entry.meta.truncated = true
      degraded.push({ type: entry.meta.type, reason: `truncated at the ${String(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS)}-character aggregate limit`, originalSize: entry.text.length })
      blocks.push({
        type: 'text',
        text: `${entry.text.slice(0, remaining)}\n[…truncated at the ${String(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS)}-character aggregate limit; this item originally had ${String(entry.text.length)} characters…]`,
      })
      keptChars = ACP_TOOL_CONTENT_TOTAL_MAX_CHARS
    }
    metaItems.push(entry.meta)
  }
  if (omitted > 0) {
    truncated = true
    blocks.push({ type: 'text', text: `[…${String(omitted)} additional item(s) hidden by the aggregate limit…]` })
  }
 // 信封 content 独立过条数 + 文本总量双闸（与落盘 text 块同界限值、
  // 各自计数——两条通道的截断互不影响，信封截断由项上 truncated 表达）。
  const presentation = boundAcpToolPresentationItems(presentationItems)
  if (degraded.length === 0) return { blocks, degraded, keptChars, truncated, presentation: presentation.items }
  const meta: AcpToolResultMeta = {
    acpToolContent: {
      items: metaItems.slice(0, ACP_TOOL_CONTENT_META_ITEMS_MAX),
      truncated,
      originalItems: content.length,
    },
  }
  return { blocks, meta: toolContentMetaJson(meta), degraded, keptChars, truncated, presentation: presentation.items }
}

/**
 * +：tool_call 帧的摘要 meta（形状见 {@link AcpToolCallMeta}；
 * 落 `Record<string, JsonValue>`，可选字段缺席而非 undefined）。kind 与
 * locations 与 title 全缺 → `undefined`（不带 meta）。rawInput 不走这里——
 * 它已在 `arguments` JSON 串。title 有界（{@link ACP_TOOL_TITLE_MAX_CHARS}），
 * 空白 title 不落。
 */
function acpToolCallMetaJson(update: ToolCall): JsonValue | undefined {
  const locations = update.locations === undefined || update.locations === null
    ? undefined
    : acpLocationsJson(update.locations)
  const hasLocations = locations !== undefined && locations.length > 0
  const title = boundAcpToolTitle(update.title)
  if (update.kind === undefined && !hasLocations && title === undefined) return undefined
  return {
    acpToolCall: {
      ...(title === undefined ? {} : { title }),
      ...(update.kind === undefined ? {} : { kind: update.kind }),
      ...(locations === undefined ? {} : { locations }),
    },
  }
}

/** locations 的落盘形态（path 原样、line 缺席/ null 则不带该键）。 */
function acpLocationsJson(
  locations: readonly { path: string; line?: number | null }[],
): { path: string; line?: number }[] {
  return locations.map((loc) => ({
    path: loc.path,
    ...(loc.line === undefined || loc.line === null ? {} : { line: loc.line }),
  }))
}

/**
 * raw input 的 canonical JSON round-trip（终态快照 `input` 的落盘前处理）：
 * 消掉 undefined 属性/非 JSON 值，保证 meta 恒为 JsonValue。不可序列化（如
 * BigInt）→ undefined（该字段缺席，快照退化为无 input）。**有界折叠不在本层**——
 * 见 {@link AcpToolCallTerminalMeta} 的纪律说明。
 */
function acpCanonicalJsonRoundTrip(value: unknown): JsonValue | undefined {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return undefined
    return JSON.parse(json) as JsonValue
  } catch {
    return undefined
  }
}

const ACP_AGENT_EXTENSION_STRING_MAX = 256
const ACP_AGENT_EXTENSION_THREAD_MAX = 16

function extensionRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function extensionString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== ''
    ? value.slice(0, ACP_AGENT_EXTENSION_STRING_MAX)
    : undefined
}

/** codex-acp namespaced `_meta` 的白名单投影；未知字段/runtime 不复制。 */
function codexAgentExtension(meta: unknown): AcpAgentExtensionV1 | undefined {
  const codex = extensionRecord(extensionRecord(meta)?.['codex'])
  if (codex === undefined) return undefined
  const collaboration = extensionRecord(codex['collaboration'])
  if (collaboration !== undefined) {
    const tool = extensionString(collaboration['tool'])
    if (tool === undefined) return undefined
    const receiverThreadIds = Array.isArray(collaboration['receiverThreadIds'])
      ? collaboration['receiverThreadIds']
        .flatMap((value) => extensionString(value) ?? [])
        .slice(0, ACP_AGENT_EXTENSION_THREAD_MAX)
      : []
    const senderThreadId = extensionString(collaboration['senderThreadId'])
    return {
      runtime: 'codex',
      type: 'collaboration',
      tool,
      receiverThreadIds,
      ...(senderThreadId === undefined ? {} : { senderThreadId }),
    }
  }
  const subagent = extensionRecord(codex['subagent'])
  if (subagent === undefined) return undefined
  const threadId = extensionString(subagent['threadId'])
  const path = extensionString(subagent['path'])
  const activity = extensionString(subagent['activity'])
  if (threadId === undefined || path === undefined || activity === undefined) return undefined
  return { runtime: 'codex', type: 'subagent-activity', threadId, path, activity }
}

/**
 * 单帧（tool_call 首帧 / 孤儿终态 update）自带的快照事实（ACP patch 语义：
 * null/缺席 = 无事实；空白 title 忽略）。exactOptionalPropertyTypes 纪律：
 * 字段逐条判在场才赋值，绝不写 undefined 值。
 */
function acpTerminalSnapshotFromFrame(frame: {
  readonly title?: string | null
  readonly kind?: string | null
  readonly locations?: readonly { path: string; line?: number | null }[] | null
  readonly rawInput?: unknown
  readonly _meta?: unknown
}): TerminalSnapshotState {
  const snapshot: TerminalSnapshotState = {}
  if (typeof frame.title === 'string' && frame.title !== '') snapshot.title = frame.title
  if (typeof frame.kind === 'string') snapshot.kind = frame.kind
  if (frame.locations !== undefined && frame.locations !== null) {
    snapshot.locations = acpLocationsJson(frame.locations)
  }
  if (frame.rawInput !== undefined && frame.rawInput !== null) {
    const canonical = acpCanonicalJsonRoundTrip(frame.rawInput)
    if (canonical !== undefined) snapshot.rawInput = canonical
  }
  // Extension identity comes from the namespaced wire fact itself. Profile
  // names and built-in templates are user configuration, not protocol facts.
  const extension = codexAgentExtension(frame._meta)
  if (extension !== undefined) snapshot.agentExtension = extension
  return snapshot
}

/**
 * 非对称工具回放：终态快照 meta（形状见 {@link AcpToolCallTerminalMeta}）。仅在
 * 「有 update 帧携带过 title/kind/locations/rawInput」（`updated` 闸）时落盘——
 * 首帧即全量的 agent 不产生本键，日志形状与既有行为一致。`locations`/`input`
 * 等可选字段缺席而非 undefined。
 */
function acpToolCallTerminalMetaJson(snapshot: TerminalSnapshotState, updated: boolean): JsonValue | undefined {
  if (!updated) return undefined
  const terminal: Record<string, JsonValue> = {}
  if (snapshot.title !== undefined && snapshot.title !== '') terminal.title = snapshot.title
  if (snapshot.kind !== undefined) terminal.kind = snapshot.kind
  if (snapshot.locations !== undefined) terminal.locations = snapshot.locations as JsonValue
  if (snapshot.rawInput !== undefined) terminal.input = snapshot.rawInput
  if (Object.keys(terminal).length === 0) return undefined
  return { acpToolCall: { terminal } }
}

/**
 * Render a `plan` update as one reasoning-block text ( 事实驱动：plan 只
 * 折叠为思考块文本——它是 **Agent 侧计划**，绝不触碰 dsh 原生 plan-mode 状态）。
 * Deterministic format: the header line `Agent 计划：` followed by one
 * `- [<status>] <content>` line per entry, in entry order, with the ACP status
 * verbatim (`pending`/`in_progress`/`completed`); entry priority is omitted.
 * @param entries - the plan's complete entry list (each update is a full snapshot).
 * @returns the folded reasoning text.
 */
function renderPlan(entries: readonly PlanEntry[]): string {
  const lines = entries.map(entry => `- [${entry.status}] ${entry.content}`)
  return `Agent plan:\n${lines.join('\n')}`
}

/**
 * PresentationSegmenter：每 turn 的展示分段状态机（消息展示顺序；纯决策状态，
 * 无 I/O——事件生产仍在 {@link TurnTranslator}）。状态机：
 * `none → assistant segment → tool segment(s) → assistant segment → … → end`。
 *
 * 展示顺序约束：
 * - 第一个 tool 到来前，调用方先 flush 已积累的 assistant segment
 *   （{@link PresentationSegmenter.closeAssistantSegment}）；
 * - 每个 assistant phase 经 {@link PresentationSegmenter.openAssistantSegment}
 *   分配稳定递增的 presentation step（{@link ACP_STEP}=1 起，按到达序）；
 * - 同一批并行 tool calls 经
 *   {@link PresentationSegmenter.openToolSegment} 共享一个稳定 step；配对
 *   update/result 从 pendingCalls 复用该 step；
 * - tool 之后的新文本必须开新 segment（close 后再 open 即得新 step），绝不
 *   回写旧/已提交消息；
 * - endTurn flush 当前开放 segment 并关闭 synthetic step（调用方
 *   {@link TurnTranslator.endTurn}），不移动已提交消息；
 * - synthetic step 只是 DSH 展示 identity（上游 ui-conversation 的
 *   `turn:step` 节点键与 anchorSeq 排序的输入），**不宣称 ACP 有 step 语义**，
 *   也不进任何对账 digest（resume.ts 的 digest 输入只含语义事实）。
 */
export class PresentationSegmenter {
  /** 当前 turn 下一个待分配的 presentation step（每 turn 从 {@link ACP_STEP} 重起）。 */
  private nextStep = ACP_STEP
  /** 当前开放 assistant segment 的 step（无开放 segment 时 undefined）。 */
  private assistantStep: number | undefined
  /** 当前 turn 开放的 tool phase step；并行调用共享，turn 边界复位。 */
  private toolStep: number | undefined
  /** 当前 turn 是否已产出可见输出（已提交的 assistant segment / tool call / tool result）。 */
  private producedOutput = false

  /** turn 边界：重置每 turn 的分配计数与开放 segment（上一 turn 的遗留内容应由调用方先 flush）。 */
  beginTurn(): void {
    this.nextStep = ACP_STEP
    this.assistantStep = undefined
    this.toolStep = undefined
    this.producedOutput = false
  }

  /** 当前开放 assistant segment 的 step；无开放 segment 时 undefined。 */
  get assistantSegmentStep(): number | undefined {
    return this.assistantStep
  }

  /** 当前 turn 最近分配的展示 step；尚未分配时回退起始 step。 */
  get lastAllocatedStep(): number {
    return this.nextStep === ACP_STEP ? ACP_STEP : this.nextStep - 1
  }

  /**
   * 打开（或返回）当前 assistant segment。tool phase 尚未结束时复用其
   * step；否则分配下一展示 step。
   */
  openAssistantSegment(existingStep?: number): number {
    this.assistantStep ??= existingStep ?? this.nextStep++
    return this.assistantStep
  }

  /** 关闭当前开放的 assistant segment（tool 到达前 / endTurn flush）；返回其 step，无开放 segment 时 undefined。 */
  closeAssistantSegment(): number | undefined {
    const step = this.assistantStep
    this.assistantStep = undefined
    return step
  }

  /** 打开（或返回）当前并行 tool phase 的 step。 */
  openToolSegment(existingStep?: number): number {
    this.toolStep ??= existingStep ?? this.nextStep++
    return this.toolStep
  }

  /** 当前 tool phase 已无 pending call 后关闭。 */
  closeToolSegment(): number | undefined {
    const step = this.toolStep
    this.toolStep = undefined
    return step
  }

  /** 记录本 turn 产出了可见输出（assistant segment 提交 / tool 事件落盘）。 */
  noteVisibleOutput(): void {
    this.producedOutput = true
  }

  /** 当前 turn 是否已产出任何可见输出（ACP_EMPTY_RESPONSE 空响应信号的输入；beginTurn 复位）。 */
  get turnProducedOutput(): boolean {
    return this.producedOutput
  }
}

/**
 * Stateful ACP → dsh turn translator; one instance per dsh session (ACP
 * session). NOT thread-safe by design — the driver feeds notifications in
 * wire order. See the module doc for the turn mapping and out-of-turn rules.
 *
 * Append discipline (mirrors agent-loop; ; 分段化):
 * - every `assistant/chunk` seq of the current assistant segment is collected
 *   into `chunkSeqs`;
 * - each segment's `assistant/message`（tool/call 到达前的 flush 或 endTurn
 *   的收口）is appended with `{ surfaceOp: 'append', sourceEventSeqs: chunkSeqs }`
 *   — 只引用本 segment 的 chunk；
 * - every `tool/result` is appended with
 *   `{ surfaceOp: 'append', sourceEventSeqs: [callSeq] }`, citing its
 *   `tool/call`; the orphan case omits `sourceEventSeqs` (a present-but-empty
 *   array is reserved for known-empty streams and is never used here);
 * - `assistant/chunk`, `tool/call`, `request/context` are log-only and carry
 *   no surface metadata.
 */
export class TurnTranslator {
  private readonly sink: SessionEventSink
  private readonly degradation: ((entry: AcpDegradationAuditData) => void) | undefined
  private readonly terminalSnapshot: TurnTranslatorOptions['terminalSnapshot']
  private currentRoute: TranslatorRoute
  /**
   * Latch of the last non-empty model seen (constructor or {@link TurnTranslator.setRoute}).
   * `currentRoute.model` may be `''` (agent advertises no model option and no
   * fallback selection was configured); the latch backs the persist-time
   * fallback so an empty model never reaches the log (see {@link ACP_UNKNOWN_MODEL}).
   */
  private lastKnownModel = ''

  /** Current turn number; `0` before the first `beginTurn`. */
  private turnNumber = 0
  /** Whether a `beginTurn`/`endTurn` bracket is currently open. */
  private inTurnNow = false

 /** 展示分段状态机（presentation step 分配与 turn 产出跟踪的唯一真源）。 */
  private readonly segmenter = new PresentationSegmenter()
  /** 当前已落 `step/start`、尚未落 `step/end` 的 DSH 展示 step。 */
  private openPresentationStep: number | undefined
  /** Completed blocks of the current assistant segment, in block-index order. */
  private blocks: ContentBlock[] = []
  /** The open chunk block, if any. */
  private openBlock: OpenBlock | undefined
  /** Seqs of every `assistant/chunk` appended in the current segment, in append order. */
  private chunkSeqs: number[] = []
  /** Next block index within the current segment（每 segment 从 0 重起——上游按 `turn:step` 节点各自聚合块索引）。 */
  private nextBlockIndex = 0
 /** 最新已知上下文占用（latest-wins、跨 turn 存活——非 turn 量，beginTurn 不清）。 */
  private lastContextUsage: AcpContextUsageSnapshot | undefined

  /** Open tool calls by ACP `toolCallId`, kept across turn boundaries until a terminal update resolves them. */
  private readonly pendingCalls = new Map<string, PendingToolCall>()
  /** Last emitted `request/context` payload; re-emission happens only on change. */
  private lastContext: { provider: string; model: string; contextWindow: number } | undefined

  private configOptionsState: SessionConfigOption[] | undefined
  private currentModeIdState: string | undefined
  private availableCommandsState: AvailableCommand[] | undefined
  /** 保留段（最多 {@link TRANSLATOR_WARNINGS_RETAINED_MAX} 条；超出见 droppedWarningCount）。 */
  private readonly warningsList: TranslatorWarning[] = []
  /** 全量计数（审计摘要；码表固定 8 项，自身有界）。 */
  private readonly warningCountByCode = new Map<TranslatorWarningCode, number>()
  private droppedWarningCountValue = 0

  constructor(options: TurnTranslatorOptions) {
    this.sink = options.sink
    this.degradation = options.degradation
    this.terminalSnapshot = options.terminalSnapshot
    this.currentRoute = { provider: options.provider, model: options.model }
    if (options.model !== '') this.lastKnownModel = options.model
    if (options.configOptions !== undefined) this.configOptionsState = options.configOptions
    if (options.currentModeId !== undefined) this.currentModeIdState = options.currentModeId
    if (options.availableCommands !== undefined) this.availableCommandsState = options.availableCommands
  }

  /** The turn number events are currently attributed to; `0` before the first `beginTurn`. */
  get turn(): number {
    return this.turnNumber
  }

  /** Whether a `beginTurn`/`endTurn` bracket is currently open. */
  get inTurn(): boolean {
    return this.inTurnNow
  }

  /** agent/error 运行时坐标使用的最近 synthetic presentation step。 */
  get presentationStep(): number {
    return this.openPresentationStep ?? this.segmenter.lastAllocatedStep
  }

  /**
   * 当前 turn 是否已产出任何可见输出（已提交的 assistant segment / tool/call /
 * tool/result； ACP_EMPTY_RESPONSE 空响应信号的输入——AcpAgent 在
   * `prompt` 完成且本信号为 false 时落说明消息）。`beginTurn` 复位。
   */
  get turnProducedOutput(): boolean {
    return this.segmenter.turnProducedOutput
  }

  /** The provider/model identity currently stamped on new events. */
  get route(): TranslatorRoute {
    return { ...this.currentRoute }
  }

  /** Lookup bounded presentation identity; raw input/output stay internal, while a bounded input summary crosses this seam. */
  getToolCallPresentationSnapshot(toolCallId: string): AcpToolCallPresentationSnapshot | undefined {
    const pending = this.pendingCalls.get(toolCallId)
    if (pending === undefined) return undefined
    const snapshot = pending.snapshot
    return {
      toolCallId,
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      ...(snapshot.kind === undefined ? {} : { kind: snapshot.kind }),
      ...(snapshot.locations === undefined ? {} : { locations: [...snapshot.locations] }),
      ...(snapshot.rawInput === undefined ? {} : { inputSummary: acpToolInputSummary(snapshot.rawInput) }),
    }
  }

  /**
 * Latest config-option snapshot (slot for the option endpoints and
   * selectors); `undefined` until seeded or a `config_option_update` arrives.
   * Treat the returned array as read-only.
   */
  get configOptions(): readonly SessionConfigOption[] | undefined {
    return this.configOptionsState
  }

  /** Latest mode id pushed by `current_mode_update` (or seeded); `undefined` until known. */
  get currentModeId(): string | undefined {
    return this.currentModeIdState
  }

  /**
   * Latest available-command list pushed by `available_commands_update` (or
   * seeded); `undefined` until the agent reports one. Consumed by the
   * slash command bridge. Treat the returned array as read-only.
   */
  get availableCommands(): readonly AvailableCommand[] | undefined {
    return this.availableCommandsState
  }

  /**
 * 最新已知上下文占用（`usage_update` 的如实快照，latest-wins、跨
   * turn 存活——非 turn 量）。未收到过任何 `usage_update` 时为 `undefined`
   * （诚实空缺，不虚构零值）。只读；消费方是 AcpAgent 的 live state 通道
   * （dshAcp Remote options 快照的 `contextUsage` 字段）。
   */
  get contextUsage(): AcpContextUsageSnapshot | undefined {
    return this.lastContextUsage
  }

  /** Every anomaly recorded so far, in recording order; translation continued past each. */
  get warnings(): readonly TranslatorWarning[] {
    return this.warningsList
  }

  /**
   * 全量审计摘要：每个 warning 码的出现次数（含被丢弃未保留的）。码表词表固定，
   * 本计数自身有界；与 {@link TurnTranslator.warnings}（保留段）+
   * {@link TurnTranslator.droppedWarningCount} 一起构成完整诊断。
   */
  get warningCounts(): Readonly<Partial<Record<TranslatorWarningCode, number>>> {
    return Object.fromEntries(this.warningCountByCode)
  }

  /** 超出保留上限后被丢弃（只计数未留样）的 warning 条数。 */
  get droppedWarningCount(): number {
    return this.droppedWarningCountValue
  }

  /**
   * Update the route stamped on subsequently synthesized `assistant/message`
   * sources and `request/context` events (model hot-switch, ).
   * Emits nothing by itself; a route change surfaces as `request/context` on
 * the next `usage_update` and as `request/header` via 's own logic.
   * A non-empty `route.model` also refreshes the last-known-model latch (see
   * {@link ACP_UNKNOWN_MODEL}); an empty one leaves the latch untouched.
   * @param route - the new provider/model identity.
   */
  setRoute(route: TranslatorRoute): void {
    this.currentRoute = { ...route }
    if (route.model !== '') this.lastKnownModel = route.model
  }

  /**
   * Open translation turn `turn`. The caller numbers turns from 1,
   * sequentially. Emits nothing for the boundary itself (`turn/start` is
   * AcpAgent's). If the previous bracket was never closed — or out-of-turn
   * feeds left aggregated content behind — that content is first flushed
   * under the PREVIOUS turn number (plus a `'begin-turn-while-active'`
   * warning when a turn was open), so no translated content is lost.
   * @param turn - the 1-based turn number.
   * @returns the events appended by the implicit flush, usually none.
   */
  beginTurn(turn: number): SessionEvent[] {
    const events: SessionEvent[] = []
    if (this.inTurnNow) {
      this.warn('begin-turn-while-active', `beginTurn(${turn}) while turn ${this.turnNumber} is still active; flushing it implicitly`)
      events.push(...this.flushSegment())
      events.push(...this.closeOpenPresentationStep())
    } else if (this.hasPendingContent()) {
      events.push(...this.flushSegment())
      events.push(...this.closeOpenPresentationStep())
    }
    this.blocks = []
    this.openBlock = undefined
    this.chunkSeqs = []
    this.nextBlockIndex = 0
    this.openPresentationStep = undefined
    this.segmenter.beginTurn()
    this.turnNumber = turn
    this.inTurnNow = true
    return events
  }

  /**
   * Translate one ACP `session/update` notification. Per-branch contract
   * ( table; `notification.sessionId`/`_meta` are the router's
   * concern and are not inspected):
   *
   * - `agent_message_chunk` → `assistant/chunk` events forming dsh stream
   *   structure: the first chunk of a message emits
   *   `{type:'block-start', index, blockType:'text'}`, each chunk emits
   *   `{type:'text-delta', index, text}`, and when the `(kind, messageId)` run
   *   ends (different messageId/kind arrives, a `plan` is folded, or the turn
   *   is flushed) `{type:'block-end', index, block:{type:'text', text}}`
   *   closes it with the aggregated text. One ACP chunk produces 1–3
   *   `assistant/chunk` events. Block indexes start at 0 per assistant segment
 * （上游按 `turn:step` 节点各自聚合块索引）and
   *   increment per opened block. Revisiting an earlier messageId after a
   *   switch opens a NEW block (single-open-block policy). A chunk whose ACP
 * content is not `text` is NOT dropped: 此后按 同一映射纪律
   *   （{@link mapToolContent}）生成有界可见占位（mime/type 身份、有界 size
   *   事实、截断标记，原始字节不落盘），先关闭当前开放块，再以独立完整块
   *   （block-start/delta/block-end 三连，占位文本进 turn 聚合的 blocks）
   *   落盘——一个非文本 chunk 产生 3–4 个 `assistant/chunk` 事件，并记一条
   *   `'unsupported-chunk-content'` warning + 一条 degradation 审计。
   *   An omitted `messageId` counts as one anonymous run per kind.
   * - `agent_thought_chunk` → identical, with `blockType:'reasoning'`,
   *   `reasoning-delta`, and `{type:'reasoning', text}` blocks.
   * - `user_message_chunk` → no events. User prompts enter the log as
   *   `user/message` at turn start (AcpAgent's job); replay-time user chunks
   *   are aggregated into synthetic `user/message` events by
   *   {@link ReplayTranslator} before reaching this translator.
 * - `tool_call` → 先 flush 当前开放 assistant segment（钉死「正文在
   *   tool 卡片上方」，见 {@link PresentationSegmenter}），再发一个仅含
   *   tool-call block 的标准 `assistant/message`（其人类可读 name 取 ACP title，
   *   供 DSH 轨迹归属和标题展示）以及 one `tool/call`
   *   with `{callId: CallId(toolCallId),
   *   name: ACP_EXTERNAL_TOOL_NAME, arguments: JSON.stringify(rawInput ?? {})}` ( * the unstable ACP `name` field is NOT consulted；：`name` 恒为稳定名
   *   {@link ACP_EXTERNAL_TOOL_NAME}——宿主 keyed `tool.call.toolview` 槽位
   *   按 wire tool name 分发，动态 title 无法稳定命中；首帧 wire title 有界
   *   落入 meta.acpToolCall.title，展示信封的终态 title 随配对 tool/result
   *   落盘)； `kind`/
   *   `locations` 的摘要随事件 `meta.acpToolCall` 落盘（恢复对账的对称事实源，
   *   见 {@link AcpToolCallMeta}）。The frame's own
   *   `content` is mapped ({@link mapToolContent}) and stashed as fallback for
   *   the terminal update. A second `tool_call` for a still-open id emits its
   *   event anyway and supersedes the stash with a `'duplicate-tool-call'`
   *   warning.
   * - `tool_call_update` → nothing while `status` is absent/`pending`/
   *   `in_progress`（但帧携带的 title/kind/locations/rawInput/content 先并入
 * pending 簿记的终态快照累积——非对称工具回放，claude 的终态事实经进行中
   *   update 帧到达；ACP patch 语义：null/缺席 = 不变）. On a terminal status (`completed`/`failed`) it appends
   *   one `tool/result{surfaceOp:'append', sourceEventSeqs:[callSeq]}` whose
   *   message is `createToolResultMessage({callId, content, isError})`:
 * `content` is the update's mapped blocks —：每个 ACP 内容项都映射为
   *   可见 text 块（text 原样；resource text 原样；diff 摘要+有界预览；
   *   terminal/image/audio/blob 占位；resource_link 全量引用记录；未知类型
   *   占位点名），任何类型都不静默消失。有降级项时记
   *   `'unsupported-tool-content'` warning、回调一条 degradation 审计（经
   *   {@link TurnTranslatorOptions.degradation}），并把逐项结构化事实摘要写进
   *   事件的 `meta.acpToolContent`（不含 patch/输出全文字节）。终态 update 无
   *   `content` 字段时回退到最新累积的 content 映射（tool_call 首帧 stash 经
   *   各 update 帧 latest-wins 覆盖；`null` 是显式空结果）。
 * 非对称工具回放：任何 update 帧携带过 title/kind/locations/rawInput 时，
   *   终态快照（各帧 latest-wins 累积）以 `meta.acpToolCall.terminal` 落盘
   *   （形状见 {@link AcpToolCallTerminalMeta}）——恢复对账的对称事实源
   *   （resume.ts expectedVisibleHistory 优先读它）；首帧即全量的 agent 不
 * 产生本键，日志形状与既有行为一致。：展示信封恒以
   *   `meta.acpToolPresentation` 落盘（版本化有界形状见
   *   ./tool-presentation.ts 的 AcpToolPresentationV1；title/kind/locations/
   *   inputSummary 取终态快照，content 是 mapToolContent 的逐项展示形态）——
   *   展示通道，不进对账 digest。`failed` sets `isError` and
   *   `error:{name: ACP_TOOL_ERROR_NAME, code: ACP_TOOL_ERROR_CODE}`.
   *   `rawOutput` is not translated. A terminal update for an unknown id
   *   still appends the result — without `sourceEventSeqs` and with an
 * `'orphan-tool-result'` warning；：orphan 终态也先 flush 当前开放
   *   文本段再分配独立 presentation step，已提交文本不与之交错。
   * - `plan` → folded into a reasoning block: closes any open chunk block,
   *   then emits the `assistant/chunk` triple `block-start(reasoning)` /
   *   `reasoning-delta` / `block-end` with {@link renderPlan}'s deterministic
   *   text. An empty `entries` list emits nothing.
   * - `plan_update` / `plan_removed` (unstable ACP extensions) → no events.
   * - `usage_update` → 不落任何 usage：ACP 报告的是上下文占用而非 token
 * 计费。旧的伪 `{inputTokens: used, outputTokens: 0}` 已删除——占用
   *   事实改记入 {@link TurnTranslator.contextUsage} 快照（latest-wins、
   *   跨 turn 存活；`cost` 收窄为 amount/currency 原样透传，未提供归
   *   null），经 AcpAgent live state 通道供 UI 展示。本分支仍 append
   *   `request/context{provider, model, contextWindow: size}`——仅当该
   *   三元组与上一次所发不同（route 或容量变化），重复不发。
   * - `session_info_update` → no events, no state (展示边界: dsh's title
   *   fallback owns naming).
   * - `config_option_update` → no events; replaces the
   *   {@link TurnTranslator.configOptions} slot.
   * - `current_mode_update` → no events; replaces the
   *   {@link TurnTranslator.currentModeId} slot.
   * - `available_commands_update` → no events; replaces the
 * {@link TurnTranslator.availableCommands} slot for the bridge.
   * - any `sessionUpdate` value unknown to this build → no events, flagged
   *   `'unknown-session-update'`.
   *
   * @param notification - one ACP `session/update` notification, in wire order.
   * @returns the events appended while translating it (empty for state-only
   *   or ignored updates).
   */
  feed(notification: SessionNotification): SessionEvent[] {
    const update = notification.update
    if (!this.inTurnNow) {
      this.warn('update-outside-turn', `session/update "${update.sessionUpdate}" received with no active turn; translated under turn ${this.turnNumber}`)
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.feedContentChunk('text', update)
      case 'agent_thought_chunk':
        return this.feedContentChunk('reasoning', update)
      case 'user_message_chunk':
        return []
      case 'tool_call':
        return this.feedToolCall(update)
      case 'tool_call_update':
        return this.feedToolCallUpdate(update)
      case 'plan':
        return this.feedPlan(update)
      case 'plan_update':
      case 'plan_removed':
        return []
      case 'usage_update':
        return this.feedUsageUpdate(update)
      case 'session_info_update':
        return []
      case 'config_option_update':
        this.configOptionsState = update.configOptions
        return []
      case 'current_mode_update':
        this.currentModeIdState = update.currentModeId
        return []
      case 'available_commands_update':
        this.availableCommandsState = update.availableCommands
        return []
      default: {
        // Compile-time exhaustiveness: an SDK upgrade adding a SessionUpdate
        // variant fails here until this switch decides its translation.
        const exhaustive: never = update
        this.warn('unknown-session-update', `ignored unknown sessionUpdate: ${JSON.stringify(exhaustive)}`)
        return []
      }
    }
  }

  /**
   * Close the translation turn: flushes the current open assistant segment
 * （一个 turn 可能已因 tool/call 到达而提交过若干 segment 的
   *   `assistant/message`；endTurn 只收口当前开放 segment，不移动已提交消息）—
   * content blocks in block order, `source` from the current
 * {@link TranslatorRoute}; 不再携带 `usage`（上下文占用走
   * {@link TurnTranslator.contextUsage} 的 live state 通道，不进日志）。
   * A segment with no content appends no message — a turn that received only a
   * `usage_update` flushes to nothing. Call it on every turn exit path —
   * including cancel and agent crash — so partial output is preserved; v1
   * flushes identically for every stop reason, so the ACP `stopReason` is not
   * an input here (the `turn/end` reason mapping is AcpAgent's job). Open
   * tool calls are left pending: the ACP agent owns their lifecycle, and a
   * late terminal update still resolves them in a later turn.
 * @returns the appended events: at most one `assistant/chunk` (block-end),
 *   one `assistant/message`, and the matching `step/end`.
   */
  endTurn(): SessionEvent[] {
    if (!this.inTurnNow) {
      this.warn('end-turn-while-inactive', 'endTurn with no active turn; flushing any pending aggregation')
    }
    const events = this.flushSegment()
    events.push(...this.closeOpenPresentationStep())
    this.inTurnNow = false
    return events
  }

  /** Whether unflushed translated content exists. */
  private hasPendingContent(): boolean {
    return this.openBlock !== undefined || this.blocks.length > 0
  }

  /** Record an anomaly and continue translating (bounded: see {@link TRANSLATOR_WARNINGS_RETAINED_MAX}). */
  private warn(code: TranslatorWarningCode, message: string): void {
    this.warningCountByCode.set(code, (this.warningCountByCode.get(code) ?? 0) + 1)
    if (this.warningsList.length < TRANSLATOR_WARNINGS_RETAINED_MAX) {
      this.warningsList.push({ code, message })
    } else {
      this.droppedWarningCountValue += 1
    }
  }

 /** 降级事实回调（同步 fire-and-forget；回调缺席 = 只留内存 warning，不落 sidecar 审计）。 */
  private noteDegradation(entry: AcpDegradationAuditData): void {
    this.degradation?.(entry)
  }

  /** Append one `assistant/chunk` (log-only; no surface metadata) and collect its seq. */
  private emitChunk(chunk: StreamChunk): SessionEvent<'assistant/chunk'> {
    const step = this.segmenter.assistantSegmentStep
    if (step === undefined) {
      // 内部不变量：chunk 只可能存在于开放的 assistant segment 内（feedContentChunk/
      // feedPlan 先经 ensureAssistantSegment 开段）。走到这里即翻译器内部状态破损。
      throw new Error('dsh-acp translate: emitChunk without an open presentation segment (internal invariant violated)')
    }
    const event = this.sink.append('assistant/chunk', { turn: this.turnNumber, step, chunk })
    this.chunkSeqs.push(event.seq)
    return event
  }

  /**
 * 确保当前有开放的 assistant segment（文本/plan/占位内容落盘前调用）；
   * 新开的 segment 块索引从 0 重起（上游按 `turn:step` 节点各自聚合块索引）。
   */
  private ensureAssistantSegment(): SessionEvent[] {
    if (this.segmenter.assistantSegmentStep === undefined) {
      const step = this.segmenter.openAssistantSegment(this.openPresentationStep)
      this.nextBlockIndex = 0
      return this.openPresentationStepIfNeeded(step)
    }
    return []
  }

  /** Open one synthetic DSH presentation step before its first scoped event. */
  private openPresentationStepIfNeeded(step: number): SessionEvent[] {
    if (this.openPresentationStep === step) return []
    if (this.openPresentationStep !== undefined) {
      throw new Error(`dsh-acp translate: cannot open presentation step ${step} while step ${this.openPresentationStep} is active`)
    }
    this.openPresentationStep = step
    return [this.sink.append('step/start', { turn: this.turnNumber, step })]
  }

  /** Close the current synthetic DSH presentation step, if any. */
  private closeOpenPresentationStep(): SessionEvent[] {
    const step = this.openPresentationStep
    if (step === undefined) return []
    this.openPresentationStep = undefined
    this.segmenter.closeToolSegment()
    return [this.sink.append('step/end', { turn: this.turnNumber, step })]
  }

  /** Whether the current open step still owns an unfinished tool call. */
  private openStepHasPendingTool(): boolean {
    const step = this.openPresentationStep
    return step !== undefined && [...this.pendingCalls.values()]
      .some(call => call.turn === this.turnNumber && call.step === step)
  }

  /** Close the open chunk block: emit its `block-end` and move the aggregated block to the turn's block list. */
  private closeBlock(): SessionEvent<'assistant/chunk'> {
    const open = this.openBlock
    if (open === undefined) throw new Error('dsh-acp translate: closeBlock without an open block')
    const block: ContentBlock = open.kind === 'text'
      ? { type: 'text', text: open.text }
      : { type: 'reasoning', text: open.text }
    this.openBlock = undefined
    this.blocks.push(block)
    return this.emitChunk({ type: 'block-end', index: open.index, block })
  }

  /**
   * `agent_message_chunk`/`agent_thought_chunk` branch. Contract documented at
   * {@link TurnTranslator.feed}: one open block per `(kind, messageId)` run;
   * a run switch closes the previous block first.
   */
  private feedContentChunk(kind: BlockKind, update: ContentChunk): SessionEvent[] {
    const content = update.content
    if (content.type !== 'text') {
 // 非文本 chunk 不静默丢弃——复用 同一映射纪律（mime/type
      // 身份、有界 size/hash 事实、超界 head/tail 截断标记，原始字节不落盘）
      // 生成有界可见占位；占位作为独立完整块落盘（关闭当前开放块后
      // block-start/delta/block-end 三连，不进开放块聚合），降级事实仍落审计。
      const mapped = mapToolContent([{ type: 'content', content }], this.terminalSnapshot)
      const text = mapped.blocks[0]?.text ?? ''
      const chunkName = kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk'
      this.warn('unsupported-chunk-content', `${chunkName} non-text block "${content.type}" cannot be rendered verbatim; a bounded placeholder was persisted (see sidecar degradation audit)`)
      this.noteDegradation({
        code: 'unsupported-chunk-content',
        items: mapped.degraded.length > 0
          ? [...mapped.degraded]
          : [{ type: content.type, reason: 'non-text message chunk persisted as a bounded placeholder' }],
        keptPreviewChars: mapped.keptChars,
        truncated: mapped.truncated,
      })
      const events: SessionEvent[] = []
      events.push(...this.ensureAssistantSegment())
      if (this.openBlock !== undefined) events.push(this.closeBlock())
      const index = this.nextBlockIndex++
      events.push(this.emitChunk({ type: 'block-start', index, blockType: kind }))
      const block: ContentBlock = kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text }
      events.push(this.emitChunk(kind === 'text'
        ? { type: 'text-delta', index, text }
        : { type: 'reasoning-delta', index, text }))
      this.blocks.push(block)
      events.push(this.emitChunk({ type: 'block-end', index, block }))
      return events
    }
    const events: SessionEvent[] = []
    const messageKey = update.messageId ?? null
    events.push(...this.ensureAssistantSegment())
    const open = this.openBlock
    if (open !== undefined && (open.kind !== kind || open.messageKey !== messageKey)) {
      events.push(this.closeBlock())
    }
    if (this.openBlock === undefined) {
      const index = this.nextBlockIndex++
      events.push(this.emitChunk({ type: 'block-start', index, blockType: kind }))
      this.openBlock = { index, kind, messageKey, text: '' }
    }
    const block = this.openBlock
    const delta: StreamChunk = kind === 'text'
      ? { type: 'text-delta', index: block.index, text: content.text }
      : { type: 'reasoning-delta', index: block.index, text: content.text }
    events.push(this.emitChunk(delta))
    block.text += content.text
    return events
  }

  /** `tool_call` branch; contract documented at {@link TurnTranslator.feed}. */
  private feedToolCall(update: ToolCall): SessionEvent[] {
 // （消息展示顺序）：先把积累的 assistant segment flush 成 assistant/message——
    // 其落盘 seq 先于本 tool/call，上游 settled 锚点因此恒在 tool 卡片之上，
    // 不再出现「流式期在上方、endTurn 后跳到下方」的跳变。
    const events = this.flushSegment()
    const step = this.segmenter.openToolSegment(this.openPresentationStep)
    events.push(...this.openPresentationStepIfNeeded(step))
    const callTitle = boundAcpToolTitle(update.title) ?? acpUnknownToolName(update.toolCallId)
    const assistantCall: ContentBlock = {
      type: 'tool-call',
      id: CallId(update.toolCallId),
      // 轨迹使用 assistant block 的 name 展示；这里保留 ACP 的人类可读标题。
      // 独立 tool/call 仍使用稳定 wire name，以命中插件的 keyed toolview。
      name: callTitle,
      arguments: JSON.stringify(update.rawInput ?? {}),
    }
    const callChunk = this.sink.append('assistant/chunk', {
      turn: this.turnNumber,
      step,
      chunk: { type: 'block-end', index: 0, block: assistantCall },
    })
    events.push(callChunk)
    events.push(this.sink.append('assistant/message', {
      turn: this.turnNumber,
      step,
      message: createAssistantMessage({
        content: [assistantCall],
        source: { provider: this.currentRoute.provider, model: this.effectiveModel() },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callChunk.seq] }))
    const meta = acpToolCallMetaJson(update)
    const data: AcpToolCallEventData = {
      turn: this.turnNumber,
      step,
      callId: CallId(update.toolCallId),
 // name 恒为稳定名——宿主 keyed `tool.call.toolview` 槽位按 wire
      // tool name 分发（ui-tool ToolCallTree 的 entryKey），动态 title 会让
      // 渲染器永远无法稳定命中。首帧 wire title 随 meta.acpToolCall.title
      // 落盘（有界；的 blank-title 防线由 boundAcpToolTitle 的空白
      // 归 undefined 承担，信封 title 回退 acpUnknownToolName）；旧日志的
      // 动态 name 不命中注册 key，自然落宿主 GenericToolCard。
      name: ACP_EXTERNAL_TOOL_NAME,
      arguments: JSON.stringify(update.rawInput ?? {}),
 // +：title/kind/locations 摘要随 meta 落盘（kind/locations
      // 是恢复对账的对称事实源；title 是 running 卡片标题的唯一幸存通道）
      ...(meta === undefined ? {} : { meta }),
    }
    const event = this.sink.append('tool/call', data)
    this.segmenter.noteVisibleOutput()
    if (this.pendingCalls.has(update.toolCallId)) {
      this.warn('duplicate-tool-call', `tool_call "${update.toolCallId}" arrived while an earlier call with that id is still open; the later frame supersedes the stash`)
    }
    this.pendingCalls.set(update.toolCallId, {
      callSeq: event.seq,
      step,
      turn: this.turnNumber,
      fallback: mapToolContent(update.content, this.terminalSnapshot),
 // 非对称工具回放：终态快照以首帧 wire 事实为初值（占位首帧的
      // rawInput/locations 缺席即缺席，由后续 update 帧补齐），后续 update 覆盖。
      snapshot: acpTerminalSnapshotFromFrame(update),
      snapshotUpdated: false,
    })
    events.push(event)
    return events
  }

  /**
 * 终态快照累积（非对称工具回放）：tool_call_update 帧携带的
   * title/kind/locations/rawInput/content 以 latest-wins 并入 pending 簿记。
   * ACP patch 语义：null/缺席 = 不变，绝不覆盖既有事实。content 覆盖的同时
   * 重映射为 {@link PendingToolCall.fallback}（claude 形态：终态 content 经
   * 进行中 update 帧到达，终态帧不带 content——旧口径下这些事实被整条丢弃，
   * tool/result 落空 content，恢复对账与回放侧终态合并帧必然发散）。
   */
  private accumulateToolCallUpdate(pending: PendingToolCall, update: ToolCallUpdate): void {
    const snapshot = pending.snapshot
    let touched = false
    if (typeof update.title === 'string' && update.title !== '') {
      snapshot.title = update.title
      touched = true
    }
    if (update.kind !== undefined && update.kind !== null) {
      snapshot.kind = update.kind
      touched = true
    }
    if (update.locations !== undefined && update.locations !== null) {
      snapshot.locations = acpLocationsJson(update.locations)
      touched = true
    }
    if (update.rawInput !== undefined && update.rawInput !== null) {
      const canonical = acpCanonicalJsonRoundTrip(update.rawInput)
      if (canonical !== undefined) {
        snapshot.rawInput = canonical
        touched = true
      }
    }
    const extension = codexAgentExtension(update._meta)
    if (extension !== undefined) {
      snapshot.agentExtension = extension
      touched = true
    }
    if (touched) pending.snapshotUpdated = true
    if (update.content !== undefined && update.content !== null) {
      pending.fallback = mapToolContent(update.content, this.terminalSnapshot)
    }
  }

  /** `tool_call_update` branch; contract documented at {@link TurnTranslator.feed}. */
  private feedToolCallUpdate(update: ToolCallUpdate): SessionEvent[] {
    const status = update.status
    let pending = this.pendingCalls.get(update.toolCallId)
    if (pending !== undefined) this.accumulateToolCallUpdate(pending, update)
    if (status !== 'completed' && status !== 'failed') return []
    // DSH 的 tool/result 必须与当前开放 step 内的 tool/call 配对。ACP 正常会在
    // prompt 返回前交付所有终态；若上游仍迟到到后续 turn（或只发终态帧），
    // 先在当前 turn 建立一个明确的 continuation call，再落 result。这样既保留
    // 结果，也不伪造跨 turn 的 DSH step 关系。
    const events: SessionEvent[] = []
    if (pending === undefined || pending.turn !== this.turnNumber) {
      const previous = pending
      if (previous === undefined) {
        this.warn('orphan-tool-result', `terminal tool_call_update "${update.toolCallId}" had no known tool/call; registered a continuation call before preserving its result`)
      }
      if (previous !== undefined) this.pendingCalls.delete(update.toolCallId)
      events.push(...this.flushSegment())
      const snapshot = previous?.snapshot ?? acpTerminalSnapshotFromFrame(update)
      const continuation: ToolCall = {
        toolCallId: update.toolCallId,
        title: boundAcpToolTitle(snapshot.title) ?? acpUnknownToolName(update.toolCallId),
        ...(snapshot.rawInput === undefined ? {} : { rawInput: snapshot.rawInput }),
        ...(update.content === undefined || update.content === null ? {} : { content: update.content }),
      }
      events.push(...this.feedToolCall(continuation))
      pending = this.pendingCalls.get(update.toolCallId)
      if (pending === undefined) {
        throw new Error('dsh-acp translate: continuation tool call was not registered')
      }
      if (previous !== undefined) {
        pending.fallback = previous.fallback
        pending.snapshot = previous.snapshot
        pending.snapshotUpdated = previous.snapshotUpdated
      } else {
        pending.snapshot = snapshot
        pending.snapshotUpdated = update.title !== undefined && update.title !== null
          || update.kind !== undefined && update.kind !== null
          || update.locations !== undefined && update.locations !== null
          || update.rawInput !== undefined && update.rawInput !== null
      }
    }
    this.pendingCalls.delete(update.toolCallId)
    const step = pending.step
    const mapped = update.content === undefined
      ? pending.fallback
      : mapToolContent(update.content, this.terminalSnapshot)
    if (mapped.degraded.length > 0) {
 // 如实口径：非文本/超限内容不静默丢弃，按占位/摘要落盘
      this.warn('unsupported-tool-content', `tool result "${update.toolCallId}" contains ${String(mapped.degraded.length)} item(s) that cannot be rendered verbatim; placeholders or summaries were persisted (see tool/result metadata and sidecar degradation audit)`)
      this.noteDegradation({
        code: 'unsupported-tool-content',
        toolCallId: update.toolCallId,
        items: mapped.degraded.slice(0, ACP_DEGRADATION_ITEMS_MAX),
        keptPreviewChars: mapped.keptChars,
        truncated: mapped.truncated,
      })
    }
    const isError = status === 'failed'
    const message = createToolResultMessage({
      callId: CallId(update.toolCallId),
      content: mapped.blocks,
      isError,
    })
 // 非对称工具回放：终态快照 meta（配对 call 的累积快照；孤儿终态帧只有本帧
    // 事实——orphan 不入对账，meta 仅作诊断留痕）。与 mapped.meta（acpToolContent）
    // 键不相交，浅合并共存。
    const terminalMeta = acpToolCallTerminalMetaJson(pending.snapshot, pending.snapshotUpdated)
 // 展示信封（meta.acpToolPresentation）恒落——name 恒为稳定名后，
    // 渲染器靠信封拿 title/kind/locations/content 的展示形态。title 取终态
    // 快照（latest-wins 含首帧），缺席回退 acpUnknownToolName；inputSummary
    // 是快照 rawInput 的有界折叠（acpToolInputSummary）。信封是展示通道，
    // 不进对账 digest（resume.ts dshToolResultProjectionMeta 只计
    // acpToolContent 键）；回放侧经同一代码路径产出同样信封，天然对称。
    const snapshot = pending.snapshot
    const inputSummary = snapshot.rawInput === undefined ? undefined : acpToolInputSummary(snapshot.rawInput)
    const presentation: AcpToolPresentationV1 = {
      version: 1,
      title: boundAcpToolTitle(snapshot.title) ?? acpUnknownToolName(update.toolCallId),
      ...(snapshot.kind === undefined ? {} : { kind: snapshot.kind }),
      status: isError ? 'failed' : 'completed',
      ...(snapshot.locations === undefined || snapshot.locations.length === 0 ? {} : { locations: snapshot.locations }),
      ...(inputSummary === undefined ? {} : { inputSummary }),
      ...(snapshot.agentExtension === undefined ? {} : { agentExtension: snapshot.agentExtension }),
      content: [...mapped.presentation],
    }
    const mergedMeta: Record<string, JsonValue> = {
      ...(mapped.meta !== undefined && typeof mapped.meta === 'object' && mapped.meta !== null ? mapped.meta as Record<string, JsonValue> : {}),
      ...(terminalMeta !== undefined && typeof terminalMeta === 'object' ? terminalMeta as Record<string, JsonValue> : {}),
      ...acpToolPresentationMetaJson(presentation),
    }
    const data: SessionEventMap['tool/result'] = {
      turn: this.turnNumber,
      step,
      message,
      ...(isError ? { error: { name: ACP_TOOL_ERROR_NAME, code: ACP_TOOL_ERROR_CODE } } : {}),
      ...(Object.keys(mergedMeta).length === 0 ? {} : { meta: mergedMeta }),
    }
    this.segmenter.noteVisibleOutput()
    events.push(this.sink.append('tool/result', data, { surfaceOp: 'append', sourceEventSeqs: [pending.callSeq] }))
    if (!this.openStepHasPendingTool() && !this.hasPendingContent()) {
      events.push(...this.closeOpenPresentationStep())
    }
    return events
  }

  /** `plan` branch; contract documented at {@link TurnTranslator.feed}. */
  private feedPlan(update: Plan): SessionEvent[] {
    if (update.entries.length === 0) return []
    const text = renderPlan(update.entries)
    const events: SessionEvent[] = []
    events.push(...this.ensureAssistantSegment())
    if (this.openBlock !== undefined) events.push(this.closeBlock())
    const index = this.nextBlockIndex++
    const block: ContentBlock = { type: 'reasoning', text }
    this.blocks.push(block)
    events.push(this.emitChunk({ type: 'block-start', index, blockType: 'reasoning' }))
    events.push(this.emitChunk({ type: 'reasoning-delta', index, text }))
    events.push(this.emitChunk({ type: 'block-end', index, block }))
    return events
  }

  /** `usage_update` branch; contract documented at {@link TurnTranslator.feed}. */
  private feedUsageUpdate(update: UsageUpdate): SessionEvent[] {
 // 占用事实记内存快照（live state 通道的数据源），不落 usage 进日志。
    // latest-wins、跨 turn 存活。percent 保留一位小数；size 为 0（agent 报告
    // 异常）时记 0，不做除零。cost 收窄为 amount/currency 原样透传。
    this.lastContextUsage = {
      used: update.used,
      size: update.size,
      percent: update.size > 0 ? Math.round((update.used / update.size) * 1000) / 10 : 0,
      cost: update.cost === undefined || update.cost === null
        ? null
        : { amount: update.cost.amount, currency: update.cost.currency },
    }
    const context = { provider: this.currentRoute.provider, model: this.effectiveModel(), contextWindow: update.size }
    const last = this.lastContext
    if (last !== undefined
      && last.provider === context.provider
      && last.model === context.model
      && last.contextWindow === context.contextWindow) {
      return []
    }
    this.lastContext = context
    return [this.sink.append('request/context', context)]
  }

  /**
   * The model value safe to persist: the current route's non-empty model, else
   * the last known non-empty model, else the {@link ACP_UNKNOWN_MODEL}
   * sentinel. Persisting `''` poisons the log — the session seed validators
   * reject empty provider/model at load time（恢复矩阵测试覆盖）。
   */
  private effectiveModel(): string {
    if (this.currentRoute.model !== '') return this.currentRoute.model
    if (this.lastKnownModel !== '') return this.lastKnownModel
    return ACP_UNKNOWN_MODEL
  }

  /**
   * Flush the current assistant segment into its `assistant/message`。
   * 分段化后的收口单元——tool/call 到达前的钉版 flush、endTurn 的收口、以及
   * {@link TurnTranslator.beginTurn} 的隐式 flush 都走这里）。segment 无内容
   * 时不产任何事件（不产空 assistant message）；只 flush 当前开放 segment，
   * 绝不移动/回写已提交的消息。
   */
  private flushSegment(): SessionEvent[] {
    const events: SessionEvent[] = []
    if (this.openBlock !== undefined) events.push(this.closeBlock())
    const step = this.segmenter.closeAssistantSegment()
    if (this.blocks.length === 0) {
      this.chunkSeqs = []
      return events
    }
    if (step === undefined) {
      // 内部不变量：有聚合内容必有开放 segment（内容路径先经 ensureAssistantSegment）。
      throw new Error('dsh-acp translate: flushed content without an open presentation segment (internal invariant violated)')
    }
    const message = createAssistantMessage({
      content: this.blocks,
      source: { provider: this.currentRoute.provider, model: this.effectiveModel() },
    })
    const data: SessionEventMap['assistant/message'] = {
      turn: this.turnNumber,
      step,
      message,
    }
    events.push(this.sink.append('assistant/message', data, {
      surfaceOp: 'append',
      sourceEventSeqs: this.chunkSeqs,
    }))
    this.segmenter.noteVisibleOutput()
    this.blocks = []
    this.chunkSeqs = []
    if (!this.openStepHasPendingTool()) events.push(...this.closeOpenPresentationStep())
    return events
  }
}

/**
 * 回放共轨翻译器：session/load 回放更新流经**同一个**
 * {@link TurnTranslator} 翻译（内部 staging sink 只记录事件、seq 从 0 连续，
 * **绝不写 session log**），恢复对账两侧因此由同一代码路径产出可见历史
 * （resume.ts 的 replayVisibleHistory 与 expectedVisibleHistory 是同一提取
 * 函数作用于两份事件流）。
 *
 * 与 live 的唯一差异在输入边界：回放流没有 `beginTurn`/`endTurn` 括号，本类
 * 以 user 锚点重建 turn 结构——连续 `user_message_chunk` run 聚合成一条合成
 * `user/message` 事件（对齐旧 normalizeReplayUpdates 的聚合语义：连续 run 一
 * 条、非文本 user chunk 跳过），run 开始即 endTurn 上一段（收尾其开放
 * assistant segment），run 结束后的首个非 user 更新前 beginTurn 下一段。合成
 * turn 号从 1 递增（仅为满足载荷必填字段；可见历史提取不读 assistant 事件的
 * turn 号）。
 *
 * 有界闸（条目数/字符数上限与溢出闩锁）在调用方 AcpAgent——本类只如实翻译，
 * 溢出判定需要原始 wire 更新文本，不属于本层。
 */
export class ReplayTranslator {
  /** 内部翻译器（staging sink 接线；分段/对账事实产出的唯一代码路径）。 */
  private readonly translator: TurnTranslator
  /** staged 事件（seq 从 0 连续，含合成 user/message）。 */
  private readonly stagedEvents: SessionEvent[] = []
  /** staging sink 的确定性时间基（与 seq 同步递增；回放 staging 不需要真实时钟）。 */
  private static readonly TIME_BASE = 1_700_000_000_000
  /** 已 beginTurn 的合成 turn 数（下一个 turn 号 = turnCount + 1）。 */
  private turnCount = 0
  /** 当前是否有开放的合成 turn 括号。 */
  private turnOpen = false
  /** 聚合中的 user chunk 文本 run（undefined = 不在 user run 内）。 */
  private userRun: string[] | undefined

  /**
   * @param options - 与 {@link TurnTranslatorOptions} 相同，但不带 sink（staging
   *   sink 内置）；provider/model 取恢复时的当前路由，与 live 落盘的 source 口径一致。
   */
  constructor(options: Omit<TurnTranslatorOptions, 'sink'>) {
    this.translator = new TurnTranslator({ ...options, sink: this.stagingSink })
    // 头部内容（首个 user 锚之前的残留/外来更新）归入带头段，与
    // resume.ts segmentByTurnAnchors 的带头段口径对齐。
    this.openNextTurn()
  }

  /** 已 staged 的事件（seq 从 0 连续；只读视图，调用方不得修改）。 */
  get staged(): readonly SessionEvent[] {
    return this.stagedEvents
  }

  /** 已 staged 的事件条数（AcpAgent 有界闸的条目数输入）。 */
  get stagedCount(): number {
    return this.stagedEvents.length
  }

  /** 内部翻译器记录的诊断（orphan/unknown 更新等）；回放路径同样如实留痕。 */
  get warnings(): readonly TranslatorWarning[] {
    return this.translator.warnings
  }

  /**
   * 喂入一条回放 `session/update`（wire 序）。user 锚点语义见类注释；其余
   * 更新直喂内部 {@link TurnTranslator.feed}。
   */
  feed(update: SessionUpdate): void {
    if (update.sessionUpdate === 'user_message_chunk') {
      if (this.turnOpen) {
        // user 锚开新 turn 段：先收口上一段（flush 其开放 assistant segment）。
        this.translator.endTurn()
        this.turnOpen = false
      }
      if (update.content.type === 'text') {
        this.userRun ??= []
        this.userRun.push(update.content.text)
      }
      return
    }
    this.flushUserRun()
    if (!this.turnOpen) this.openNextTurn()
    this.translator.feed({ sessionId: 'replay', update })
  }

  /**
   * 回放流收尾：flush 末尾 user run（若有）与当前开放 turn（若有），返回全部
   * staged 事件。之后本实例不可再 feed（翻译器已 endTurn，再 feed 只会按
   * out-of-turn 纪律翻译并留 warning）。
   */
  finish(): readonly SessionEvent[] {
    this.flushUserRun()
    if (this.turnOpen) {
      this.translator.endTurn()
      this.turnOpen = false
    }
    return this.stagedEvents
  }

  /** 记录型 staging sink：seq 从 0 连续分配；事件只进内存数组，绝不落盘。 */
  private readonly stagingSink: SessionEventSink = {
    append: <T extends SessionEventType>(
      type: T,
      data: SessionEventMap[T],
      ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
    ): SessionEvent<T> => {
      const intent = (opts as unknown as ReadonlyArray<SurfaceIntent | undefined>)[0]
      const event = {
        type,
        seq: this.stagedEvents.length,
        time: ReplayTranslator.TIME_BASE + this.stagedEvents.length,
        data,
        ...(intent?.surfaceOp === undefined ? {} : { surfaceOp: intent.surfaceOp }),
        ...(intent?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...intent.sourceEventSeqs] }),
      } as unknown as SessionEvent<T>
      this.stagedEvents.push(event as SessionEvent)
      return event
    },
  }

  /** 聚合中的 user run 落为一条合成 `user/message`（surfaceOp 'append'；不在 run 内则无操作）。 */
  private flushUserRun(): void {
    if (this.userRun === undefined) return
    const text = this.userRun.join('')
    this.userRun = undefined
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: '@zaimokuza/dsh-acp-adapter' },
    })
    this.stagedEvents.push({
      type: 'user/message',
      seq: this.stagedEvents.length,
      time: ReplayTranslator.TIME_BASE + this.stagedEvents.length,
      data: message,
      surfaceOp: 'append',
    } as unknown as SessionEvent)
  }

  /** 开下一个合成 turn（turn 号从 1 递增）。 */
  private openNextTurn(): void {
    this.turnCount += 1
    this.translator.beginTurn(this.turnCount)
    this.turnOpen = true
  }
}
