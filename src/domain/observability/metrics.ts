/**
 * 最小内存指标面：纯内存计数器 + 延迟聚合 + 快照导出，零依赖、零 I/O。
 *
 * 指标词表（{@link ACP_METRIC}，封闭集合——ACP 没有的数据不造：不伪造
 * token/cache/retry 统计）：
 * - `acp.probe`（timer，labels: provider, result）——probe 延迟与成败
 *   （result = `ok` / AcpErrorKind）
 * - `acp.initialize`（timer，labels: result）——会话懒启动的握手
 * - `acp.prompt`（timer，labels: result）——一轮 session/prompt
 *   （result = stopReason / `cancelled` / 错误 kind）
 * - `acp.cancel`（counter，labels: cause）——本地 cancel/dispose 触发的
 *   session/cancel 发出
 * - `acp.crash`（counter，labels: provider）——子进程意外退出被分类为 crash
 * - `acp.resume.degraded`（counter，labels: cause）——恢复降级
 *   （capability-missing / id-not-found / load-failed / binding-in-use）
 * - `acp.approval.requested` / `acp.approval.decided`（counter；decided 带
 *   labels: outcome=selected/cancelled）——审批桥
 * - `acp.orphan_reap.failure`（counter）——拆除梯子未能拿到整树退出证明
 *   （close 抛错）的次数；宿主服务 dispose 的兜底强杀不算在内
 *
 * 快照（{@link AcpMetricsRegistry.snapshot}）供 health 端点/测试导出；标签值
 * 只允许低基词汇（result/cause/provider），绝不含 id/路径/内容。
 *
 * telemetry 降级：{@link createAcpMetricReporter} 把每次计数/观察转成
 * 事件上报宿主 telemetry 服务（`ctx.get('telemetry')` 探测 +
 * {@link narrowAcpTelemetry} 结构窄化——宿主未默认装配该服务，探测是面向未来
 * 宿主的可选钩子）；服务缺席时降级为结构化日志（debug 级），服务抛错只 warn 一次，
 * ACP 主链路永不因遥测失败。
 *
 * 零 import 叶子（domain/observability 层；同层 logging.ts 仅作类型/格式复用）。
 * @module @zaimokuza/dsh-acp-adapter/domain/observability/metrics
 */

import type { AcpLogger } from './logging.ts'

/** 指标名封闭词表（见模块头注释）。 */
export const ACP_METRIC = {
  probe: 'acp.probe',
  initialize: 'acp.initialize',
  prompt: 'acp.prompt',
  cancel: 'acp.cancel',
  crash: 'acp.crash',
  resumeDegraded: 'acp.resume.degraded',
  approvalRequested: 'acp.approval.requested',
  approvalDecided: 'acp.approval.decided',
  orphanReapFailure: 'acp.orphan_reap.failure',
} as const

export type AcpMetricName = (typeof ACP_METRIC)[keyof typeof ACP_METRIC]

/** 指标标签（低基词汇；值不得含 id/路径/内容）。 */
export type AcpMetricLabels = Readonly<Record<string, string>>

/** 埋点消费面（各模块的注入类型）：计数 + 延迟观察。 */
export interface AcpMetricsLike {
  /** 计数器 +1。 */
  increment(name: AcpMetricName, labels?: AcpMetricLabels): void
  /** 延迟观察（毫秒）：计入同名 timer 的 count/total/min/max。 */
  observe(name: AcpMetricName, durationMs: number, labels?: AcpMetricLabels): void
}

/** 一次计数/观察的遥测事件（reporter 与 registry 的 onEvent 钩子共用形状）。 */
export interface AcpMetricEvent {
  readonly name: AcpMetricName
  readonly kind: 'count' | 'duration'
  /** count 事件恒为 1；duration 事件为耗时毫秒。 */
  readonly value: number
  readonly labels?: AcpMetricLabels
}

/** 快照的一行计数器。 */
export interface AcpCounterSample {
  readonly name: AcpMetricName
  readonly labels: AcpMetricLabels
  readonly value: number
}

/** 快照的一行延迟聚合。 */
export interface AcpTimerSample {
  readonly name: AcpMetricName
  readonly labels: AcpMetricLabels
  readonly count: number
  readonly totalMs: number
  readonly minMs: number
  readonly maxMs: number
}

/** 内存指标快照（health 端点/测试导出面；确定性排序：name → 规范化标签串）。 */
export interface AcpMetricsSnapshot {
  /** registry 创建时刻（epoch 毫秒；uptime 由消费方算）。 */
  readonly startedAt: number
  readonly counters: readonly AcpCounterSample[]
  readonly timers: readonly AcpTimerSample[]
}

