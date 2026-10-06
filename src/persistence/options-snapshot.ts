/**
 * Bounded option snapshot codec used by sidecar cold-start presentation.
 *
 * This module owns normalization and validation only; SQLite lifecycle remains
 * in sidecar.ts. Snapshot fields use independent display bounds; serialized
 * length remains protected by the existing budget below.
 */
/// <reference types="node" />

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../contract/config-options.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------- 冷启动 last-known option 快照（option_snapshots 表） ----------

/** 快照的选项数硬上限（超出从尾部丢弃，model 类选项保底保留）。 */
export const ACP_SNAPSHOT_OPTION_LIMIT = 32 as const
/** 展示字段的字符数硬上限（超出截断）。 */
export const ACP_SNAPSHOT_FIELD_MAX = 128 as const
/** Mode descriptions are explanatory UI text, separate from compact option labels. */
export const ACP_SNAPSHOT_MODE_DESCRIPTION_MAX = 1024 as const
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
 * 不作能力结论。快照既供冷启动只读展示，也供同一 binding 建立时恢复仍由
 * 活体 Agent 广告且值域兼容的非模型选项；它本身绝不授权热切换（coordinator
 * 预检仍要求活体可写 option）。
 */
export interface AcpOptionsSnapshotRecord {
  readonly options: readonly AcpOptionsSnapshotOption[]
  readonly currentModeId: string | null
  /** 刷新时间（epoch 毫秒）。 */
  readonly updatedAt: number
  readonly fingerprint: string
  /** Last ACP context occupancy; never mapped to DSH TokenUsage. */
  readonly contextUsage?: {
    readonly used: number
    readonly size: number
    readonly cost?: { readonly amount: number; readonly currency: string } | null
  } | null
  /** Complete bounded legacy mode state, when advertised by the Agent. */
  readonly modes?: {
    readonly currentModeId: string
    readonly availableModes: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string | null
    }[]
  } | null
}

/** 截断到 {@link ACP_SNAPSHOT_FIELD_MAX}（快照字段的统一截断点）。 */
function snapshotField(value: string): string {
  return value.length > ACP_SNAPSHOT_FIELD_MAX ? value.slice(0, ACP_SNAPSHOT_FIELD_MAX) : value
}

/** 标准化单条目；类型/形态不合格 → undefined（跳过该项，协议 SHOULD-ignore 同款口径）。 */
function snapshotOptionOf(option: SessionConfigOption): AcpOptionsSnapshotOption | undefined {
  if (typeof option.id !== 'string' || option.id === '' || option.id.length > ACP_CONFIG_IDENTIFIER_MAX)
    return undefined
  if (typeof option.name !== 'string') return undefined
  if (option.category != null && option.category.length > ACP_CONFIG_IDENTIFIER_MAX) return undefined
  const base = {
    id: option.id,
    category: typeof option.category === 'string' && option.category !== '' ? option.category : null,
    name: snapshotField(option.name),
  }
  if (option.type === 'select') {
    if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) return undefined
    const values: string[] = []
    for (const entry of option.options) {
      const nested = 'options' in entry ? entry.options : [entry]
      for (const item of nested) {
        if (typeof item.value !== 'string' || item.value.length > ACP_CONFIG_IDENTIFIER_MAX) continue
        if (values.length >= ACP_SNAPSHOT_VALUES_LIMIT) break
        values.push(item.value)
      }
      if (values.length >= ACP_SNAPSHOT_VALUES_LIMIT) break
    }
    if (option.currentValue.length > ACP_CONFIG_IDENTIFIER_MAX) return undefined
    return { ...base, value: option.currentValue, values }
  }
  if (option.type === 'boolean') {
    if (typeof option.currentValue !== 'boolean') return undefined
    return { ...base, value: option.currentValue, values: null }
  }
  return undefined
}

type SnapshotModes = NonNullable<AcpOptionsSnapshotRecord['modes']>
type SnapshotContextUsage = NonNullable<AcpOptionsSnapshotRecord['contextUsage']>

