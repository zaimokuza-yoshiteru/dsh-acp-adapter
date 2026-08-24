// observability.spec.ts — 随附测试：domain/observability 两模块
//（src/domain/observability/logging.ts 与 metrics.ts）。
//
// 覆盖：formatAcpLogFields（固定序后缀/缺失省略/durationMs 取整/单行净化/无字段
// 空串）；createAcpLogger（base 合并、逐次覆盖、debug 缺席降级 info、error 非
// string 透传不拼字段）；AcpMetricsRegistry（increment/observe/标签键序无关
// 归并/快照确定性排序/startedAt 注入时钟/onEvent 抛错吞掉）；narrowAcpTelemetry
// （非对象/无 record/结构满足）；createAcpMetricReporter 三路（在场上报、缺席
// 降级 debug 结构化行、抛错 warn 一次后保持降级且不抛出）。

import { describe, expect, it } from 'vitest'
import {
  createAcpLogger,
  formatAcpLogFields,
  type AcpLogSink,
} from '../../../src/domain/observability/logging.ts'
import {
  ACP_METRIC,
  AcpMetricsRegistry,
  createAcpMetricReporter,
  narrowAcpTelemetry,
  type AcpMetricEvent,
} from '../../../src/domain/observability/metrics.ts'

/** 收集型 sink：各级别行按 level 分桶。 */
function collectingSink(): { sink: AcpLogSink; lines: { debug: string[]; info: string[]; warn: string[]; error: unknown[] } } {
  const lines = { debug: [] as string[], info: [] as string[], warn: [] as string[], error: [] as unknown[] }
  return {
    lines,
    sink: {
      debug: (message) => { lines.debug.push(message) },
      info: (message) => { lines.info.push(message) },
      warn: (message) => { lines.warn.push(message) },
      error: (message) => { lines.error.push(message) },
    },
  }
}

describe('formatAcpLogFields', () => {
  it('按固定序渲染后缀，缺失字段省略', () => {
    expect(formatAcpLogFields({
      result: 'ok',
      dshSessionId: 's-1',
      operation: 'prompt',
      acpProvider: 'acp-devin',
    })).toBe(' [dshSessionId=s-1 acpProvider=acp-devin operation=prompt result=ok]')
  })

  it('durationMs 取整渲染', () => {
    expect(formatAcpLogFields({ durationMs: 12.6 })).toBe(' [durationMs=13]')
  })

  it('值单行净化：折行/制表压成空格', () => {
    expect(formatAcpLogFields({ result: 'bad\nvalue\there' })).toBe(' [result=bad value here]')
  })

  it('undefined 与全空字段都渲染为空串', () => {
    expect(formatAcpLogFields(undefined)).toBe('')
    expect(formatAcpLogFields({})).toBe('')
  })
})

describe('createAcpLogger', () => {
  it('base 字段并入每行，逐次调用字段覆盖 base', () => {
    const { sink, lines } = collectingSink()
    const log = createAcpLogger(sink, { dshSessionId: 's-1', acpProvider: 'acp-devin' })
    log.info('dsh-acp: hello')
    log.info('dsh-acp: again', { acpProvider: 'acp-other', operation: 'prompt' })
    expect(lines.info).toEqual([
      'dsh-acp: hello [dshSessionId=s-1 acpProvider=acp-devin]',
      'dsh-acp: again [dshSessionId=s-1 acpProvider=acp-other operation=prompt]',
    ])
  })

  it('sink 无 debug 时 debug 降级到 info（不丢行）', () => {
    const lines: string[] = []
    const log = createAcpLogger({ info: (m) => { lines.push(m) }, warn: () => {}, error: () => {} })
    log.debug('dsh-acp: dbg', { operation: 'metric' })
    expect(lines).toEqual(['dsh-acp: dbg [operation=metric]'])
  })

  it('error 对非 string 值原样透传（不拼字段、不丢 stack）', () => {
    const { sink, lines } = collectingSink()
    const log = createAcpLogger(sink, { dshSessionId: 's-1' })
    const boom = new Error('boom')
    log.error(boom, { operation: 'prompt' })
    log.error('dsh-acp: plain', { operation: 'prompt' })
    expect(lines.error[0]).toBe(boom)
    expect(lines.error[1]).toBe('dsh-acp: plain [dshSessionId=s-1 operation=prompt]')
  })
})

