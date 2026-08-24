/**
 * ACP 外部工具的稳定 tool 身份 + 版本化有界展示信封
 * （`AcpToolPresentationV1`）的共享叶子模块。
 *
 * 背景：ACP `tool_call` 的 title 是 Agent 给的动态展示串（Claude
 * 首帧甚至是进行态占位），直接用作 DSH `tool/call` 的 `name` 会让宿主
 *  keyed `tool.call.toolview` 槽位（按 wire tool name 分发，见上游
 * ui-tool ToolCallTree）无法稳定命中。本适配器因此把落盘 name 固定为
 * {@link ACP_EXTERNAL_TOOL_NAME}，动态 title/kind 移入 meta：
 * 首帧 title 随 `tool/call` 的 `meta.acpToolCall.title`（有界）落盘，
 * 终态展示事实随配对 `tool/result` 的 `meta.acpToolPresentation` 信封落盘。
 *
 * 信封载体决策（证据钉在 translate.ts 与本模块测试）：上游
 * ui-conversation conversation-nodes/tool.ts 的 `RunningToolCall` 不携带
 * meta（tool/call 的 meta 到不了 client），`ToolResultNode.meta` 则是
 * tool/result event.data.meta 原样透传——信封因此只落 `tool/result`；
 * running 卡片由注册渲染器用首帧 meta 缺失时的通用形态兜底。
 *
 * 信封纪律：
 * - **有界** 界限沿用 同口径常量（本模块是它们的单一事实源，
 *   translate.ts re-export 保持既有引用面不变）；title 另有
 *   {@link ACP_TOOL_TITLE_MAX_CHARS} 上限。content 条目独立过
 *   「条数 + 文本总量」双闸，溢出折叠为一条固定注记项。
 * - **二进制只留引用 + 元数据** image/audio/blob 的字节从不进信封
 * （与 占位同一纪律），image 项的 `ref` 是 uri 或 `sha256:<hash16>`。
 * - **不进对账 digest** resume.ts `dshToolResultProjectionMeta` 只计
 * `acpToolContent` 键；本信封是展示通道（与 title 同为展示事实，被拒工具回放不对称
 *   纪律），回放侧经同一代码路径产出同样 meta，天然对称。
 * - **版本化** `version: 1`；client 侧解码器（src/client/data/
 *   tool-presentation.ts 的零 import 镜像）对 version≠1 / 结构破损一律
 *   fail-closed 归 undefined（宿主 GenericToolCard 自然兜底）。
 *
 * 架构：本模块是 protocol 层叶子——只允许 type-only 的外部 import
 * （SDK wire 类型 / dsh-session JsonValue）+ node:crypto（展示摘要 hash；
 * 本包 tsconfig `types: []`，经 triple-slash reference 引入 @types/node，
 * translate.ts 同款先例）。translate.ts（同层）向下消费，不产生循环。
 *
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/tool-presentation
 */
/// <reference types="node" />

import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * ACP 外部工具的 DSH `tool/call.name` 稳定值。宿主 keyed
 * `tool.call.toolview` 槽位按 wire tool name 分发（ui-tool ToolCallTree 的
 * `entryKey: toolName`），稳定名使本适配器注册的渲染器恒命中；旧日志的
 * 动态 name 不命中任何 key，自然落 GenericToolCard（向后兼容的兜底）。
 * 审批 UX 的事实标签不受影响（domain/policy/permissions.ts 用
 * `acpUnknownToolName`，与本常量独立）。
 */
export const ACP_EXTERNAL_TOOL_NAME = 'dsh_acp_external_tool'

/** 展示信封的版本号（`meta.acpToolPresentation.version` 的唯一合法值）。 */
export const ACP_TOOL_PRESENTATION_VERSION = 1

/**
 * 落盘 title 的用户可见面上限（`tool/call` meta.acpToolCall.title 与
 * 信封 title 共用）；超长截断加省略号。
 */
export const ACP_TOOL_TITLE_MAX_CHARS = 200

/**
 * raw input 摘要的 JSON 串上限（起本模块是单一事实源；resume.ts 的
 * 对账折叠 boundToolInput 与信封 inputSummary 共用同一界限）。
 */
export const ACP_TOOL_INPUT_SUMMARY_MAX_CHARS = 2_000

/**
 * tool result fidelity：单内容项 preview 的 head 保留字符数。超界文本
 * （embedded resource text、diff 新内容预览）按 head + 截断标记 + tail 截断，
 * 单 item 内容保留上限 = head + tail（标记本身不计）。 位于本模块
 * （信封与落盘 text 块共用界限的单一事实源），translate.ts re-export。
 */
