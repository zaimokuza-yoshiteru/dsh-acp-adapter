/** ACP 补充信息请求桥接层。
 *
 * broker 会一直保持 ACP 请求待处理，直到用户明确作出选择。请求按会话隔离，
 * 表单值会依据协商得到的基础 schema 校验，提交值不会持久化。SDK 目前仍将
 * 这部分协议标记为不稳定，因此未知或格式错误的变体会被拒绝，不做猜测性兼容。
 */
import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'

export type AcpElicitationDecision =
  | { readonly action: 'accept'; readonly content: Record<string, acp.ElicitationContentValue> }
  | { readonly action: 'decline' | 'cancel' }

export interface AcpElicitationFieldView {
  readonly name: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly required: boolean
  readonly options?: readonly { readonly value: string; readonly title?: string; readonly description?: string }[]
  readonly defaultValue?: string | number | boolean | readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly format?: 'email' | 'uri' | 'date' | 'date-time'
}

export interface AcpPendingElicitationView {
  readonly requestId: string
  readonly sessionId: string
  readonly acpSessionId?: string
  readonly mode: 'form' | 'url'
  readonly message: string
  readonly fields: readonly AcpElicitationFieldView[]
  readonly url?: string
  readonly createdAt: number
}

export interface AcpPendingElicitationRequest {
  readonly sessionId: string
  readonly params: acp.CreateElicitationRequest
  readonly signal?: AbortSignal
}

export interface AcpElicitationAnswer {
  readonly requestId: string
  readonly action: 'accept' | 'decline' | 'cancel'
  readonly values?: readonly { readonly name: string; readonly value: string | number | boolean | readonly string[] }[]
}

export interface AcpElicitationBroker {
  open(request: AcpPendingElicitationRequest): Promise<AcpElicitationDecision>
  list(sessionId?: string): readonly AcpPendingElicitationView[]
  answer(sessionId: string, answer: AcpElicitationAnswer): Promise<void>
  cancel(sessionId: string, requestId: string): Promise<void>
  cancelSession(sessionId: string): void
  dispose(): void
}

export interface AcpElicitationAudit {
  readonly phase: 'requested' | 'decided'
  readonly requestId: string
  readonly acpSessionId?: string
  readonly mode: 'form' | 'url'
  readonly fieldNames: readonly string[]
  readonly schemaSummary: readonly { readonly name: string; readonly type: string; readonly required: boolean }[]
  readonly result?: 'accept' | 'decline' | 'cancel'
}

const SENSITIVE_FIELD = /(?:password|passwd|token|secret|credential|api[\s_-]*key|authorization|private[\s_-]*key|passphrase)/i

function requestIdOf(params: acp.CreateElicitationRequest): string {
  if (params.mode === 'url' && 'elicitationId' in params && typeof params.elicitationId === 'string' && params.elicitationId.length > 0) return params.elicitationId
  return `dsh-acp-elicitation-${randomUUID()}`
}

function acpSessionIdOf(params: acp.CreateElicitationRequest): string | undefined {
  return 'sessionId' in params && typeof params.sessionId === 'string' ? params.sessionId : undefined
}

type FormSchema = {
  readonly type?: unknown
  readonly properties?: unknown
  readonly required?: unknown
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function formSchemaOf(params: acp.CreateElicitationRequest): FormSchema {
  return (params as unknown as { requestedSchema: FormSchema }).requestedSchema
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function finiteOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

function boundedPair(item: Record<string, unknown>, minKey: string, maxKey: string, integer: boolean): boolean {
  const minimum = item[minKey]
  const maximum = item[maxKey]
  const valid = integer
    ? (minimum === undefined || minimum === null || nonNegativeInteger(minimum))
      && (maximum === undefined || maximum === null || nonNegativeInteger(maximum))
    : finiteOrAbsent(minimum) && finiteOrAbsent(maximum)
  return valid && !(typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum)
}

function enumOptions(value: unknown, titled: boolean): readonly { readonly value: string; readonly title?: string; readonly description?: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out: { value: string; title?: string; description?: string }[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!titled) {
      if (typeof raw !== 'string' || seen.has(raw)) return undefined
      seen.add(raw)
      out.push({ value: raw })
      continue
    }
    if (!plain(raw) || typeof raw.const !== 'string' || typeof raw.title !== 'string' || seen.has(raw.const)) return undefined
    if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') return undefined
    seen.add(raw.const)
    out.push({
      value: raw.const,
      title: raw.title,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    })
  }
  return out
}

function optionsOf(item: Record<string, unknown>): readonly { readonly value: string; readonly title?: string; readonly description?: string }[] | undefined {
  const enumPresent = item.enum !== undefined && item.enum !== null
  const oneOfPresent = item.oneOf !== undefined && item.oneOf !== null
  if (enumPresent && oneOfPresent) return undefined
  if (enumPresent) return enumOptions(item.enum, false)
  if (oneOfPresent) return enumOptions(item.oneOf, true)
  return []
}

function validStringFormat(value: string, format: unknown): boolean {
  if (format === undefined || format === null) return true
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'uri') {
    try { return new URL(value).protocol.length > 1 } catch { return false }
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
    return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day
  }
  if (format === 'date-time') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(Date.parse(value))
  }
  return false
}

