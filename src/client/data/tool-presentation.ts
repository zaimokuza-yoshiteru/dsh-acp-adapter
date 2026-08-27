/**
 * client half: the ACP external-tool presentation envelope's decode
 * and row-model decisions (pure logic, directly vitest-testable).
 *
 * CLIENT-SIDE COPY discipline (same as ./logic.ts): the constants, envelope
 * types and fallback vocabulary below mirror the host-half source of truth
 * src/protocol/v1/tool-presentation.ts — clientData may not import host
 * modules (architecture whitelist: same layer + contract only, zero external
 * modules), and a value import would inline Node-targeted code into the
 * browser bundle. test/client-toolview.spec.ts pins the two sides equal.
 *
 * Fail-closed decode: version ≠ 1 or a structurally broken core field
 * (title/status/content) degrades the whole envelope to `undefined` — the
 * registered toolview then renders its minimal generic row, and calls logged
 * before (dynamic `name`) never reach this renderer at all (the keyed
 * slot dispatches on the stable name and falls back to the host
 * GenericToolCard). An unknown content variant decodes to a placeholder text
 * item instead of dropping the fact silently (the same discipline the
 * protocol side applies to unknown ACP content types).
 *
 * @module @zaimokuza/dsh-acp-adapter/client/tool-presentation
 */

// ---------- 常量镜像（真源 src/protocol/v1/tool-presentation.ts；钉版测试锁双侧相等） ----------

/** ACP 外部工具的 DSH `tool/call.name` 稳定值（keyed toolview 的注册 key）。 */
export const ACP_EXTERNAL_TOOL_NAME = 'dsh_acp_external_tool'
/** 展示信封版本号（`meta.acpToolPresentation.version` 的唯一合法值）。 */
export const ACP_TOOL_PRESENTATION_VERSION = 1

/** 局部 JsonValue（clientData 零外部模块纪律——dsh-session 的类型也不能 import）。 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ---------- 信封类型镜像 ----------

/** 信封 content 单项（五变体；镜像 protocol 侧 AcpToolPresentationContentV1）。 */
export type AcpToolPresentationContent =
  | { type: 'text'; text: string; originalChars?: number; truncated?: true }
  | {
    type: 'diff'
    path: string
    operation: string
    linesAdded: number
    linesRemoved: number
    patch: string
    originalChars?: number
    truncated?: true
  }

  | { type: 'terminal'; terminalId: string; text: string; truncated?: true }
  | { type: 'image'; ref: string; mimeType?: string; size?: number; hash16?: string }
  | {
    type: 'resource'
    uri: string
    name?: string
    mimeType?: string
    size?: number
    hash16?: string
    summary: string
    truncated?: true
  }

export type AcpAgentExtension =
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

/** 版本化有界展示信封（镜像 protocol 侧 AcpToolPresentationV1）。 */
export interface AcpToolPresentation {
  version: typeof ACP_TOOL_PRESENTATION_VERSION
  title: string
  kind?: string
  status: 'completed' | 'failed'
  locations?: { path: string; line?: number }[]
  inputSummary?: JsonValue
  agentExtension?: AcpAgentExtension
  content: AcpToolPresentationContent[]
}

// ---------- fail-closed 解码 ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function decodeLocations(value: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: { path: string; line?: number }[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined || typeof record.path !== 'string') continue
    out.push({
      path: record.path,
      ...(typeof record.line === 'number' ? { line: record.line } : {}),
    })
  }
  return out
}

function decodeAgentExtension(value: unknown): AcpAgentExtension | undefined {
  const record = asRecord(value)
  if (record?.runtime !== 'codex') return undefined
  if (record.type === 'collaboration' && typeof record.tool === 'string' && Array.isArray(record.receiverThreadIds)) {
    const receiverThreadIds = record.receiverThreadIds.filter((item): item is string => typeof item === 'string')
    return {
      runtime: 'codex',
      type: 'collaboration',
      tool: record.tool,
      receiverThreadIds,
      ...(typeof record.senderThreadId === 'string' ? { senderThreadId: record.senderThreadId } : {}),
    }
  }
  if (record.type === 'subagent-activity'
    && typeof record.threadId === 'string'
    && typeof record.path === 'string'
    && typeof record.activity === 'string') {
    return {
      runtime: 'codex',
      type: 'subagent-activity',
      threadId: record.threadId,
      path: record.path,
      activity: record.activity,
    }
  }
  return undefined
}

/** 未识别变体的占位项（与协议侧「未知内容类型占位点名」同一纪律：不静默消失）。 */
function unknownContentItem(acpType: unknown): AcpToolPresentationContent {
  return { type: 'text', text: `[Unrecognized presentation item: ${typeof acpType === 'string' ? acpType : '?'}]` }
}

