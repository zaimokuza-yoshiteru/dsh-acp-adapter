/** ACP 补充信息请求桥接层。
 *
 * broker 会一直保持 ACP 请求待处理，直到用户明确作出选择。请求按会话隔离，
 * 表单值会依据协商得到的基础 schema 校验，提交值不会持久化。SDK 目前仍将
 * 这部分协议标记为不稳定，因此未知或格式错误的变体会被拒绝，不做猜测性兼容。
 */
import type * as acp from '@agentclientprotocol/sdk'

const SENSITIVE_FIELD = /(?:password|passwd|token|secret|credential|api[\s_-]*key|authorization|private[\s_-]*key|passphrase)/i

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
    const parsed = optionsOf({ enum: items.enum, oneOf: items.oneOf })
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
function validateValues(params: acp.CreateElicitationRequest, input: readonly { readonly name: string; readonly value: string | number | boolean | readonly string[] }[] | undefined): Record<string, acp.ElicitationContentValue> | undefined {
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
      const allowed = items !== undefined && Array.isArray(items.enum) ? items.enum : items !== undefined && Array.isArray(items.oneOf) ? items.oneOf.map((value) => typeof value === 'object' && value !== null ? (value as Record<string, unknown>).const : undefined) : undefined
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

/** The narrow structural face of DSH's native user-question service. */
export interface AcpNativeUserQuestionService {
  ask(request: {
    readonly questions: readonly {
      readonly id: string
      readonly question: string
      readonly detail?: string
      readonly header?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
      readonly multiSelect?: boolean
    }[]
    readonly agent?: unknown
    readonly signal?: AbortSignal
  }): Promise<{
    readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
  }>
}

export interface AcpNativeElicitationDeps {
  readonly userQuestions?: AcpNativeUserQuestionService
  readonly getAgent: () => unknown
  readonly locale?: string
  /** Supplied only by the live host bridge after exact request/call correlation. */
  readonly hostToolName?: string
  /** Native child approval for an exactly correlated DSH tool; never answers arbitrary forms. */
  readonly approveDelegatedOnce?: (signal?: AbortSignal) => Promise<boolean>
  readonly log?: (message: string) => void
}

/** DSH returns labels, so every displayed choice must map unambiguously to its wire value. */
function displayOptions(options: NonNullable<AcpElicitationFieldView['options']>) {
  const titles = options.map(option => option.title?.trim() || option.value)
  let labels = titles.map((title, index) => titles.indexOf(title) === titles.lastIndexOf(title)
    ? title : `${title} (${options[index]!.value})`)
  // A supplied title can itself collide with a disambiguated title. Number the
  // entire set in that rare case rather than guessing which value was chosen.
  if (new Set(labels).size !== labels.length) labels = labels.map((label, index) => `${index + 1}. ${label}`)
  return options.map((option, index) => ({ ...option, label: labels[index]! }))
}

/**
 * Bridge ACP form elicitation to DSH's native question waterfall. URL
 * elicitation is deliberately declined: this plugin has no public, safe host
 * URL-opener seam and must never open or prefetch an Agent-supplied URL.
 */
export function createAcpNativeElicitationHandler(
  deps: AcpNativeElicitationDeps,
): (params: acp.CreateElicitationRequest, signal?: AbortSignal) => Promise<acp.CreateElicitationResponse> {
  return async (params, signal) => {
    if (params.mode !== 'form' || deps.userQuestions === undefined) return { action: 'cancel' }
    if (signal?.aborted === true) return { action: 'cancel' }
    const schema = schemaOf(params)
    if (!schema.valid || schema.fields.length === 0) return { action: 'cancel' }
    const message = params.message.trim().length > 4_096
      ? `${params.message.trim().slice(0, 4_096)}…`
      : params.message.trim()
    const zh = deps.locale?.toLowerCase().startsWith('zh') === true
    const scopeTitles: Record<string, string> = zh
      ? { once: '仅允许一次', session: '在本次会话中允许', always: '始终允许，不再询问' }
      : { once: 'Allow once', session: 'Allow for this session', always: "Always allow, don't ask again" }
    const fields = schema.fields.map(field => {
      const scope = params._meta?.codex_approval_kind === 'mcp_tool_call' && field.name === 'persist'
        && field.type === 'string' && (field.options?.length ?? 0) > 0
        && field.options!.every(option => Object.hasOwn(scopeTitles, option.value))
      const options = displayOptions(field.options?.map(option => scope
        ? { ...option, title: scopeTitles[option.value]! } : option)
        ?? (field.type === 'boolean' ? [{ value: 'true', title: zh ? '是' : 'Yes' }, { value: 'false', title: zh ? '否' : 'No' }] : []))
      return { ...field, question: scope ? (zh ? '授权范围' : 'Approval scope') : field.title?.trim() || field.name, options }
    })
    const questions = fields.map((field, index) => {
      // Only a verified, exact Codex bridge message is replaced. Other agents'
      // explanations remain intact, including any additional approval context.
      const introduction = deps.hostToolName === undefined ? message
        : zh ? `允许 Agent 调用 DSH 工具“${deps.hostToolName}”吗？` : `Allow the Agent to use the DSH tool "${deps.hostToolName}"?`
      const detail = [index === 0 ? introduction : undefined, field.description]
        .filter((value): value is string => value !== undefined && value.length > 0).join('\n\n')
      return {
        id: field.name,
        question: field.question,
        ...(detail.length === 0 ? {} : { detail }),
        ...(field.options.length === 0 ? {} : { options: field.options.map(option => ({
          label: option.label, ...(option.description === undefined ? {} : { description: option.description }),
        })) }),
        ...(field.type === 'array' ? { multiSelect: true } : {}),
      }
    })
    try {
      const agent = deps.getAgent()
      if (agent === undefined) return { action: 'cancel' }
      const answer = await deps.userQuestions.ask({ questions, agent, ...(signal === undefined ? {} : { signal }) })
      if (signal?.aborted) return { action: 'cancel' }
      const values: { name: string; value: string | number | boolean | readonly string[] }[] = []
      for (const field of fields) {
        const item = answer.answers.find((candidate) => candidate.id === field.name)
        if (item === undefined) continue
        // Enum answers must be explicit displayed choices; never interpret free
        // text as a permission scope or guess from a protocol identifier.
        if (field.options.length > 0 && (item.custom?.trim() || item.selected.some(label => !field.options.some(option => option.label === label)))) return { action: 'cancel' }
        if (field.type !== 'array' && item.selected.length > 1) return { action: 'cancel' }
        const selected = item.selected.map(label => field.options.find(option => option.label === label)?.value ?? label)
        if (field.type === 'array') values.push({ name: field.name, value: selected })
        else if (field.type === 'boolean') {
          const value = selected[0] ?? item.custom
          if (value !== 'true' && value !== 'false') return { action: 'cancel' }
          values.push({ name: field.name, value: value === 'true' })
        } else if (field.type === 'number' || field.type === 'integer') {
          const raw = selected[0] ?? item.custom
          if (raw === undefined || raw.trim() === '') return { action: 'cancel' }
          const value = Number(raw)
          if (!Number.isFinite(value)) return { action: 'cancel' }
          values.push({ name: field.name, value })
        } else {
          values.push({ name: field.name, value: selected[0] ?? item.custom ?? '' })
        }
      }
      const content = validateValues(params, values)
      return content === undefined ? { action: 'cancel' } : { action: 'accept', content }
    } catch (error: unknown) {
      // Native questions intentionally reject owned children. Preserve that
      // boundary for questions, but a verified tool-approval scope can use the
      // native approval service, which supports the original child ownership.
      const once = validateValues(params, [{ name: 'persist', value: 'once' }])
      if (plain(error) || error instanceof Error) {
        const code = (error as { code?: unknown }).code
        if (code === 'DELEGATED_CALLER' && !signal?.aborted
          && deps.hostToolName !== undefined && deps.approveDelegatedOnce !== undefined
          && params._meta?.codex_approval_kind === 'mcp_tool_call'
          && schema.fields.length === 1 && schema.fields[0]?.name === 'persist'
          && schema.fields[0].type === 'string'
          && schema.fields[0].options?.some(option => option.value === 'once')
          && once !== undefined) {
          try {
            const allowed = await deps.approveDelegatedOnce(signal)
            return allowed && !signal?.aborted ? { action: 'accept', content: once } : { action: 'cancel' }
          } catch { return { action: 'cancel' } }
        }
      }
      deps.log?.(`dsh-acp native elicitation cancelled: ${error instanceof Error ? error.message : String(error)}`)
      return { action: 'cancel' }
    }
  }
}