export const ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS = 2_000
/** 单内容项 preview 的 tail 保留字符数（见 {@link ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS}）。 */
export const ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS = 2_000
/**
 * 单条 tool/result 全部内容块的合计字符上限；超出继续截断并标记，
 * 预算耗尽后剩余的项折叠为一条「另有 N 项未显示」占位。信封 content 的
 * 文本总量闸沿用同一值。
 */
export const ACP_TOOL_CONTENT_TOTAL_MAX_CHARS = 16_000
/** 二进制内容（image/audio/blob resource）sha256 摘要保留的 hex 字符数（对 wire payload 算）。 */
export const ACP_TOOL_CONTENT_HASH_HEX_CHARS = 16
/** tool/result `meta.acpToolContent.items` 的条目上限（超出部分只计入 originalItems 总数）。信封 content 条数闸沿用同一值。 */
export const ACP_TOOL_CONTENT_META_ITEMS_MAX = 64

/** 信封 content 的终态（ACP ToolCallStatus 的 completed/failed 二值；pending/in_progress 不产生信封）。 */
export type AcpToolPresentationStatusV1 = 'completed' | 'failed'

/**
 * 信封 content 的单项（五变体）。全部字段有界（text/patch/summary 已过
 * head/tail 与总量双闸）；二进制项（image、无 uri 的 blob resource）只有
 * ref + 元数据，字节不落。`truncated: true` 表示该文本字段是截断预览，
 * `originalChars` 记截断前长度（字符）。
 */
export type AcpToolPresentationContentV1 =
  | {
    /** 可见文本（agent 文本 / audio·未知类型的占位事实行）。 */
    type: 'text'
    text: string
    originalChars?: number
    truncated?: true
  }
  | {
 /** diff 预览：`patch` 是 newText 的有界 head/tail 预览（非完整 patch——完整字节从不落盘， 纪律）。 */
    type: 'diff'
    path: string
    /** 操作类型（按 oldText/newText 可空推断；与 acpToolContent meta 同口径）。 */
    operation: '新建' | '修改' | '删除'
    linesAdded: number
    linesRemoved: number
    patch: string
    originalChars?: number
    truncated?: true
  }
  | {
    /** terminal 占位：DSH 无 terminal 能力，`text` 是占位事实行（输出不可得）。 */
    type: 'terminal'
    terminalId: string
    text: string
    truncated?: true
  }

  | {
    /** image 引用：`ref` = uri（agent 提供时）或 `sha256:<hash16>`；字节不落。 */
    type: 'image'
    ref: string
    mimeType?: string
    /** wire 载荷字节数（base64 串长）。 */
    size?: number
    hash16?: string
  }
  | {
    /** resource / resource_link：embedded text 的 summary 是有界预览；blob 的 summary 是占位事实行（ref 元数据在 uri/hash16/size）。 */
    type: 'resource'
    uri: string
    name?: string
    mimeType?: string
    size?: number
    hash16?: string
    summary: string
    truncated?: true
  }

/**
 * 受控的 Agent 私有扩展投影。仅接纳 codex-acp 已知 namespaced 字段，不复制
 * 任意 `_meta`。这些 thread 属于 Codex，不伪装成 DSH child session。
 */
export type AcpAgentExtensionV1 =
  | {
      runtime: 'codex'
      type: 'collaboration'
      tool: string
      senderThreadId?: string
      receiverThreadIds: string[]
    }
  | {
      runtime: 'codex'
      type: 'subagent-activity'
      threadId: string
      path: string
      activity: string
    }

/**
 * 版本化有界展示信封（`tool/result` 事件 `meta.acpToolPresentation`）。
 * title 是各帧 latest-wins 的终态标题（含首帧；缺席回退
 * `acpUnknownToolName(callId)`，由装配侧 translate.ts 决定），已过
 * {@link ACP_TOOL_TITLE_MAX_CHARS} 上限。`inputSummary` 是 rawInput 的有界
 * canonical JSON 值（{@link acpToolInputSummary} 折叠口径）。
 */
export type AcpToolPresentationV1 = {
  version: typeof ACP_TOOL_PRESENTATION_VERSION
  /** 终态展示标题（有界；非空）。 */
  title: string
  /** 终态 ACP ToolKind（agent 未提供时缺席）。 */
  kind?: string
  status: AcpToolPresentationStatusV1
  /** 终态 locations（path + 可选 line；保持 wire 顺序；空集缺席）。 */
  locations?: { path: string; line?: number }[]
  /** rawInput 的有界摘要（超界折 `{truncated, originalChars, hash16}`；rawInput 全程缺席则本字段缺席）。 */
  inputSummary?: JsonValue
  /** Agent 私有扩展的白名单投影；未知 runtime/meta 永不进入信封。 */
  agentExtension?: AcpAgentExtensionV1
  /** 展示内容项（封顶 {@link ACP_TOOL_CONTENT_META_ITEMS_MAX} 条、文本总量 {@link ACP_TOOL_CONTENT_TOTAL_MAX_CHARS}）。 */
  content: AcpToolPresentationContentV1[]
}