describe('AcpMetricsRegistry', () => {
  it('increment 按 name+标签分组计数，标签键序无关', () => {
    const registry = new AcpMetricsRegistry({ now: () => 1000 })
    registry.increment(ACP_METRIC.cancel, { cause: 'user', provider: 'acp-devin' })
    registry.increment(ACP_METRIC.cancel, { provider: 'acp-devin', cause: 'user' })
    registry.increment(ACP_METRIC.cancel)
    const snapshot = registry.snapshot()
    expect(snapshot.startedAt).toBe(1000)
    expect(snapshot.counters).toEqual([
      { name: 'acp.cancel', labels: {}, value: 1 },
      { name: 'acp.cancel', labels: { cause: 'user', provider: 'acp-devin' }, value: 2 },
    ])
  })

  it('observe 聚合 count/total/min/max，快照按 name 与标签串排序', () => {
    const registry = new AcpMetricsRegistry({ now: () => 1000 })
    registry.observe(ACP_METRIC.prompt, 30, { result: 'end_turn' })
    registry.observe(ACP_METRIC.prompt, 10, { result: 'end_turn' })
    registry.observe(ACP_METRIC.initialize, 5, { result: 'ok' })
    expect(registry.snapshot().timers).toEqual([
      { name: 'acp.initialize', labels: { result: 'ok' }, count: 1, totalMs: 5, minMs: 5, maxMs: 5 },
      { name: 'acp.prompt', labels: { result: 'end_turn' }, count: 2, totalMs: 40, minMs: 10, maxMs: 30 },
    ])
  })

  it('onEvent 钩子收到每次计数/观察；钩子抛错被吞掉', () => {
    const events: AcpMetricEvent[] = []
    const registry = new AcpMetricsRegistry({
      now: () => 1000,
      onEvent: (event) => {
        events.push(event)
        if (events.length === 2) throw new Error('hook boom')
      },
    })
    registry.increment(ACP_METRIC.crash, { provider: 'acp-devin' })
    registry.observe(ACP_METRIC.probe, 7, { provider: 'acp-devin', result: 'ok' })
    registry.increment(ACP_METRIC.crash, { provider: 'acp-devin' })
    expect(events).toEqual([
      { name: 'acp.crash', kind: 'count', value: 1, labels: { provider: 'acp-devin' } },
      { name: 'acp.probe', kind: 'duration', value: 7, labels: { provider: 'acp-devin', result: 'ok' } },
      { name: 'acp.crash', kind: 'count', value: 1, labels: { provider: 'acp-devin' } },
    ])
    expect(registry.snapshot().counters).toEqual([
      { name: 'acp.crash', labels: { provider: 'acp-devin' }, value: 2 },
    ])
  })
})

describe('narrowAcpTelemetry', () => {
  it('非对象/无 record 函数的候选一律不采信', () => {
    expect(narrowAcpTelemetry(undefined)).toBeUndefined()
    expect(narrowAcpTelemetry(null)).toBeUndefined()
    expect(narrowAcpTelemetry('telemetry')).toBeUndefined()
    expect(narrowAcpTelemetry({ record: 42 })).toBeUndefined()
    expect(narrowAcpTelemetry({})).toBeUndefined()
  })

  it('带函数 record 的对象被采信', () => {
    const candidate = { record: (_event: AcpMetricEvent): void => {} }
    expect(narrowAcpTelemetry(candidate)).toBe(candidate)
  })
})

describe('createAcpMetricReporter', () => {
  const event: AcpMetricEvent = { name: 'acp.prompt', kind: 'duration', value: 12.4, labels: { result: 'ok' } }

  it('telemetry 在场：事件上报 record，不落日志', () => {
    const recorded: AcpMetricEvent[] = []
    const { sink, lines } = collectingSink()
    const report = createAcpMetricReporter({ telemetry: { record: (e: AcpMetricEvent) => { recorded.push(e) } }, log: createAcpLogger(sink) })
    report(event)
    expect(recorded).toEqual([event])
    expect(lines.debug).toEqual([])
    expect(lines.warn).toEqual([])
  })

  it('telemetry 缺席：降级为 debug 结构化日志行', () => {
    const { sink, lines } = collectingSink()
    const report = createAcpMetricReporter({ log: createAcpLogger(sink) })
    report(event)
    report({ name: 'acp.cancel', kind: 'count', value: 1 })
    expect(lines.debug).toEqual([
      'dsh-acp: metric acp.prompt 12ms (result=ok) [operation=metric result=acp.prompt]',
      'dsh-acp: metric acp.cancel +1 [operation=metric result=acp.cancel]',
    ])
  })

  it('telemetry 抛错：warn 一次后保持日志降级，reporter 自身不抛出', () => {
    const { sink, lines } = collectingSink()
    const report = createAcpMetricReporter({
      telemetry: {
        record: (): void => { throw new Error('telemetry down') },
      },
      log: createAcpLogger(sink),
    })
    expect(() => {
      report(event)
      report(event)
    }).not.toThrow()
    expect(lines.warn).toHaveLength(1)
    expect(lines.warn[0]).toContain('telemetry down')
    expect(lines.warn[0]).toContain('[operation=metric result=telemetry-error]')
    expect(lines.debug).toEqual([
      'dsh-acp: metric acp.prompt 12ms (result=ok) [operation=metric result=acp.prompt]',
      'dsh-acp: metric acp.prompt 12ms (result=ok) [operation=metric result=acp.prompt]',
    ])
  })
})
