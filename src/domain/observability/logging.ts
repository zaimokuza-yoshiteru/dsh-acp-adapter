/**
 * 结构化日志包装： cordis `ctx.logger` 承载不变，本模块只在文本行尾部
 * 追加**固定词表**的结构化字段后缀，让 ACP 相关日志可以按字段 grep/对账。
 *
 * 字段词表（{@link AcpLogFields}，**封闭集合**，新增字段需同步本注释与
 * test/observability.spec.ts 的钉版）：
 * - `dshSessionId`：宿主 dsh 会话 id（sidecar 文件键同名，可跨通道对账）
 * - `acpProvider`：LLM 路由 id（`acp-<id>`）
 * - `acpSessionId`：ACP 侧会话 id（懒启动后才存在）
 * - `runId`：一次子进程运行的标识（`pid:<n>`；spawn 失败前缺失）
 * - `operation`：操作名（小词表，如 `initialize`/`prompt`/`cancel`/`resume`/
 *   `permission`/`registry-sync`/`binding-guard`/`audit`/`teardown`…）
 * - `durationMs`：耗时（毫秒，整数）
 * - `result`：结果码（`ok` / ACP 错误 kind / 稳定分流词，如 `load-failed`）
 *
 * 纪律：
 * - **适用字段缺失时省略**，绝不填空串/占位符。
 * - message 与字段值都**不得携带** prompt 内容、凭据、完整工具参数、env 值；
 *   字段值只允许 id/操作名/结果码/耗时这类低敏事实。本模块对值做单行净化
 *   （折行压成空格），不做内容审查——内容纪律由各调用点遵守（钉版测试见
 *   test/observability.spec.ts 与 acp-client.spec.ts 的 stderr 脱敏套件）。
 * - 各模块的 message 维持既有 `dsh-acp: ` 前缀习惯，本包装不再加前缀。
 *
 * 零 import 叶子（domain/observability 层；分层守卫见 test/contracts/architecture.spec.ts）。
 * @module @zaimokuza/dsh-acp-adapter/domain/observability/logging
 */

/** 结构化日志字段（封闭词表，见模块头注释）；全部可选，缺失即省略。 */
export interface AcpLogFields {
  readonly dshSessionId?: string
  readonly acpProvider?: string
  readonly acpSessionId?: string
  /** 一次子进程运行的标识（`pid:<n>`）。 */
  readonly runId?: string
  readonly operation?: string
  readonly durationMs?: number
  /** 结果码（`ok` / ACP 错误 kind / 稳定分流词）。 */
  readonly result?: string
}

/** 字段渲染顺序（钉版：grep/对账的稳定形态）。 */
const FIELD_ORDER = [
  'dshSessionId',
  'acpProvider',
  'acpSessionId',
  'runId',
  'operation',
  'durationMs',
  'result',
] as const

/** 字段值单行净化：折行/制表压成空格，保持一条日志一行。 */
function sanitizeFieldValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim()
}

/**
 * 把字段格式化成稳定序后缀：` [dshSessionId=… operation=…]`；无字段（或全部
 * 缺失）时为空串。durationMs 取整渲染。
 */
export function formatAcpLogFields(fields: AcpLogFields | undefined): string {
  if (fields === undefined) return ''
  const parts: string[] = []
  for (const key of FIELD_ORDER) {
    const value = fields[key]
    if (value === undefined) continue
    parts.push(`${key}=${typeof value === 'number' ? String(Math.round(value)) : sanitizeFieldValue(value)}`)
  }
  return parts.length === 0 ? '' : ` [${parts.join(' ')}]`
}

/**
 * 日志 sink 的最小面：cordis `Logger` 天然满足（`debug` 可选——缺席时 debug
 * 降级到 info，不丢行）。
 */
export interface AcpLogSink {
  debug?(message: string): void
  info(message: string): void
  warn(message: string): void
  /** 兼容 cordis Logger.error 的非 string 直传（Error 对象原样透传，不拼字段）。 */
  error(message: unknown): void
}

/** 结构化 logger：各级别在文本行尾部追加字段后缀（{@link formatAcpLogFields}）。 */
export interface AcpLogger {
  debug(message: string, fields?: AcpLogFields): void
  info(message: string, fields?: AcpLogFields): void
  warn(message: string, fields?: AcpLogFields): void
  /** 非 string 值（Error 对象）原样透传 sink——stack 不因包装而丢。 */
  error(message: unknown, fields?: AcpLogFields): void
}

/**
 * 创建结构化 logger。`base` 是实例级固定字段（如 agent 会话的
 * dshSessionId/acpProvider），逐次调用的字段与之合并（逐次优先）。
 */
export function createAcpLogger(sink: AcpLogSink, base: AcpLogFields = {}): AcpLogger {
  const merged = (fields: AcpLogFields | undefined): AcpLogFields => ({ ...base, ...fields })
  const debug = sink.debug ?? ((message: string): void => { sink.info(message) })
  return {
    debug: (message, fields) => { debug.call(sink, `${message}${formatAcpLogFields(merged(fields))}`) },
    info: (message, fields) => { sink.info(`${message}${formatAcpLogFields(merged(fields))}`) },
    warn: (message, fields) => { sink.warn(`${message}${formatAcpLogFields(merged(fields))}`) },
    error: (message, fields) => {
      sink.error(typeof message === 'string' ? `${message}${formatAcpLogFields(merged(fields))}` : message)
    },
  }
}