/** 展示用 sha256 前 {@link ACP_TOOL_CONTENT_HASH_HEX_CHARS} hex（与 translate.ts hash16Of 同算法；展示/诊断用途，与对账 digest 的 acpCanonicalHash16 不同源——信封不进 digest，见模块头）。 */
export function presentationHash16(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
}

/**
 * 落盘 title 的有界化：缺席/空白 → undefined（装配侧回退
 * `acpUnknownToolName`）；超 {@link ACP_TOOL_TITLE_MAX_CHARS} 截断加省略号。
 */
export function boundAcpToolTitle(title: string | undefined): string | undefined {
  if (title === undefined || title === '') return undefined
  return title.length <= ACP_TOOL_TITLE_MAX_CHARS
    ? title
    : `${title.slice(0, ACP_TOOL_TITLE_MAX_CHARS)}…`
}

/**
 * 信封文本字段的 head/tail 预览（界限同 单 item 口径）。与落盘 text
 * 块的 headTailPreview 差别：不内嵌中文截断标记行——信封是结构化通道，
 * 截断事实由 `truncated`/`originalChars` 字段表达，渲染器自行注记。
 */
export function acpToolPresentationPreview(text: string): { text: string; truncated: boolean } {
  const budget = ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS + ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS
  if (text.length <= budget) return { text, truncated: false }
  return {
    text: text.slice(0, ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS) + text.slice(text.length - ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS),
    truncated: true,
  }
}

/**
 * rawInput（已 canonical 的 JsonValue）的有界展示摘要：未超界原样；超界折
 * `{truncated:true, originalChars, hash16}` 标记对象。形状与 resume.ts
 * boundToolInput 的对账折叠一致（同界限、同键名），但 hash16 用
 * {@link presentationHash16}（纯 sha256）——信封是展示通道不进 digest，
 * 与对账的 acpCanonicalHash16 刻意不同源，两处语义不耦合。
 */
export function acpToolInputSummary(rawInput: JsonValue): JsonValue {
  const json = JSON.stringify(rawInput)
  if (json === undefined || json.length <= ACP_TOOL_INPUT_SUMMARY_MAX_CHARS) return rawInput
  return {
    truncated: true,
    originalChars: json.length,
    hash16: presentationHash16(json),
  }
}

/** 单项的文本预算占用（image 无文本字段，计 0）。 */
function presentationItemChars(item: AcpToolPresentationContentV1): number {
  switch (item.type) {
    case 'text': return item.text.length
    case 'diff': return item.patch.length
    case 'terminal': return item.text.length
    case 'resource': return item.summary.length
    case 'image': return 0
  }
}

/** 文本字段就地截断到 `chars` 并标记（image 无文本字段，调用侧保证不进入本分支）。 */
function slicePresentationItem(item: AcpToolPresentationContentV1, chars: number): AcpToolPresentationContentV1 {
  switch (item.type) {
    case 'text': return { ...item, text: item.text.slice(0, chars), truncated: true }
    case 'diff': return { ...item, patch: item.patch.slice(0, chars), truncated: true }
    case 'terminal': return { ...item, text: item.text.slice(0, chars), truncated: true }
    case 'resource': return { ...item, summary: item.summary.slice(0, chars), truncated: true }
    case 'image': return item
  }
}

/** 总量闸耗尽后的固定注记项（五变体内唯一的 meta 项；计数含被条数闸丢弃的项）。 */
function omittedNoteItem(omitted: number): AcpToolPresentationContentV1 {
  return { type: 'text', text: `[……另有 ${String(omitted)} 项内容未纳入展示信封……]` }
}

/**
 * 信封 content 的双闸归一化（装配侧对映射产物逐项收集后调用）：
 * 1. 文本总量闸 {@link ACP_TOOL_CONTENT_TOTAL_MAX_CHARS}——逐项累计文本
 *    字段长度，超界项就地截断标记，预算耗尽的后续项计 omitted；
 * 2. 条数闸 {@link ACP_TOOL_CONTENT_META_ITEMS_MAX}——实项超过时丢弃尾部
 *    （计入 omitted），为注记项预留最后一个槽位；
 * 3. omitted > 0 时尾部追加一条固定注记项（信封因此恒有界）。
 */
