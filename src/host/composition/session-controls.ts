/** Session-scoped controls and explicit user mode choices; no transport or dispatch ownership. */
import type * as acp from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AcpAgentSessionSnapshotView as AgentSessionSnapshotView,
  AcpAgentSessionOptionWrite as AgentSessionOptionWrite,
  AcpAgentModeView as AgentSessionModeView,
} from '../../contract/remote.ts'
import { teamModeChoices } from '../../contract/session-modes.ts'
import { isAcpModelOrReasoningOption, normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { modeIntentBindingKey } from '../../persistence/sidecar.ts'
import type { AcpBindingData, AcpBindingLookup, AcpModeIntent, AcpRecoveryState } from '../../persistence/sidecar.ts'
import type { AcpOptionsSnapshotRecord } from '../../persistence/options-snapshot.ts'
import type { AcpRuntimeContextUsage } from '../../runtime/session/session-runtime.ts'

/** The control owner may inspect and configure an established runtime, never start a prompt. */
interface SessionControlRuntime {
  readonly configOptions?: readonly acp.SessionConfigOption[] | undefined
  readonly modes?: acp.SessionModeState | undefined
  readonly currentModeId?: string | undefined
  readonly contextUsage?: AcpRuntimeContextUsage | undefined
  readonly cancelledSessionRefreshPending?: boolean | undefined
  readonly cancelledSessionRefreshBindingId?: string | undefined
  readonly isBusy?: boolean
  setConfigOption?(id: string, value: string | boolean, signal?: AbortSignal): Promise<void>
  setMode?(id: string, signal?: AbortSignal): Promise<void>
}

/** Control facts and intents only; the adapter retains the writer and binding lifecycle. */
interface SessionControlStorage {
  readLatestBinding(sessionId: string): Promise<AcpBindingLookup | undefined>
  readOptionSnapshot(sessionId: string): Promise<AcpOptionsSnapshotRecord | undefined>
  readModeIntent(sessionId: string): Promise<AcpModeIntent | undefined>
  writeModeIntent(sessionId: string, intent: AcpModeIntent): Promise<void>
  clearModeIntent(sessionId: string, intent: AcpModeIntent): Promise<void>
}

interface SessionControlAccess<Runtime extends SessionControlRuntime> {
  readonly storage?: SessionControlStorage
  runtime(sessionId: string): Runtime | undefined
  owner(runtime: Runtime): object | undefined
  sessionOwner(sessionId: string): object | undefined
  handoffPending(sessionId: string): boolean
  bindingCompatible(binding: AcpBindingData): Promise<boolean>
  recovery(sessionId: string): Promise<AcpRecoveryState | undefined>
  restoreCancelledRuntime(sessionId: string, runtime: Runtime): Promise<void>
  persistSnapshot(sessionId: string, runtime: Runtime): Promise<void>
  changed(sessionId: string): void
}

interface UserModeChoice {
  readonly kind: 'legacy' | 'config'
  readonly id: string
  readonly value?: string | boolean
}

interface ConfirmedUserModeSelection extends UserModeChoice {
  readonly bindingKey: string
  readonly agentSessionId: string
  readonly owner: object
  readonly needsRestore: boolean
}

/** One adapter instance owns its writes and transient confirmed user choices. */
export class SessionControls<Runtime extends SessionControlRuntime> {
  private readonly confirmedModes = new Map<string, ConfirmedUserModeSelection>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly retiringOwners = new WeakMap<object, number>()
  private accepting = true

  constructor(
    private readonly profileId: string,
    private readonly access: SessionControlAccess<Runtime>,
  ) {}

  /** Narrow session-scoped control/read surface for the additive Agent dock. */
  async agentSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshotView> {
    await this.waitForSessionControlWrite(sessionId)
    const snapshot = await this.readAgentSessionSnapshotView(sessionId)
    const controlsWritable = this.admitsOwner(this.access.sessionOwner(sessionId))
    return {
      ...snapshot,
      editable: snapshot.editable && controlsWritable,
      modeWritable: snapshot.modeWritable === true && controlsWritable,
    }
  }

  private async readAgentSessionSnapshotView(sessionId: string): Promise<AgentSessionSnapshotView> {
    const snapshot = await this.readAgentSessionSnapshot(sessionId)
    const binding = await this.access.storage?.readLatestBinding(sessionId)
    const intent = await this.access.storage?.readModeIntent(sessionId)
    const recovery = await this.access.recovery(sessionId)
    const compatible =
      binding?.status === 'ok' &&
      binding.binding.provider === `acp-${this.profileId}` &&
      (await this.access.bindingCompatible(binding.binding)) &&
      (recovery === undefined || recovery.kind === 'healthy')
    const pending = compatible && intent?.bindingKey === modeIntentBindingKey(binding.binding) ? intent.modeId : null
    return {
      ...snapshot,
      modeWritable: compatible && (snapshot.freshness === 'stale' || snapshot.editable),
      pendingModeId:
        pending !== null &&
        !teamModeChoices(snapshot).some(
          (choice) => choice.id === pending && choice.current && snapshot.freshness === 'live',
        )
          ? pending
          : null,
    }
  }

  /** Mode changes for dormant members are durable settings; they never create a session or send a prompt. */
  async setTeamMemberMode(sessionId: string, modeId: string): Promise<AgentSessionSnapshotView> {
    if (this.access.storage === undefined)
      throw new LlmError('This member mode cannot be changed', 'ACP_SESSION_OPTIONS_READ_ONLY')
    await this.serializeSessionControlWrite(sessionId, async (owner) => {
      const current = await this.readAgentSessionSnapshotView(sessionId)
      const currentChoice = teamModeChoices(current).find((candidate) => candidate.id === modeId)
      if (!current.modeWritable || currentChoice === undefined)
        throw new LlmError('This member mode cannot be changed', 'ACP_SESSION_OPTIONS_READ_ONLY')
      if (this.access.handoffPending(sessionId))
        throw new LlmError('Member started running; retry after it settles', 'ACP_SESSION_OPTIONS_READ_ONLY')
      const binding = await this.access.storage!.readLatestBinding(sessionId)
      if (binding?.status !== 'ok' || binding.binding.provider !== `acp-${this.profileId}`)
        throw new LlmError('The original ACP binding is unavailable', 'ACP_BINDING_UNAVAILABLE')
      const currentRuntime = this.access.runtime(sessionId)
      if (currentRuntime?.isBusy || (current.freshness === 'stale' && currentRuntime !== undefined))
        throw new LlmError('Member started running; retry after it settles', 'ACP_SESSION_OPTIONS_READ_ONLY')
      if (currentRuntime !== undefined) this.assertRuntime(sessionId, currentRuntime)
      this.assertSessionOwner(sessionId, owner)
      const intent = { bindingKey: modeIntentBindingKey(binding.binding), modeId }
      // Save before contacting the Agent: a disconnected write remains visible and is retried before the next prompt.
      await this.access.storage!.writeModeIntent(sessionId, intent)
      try {
        if (current.freshness === 'live' && currentRuntime && !currentRuntime.isBusy) {
          await this.access.restoreCancelledRuntime(sessionId, currentRuntime)
          this.assertRuntime(sessionId, currentRuntime)
          await this.applyMemberMode(sessionId, currentRuntime)
        }
      } finally {
        this.access.changed(sessionId)
      }
    })
    return await this.agentSessionSnapshot(sessionId)
  }

  async applyMemberMode(sessionId: string, runtime: Runtime): Promise<void> {
    const intent = await this.access.storage?.readModeIntent(sessionId)
    if (intent === undefined) return
    const binding = await this.access.storage?.readLatestBinding(sessionId)
    if (binding?.status !== 'ok' || intent.bindingKey !== modeIntentBindingKey(binding.binding)) {
      await this.access.storage?.clearModeIntent(sessionId, intent)
      return
    }
    const choice = teamModeChoices(this.liveAgentSessionSnapshot(sessionId, runtime)).find(
      (choice) => choice.id === intent.modeId,
    )
    if (choice === undefined)
      throw new LlmError(
        'The saved member mode is no longer supported; choose another mode before continuing',
        'ACP_CONFIG_UNSUPPORTED',
      )
    this.assertRuntimeOwner(sessionId, runtime)
    if (!choice.current) {
      if (choice.write.kind === 'mode') {
        if (!runtime.setMode) throw new LlmError('Agent mode control is unavailable', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setMode(choice.write.id)
      } else {
        if (!runtime.setConfigOption) throw new LlmError('Agent mode control is unavailable', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setConfigOption(choice.write.id, choice.write.value)
      }
      if (
        !teamModeChoices(this.liveAgentSessionSnapshot(sessionId, runtime)).some(
          (choice) => choice.id === intent.modeId && choice.current,
        )
      )
        throw new LlmError('Agent did not confirm the saved member mode', 'ACP_CONFIG_SYNC_FAILED')
    }
    this.assertRuntimeOwner(sessionId, runtime)
    await this.access.persistSnapshot(sessionId, runtime)
    this.rememberConfirmedUserMode(
      sessionId,
      runtime,
      choice.write.kind === 'mode'
        ? { kind: 'legacy', id: choice.write.id }
        : { kind: 'config', id: choice.write.id, value: choice.write.value },
      binding.binding,
    )
    // Consume only the confirmed choice. A later user selection must survive this completion.
    await this.access.storage?.clearModeIntent(sessionId, intent)
    this.access.changed(sessionId)
  }

  private async readAgentSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshotView> {
    const runtime = this.access.runtime(sessionId)
    if (runtime !== undefined) return this.liveAgentSessionSnapshot(sessionId, runtime)
    if (this.access.storage === undefined) throw new LlmError('ACP sidecar is unavailable', 'ACP_BINDING_UNAVAILABLE')
    const lookup = await this.access.storage.readLatestBinding(sessionId)
    if (lookup?.status !== 'ok')
      throw new LlmError('No established ACP Agent session is available', 'ACP_SESSION_UNAVAILABLE')
    const snapshot = await this.access.storage.readOptionSnapshot(sessionId)
    if (snapshot === undefined)
      throw new LlmError('No last-known Agent session controls are available', 'ACP_SESSION_OPTIONS_UNAVAILABLE')
    const configOptions = snapshot.options.map((option) =>
      typeof option.value === 'boolean'
        ? {
            type: 'boolean' as const,
            id: option.id,
            name: option.name,
            ...(option.category === null ? {} : { category: option.category }),
            currentValue: option.value,
          }
        : {
            type: 'select' as const,
            id: option.id,
            name: option.name,
            ...(option.category === null ? {} : { category: option.category }),
            currentValue: option.value,
            options: (option.values ?? []).map((value) => ({
              value,
              name:
                (normalizeAcpConfigOptionKey(option.id) === 'mode' ||
                normalizeAcpConfigOptionKey(option.category ?? '') === 'mode'
                  ? snapshot.modes?.availableModes.find((mode) => mode.id === value)?.name
                  : undefined) ?? value,
            })),
          },
    )
    return {
      sessionId,
      profileId: this.profileId,
      freshness: 'stale',
      editable: false,
      configOptions,
      modes: snapshot.modes?.availableModes ?? null,
      currentModeId: snapshot.currentModeId,
      contextUsage:
        snapshot.contextUsage === undefined || snapshot.contextUsage === null
          ? null
          : {
              used: snapshot.contextUsage.used,
              size: snapshot.contextUsage.size,
              percent:
                snapshot.contextUsage.size > 0
                  ? Math.round((snapshot.contextUsage.used / snapshot.contextUsage.size) * 1000) / 10
                  : 0,
              cost: snapshot.contextUsage.cost ?? null,
            },
      note: 'Last known Agent session state; controls are read-only until the Agent reconnects.',
    }
  }

  async setAgentSessionOption(sessionId: string, request: AgentSessionOptionWrite): Promise<AgentSessionSnapshotView> {
    return await this.serializeSessionControlWrite(sessionId, async () => {
      const runtime = this.access.runtime(sessionId)
      if (runtime === undefined || this.access.handoffPending(sessionId))
        throw new LlmError('Agent session is not live or is currently running', 'ACP_SESSION_OPTIONS_READ_ONLY')
      this.assertRuntime(sessionId, runtime)
      await this.access.restoreCancelledRuntime(sessionId, runtime)
      this.assertRuntime(sessionId, runtime)
      const selectionBeforeWrite = this.modeSelectionForRequest(runtime, request)
      const selectionBindingBefore =
        selectionBeforeWrite === undefined ? undefined : await this.readBindingForUserMode(sessionId)
      if (selectionBeforeWrite !== undefined && selectionBindingBefore === undefined)
        throw new LlmError('The ACP session binding is unavailable for this mode change', 'ACP_BINDING_UNAVAILABLE')
      this.assertRuntime(sessionId, runtime)
      if (request.kind === 'mode') {
        if (runtime.setMode === undefined)
          throw new LlmError('This Agent does not expose mode controls', 'ACP_CONFIG_UNSUPPORTED')
        if (runtime.modes === undefined || !runtime.modes.availableModes.some((mode) => mode.id === request.id))
          throw new LlmError(`Agent mode "${request.id}" is not available`, 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setMode(request.id)
      } else {
        const option = runtime.configOptions?.find((candidate) => candidate.id === request.id)
        if (option === undefined || isAcpModelOrReasoningOption(option)) {
          throw new LlmError(
            'Model and reasoning controls are managed by the DSH model picker',
            'ACP_CONFIG_UNSUPPORTED',
          )
        }
        if (
          option.type === 'select' &&
          (typeof request.value !== 'string' || !acpSelectValues(option).has(request.value))
        )
          throw new LlmError(`Agent option "${request.id}" does not allow that value`, 'ACP_CONFIG_UNSUPPORTED')
        if (option.type === 'boolean' && typeof request.value !== 'boolean')
          throw new LlmError(`Agent option "${request.id}" expects a boolean`, 'ACP_CONFIG_UNSUPPORTED')
        if (runtime.setConfigOption === undefined)
          throw new LlmError('This Agent does not expose session controls', 'ACP_CONFIG_UNSUPPORTED')
        await runtime.setConfigOption(request.id, request.value)
      }
      this.assertRuntimeOwner(sessionId, runtime)
      if (
        request.kind === 'mode' ||
        runtime.configOptions?.some(
          (option) =>
            option.id === request.id &&
            (normalizeAcpConfigOptionKey(option.id) === 'mode' ||
              normalizeAcpConfigOptionKey(option.category ?? '') === 'mode'),
        )
      ) {
        const intent = await this.access.storage?.readModeIntent(sessionId)
        if (intent !== undefined) await this.access.storage?.clearModeIntent(sessionId, intent)
      }
      await this.access.persistSnapshot(sessionId, runtime)
      if (selectionBeforeWrite !== undefined) {
        if (!this.confirmedModeSelection(runtime, selectionBeforeWrite))
          throw new LlmError('Agent did not confirm the selected mode', 'ACP_CONFIG_SYNC_FAILED')
        const bindingAfter = await this.readBindingForUserMode(sessionId)
        if (
          bindingAfter === undefined ||
          modeIntentBindingKey(bindingAfter) !== modeIntentBindingKey(selectionBindingBefore!)
        )
          throw new LlmError('The ACP session binding changed while saving its mode', 'ACP_BINDING_UNAVAILABLE')
        this.rememberConfirmedUserMode(sessionId, runtime, selectionBeforeWrite, bindingAfter)
      }
      return this.liveAgentSessionSnapshot(sessionId, runtime)
    })
  }

  private modeSelectionForRequest(runtime: Runtime, request: AgentSessionOptionWrite): UserModeChoice | undefined {
    if (request.kind === 'mode') return { kind: 'legacy', id: request.id }
    const option = runtime.configOptions?.find((candidate) => candidate.id === request.id)
    if (
      option === undefined ||
      (normalizeAcpConfigOptionKey(option.id) !== 'mode' &&
        normalizeAcpConfigOptionKey(option.category ?? '') !== 'mode')
    )
      return undefined
    if (typeof request.value !== 'string') return undefined
    return { kind: 'config', id: request.id, value: request.value }
  }

  private async readBindingForUserMode(sessionId: string): Promise<AcpBindingData | undefined> {
    const lookup = await this.access.storage?.readLatestBinding(sessionId)
    if (
      lookup?.status !== 'ok' ||
      lookup.binding.provider !== `acp-${this.profileId}` ||
      lookup.binding.profileId !== this.profileId
    )
      return undefined
    return lookup.binding
  }

  private rememberConfirmedUserMode(
    sessionId: string,
    runtime: Runtime,
    selection: UserModeChoice,
    binding: AcpBindingData,
  ): void {
    const owner = this.access.owner(runtime)
    if (owner === undefined) {
      this.confirmedModes.delete(sessionId)
      return
    }
    this.assertRuntimeOwner(sessionId, runtime)
    this.confirmedModes.set(sessionId, {
      ...selection,
      bindingKey: modeIntentBindingKey(binding),
      agentSessionId: binding.agentSessionId,
      owner,
      needsRestore: false,
    })
  }

  markConfirmedUserModeForRestore(sessionId: string, runtime: Runtime): void {
    if (runtime.cancelledSessionRefreshPending !== true) return
    const selection = this.confirmedModes.get(sessionId)
    if (
      selection === undefined ||
      selection.agentSessionId !== runtime.cancelledSessionRefreshBindingId ||
      selection.owner !== this.access.owner(runtime)
    )
      return
    // A vendor may change modes while handling the turn. Preserve only the
    // last mode the user explicitly selected; never overwrite a newer Agent
    // mode update with that older choice after the cancelled session reloads.
    if (!this.confirmedModeSelection(runtime, selection)) {
      this.confirmedModes.delete(sessionId)
      return
    }
    this.confirmedModes.set(sessionId, { ...selection, needsRestore: true })
  }

  private confirmedModeSelection(runtime: Runtime, selection: UserModeChoice): boolean {
    if (selection.kind === 'legacy') return (runtime.currentModeId ?? runtime.modes?.currentModeId) === selection.id
    return (
      runtime.configOptions?.some((option) => option.id === selection.id && option.currentValue === selection.value) ===
      true
    )
  }

  async restoreConfirmedUserMode(sessionId: string, runtime: Runtime, binding: AcpBindingData): Promise<boolean> {
    const selection = this.confirmedModes.get(sessionId)
    if (selection === undefined) return true
    if (
      selection.bindingKey !== modeIntentBindingKey(binding) ||
      selection.agentSessionId !== binding.agentSessionId ||
      selection.owner !== this.access.owner(runtime)
    ) {
      this.confirmedModes.delete(sessionId)
      return true
    }
    if (!selection.needsRestore) return true
    if (selection.kind === 'legacy') {
      if (!runtime.modes?.availableModes.some((mode) => mode.id === selection.id)) return false
      if ((runtime.currentModeId ?? runtime.modes.currentModeId) !== selection.id) {
        if (runtime.setMode === undefined) return false
        await runtime.setMode(selection.id)
      }
    } else {
      const option = runtime.configOptions?.find((candidate) => candidate.id === selection.id)
      if (option === undefined || option.type !== 'select' || !acpSelectValues(option).has(String(selection.value)))
        return false
      if (option.currentValue !== selection.value) {
        if (runtime.setConfigOption === undefined) return false
        await runtime.setConfigOption(selection.id, selection.value!)
      }
    }
    if (!this.confirmedModeSelection(runtime, selection)) return false
    this.confirmedModes.set(sessionId, { ...selection, needsRestore: false })
    return true
  }

  private async serializeSessionControlWrite<T>(
    sessionId: string,
    operation: (owner: object | undefined) => Promise<T>,
  ): Promise<T> {
    const owner = this.access.sessionOwner(sessionId)
    this.assertAdmission(owner)
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.writes.set(sessionId, tail)
    await previous
    try {
      this.assertAdmission(owner)
      this.assertSessionOwner(sessionId, owner)
      return await operation(owner)
    } finally {
      release()
      if (this.writes.get(sessionId) === tail) this.writes.delete(sessionId)
    }
  }

  async waitForSessionControlWrite(sessionId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.writes.get(sessionId)
    if (pending === undefined) return
    if (signal?.aborted === true) signal.throwIfAborted()
    if (signal === undefined) return await pending
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      signal.throwIfAborted()
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private liveAgentSessionSnapshot(sessionId: string, runtime: Runtime): AgentSessionSnapshotView {
    const options =
      runtime.configOptions === undefined
        ? null
        : runtime.configOptions.map((option) => {
            if (option.type === 'boolean')
              return {
                type: 'boolean' as const,
                id: option.id,
                name: option.name,
                ...(option.description === undefined ? {} : { description: option.description }),
                ...(option.category === undefined ? {} : { category: option.category }),
                currentValue: option.currentValue,
              }
            return {
              type: 'select' as const,
              id: option.id,
              name: option.name,
              ...(option.description === undefined ? {} : { description: option.description }),
              ...(option.category === undefined ? {} : { category: option.category }),
              currentValue: option.currentValue,
              options: option.options.map((entry) =>
                'options' in entry
                  ? {
                      group: entry.group,
                      name: entry.name,
                      options: entry.options.map((value) => ({
                        value: value.value,
                        name: value.name,
                        ...(value.description === undefined ? {} : { description: value.description }),
                      })),
                    }
                  : {
                      value: entry.value,
                      name: entry.name,
                      ...(entry.description === undefined ? {} : { description: entry.description }),
                    },
              ),
            }
          })
    const modes: readonly AgentSessionModeView[] | null =
      runtime.modes?.availableModes?.map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(mode.description === undefined ? {} : { description: mode.description }),
      })) ?? null
    const usage = runtime.contextUsage
    return {
      sessionId,
      profileId: this.profileId,
      freshness: 'live',
      editable: runtime.isBusy !== true,
      configOptions: options,
      modes,
      currentModeId: runtime.currentModeId ?? runtime.modes?.currentModeId ?? null,
      contextUsage:
        usage === undefined
          ? null
          : {
              used: usage.used,
              size: usage.size,
              percent: usage.size > 0 ? Math.round((usage.used / usage.size) * 1000) / 10 : 0,
              cost: usage.cost === undefined ? null : usage.cost,
            },
      note: null,
    }
  }

  /** Directory handoff keeps the same Host owner and requires an explicit mode restore. */
  advanceBinding(sessionId: string, previous: AcpBindingData, next: AcpBindingData): void {
    const mode = this.confirmedModes.get(sessionId)
    if (mode !== undefined && mode.agentSessionId === previous.agentSessionId)
      this.confirmedModes.set(sessionId, {
        ...mode,
        bindingKey: modeIntentBindingKey(next),
        agentSessionId: next.agentSessionId,
        needsRestore: true,
      })
  }

  needsModeRestore(sessionId: string, binding: AcpBindingData | undefined): boolean {
    const mode = this.confirmedModes.get(sessionId)
    if (mode === undefined || binding === undefined) return false
    if (mode.bindingKey !== modeIntentBindingKey(binding) || mode.agentSessionId !== binding.agentSessionId) {
      this.confirmedModes.delete(sessionId)
      return false
    }
    return mode.needsRestore
  }

  forget(sessionId: string): void {
    this.confirmedModes.delete(sessionId)
  }

  /** Fence this exact owner's controls until its runtime cleanup has finished.
   * A dormant member can retain its Host Session after releasing its runtime. */
  async retireSession(sessionId: string, owner: object): Promise<() => void> {
    const previous = this.retiringOwners.get(owner) ?? 0
    this.retiringOwners.set(owner, previous + 1)
    if (previous === 0) this.notifyControlAvailability(sessionId)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const remaining = this.retiringOwners.get(owner)! - 1
      if (remaining === 0) {
        this.retiringOwners.delete(owner)
        this.notifyControlAvailability(sessionId)
      } else this.retiringOwners.set(owner, remaining)
    }
    try {
      await this.waitForSessionControlWrite(sessionId)
      if (this.confirmedModes.get(sessionId)?.owner === owner) this.confirmedModes.delete(sessionId)
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  /** Stop queued/future writes, then keep dependencies alive until accepted writes finish. */
  async close(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.writes.values()])
    this.confirmedModes.clear()
  }

  private assertAdmission(owner: object | undefined): void {
    if (!this.admitsOwner(owner))
      throw new LlmError('Agent session controls are closing', 'ACP_SESSION_OPTIONS_READ_ONLY')
  }

  private admitsOwner(owner: object | undefined): boolean {
    return this.accepting && (owner === undefined || !this.retiringOwners.has(owner))
  }

  private notifyControlAvailability(sessionId: string): void {
    try {
      this.access.changed(sessionId)
    } catch {
      /* A UI observer cannot interrupt the owner's control or runtime cleanup. */
    }
  }

  private assertSessionOwner(sessionId: string, owner: object | undefined): void {
    if (this.access.sessionOwner(sessionId) !== owner)
      throw new LlmError(
        'Agent session owner changed before its controls could be written',
        'ACP_SESSION_OPTIONS_READ_ONLY',
      )
  }

  /** Completion may drain after close, but never publish a choice under a replacement Host owner. */
  private assertRuntimeOwner(sessionId: string, runtime: Runtime): void {
    const owner = this.access.sessionOwner(sessionId)
    if (this.access.runtime(sessionId) !== runtime || (owner !== undefined && this.access.owner(runtime) !== owner))
      throw new LlmError('Agent session owner changed while configuring its controls', 'ACP_SESSION_OPTIONS_READ_ONLY')
  }

  private assertRuntime(sessionId: string, runtime: Runtime): void {
    const owner = this.access.sessionOwner(sessionId)
    this.assertAdmission(owner)
    if (
      this.access.runtime(sessionId) !== runtime ||
      runtime.isBusy === true ||
      (owner !== undefined && this.access.owner(runtime) !== owner)
    )
      throw new LlmError(
        'Agent session changed or started running; retry after it settles',
        'ACP_SESSION_OPTIONS_READ_ONLY',
      )
  }
}

/** Flatten ACP select values without assuming whether the agent groups them. */
export function acpSelectValues(option: acp.SessionConfigOption | undefined): Set<string> {
  if (option?.type !== 'select') return new Set()
  return new Set(
    option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry])).map((entry) => entry.value),
  )
}