/** Keep stable mode ids intact; trim only display labels and descriptions. */
function snapshotModesOf(modes: SnapshotModes | null | undefined): SnapshotModes | null | undefined {
  if (modes == null) return modes
  if (typeof modes.currentModeId !== 'string' || !Array.isArray(modes.availableModes))
    throw new TypeError('ACP mode snapshot contains an invalid active mode or mode list')
  if (modes.currentModeId.length > ACP_CONFIG_IDENTIFIER_MAX) return undefined

  const availableModes: NonNullable<SnapshotModes['availableModes']>[number][] = []
  const seen = new Set<string>()
  for (const mode of modes.availableModes) {
    if (
      typeof mode.id !== 'string' ||
      mode.id.length === 0 ||
      mode.id.length > ACP_CONFIG_IDENTIFIER_MAX ||
      typeof mode.name !== 'string' ||
      (mode.description !== undefined && mode.description !== null && typeof mode.description !== 'string') ||
      seen.has(mode.id)
    )
      continue
    seen.add(mode.id)
    availableModes.push({
      id: mode.id,
      name: snapshotField(mode.name),
      ...(mode.description === undefined
        ? {}
        : {
            description:
              mode.description === null
                ? null
                : mode.description.length > ACP_SNAPSHOT_MODE_DESCRIPTION_MAX
                  ? mode.description.slice(0, ACP_SNAPSHOT_MODE_DESCRIPTION_MAX)
                  : mode.description,
          }),
    })
  }

  // Preserve the active mode in the bounded list even when the Agent advertises
  // more entries than this read-only snapshot can retain.
  let boundedModes = availableModes.slice(0, ACP_SNAPSHOT_OPTION_LIMIT)
  if (!boundedModes.some((mode) => mode.id === modes.currentModeId)) {
    const currentMode = availableModes.find((mode) => mode.id === modes.currentModeId)
    if (currentMode !== undefined) {
      if (boundedModes.length === ACP_SNAPSHOT_OPTION_LIMIT) boundedModes = boundedModes.slice(0, -1)
      boundedModes.push(currentMode)
    }
  }
  return { currentModeId: modes.currentModeId, availableModes: boundedModes }
}

/** Malformed optional usage telemetry must not prevent a terminal turn from settling. */
function snapshotContextUsageOf(
  usage: SnapshotContextUsage | null | undefined,
): SnapshotContextUsage | null | undefined {
  if (usage == null) return usage
  if (!Number.isFinite(usage.used) || !Number.isFinite(usage.size) || usage.used < 0 || usage.size < 0) return undefined
  const cost = usage.cost
  const safeCost =
    cost === undefined ||
    cost === null ||
    !Number.isFinite(cost.amount) ||
    typeof cost.currency !== 'string' ||
    cost.currency.length > ACP_SNAPSHOT_FIELD_MAX
      ? null
      : { amount: cost.amount, currency: cost.currency }
  return { used: usage.used, size: usage.size, cost: safeCost }
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
  extras?: Pick<AcpOptionsSnapshotRecord, 'contextUsage' | 'modes'>,
): AcpOptionsSnapshotRecord {
  const options: AcpOptionsSnapshotOption[] = []
  for (const option of configOptions ?? []) {
    if (options.length >= ACP_SNAPSHOT_OPTION_LIMIT) break
    const narrowed = snapshotOptionOf(option)
    if (narrowed !== undefined) options.push(narrowed)
  }
  const normalizedModes = snapshotModesOf(extras?.modes)
  const normalizedUsage = snapshotContextUsageOf(extras?.contextUsage)
  const stableCurrentModeId =
    typeof currentModeId === 'string' && currentModeId.length <= ACP_CONFIG_IDENTIFIER_MAX ? currentModeId : null
  const build = (
    list: readonly AcpOptionsSnapshotOption[],
    modes: SnapshotModes | null | undefined,
    contextUsage: SnapshotContextUsage | null | undefined,
  ): AcpOptionsSnapshotRecord => ({
    options: list,
    currentModeId: stableCurrentModeId,
    updatedAt,
    fingerprint,
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(modes === undefined ? {} : { modes }),
  })
  let record = build(options, normalizedModes, normalizedUsage)
  while (JSON.stringify(record).length > ACP_SNAPSHOT_TOTAL_BYTES) {
    const list = [...record.options]
    // Drop non-model options first; the model option remains the primary control snapshot.
    const dropIndex = list.reduce((found, candidate, index) => (isModelSnapshotOption(candidate) ? found : index), -1)
    if (dropIndex >= 0) {
      list.splice(dropIndex, 1)
      record = build(list, record.modes, record.contextUsage)
      continue
    }
    const valueIndex = list.findLastIndex((option) => option.values !== null && option.values.length > 0)
    if (valueIndex >= 0) {
      list[valueIndex] = { ...list[valueIndex]!, values: null }
      record = build(list, record.modes, record.contextUsage)
      continue
    }
    const modes = record.modes
    if (modes !== undefined && modes !== null && modes.availableModes.length > 0) {
      const nonCurrentIndex = modes.availableModes.findLastIndex((mode) => mode.id !== modes.currentModeId)
      const availableModes = [...modes.availableModes]
      if (nonCurrentIndex >= 0) availableModes.splice(nonCurrentIndex, 1)
      else availableModes.length = 0
      record = build(record.options, { ...modes, availableModes }, record.contextUsage)
      continue
    }
    if (record.contextUsage !== undefined && record.contextUsage !== null) {
      record = build(record.options, record.modes, undefined)
      continue
    }
    throw new TypeError('ACP option snapshot cannot be represented within its bounded storage format')
  }
  const validated = toOptionsSnapshotRecord(record)
  if (validated === undefined)
    throw new TypeError('ACP option snapshot projection did not produce a valid storage record')
  return validated
}

