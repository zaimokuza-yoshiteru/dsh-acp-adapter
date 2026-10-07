import type { LongTaskScene } from './live-long-task-budget.ts'

export type ExecuteRegistration = {
  readonly scene: LongTaskScene
  readonly ownerDshSessionId: string
  readonly operation: string
  readonly command: string
}

export type NativeExecuteEvidence = {
  readonly scene: LongTaskScene
  readonly owner: string
  readonly session: string
  readonly callId: string
  readonly operation: string
  readonly commandFingerprint: string
  readonly status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'unexpected'
}

export type ExecutionRoute = 'host-tool' | 'native-execute' | 'not-dispatched' | 'unknown'

export function classifyExecutionRoute(input: {
  readonly decision: 'allow' | 'reject'
  readonly hostAdmissions: number
  readonly hostResults: readonly { readonly isError: boolean }[]
  readonly nativeCalls: readonly NativeExecuteEvidence[]
  readonly fileExists: boolean
  readonly fileContents: string | undefined
  readonly expectedContents: string
}): ExecutionRoute {
  if (input.hostAdmissions > 0) {
    if (input.hostAdmissions !== 1 || input.hostResults.length !== 1) return 'unknown'
    const hostResult = input.hostResults[0]
    if (hostResult === undefined) return 'unknown'
    if (input.decision === 'allow' && !hostResult.isError && input.fileContents === input.expectedContents)
      return 'host-tool'
    if (input.decision === 'reject' && hostResult.isError && !input.fileExists) return 'host-tool'
    return 'unknown'
  }
  if (input.hostResults.length !== 0) return 'unknown'
  if (input.decision === 'reject' && !input.fileExists) {
    if (input.nativeCalls.length === 0) return 'not-dispatched'
    if (
      input.nativeCalls.length === 1 &&
      (input.nativeCalls[0]?.status === 'failed' || input.nativeCalls[0]?.status === 'cancelled')
    )
      return 'not-dispatched'
    return 'unknown'
  }
  if (
    input.decision === 'allow' &&
    input.fileExists &&
    input.fileContents === input.expectedContents &&
    input.nativeCalls.length === 1 &&
    input.nativeCalls[0]?.status === 'completed'
  )
    return 'native-execute'
  return 'unknown'
}

type MutableEvidence = {
  scene: LongTaskScene
  owner: string
  session: string
  callId: string
  operation: string
  commandFingerprint: string
  status: NativeExecuteEvidence['status']
  command: string
  ownerDshSessionId: string
  acpSessionId: string
}