function decodeContentItem(value: unknown): AcpToolPresentationContent {
  const record = asRecord(value)
  if (record === undefined || typeof record.type !== 'string') return unknownContentItem(undefined)
  switch (record.type) {
    case 'text':
      if (typeof record.text !== 'string') return unknownContentItem(record.type)
      return {
        type: 'text',
        text: record.text,
        ...(typeof record.originalChars === 'number' ? { originalChars: record.originalChars } : {}),
        ...(record.truncated === true ? { truncated: true as const } : {}),
      }
    case 'diff':
      if (typeof record.path !== 'string' || typeof record.patch !== 'string') return unknownContentItem(record.type)
      return {
        type: 'diff',
        path: record.path,
        operation: typeof record.operation === 'string' ? record.operation : 'modify',
        linesAdded: typeof record.linesAdded === 'number' ? record.linesAdded : 0,
        linesRemoved: typeof record.linesRemoved === 'number' ? record.linesRemoved : 0,
        patch: record.patch,
        ...(typeof record.originalChars === 'number' ? { originalChars: record.originalChars } : {}),
        ...(record.truncated === true ? { truncated: true as const } : {}),
      }
    case 'terminal':
      if (typeof record.text !== 'string') return unknownContentItem(record.type)
      return {
        type: 'terminal',
        terminalId: typeof record.terminalId === 'string' ? record.terminalId : '',
        text: record.text,
        ...(record.truncated === true ? { truncated: true as const } : {}),
      }
    case 'image':
      if (typeof record.ref !== 'string') return unknownContentItem(record.type)
      return {
        type: 'image',
        ref: record.ref,
        ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
        ...(typeof record.size === 'number' ? { size: record.size } : {}),
        ...(typeof record.hash16 === 'string' ? { hash16: record.hash16 } : {}),
      }
    case 'resource':
      if (typeof record.uri !== 'string' || typeof record.summary !== 'string') return unknownContentItem(record.type)
      return {
        type: 'resource',
        uri: record.uri,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
        ...(typeof record.size === 'number' ? { size: record.size } : {}),
        ...(typeof record.hash16 === 'string' ? { hash16: record.hash16 } : {}),
        summary: record.summary,
        ...(record.truncated === true ? { truncated: true as const } : {}),
      }
    default:
      return unknownContentItem(record.type)
  }
}

/**
 * `tool/result` 事件 meta → 展示信封。fail-closed：meta 缺席/非对象、缺
 * acpToolPresentation 键、version ≠ 1、title/status/content 核心结构破损
 * 一律归 `undefined`（渲染器落通用最小行；绝不抛——日志可能被手改）。
 * 可选字段（kind/locations/inputSummary）畸形时丢字段保信封。
 */
export function decodeAcpToolPresentation(meta: unknown): AcpToolPresentation | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const body = asRecord(record.acpToolPresentation)
  if (body === undefined) return undefined
  if (body.version !== ACP_TOOL_PRESENTATION_VERSION) return undefined
  if (typeof body.title !== 'string' || body.title === '') return undefined
  if (body.status !== 'completed' && body.status !== 'failed') return undefined
  if (!Array.isArray(body.content)) return undefined
  const locations = decodeLocations(body.locations)
  const agentExtension = decodeAgentExtension(body.agentExtension)
  return {
    version: ACP_TOOL_PRESENTATION_VERSION,
    title: body.title,
    status: body.status,
    content: body.content.map(decodeContentItem),
    ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
    ...(agentExtension === undefined ? {} : { agentExtension }),
    ...('inputSummary' in body ? { inputSummary: body.inputSummary as JsonValue } : {}),
  }
}

// ---------- 行模型决策 ----------

/** ACP ToolKind → 图标键（ui-primitives 图形的选择事实；渲染侧按键取图标）。 */
export type AcpToolIconKey = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'

/** kind 缺席/未知 → 'other'；ACP ToolKind 词表（read/edit/delete/move/search/execute/think/fetch/switch_mode/other）归并到七枚图形。 */
export function acpToolIconKey(kind: string | undefined): AcpToolIconKey {
  switch (kind) {
    case 'read': return 'read'
    case 'edit':
    case 'delete':
    case 'move': return 'edit'
    case 'execute': return 'execute'
    case 'search': return 'search'
    case 'fetch': return 'fetch'
    case 'think': return 'think'
    default: return 'other'
  }
}

/** 工具行的运行态（镜像上游 tool-call-model 的 ToolRowState 子集；ACP 侧无 stopped）。 */
export type AcpToolRowState = 'running' | 'ok' | 'error'

/** 信封 diff 项的渲染材料（DiffBlock 的 DiffHunk 形状：oldText 恒 null——完整旧内容从不落盘）。 */
export interface AcpToolDiffCard {
  path: string
  newText: string
  truncated: boolean
}

/**
 * 工具行的全部展示决策（UI 是纯渲染）。`title` 缺席 = 渲染本地化通用标题
 * （running 卡片无信封——上游 RunningToolCall 不带 meta，见模块头载体决策）。
 */