/** snapshot 行的语义校验 + 窄化（读路径；败者 undefined + warn——按「无快照」处理）。 */
export function toOptionsSnapshotRecord(raw: unknown): AcpOptionsSnapshotRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  if (!Array.isArray(raw.options)) return undefined
  if (raw.options.length > ACP_SNAPSHOT_OPTION_LIMIT) return undefined
  const options: AcpOptionsSnapshotOption[] = []
  for (const entry of raw.options as unknown[]) {
    if (!isPlainObject(entry)) return undefined
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > ACP_CONFIG_IDENTIFIER_MAX)
      return undefined
    if (typeof entry.name !== 'string' || entry.name.length > ACP_SNAPSHOT_FIELD_MAX) return undefined
    if (
      entry.category !== null &&
      (typeof entry.category !== 'string' || entry.category.length > ACP_CONFIG_IDENTIFIER_MAX)
    )
      return undefined
    if (
      (typeof entry.value !== 'string' && typeof entry.value !== 'boolean') ||
      (typeof entry.value === 'string' && entry.value.length > ACP_CONFIG_IDENTIFIER_MAX)
    )
      return undefined
    if (
      entry.values !== null &&
      (!Array.isArray(entry.values) ||
        entry.values.length > ACP_SNAPSHOT_VALUES_LIMIT ||
        !(entry.values as unknown[]).every((v) => typeof v === 'string' && v.length <= ACP_CONFIG_IDENTIFIER_MAX))
    )
      return undefined
    options.push({
      id: entry.id,
      category: entry.category as string | null,
      name: entry.name,
      value: entry.value as string | boolean,
      values: entry.values as readonly string[] | null,
    })
  }
  if (
    raw.currentModeId !== null &&
    (typeof raw.currentModeId !== 'string' || raw.currentModeId.length > ACP_CONFIG_IDENTIFIER_MAX)
  )
    return undefined
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) return undefined
  let contextUsage: AcpOptionsSnapshotRecord['contextUsage']
  if (raw.contextUsage !== undefined && raw.contextUsage !== null) {
    const usage = raw.contextUsage
    if (
      !isPlainObject(usage) ||
      typeof usage.used !== 'number' ||
      typeof usage.size !== 'number' ||
      !Number.isFinite(usage.used) ||
      !Number.isFinite(usage.size) ||
      usage.used < 0 ||
      usage.size < 0
    )
      return undefined
    const rawCost = usage.cost
    if (
      rawCost !== undefined &&
      rawCost !== null &&
      (!isPlainObject(rawCost) ||
        typeof rawCost.amount !== 'number' ||
        !Number.isFinite(rawCost.amount) ||
        typeof rawCost.currency !== 'string' ||
        rawCost.currency.length > ACP_SNAPSHOT_FIELD_MAX)
    )
      return undefined
    contextUsage = {
      used: usage.used,
      size: usage.size,
      cost:
        rawCost === undefined
          ? null
          : rawCost === null
            ? null
            : { amount: rawCost.amount as number, currency: rawCost.currency as string },
    }
  } else if (raw.contextUsage === null) contextUsage = null
  let modes: AcpOptionsSnapshotRecord['modes']
  if (raw.modes !== undefined && raw.modes !== null) {
    if (
      !isPlainObject(raw.modes) ||
      typeof raw.modes.currentModeId !== 'string' ||
      raw.modes.currentModeId.length > ACP_CONFIG_IDENTIFIER_MAX ||
      !Array.isArray(raw.modes.availableModes) ||
      raw.modes.availableModes.length > ACP_SNAPSHOT_OPTION_LIMIT
    )
      return undefined
    const availableModes: { id: string; name: string; description?: string | null }[] = []
    for (const rawMode of raw.modes.availableModes as unknown[]) {
      if (
        !isPlainObject(rawMode) ||
        typeof rawMode.id !== 'string' ||
        typeof rawMode.name !== 'string' ||
        rawMode.id.length > ACP_CONFIG_IDENTIFIER_MAX ||
        rawMode.name.length > ACP_SNAPSHOT_FIELD_MAX
      )
        return undefined
      if (
        rawMode.description !== undefined &&
        rawMode.description !== null &&
        (typeof rawMode.description !== 'string' || rawMode.description.length > ACP_SNAPSHOT_MODE_DESCRIPTION_MAX)
      )
        return undefined
      availableModes.push({
        id: rawMode.id,
        name: rawMode.name,
        ...(rawMode.description === undefined ? {} : { description: rawMode.description as string | null }),
      })
    }
    modes = { currentModeId: raw.modes.currentModeId as string, availableModes }
  } else if (raw.modes === null) modes = null
  return {
    options,
    currentModeId: raw.currentModeId as string | null,
    updatedAt: raw.updatedAt,
    fingerprint: raw.fingerprint,
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(modes === undefined ? {} : { modes }),
  }
}