function validDefault(item: Record<string, unknown>, type: string, options: readonly { readonly value: string }[]): boolean {
  const value = item.default
  if (value === undefined || value === null) return true
  if (type === 'string') return typeof value === 'string'
    && (options.length === 0 || options.some((option) => option.value === value))
    && (!(typeof item.minLength === 'number') || value.length >= item.minLength)
    && (!(typeof item.maxLength === 'number') || value.length <= item.maxLength)
    && (!(typeof item.pattern === 'string') || new RegExp(item.pattern).test(value))
    && validStringFormat(value, item.format)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    && (!(typeof item.minimum === 'number') || value >= item.minimum)
    && (!(typeof item.maximum === 'number') || value <= item.maximum)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    && (!(typeof item.minimum === 'number') || value >= item.minimum)
    && (!(typeof item.maximum === 'number') || value <= item.maximum)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
    && value.every((entry): entry is string => typeof entry === 'string')
    && new Set(value).size === value.length
    && value.every((entry) => options.some((option) => option.value === entry))
    && (!(typeof item.minItems === 'number') || value.length >= item.minItems)
    && (!(typeof item.maxItems === 'number') || value.length <= item.maxItems)
  return false
}

function fieldViewOf(name: string, item: unknown, required: boolean): AcpElicitationFieldView | undefined {
  if (!plain(item) || typeof item.type !== 'string') return undefined
  // ACP v1 form elicitation is intentionally non-sensitive. Credential-shaped
  // fields must use URL elicitation; never render a password control or accept
  // a value merely because a caller bypassed the UI.
  if (SENSITIVE_FIELD.test(name)
    || (typeof item.title === 'string' && SENSITIVE_FIELD.test(item.title))
    || (typeof item.description === 'string' && SENSITIVE_FIELD.test(item.description))
    || item.sensitive === true
    || item.secret === true) return undefined
  if (item.title !== undefined && item.title !== null && typeof item.title !== 'string') return undefined
  if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') return undefined
  const type = item.type
  let options: readonly { readonly value: string; readonly title?: string; readonly description?: string }[] = []
  if (type === 'string') {
    if (!boundedPair(item, 'minLength', 'maxLength', true)) return undefined
    if (item.pattern !== undefined && item.pattern !== null) {
      if (typeof item.pattern !== 'string') return undefined
      try { new RegExp(item.pattern) } catch { return undefined }
    }
    if (item.format !== undefined && item.format !== null && !['email', 'uri', 'date', 'date-time'].includes(String(item.format))) return undefined
    const parsed = optionsOf(item)
    if (parsed === undefined) return undefined
    options = parsed
  } else if (type === 'number' || type === 'integer') {
    if (!boundedPair(item, 'minimum', 'maximum', false)) return undefined
  } else if (type === 'boolean') {
    // 布尔字段没有额外的结构约束。
  } else if (type === 'array') {
    if (!boundedPair(item, 'minItems', 'maxItems', true) || !plain(item.items)) return undefined
    const items = item.items
    if (items.type !== undefined && items.type !== 'string') return undefined
    const parsed = optionsOf({ enum: items.enum, oneOf: items.anyOf })
    if (parsed === undefined || parsed.length === 0) return undefined
    options = parsed
  } else return undefined
  if (!validDefault(item, type, options)) return undefined
  return {
    name,
    type,
    required,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(options.length === 0 ? {} : { options }),
    ...(item.default !== undefined && item.default !== null ? { defaultValue: item.default as string | number | boolean | readonly string[] } : {}),
    ...(typeof item.minimum === 'number' ? { minimum: item.minimum } : {}),
    ...(typeof item.maximum === 'number' ? { maximum: item.maximum } : {}),
    ...(typeof item.minItems === 'number' ? { minItems: item.minItems } : {}),
    ...(typeof item.maxItems === 'number' ? { maxItems: item.maxItems } : {}),
    ...(['email', 'uri', 'date', 'date-time'].includes(String(item.format)) ? { format: item.format as 'email' | 'uri' | 'date' | 'date-time' } : {}),
  }
}