export interface AcpToolRowModel {
  state: AcpToolRowState
  /** 信封 title；running / 无信封 → undefined。 */
  title: string | undefined
  /** 折叠行摘要（单 location 的相对路径优先；running 回退 argsRaw 首行截断；可为 ''）。 */
  summary: string
  /** 恰好一个 location 时的原始路径（渲染为可打开链接）。 */
  filePath: string | undefined
  /** IN 区文本（信封 inputSummary 的 JSON 串；无信封回退 argsRaw；均缺 → undefined）。 */
  inputText: string | undefined
  /** diff 卡片材料（信封 diff 项，保持顺序）。 */
  diffs: AcpToolDiffCard[]
  /** OUT 区文本（信封 text/terminal/resource 项 + image 事实行按序拼接；无信封回退 resultText）。 */
  outputText: string | undefined
  /** 信封内是否有截断项（渲染侧据此注记）。 */
  truncated: boolean
  /** 行可展开（有任何展开体内容）。 */
  expandable: boolean
  /** Codex-owned child thread/collaboration fact; never a DSH child session. */
  agentExtension: AcpAgentExtension | undefined
}

/** 路径摘要相对 cwd 缩短（上游 tool-call-model relativizeToCwd 的最小同名纪律；display-only）。 */
function relativize(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

/** running 卡片的 argsRaw 摘要：首行、界 120 字符（有界、无秘密纪律同上游 args 摘要）。 */
function argsPreview(argsRaw: string | undefined): string {
  if (argsRaw === undefined) return ''
  const firstLine = argsRaw.split('\n', 1)[0] ?? ''
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 120)}…`
}

/** image 项的事实行（ref + mime/size 元数据；字节不可得——v1 无附件 seam）。 */
function imageFactLine(item: Extract<AcpToolPresentationContent, { type: 'image' }>): string {
  const extras: string[] = []
  if (item.mimeType !== undefined) extras.push(item.mimeType)
  if (item.size !== undefined) extras.push(`${String(item.size)} bytes`)
  return `[Image] ${item.ref}${extras.length === 0 ? '' : ` (${extras.join(', ')})`}`
}

/** resource 项的事实行（uri/name + summary 预览）。 */
function resourceFactLine(item: Extract<AcpToolPresentationContent, { type: 'resource' }>): string {
  const head = item.name === undefined ? item.uri : `${item.name} → ${item.uri}`
  return item.summary === '' ? head : `${head}\n${item.summary}`
}

/**
 * 行模型决策：state（running/isError）、title（信封）、summary（location 相对
 * 路径 / argsRaw 预览）、展开体分节（diff 卡片 / OUT 文本 / IN 输入）。
 * `resultText` 是无信封时的 OUT 兜底（settled 块的落盘 text 拼接；正常
 * 日志恒有信封，本回退服务畸形 meta 的 fail-closed 路径）。
 */
export function acpToolRowModel(args: {
  running: boolean
  isError: boolean
  argsRaw: string | undefined
  resultText: string | undefined
  envelope: AcpToolPresentation | undefined
  cwd: string | undefined
}): AcpToolRowModel {
  const { running, isError, argsRaw, resultText, envelope, cwd } = args
  const state: AcpToolRowState = running ? 'running' : isError ? 'error' : 'ok'
  const locations = envelope?.locations
  const filePath = locations !== undefined && locations.length === 1 ? locations[0]?.path : undefined
  const summary = locations !== undefined && locations.length > 0 && locations[0] !== undefined
    ? relativize(locations[0].path, cwd) + (locations.length > 1 ? ` +${String(locations.length - 1)}` : '')
    : argsPreview(argsRaw)
  const inputText = envelope === undefined
    ? argsRaw
    : envelope.inputSummary === undefined
      ? argsRaw
      : JSON.stringify(envelope.inputSummary)
  const diffs: AcpToolDiffCard[] = []
  const outputLines: string[] = []
  let truncated = false
  if (envelope !== undefined) {
    for (const item of envelope.content) {
      if ('truncated' in item && item.truncated === true) truncated = true
      switch (item.type) {
        case 'diff':
          diffs.push({ path: item.path, newText: item.patch, truncated: item.truncated === true })
          break
        case 'text':
        case 'terminal':
          outputLines.push(item.text)
          break
        case 'image':
          outputLines.push(imageFactLine(item))
          break
        case 'resource':
          outputLines.push(resourceFactLine(item))
          break
      }
    }
  }
  const outputText = envelope !== undefined
    ? (outputLines.length === 0 ? undefined : outputLines.join('\n'))
    : resultText
  const expandable = inputText !== undefined || outputText !== undefined || diffs.length > 0
  return {
    state,
    title: envelope?.title,
    summary,
    filePath,
    inputText,
    diffs,
    outputText,
    truncated,
    expandable,
    agentExtension: envelope?.agentExtension,
  }
}