/** 标签 → 规范化串（键序无关；空标签集 = ''）。 */
function canonicalLabels(labels: AcpMetricLabels | undefined): string {
  if (labels === undefined) return ''
  return Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

/** 规范化串 → 标签对象（快照导出用）。 */
function parseLabels(key: string): AcpMetricLabels {
  if (key === '') return {}
  const out: Record<string, string> = {}
  for (const part of key.split(',')) {
    const eq = part.indexOf('=')
    out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}

/** {@link AcpMetricsRegistry} 构造项。 */
export interface AcpMetricsOptions {
  /** 时钟（默认 `Date.now`；测试注入确定性）。 */
  readonly now?: () => number
  /** 每次计数/观察的钩子（telemetry reporter 的接线点）；抛错被吞掉并忽略——遥测不得炸主链路。 */
  readonly onEvent?: (event: AcpMetricEvent) => void
}

/**
 * 纯内存指标 registry：计数器（name+标签分组）与 timer（count/total/min/max）
 * 双族；`observe` 同时向 timer 记一笔（不另起计数器——timer.count 即次数）。
 */
export class AcpMetricsRegistry implements AcpMetricsLike {
  private readonly now: () => number
  private readonly onEvent: ((event: AcpMetricEvent) => void) | undefined
  private readonly startedAt: number
  private readonly counters = new Map<string, number>()
  private readonly timers = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>()

  constructor(options: AcpMetricsOptions = {}) {
    this.now = options.now ?? Date.now
    this.onEvent = options.onEvent
    this.startedAt = this.now()
  }

  increment(name: AcpMetricName, labels?: AcpMetricLabels): void {
    const key = `${name}\n${canonicalLabels(labels)}`
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)
    this.emit({ name, kind: 'count', value: 1, ...(labels === undefined ? {} : { labels }) })
  }

  observe(name: AcpMetricName, durationMs: number, labels?: AcpMetricLabels): void {
    const key = `${name}\n${canonicalLabels(labels)}`
    const entry = this.timers.get(key) ?? { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0 }
    entry.count += 1
    entry.totalMs += durationMs
    entry.minMs = Math.min(entry.minMs, durationMs)
    entry.maxMs = Math.max(entry.maxMs, durationMs)
    this.timers.set(key, entry)
    this.emit({ name, kind: 'duration', value: durationMs, ...(labels === undefined ? {} : { labels }) })
  }

  /** 快照导出（确定性排序；标签按规范化串解析回对象）。 */
  snapshot(): AcpMetricsSnapshot {
    const sortKeys = (keys: Iterable<string>): string[] => [...keys].sort()
    return {
      startedAt: this.startedAt,
      counters: sortKeys(this.counters.keys()).map((key) => {
        const splitAt = key.indexOf('\n')
        return {
          name: key.slice(0, splitAt) as AcpMetricName,
          labels: parseLabels(key.slice(splitAt + 1)),
          value: this.counters.get(key) ?? 0,
        }
      }),
      timers: sortKeys(this.timers.keys()).map((key) => {
        const splitAt = key.indexOf('\n')
        const entry = this.timers.get(key) ?? { count: 0, totalMs: 0, minMs: 0, maxMs: 0 }
        return {
          name: key.slice(0, splitAt) as AcpMetricName,
          labels: parseLabels(key.slice(splitAt + 1)),
          ...entry,
        }
      }),
    }
  }

  private emit(event: AcpMetricEvent): void {
    if (this.onEvent === undefined) return
    try {
      this.onEvent(event)
    } catch {
 // 遥测钩子不得炸主链路（纪律）
    }
  }
}

// ---------- telemetry 降级 ----------

/**
 * 宿主 telemetry 服务的结构窄化面（`ctx.get('telemetry')` 探测）：本包消费的
 * 唯一方法是 `record(event)`。宿主未默认装配 telemetry 服务——本接口是面向
 * 未来宿主的可选钩子；真实服务只要结构满足即可接入，缺席时
 * {@link createAcpMetricReporter} 降级为结构化日志。
 */
export interface AcpTelemetrySinkLike {
  record(event: AcpMetricEvent): void
}

/** 结构窄化：候选是对象且带函数 `record` 才采信（其余一律 undefined → 日志降级）。 */
export function narrowAcpTelemetry(candidate: unknown): AcpTelemetrySinkLike | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const face = candidate as { record?: unknown }
  return typeof face.record === 'function' ? (candidate as AcpTelemetrySinkLike) : undefined
}

/**
 * 指标事件 reporter：telemetry 在场 → 上报（抛错 warn 一次后保持降级，不炸
 * 主链路）；缺席 → 结构化 debug 日志（`metric <name> <kind>=<value> [labels]`，
 * operation=metric 字段便于 grep）。
 */
export function createAcpMetricReporter(deps: {
  readonly telemetry?: unknown
  readonly log: AcpLogger
}): (event: AcpMetricEvent) => void {
  const telemetry = narrowAcpTelemetry(deps.telemetry)
  let telemetryBroken = false
  return (event) => {
    if (telemetry !== undefined && !telemetryBroken) {
      try {
        telemetry.record(event)
        return
      } catch (error: unknown) {
        telemetryBroken = true
        deps.log.warn(
          `dsh-acp: telemetry service threw while recording metric "${event.name}"; falling back to structured logs `
          + `(${error instanceof Error ? error.message : String(error)})`,
          { operation: 'metric', result: 'telemetry-error' },
        )
      }
    }
    const labels = canonicalLabels(event.labels)
    const value = event.kind === 'duration' ? `${String(Math.round(event.value))}ms` : `+${String(event.value)}`
    deps.log.debug(
      `dsh-acp: metric ${event.name} ${value}${labels === '' ? '' : ` (${labels})`}`,
      { operation: 'metric', result: event.name },
    )
  }
}
