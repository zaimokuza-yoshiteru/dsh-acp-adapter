import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { RUN_CODE_NAME, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AcpHostSettlementError } from '../../runtime/session/mcp-lease.ts'
import type { ReadStepToolAdmission, StepToolAdmission } from './step-tool-admissions.ts'

interface ToolDirectoryOptions {
  readonly agent: Agent
  readonly tools: Pick<Context['tools'], 'get' | 'executable'>
  /** Exact advertised owners; replacement registrations never update these maps. */
  readonly definitions: ReadonlyMap<string, ToolSchema>
  readonly registrations: ReadonlyMap<string, ToolDefinition>
  readonly lifetime: AbortSignal
  readonly isConnectionAvailable: () => boolean
  readonly readAdmission?: ReadStepToolAdmission
}

interface ToolDirectoryPrompt {
  readonly signal: AbortSignal | undefined
  readonly generation: number
  readonly admission: StepToolAdmission | undefined
}

interface PermissionFence {
  readonly prompt: ToolDirectoryPrompt
  readonly signal: AbortSignal
  readonly definition: ToolSchema
  /** A matching display title can revoke a question, but never authorizes Auto. */
  readonly revocationOnly: boolean
}

/** One MCP lease's advertised directory and approval validity, separate from accepted execution. */
export class ToolDirectoryOwner {
  private readonly toolLifetimes: ReadonlyMap<string, AbortController>
  private readonly permissionFences = new WeakMap<object, PermissionFence>()
  private permissionGeneration = new AbortController()
  private promptSignal: AbortSignal | undefined
  private promptGeneration = 0

  constructor(private readonly options: ToolDirectoryOptions) {
    this.toolLifetimes = new Map([...options.definitions.keys()].map((name) => [name, new AbortController()]))
  }

  get prompt(): AbortSignal | undefined {
    return this.promptSignal
  }

  get generation(): number {
    return this.promptGeneration
  }

  beginPrompt(signal: AbortSignal): void {
    const admission = this.options.readAdmission?.(this.options.agent)
    if (this.options.readAdmission !== undefined && (admission === undefined || !admission.isActive()))
      throw new AcpHostSettlementError('ACP_HOST_TOOL_NOT_DISPATCHED')
    this.promptSignal = signal
    this.permissionGeneration.abort(new Error('ACP permission generation ended'))
    this.permissionGeneration = new AbortController()
    this.promptGeneration++
  }

  endPrompt(): void {
    this.permissionGeneration.abort(new Error('ACP prompt ended'))
    this.promptSignal = undefined
    this.promptGeneration++
  }

  capturePrompt(): ToolDirectoryPrompt {
    return {
      signal: this.promptSignal,
      generation: this.promptGeneration,
      admission: this.options.readAdmission?.(this.options.agent),
    }
  }

  isCurrent(captured: ToolDirectoryPrompt): boolean {
    return (
      captured.signal !== undefined &&
      !captured.signal.aborted &&
      this.promptSignal === captured.signal &&
      this.promptGeneration === captured.generation &&
      this.isLive() &&
      (this.options.readAdmission === undefined ||
        (this.options.readAdmission(this.options.agent) === captured.admission &&
          captured.admission?.isActive() === true))
    )
  }

  isLive(requireActive = true): boolean {
    if (this.options.lifetime.aborted || !this.options.isConnectionAvailable()) return false
    if (this.options.readAdmission === undefined) return true
    const admission = this.options.readAdmission(this.options.agent)
    return admission !== undefined && (!requireActive || admission.isActive())
  }

  isDefinitionLive(name: string, definition: ToolSchema, requireActive = true): boolean {
    if (this.toolLifetimes.get(name)?.signal.aborted === true) return false
    const { agent, tools, readAdmission, definitions, registrations } = this.options
    const admission = readAdmission?.(agent)
    if (readAdmission !== undefined && (admission === undefined || (requireActive && !admission.isActive())))
      return false
    // PTC's run_code belongs to the admitted executor, not the tool registry.
    if (name === RUN_CODE_NAME) return definitions.get(name) === definition
    const registered = registrations.get(name)
    if (registered === undefined || tools.get(name, agent) !== registered) return false
    if (admission === undefined) return tools.executable(name, agent) === registered
    const admitted = admission.isActive() ? admission.toolSet.view(agent) : admission.definitions
    return admitted.get(name) === registered
  }

  needsRefresh(): boolean {
    return [...this.options.definitions].some(([name, definition]) => !this.isDefinitionLive(name, definition, false))
  }

  revokeStaleTools(): void {
    for (const [name, definition] of this.options.definitions)
      if (!this.isDefinitionLive(name, definition, false))
        this.toolLifetimes.get(name)!.abort(new Error('DSH tool withdrawn'))
  }

  private toolPermissionSignal(definition: ToolSchema): AbortSignal | undefined {
    if (this.promptSignal === undefined) return undefined
    const target = this.toolLifetimes.get(definition.name)!
    if (!this.isDefinitionLive(definition.name, definition)) target.abort(new Error('DSH tool withdrawn'))
    return AbortSignal.any([this.options.lifetime, this.promptSignal, this.permissionGeneration.signal, target.signal])
  }

  clearPermission(request: object): void {
    this.permissionFences.delete(request)
  }

  capturePermission(
    request: object,
    prompt: ToolDirectoryPrompt,
    definition: ToolSchema,
    revocationOnly = false,
  ): AbortSignal {
    const signal = this.toolPermissionSignal(definition)!
    this.permissionFences.set(request, { prompt, signal, definition, revocationOnly })
    return signal
  }

  permissionSignal(request: object): AbortSignal | undefined {
    return this.permissionFences.get(request)?.signal
  }

  validatePermission(request: object, identify: () => ToolSchema | undefined): boolean {
    const fence = this.permissionFences.get(request)
    if (fence === undefined || fence.signal.aborted || !this.isCurrent(fence.prompt)) return false
    const { definition } = fence
    return (
      (fence.revocationOnly || identify() === definition) &&
      this.options.definitions.get(definition.name) === definition &&
      this.isDefinitionLive(definition.name, definition)
    )
  }
}