function schemaOf(params: acp.CreateElicitationRequest): { fields: readonly AcpElicitationFieldView[]; valid: boolean } {
  if (params.mode !== 'form') {
    if (params.mode !== 'url' || typeof params.url !== 'string') return { fields: [], valid: false }
    try {
      const url = new URL(params.url)
      return { fields: [], valid: (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' }
    } catch { return { fields: [], valid: false } }
  }
  const schema = formSchemaOf(params)
  if (!plain(schema) || (schema.type !== undefined && schema.type !== 'object')) return { fields: [], valid: false }
  const rawProperties = schema.properties
  if (rawProperties !== undefined && !plain(rawProperties)) return { fields: [], valid: false }
  const properties: Record<string, unknown> = rawProperties ?? {}
  const names = Object.keys(properties)
  const rawRequired = schema.required
  if (names.length > 32 || (rawRequired !== undefined && rawRequired !== null && !Array.isArray(rawRequired))) return { fields: [], valid: false }
  const requiredValues: readonly unknown[] = Array.isArray(rawRequired) ? rawRequired : []
  if (!requiredValues.every((value): value is string => typeof value === 'string') || new Set(requiredValues).size !== requiredValues.length || requiredValues.some((name) => !Object.prototype.hasOwnProperty.call(properties, name))) return { fields: [], valid: false }
  const required = new Set<string>(requiredValues)
  const fields: AcpElicitationFieldView[] = []
  for (const [name, item] of Object.entries(properties)) {
    const field = fieldViewOf(name, item, required.has(name))
    if (field === undefined) return { fields: [], valid: false }
    fields.push(field)
  }
  return { fields, valid: true }
}

/**
 * Audits retain only field names, coarse schema types, and required-ness. Keep
 * this independent of the renderable view so a declined sensitive schema is
 * still observable without exposing a value or accidentally rendering it.
 */
function auditFieldsOf(params: acp.CreateElicitationRequest): readonly { readonly name: string; readonly type: string; readonly required: boolean }[] {
  if (params.mode !== 'form') return []
  const schema = formSchemaOf(params)
  if (!plain(schema) || !plain(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  return Object.entries(schema.properties).map(([name, item]) => ({
    name,
    type: plain(item) && typeof item.type === 'string' ? item.type : 'unknown',
    required: required.has(name),
  }))
}

function validateValues(params: acp.CreateElicitationRequest, input: readonly { readonly name: string; readonly value: string | number | boolean | readonly string[] }[] | undefined): Record<string, acp.ElicitationContentValue> | undefined {
  if (params.mode !== 'form') return {}
  const schema = formSchemaOf(params)
  if (!plain(schema)) return undefined
  const rawProperties = schema.properties
  if (rawProperties !== undefined && !plain(rawProperties)) return undefined
  const properties: Record<string, unknown> = rawProperties ?? {}
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  const values = input ?? []
  const out: Record<string, acp.ElicitationContentValue> = {}
  for (const item of values) {
    const schema = properties[item.name] as Record<string, unknown> | undefined
    if (schema === undefined
      || SENSITIVE_FIELD.test(item.name)
      || (typeof schema.title === 'string' && SENSITIVE_FIELD.test(schema.title))
      || (typeof schema.description === 'string' && SENSITIVE_FIELD.test(schema.description))
      || schema.sensitive === true
      || schema.secret === true
      || Object.prototype.hasOwnProperty.call(out, item.name)) return undefined
    const type = schema.type
    const validType = type === 'string' ? typeof item.value === 'string'
      : type === 'number' ? typeof item.value === 'number' && Number.isFinite(item.value)
        : type === 'integer' ? typeof item.value === 'number' && Number.isInteger(item.value)
          : type === 'boolean' ? typeof item.value === 'boolean'
            : type === 'array' && Array.isArray(item.value) && item.value.every((value) => typeof value === 'string')
    if (!validType) return undefined
    if ((type === 'number' || type === 'integer') && typeof item.value === 'number') {
      if (typeof schema.minimum === 'number' && item.value < schema.minimum) return undefined
      if (typeof schema.maximum === 'number' && item.value > schema.maximum) return undefined
    }
    if (type === 'array' && Array.isArray(item.value)) {
      if (typeof schema.minItems === 'number' && item.value.length < schema.minItems) return undefined
      if (typeof schema.maxItems === 'number' && item.value.length > schema.maxItems) return undefined
      const items = schema.items as Record<string, unknown> | undefined
      const allowed = items !== undefined && Array.isArray(items.enum) ? items.enum : items !== undefined && Array.isArray(items.anyOf) ? items.anyOf.map((value) => typeof value === 'object' && value !== null ? (value as Record<string, unknown>).const : undefined) : undefined
      if (allowed !== undefined && item.value.some((value) => !allowed.includes(value))) return undefined
    }
    if (typeof item.value === 'string') {
      if (typeof schema.minLength === 'number' && item.value.length < schema.minLength) return undefined
      if (typeof schema.maxLength === 'number' && item.value.length > schema.maxLength) return undefined
      if (typeof schema.pattern === 'string') {
        try { if (!new RegExp(schema.pattern).test(item.value)) return undefined } catch { return undefined }
      }
      const allowed = Array.isArray(schema.enum) ? schema.enum : Array.isArray(schema.oneOf) ? schema.oneOf.map((value) => typeof value === 'object' && value !== null ? (value as Record<string, unknown>).const : undefined) : undefined
      if (allowed !== undefined && !allowed.includes(item.value)) return undefined
      if (!validStringFormat(item.value, schema.format)) return undefined
    }
    out[item.name] = item.value as acp.ElicitationContentValue
  }
  for (const name of required) if (!Object.prototype.hasOwnProperty.call(out, name)) return undefined
  return out
}

interface Entry {
  readonly view: AcpPendingElicitationView
  readonly params: acp.CreateElicitationRequest
  readonly resolve: (decision: AcpElicitationDecision) => void
  readonly signal?: AbortSignal
  readonly abort: () => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class InMemoryAcpElicitationBroker implements AcpElicitationBroker {
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly audit?: (sessionId: string, audit: AcpElicitationAudit) => Promise<void> | void,
    private readonly timeoutMs = 15 * 60 * 1000,
  ) {}

  async open(request: AcpPendingElicitationRequest): Promise<AcpElicitationDecision> {
    const id = requestIdOf(request.params)
    const key = `${request.sessionId}\u0000${id}`
    if (this.entries.has(key)) throw new Error(`pending ACP elicitation "${id}" is already active`)
    const schema = schemaOf(request.params)
    const fields = schema.fields
    const acpSessionId = acpSessionIdOf(request.params)
    const view: AcpPendingElicitationView = {
      requestId: id,
      sessionId: request.sessionId,
      ...(acpSessionId === undefined ? {} : { acpSessionId }),
      mode: request.params.mode === 'form' ? 'form' : 'url',
      message: request.params.message,
      fields,
      ...(request.params.mode === 'url' && typeof request.params.url === 'string' ? { url: request.params.url } : {}),
      createdAt: this.now(),
    }
    const summary = auditFieldsOf(request.params)
    const auditRequested = this.audit?.(request.sessionId, { phase: 'requested', requestId: id, ...(view.acpSessionId === undefined ? {} : { acpSessionId: view.acpSessionId }), mode: view.mode, fieldNames: summary.map((field) => field.name), schemaSummary: summary })
    if (auditRequested !== undefined) {
      try { await Promise.resolve(auditRequested) } catch { return { action: 'cancel' } }
    }
    if (!schema.valid) {
      try {
        await Promise.resolve(this.audit?.(request.sessionId, { phase: 'decided', requestId: id, ...(view.acpSessionId === undefined ? {} : { acpSessionId: view.acpSessionId }), mode: view.mode, fieldNames: summary.map((field) => field.name), schemaSummary: summary, result: 'decline' }))
      } catch { return { action: 'cancel' } }
      return { action: 'decline' }
    }
    if (request.signal?.aborted === true) {
      try {
        await Promise.resolve(this.audit?.(request.sessionId, { phase: 'decided', requestId: id, ...(view.acpSessionId === undefined ? {} : { acpSessionId: view.acpSessionId }), mode: view.mode, fieldNames: fields.map((field) => field.name), schemaSummary: summary, result: 'cancel' }))
      } catch { /* 即使审计失败，也保持取消这一安全结果。 */ }
      return { action: 'cancel' }
    }
    return new Promise((resolve) => {
      const abort = (): void => { void this.cancelEntry(key) }
      const timer = setTimeout(() => { void this.cancelEntry(key) }, Math.max(1, this.timeoutMs))
      this.entries.set(key, { view, params: request.params, resolve, abort, timer, ...(request.signal === undefined ? {} : { signal: request.signal }) })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted === true) abort()
    })
  }

  list(sessionId?: string): readonly AcpPendingElicitationView[] {
    return [...this.entries.values()].map((entry) => entry.view).filter((view) => sessionId === undefined || view.sessionId === sessionId).sort((left, right) => left.createdAt - right.createdAt)
  }

  async answer(sessionId: string, answer: AcpElicitationAnswer): Promise<void> {
    const key = `${sessionId}\u0000${answer.requestId}`
    const entry = this.entries.get(key)
    if (entry === undefined) throw new Error(`pending ACP elicitation "${answer.requestId}" is not active`)
    let decision: AcpElicitationDecision
    if (answer.action === 'accept') {
      const content = validateValues(entry.params, answer.values)
      if (content === undefined) throw new Error('ACP elicitation values do not match the requested schema')
      decision = { action: 'accept', content }
    } else decision = { action: answer.action }
    await Promise.resolve(this.audit?.(sessionId, { phase: 'decided', requestId: answer.requestId, ...(entry.view.acpSessionId === undefined ? {} : { acpSessionId: entry.view.acpSessionId }), mode: entry.view.mode, fieldNames: entry.view.fields.map((field) => field.name), schemaSummary: entry.view.fields.map((field) => ({ name: field.name, type: field.type, required: field.required })), result: answer.action })).catch((error: unknown) => { this.settle(key, { action: 'cancel' }); throw error })
    this.settle(key, decision)
  }

  async cancel(sessionId: string, requestId: string): Promise<void> {
    const key = `${sessionId}\u0000${requestId}`
    if (!this.entries.has(key)) throw new Error(`pending ACP elicitation "${requestId}" is not active`)
    const entry = this.entries.get(key)!
    try {
      await this.auditDecision(entry, 'cancel')
    } catch (error: unknown) {
      this.settle(key, { action: 'cancel' })
      throw error
    }
    this.settle(key, { action: 'cancel' })
  }

  cancelSession(sessionId: string): void {
    for (const [key, entry] of this.entries) if (entry.view.sessionId === sessionId) void this.cancelEntry(key)
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) void this.cancelEntry(key)
  }

  private async auditDecision(entry: Entry, result: 'accept' | 'decline' | 'cancel'): Promise<void> {
    await Promise.resolve(this.audit?.(entry.view.sessionId, {
      phase: 'decided',
      requestId: entry.view.requestId,
      ...(entry.view.acpSessionId === undefined ? {} : { acpSessionId: entry.view.acpSessionId }),
      mode: entry.view.mode,
      fieldNames: entry.view.fields.map((field) => field.name),
      schemaSummary: entry.view.fields.map((field) => ({ name: field.name, type: field.type, required: field.required })),
      result,
    }))
  }

  private async cancelEntry(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    try { await this.auditDecision(entry, 'cancel') } catch { /* 审计失败时仍必须释放 Agent RPC。 */ }
    this.settle(key, { action: 'cancel' })
  }

  private settle(key: string, decision: AcpElicitationDecision): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.abort)
    entry.resolve(decision)
  }
}

export function elicitationResponseOf(decision: AcpElicitationDecision): acp.CreateElicitationResponse {
  return decision.action === 'accept' ? { action: 'accept', content: decision.content } : { action: decision.action }
}