export function boundAcpToolPresentationItems(
  items: readonly AcpToolPresentationContentV1[],
): { items: AcpToolPresentationContentV1[]; truncated: boolean; omitted: number } {
  const out: AcpToolPresentationContentV1[] = []
  let usedChars = 0
  let omitted = 0
  let truncated = false
  for (const item of items) {
    if ('truncated' in item && item.truncated === true) truncated = true
    const size = presentationItemChars(item)
    const remaining = ACP_TOOL_CONTENT_TOTAL_MAX_CHARS - usedChars
    if (remaining <= 0) {
      omitted += 1
      continue
    }
    if (size <= remaining) {
      out.push(item)
      usedChars += size
    } else {
      truncated = true
      out.push(slicePresentationItem(item, remaining))
      usedChars = ACP_TOOL_CONTENT_TOTAL_MAX_CHARS
    }
  }
  if (out.length > ACP_TOOL_CONTENT_META_ITEMS_MAX) {
    omitted += out.length - ACP_TOOL_CONTENT_META_ITEMS_MAX
    out.length = ACP_TOOL_CONTENT_META_ITEMS_MAX
  }
  if (omitted > 0) {
    // 注记项占最后一个槽位：实项已满帽时把末尾实项折进 omitted 计数。
    if (out.length === ACP_TOOL_CONTENT_META_ITEMS_MAX) {
      out.pop()
      omitted += 1
    }
    truncated = true
    out.push(omittedNoteItem(omitted))
  }
  return { items: out, truncated, omitted }
}

/** content 单项 → JsonValue（逐字段落 Record，可选字段缺席而非 undefined；与 toolContentMetaJson 同一纪律）。 */
function presentationContentItemJson(item: AcpToolPresentationContentV1): JsonValue {
  const out: Record<string, JsonValue> = { type: item.type }
  switch (item.type) {
    case 'text':
      out.text = item.text
      if (item.originalChars !== undefined) out.originalChars = item.originalChars
      if (item.truncated !== undefined) out.truncated = item.truncated
      break
    case 'diff':
      out.path = item.path
      out.operation = item.operation
      out.linesAdded = item.linesAdded
      out.linesRemoved = item.linesRemoved
      out.patch = item.patch
      if (item.originalChars !== undefined) out.originalChars = item.originalChars
      if (item.truncated !== undefined) out.truncated = item.truncated
      break
    case 'terminal':
      out.terminalId = item.terminalId
      out.text = item.text
      if (item.truncated !== undefined) out.truncated = item.truncated
      break
    case 'image':
      out.ref = item.ref
      if (item.mimeType !== undefined) out.mimeType = item.mimeType
      if (item.size !== undefined) out.size = item.size
      if (item.hash16 !== undefined) out.hash16 = item.hash16
      break
    case 'resource':
      out.uri = item.uri
      if (item.name !== undefined) out.name = item.name
      if (item.mimeType !== undefined) out.mimeType = item.mimeType
      if (item.size !== undefined) out.size = item.size
      if (item.hash16 !== undefined) out.hash16 = item.hash16
      out.summary = item.summary
      if (item.truncated !== undefined) out.truncated = item.truncated
      break
  }
  return out
}

/**
 * 信封 → `tool/result` meta 片段（`{ acpToolPresentation: {...} }`，落
 * `Record<string, JsonValue>`；与 mapped.meta / terminalMeta 键不相交，
 * 浅合并共存——见 translate.ts feedToolCallUpdate）。
 */
export function acpToolPresentationMetaJson(presentation: AcpToolPresentationV1): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    version: ACP_TOOL_PRESENTATION_VERSION,
    title: presentation.title,
    status: presentation.status,
    content: presentation.content.map(presentationContentItemJson),
  }
  if (presentation.kind !== undefined) body.kind = presentation.kind
  if (presentation.locations !== undefined) {
    body.locations = presentation.locations.map((loc) => ({
      path: loc.path,
      ...(loc.line === undefined ? {} : { line: loc.line }),
    }))
  }
  if (presentation.inputSummary !== undefined) body.inputSummary = presentation.inputSummary
  if (presentation.agentExtension !== undefined) {
    const extension: Record<string, JsonValue> = {
      runtime: presentation.agentExtension.runtime,
      type: presentation.agentExtension.type,
    }
    if (presentation.agentExtension.type === 'collaboration') {
      extension.tool = presentation.agentExtension.tool
      extension.receiverThreadIds = presentation.agentExtension.receiverThreadIds
      if (presentation.agentExtension.senderThreadId !== undefined) extension.senderThreadId = presentation.agentExtension.senderThreadId
    } else {
      extension.threadId = presentation.agentExtension.threadId
      extension.path = presentation.agentExtension.path
      extension.activity = presentation.agentExtension.activity
    }
    body.agentExtension = extension
  }
  return { acpToolPresentation: body }
}
