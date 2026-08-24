/**
 * Bounded option snapshot codec used by sidecar cold-start presentation.
 *
 * This module owns normalization and validation only; SQLite lifecycle remains
 * in sidecar.ts. The wire shape and limits are unchanged.
 */
/// <reference types="node" />

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------- 冷启动 last-known option 快照（option_snapshots 表） ----------

/** 快照的选项数硬上限（超出从尾部丢弃，model 类选项保底保留）。 */
export const ACP_SNAPSHOT_OPTION_LIMIT = 32 as const
/** 快照单个字符串字段（id/name/category/当前值/可选值）的字符数硬上限（超出截断）。 */
export const ACP_SNAPSHOT_FIELD_MAX = 128 as const
/** 快照单选项的可选值条数硬上限（超出截断）。 */
export const ACP_SNAPSHOT_VALUES_LIMIT = 64 as const
/** 快照整体序列化字节数硬上限（超出先丢尾部非 model 类选项，再剥 values 列表）。 */
export const ACP_SNAPSHOT_TOTAL_BYTES = 16384 as const

/**
 * 标准化后的单个 config option 快照条目：只含展示与 allowed-values
 * 参考交集所需的最小事实——`_meta`、description、任意大对象一律不持久化。
 * `value` 为当前值（select=string 值 id / boolean=原生 boolean）；`values`
 * 为 select 的拍平可选值 id 列表（boolean 归 null）。
 */
export interface AcpOptionsSnapshotOption {
  readonly id: string
  readonly category: string | null
  readonly name: string
  readonly value: string | boolean
  readonly values: readonly string[] | null
}

/**
 * 按 DSH session 持久化的 last-known config option 快照（`option_snapshots`
 * 表 payload）。`fingerprint` 是运行时指纹（launch fingerprint + agentInfo +
 * protocolVersion 的 canonical 哈希）：恢复后指纹变化 → 旧快照只作诊断，
 * 不作能力结论。本快照是冷启动只读展示面——绝不授权热切换（coordinator
 * 预检要求活体可写 option）。
 */
export interface AcpOptionsSnapshotRecord {
  readonly options: readonly AcpOptionsSnapshotOption[]
  readonly currentModeId: string | null
  /** 刷新时间（epoch 毫秒）。 */
  readonly updatedAt: number
  readonly fingerprint: string
}

/** 截断到 {@link ACP_SNAPSHOT_FIELD_MAX}（快照字段的统一截断点）。 */
function snapshotField(value: string): string {
  return value.length > ACP_SNAPSHOT_FIELD_MAX ? value.slice(0, ACP_SNAPSHOT_FIELD_MAX) : value
}

/** 标准化单条目；类型/形态不合格 → undefined（跳过该项，协议 SHOULD-ignore 同款口径）。 */
function snapshotOptionOf(option: SessionConfigOption): AcpOptionsSnapshotOption | undefined {
  if (typeof option.id !== 'string' || option.id === '') return undefined
  if (typeof option.name !== 'string') return undefined
  const base = {
    id: snapshotField(option.id),
    category: typeof option.category === 'string' && option.category !== '' ? snapshotField(option.category) : null,
    name: snapshotField(option.name),
  }
  if (option.type === 'select') {
    if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) return undefined
    const values: string[] = []
    for (const entry of option.options) {
      const nested = 'options' in entry ? entry.options : [entry]
      for (const item of nested) {
        if (typeof item.value !== 'string') continue
        if (values.length >= ACP_SNAPSHOT_VALUES_LIMIT) break
        values.push(snapshotField(item.value))
      }
      if (values.length >= ACP_SNAPSHOT_VALUES_LIMIT) break
    }
    return { ...base, value: snapshotField(option.currentValue), values }
  }
  if (option.type === 'boolean') {
    if (typeof option.currentValue !== 'boolean') return undefined
    return { ...base, value: option.currentValue, values: null }
  }
  return undefined
}