type ObserverOptions = {
  readonly registrations: () => readonly ExecuteRegistration[]
  readonly hashIdentifier: (kind: string, value: string) => string
  readonly onViolation: (code: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirrors the adapter's finite command/cmd/argv extraction; never serializes raw input. */
export function nativeExecuteCommand(rawInput: unknown): string | undefined {
  if (typeof rawInput === 'string' && rawInput.trim() !== '') return rawInput
  if (!isRecord(rawInput)) return undefined
  for (const key of ['command', 'cmd', 'argv']) {
    const value = rawInput[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

export function createNativeExecuteObserver(options: ObserverOptions) {
  const evidenceByKey = new Map<string, MutableEvidence>()
  const requestedOperations = new Set<string>()

  const violation = (code: string): void => options.onViolation(code)
  const requestKey = (ownerDshSessionId: string, sessionId: string, callId: string): string =>
    JSON.stringify([ownerDshSessionId, sessionId, callId])
  const operationKey = (scene: LongTaskScene, owner: string, operation: string): string =>
    `${scene}\0${owner}\0${operation}`

  const observePermission = (
    params: unknown,
    context: {
      readonly scene: LongTaskScene
      readonly ownerDshSessionId: string | undefined
      readonly activeAcpSessionId: string | undefined
    },
  ): void => {
    if (!isRecord(params) || !isRecord(params.toolCall)) return
    const toolCall = params.toolCall
    if (toolCall.kind !== 'execute') return
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (sessionId === undefined || sessionId !== context.activeAcpSessionId) return
    const callId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined
    const command = nativeExecuteCommand(toolCall.rawInput)
    if (callId === undefined || callId.length === 0 || command === undefined) {
      violation('LONG_TASK_NATIVE_EXECUTE_REQUEST_MALFORMED')
      return
    }
    const owner = context.ownerDshSessionId
    const registration = options
      .registrations()
      .find(
        (candidate) =>
          candidate.scene === context.scene && candidate.ownerDshSessionId === owner && candidate.command === command,
      )
    const key = requestKey(owner ?? '', sessionId, callId)
    const opKey =
      registration === undefined ? undefined : operationKey(registration.scene, owner ?? '', registration.operation)
    const repeatedCall = evidenceByKey.has(key)
    const repeatedOperation = opKey !== undefined && requestedOperations.has(opKey)
    // Strict test-only duplicate-dispatch protection: any second request for
    // this registered command is rejected, regardless of call ID or prior
    // status. This does not establish whether a model or vendor retried it.
    const entry: MutableEvidence = {
      scene: context.scene,
      owner: options.hashIdentifier('dsh-session', owner ?? ''),
      session: options.hashIdentifier('acp-session', sessionId),
      callId: options.hashIdentifier('acp-tool-call', callId),
      operation: registration?.operation ?? 'unregistered',
      commandFingerprint: options.hashIdentifier('native-command', command),
      status: registration === undefined || repeatedCall || repeatedOperation ? 'unexpected' : 'pending',
      command,
      ownerDshSessionId: owner ?? '',
      acpSessionId: sessionId,
    }
    if (registration === undefined) violation('LONG_TASK_NATIVE_EXECUTE_UNREGISTERED')
    else if (repeatedCall || repeatedOperation) violation('LONG_TASK_NATIVE_EXECUTE_DUPLICATE_REQUEST')
    if (!repeatedCall) evidenceByKey.set(key, entry)
    if (opKey !== undefined) requestedOperations.add(opKey)
  }

  const observeUpdate = (
    notification: unknown,
    context: { readonly scene: LongTaskScene; readonly ownerDshSessionId: string | undefined },
  ): void => {
    if (!isRecord(notification) || !isRecord(notification.update)) return
    const sessionId = typeof notification.sessionId === 'string' ? notification.sessionId : undefined
    const update = notification.update
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
    if (sessionId === undefined || callId === undefined) return
    const evidence = evidenceByKey.get(requestKey(context.ownerDshSessionId ?? '', sessionId, callId))
    if (
      evidence === undefined ||
      evidence.scene !== context.scene ||
      evidence.ownerDshSessionId !== (context.ownerDshSessionId ?? '') ||
      evidence.acpSessionId !== sessionId
    )
      return
    if (update.kind !== undefined && update.kind !== 'execute') return
    const hasError =
      update.isError === true ||
      (update.error !== undefined && update.error !== null && update.error !== false) ||
      (isRecord(update.rawOutput) && update.rawOutput.isError === true)
    const nextStatus =
      update.status === 'completed'
        ? hasError
          ? 'unexpected'
          : 'completed'
        : update.status === 'failed'
          ? 'failed'
          : update.status === 'cancelled' || update.status === 'canceled' || update.status === 'aborted'
            ? 'cancelled'
            : undefined
    if (nextStatus === undefined) return
    if (nextStatus === 'unexpected') {
      evidence.status = 'unexpected'
      violation('LONG_TASK_NATIVE_EXECUTE_COMPLETED_WITH_ERROR')
      return
    }
    if (evidence.status !== 'pending' && evidence.status !== nextStatus) {
      evidence.status = 'unexpected'
      violation('LONG_TASK_NATIVE_EXECUTE_STATUS_CONFLICT')
      return
    }
    evidence.status = nextStatus
  }

  const matchApproval = (input: {
    readonly scene: LongTaskScene
    readonly ownerDshSessionId: string
    readonly operation: string
    readonly reason: string | undefined
    readonly cardText: string
  }): NativeExecuteEvidence | undefined => {
    const reason = input.reason
    if (reason === undefined) return undefined
    const matches = [...evidenceByKey.values()].filter(
      (entry) =>
        entry.scene === input.scene &&
        entry.ownerDshSessionId === input.ownerDshSessionId &&
        entry.operation === input.operation &&
        entry.status !== 'unexpected' &&
        reason.includes(entry.command) &&
        input.cardText.includes(entry.command),
    )
    return matches.length === 1 ? safeEvidence(matches[0]!) : undefined
  }

  const evidence = (): NativeExecuteEvidence[] => [...evidenceByKey.values()].map(safeEvidence)

  function safeEvidence(entry: MutableEvidence): NativeExecuteEvidence {
    const { scene, owner, session, callId, operation, commandFingerprint, status } = entry
    return { scene, owner, session, callId, operation, commandFingerprint, status }
  }

  return { observePermission, observeUpdate, matchApproval, evidence }
}