/** model 类选项判定（category 优先、约定 id 兜底——与 agent.ts modelOfConfigOptions 同口径）。 */
function isModelSnapshotOption(option: AcpOptionsSnapshotOption): boolean {
  return option.category === 'model' || option.id === 'model'
}

/**
 * 活体权威快照 → 标准化有界快照（的唯一构造点）。未知 type 跳过；
 * 超 {@link ACP_SNAPSHOT_TOTAL_BYTES} 时先丢尾部非 model 类选项（model 类是
 * Current filter 参考交集的唯一消费者，保底），再剥剩余选项的 values 列表
 * （当前值保留——只读展示仍成立）。
 */
export function acpOptionsSnapshotOf(
  configOptions: readonly SessionConfigOption[] | undefined,
  currentModeId: string | undefined,
  fingerprint: string,
  updatedAt: number,
): AcpOptionsSnapshotRecord {
  const options: AcpOptionsSnapshotOption[] = []
  for (const option of configOptions ?? []) {
    if (options.length >= ACP_SNAPSHOT_OPTION_LIMIT) break
    const narrowed = snapshotOptionOf(option)
    if (narrowed !== undefined) options.push(narrowed)
  }
  const build = (list: readonly AcpOptionsSnapshotOption[]): AcpOptionsSnapshotRecord => ({
    options: list,
    currentModeId: typeof currentModeId === 'string' ? snapshotField(currentModeId) : null,
    updatedAt,
    fingerprint,
  })
  let record = build(options)
  while (JSON.stringify(record).length > ACP_SNAPSHOT_TOTAL_BYTES && record.options.length > 1) {
    const list = [...record.options]
    // 从尾部丢非 model 类选项；都在保底集合里则剥尾部选项的 values 列表
    const dropIndex = list.reduce(
      (found, candidate, index) => (isModelSnapshotOption(candidate) ? found : index),
      -1,
    )
    if (dropIndex >= 0) list.splice(dropIndex, 1)
    else {
      const tail = list[list.length - 1]
      if (tail === undefined || tail.values === null) break
      list[list.length - 1] = { ...tail, values: null }
    }
    record = build(list)
  }
  return record
}

/** snapshot 行的语义校验 + 窄化（读路径；败者 undefined + warn——按「无快照」处理）。 */
export function toOptionsSnapshotRecord(raw: unknown): AcpOptionsSnapshotRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  if (!Array.isArray(raw.options)) return undefined
  if (raw.options.length > ACP_SNAPSHOT_OPTION_LIMIT) return undefined
  const options: AcpOptionsSnapshotOption[] = []
  for (const entry of raw.options as unknown[]) {
    if (!isPlainObject(entry)) return undefined
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > ACP_SNAPSHOT_FIELD_MAX) return undefined
    if (typeof entry.name !== 'string' || entry.name.length > ACP_SNAPSHOT_FIELD_MAX) return undefined
    if (entry.category !== null && (typeof entry.category !== 'string' || entry.category.length > ACP_SNAPSHOT_FIELD_MAX)) return undefined
    if (typeof entry.value !== 'string' && typeof entry.value !== 'boolean') return undefined
    if (entry.values !== null && (!Array.isArray(entry.values) || entry.values.length > ACP_SNAPSHOT_VALUES_LIMIT || !(entry.values as unknown[]).every((v) => typeof v === 'string'))) return undefined
    options.push({
      id: entry.id,
      category: entry.category as string | null,
      name: entry.name,
      value: entry.value as string | boolean,
      values: entry.values as readonly string[] | null,
    })
  }
  if (raw.currentModeId !== null && typeof raw.currentModeId !== 'string') return undefined
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) return undefined
  return {
    options,
    currentModeId: raw.currentModeId as string | null,
    updatedAt: raw.updatedAt,
    fingerprint: raw.fingerprint,
  }
}
