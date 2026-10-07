export type NativeReadSource = {
  readonly absolutePath: string
  readonly relativePath: string
  readonly content: string
}

export type NativeReadEvidence = {
  readonly session: string
  readonly callId: string
  readonly path: string
  readonly matchedLines: number
  readonly verified: true
}

type ReadObserverOptions = {
  readonly activeSessionId: string | undefined
  readonly sessionEvidenceId?: string
  readonly sources: readonly NativeReadSource[]
  readonly hashIdentifier: (kind: string, value: string) => string
}

type CallSnapshot = {
  kind?: string
  status?: string
  failed: boolean
  inputPaths: Set<string>
  locationPaths: Set<string>
  outputText: string
}

const MAX_UPDATE_TEXT_BYTES = 64 * 1024
const MAX_TYPED_TEXT_NODES = 64

export function wrapObservedCallback<Args extends unknown[], Result>(
  original: (this: unknown, ...args: Args) => Result,
  observe: (first: Args[0]) => void,
  onObserverFailure: () => void,
): (this: unknown, ...args: Args) => Result {
  return function (this: unknown, ...args: Args): Result {
    try {
      observe(args[0])
    } catch {
      onObserverFailure()
    }
    return original.apply(this, args)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function knownPaths(rawInput: unknown): Set<string> {
  if (!isRecord(rawInput)) return new Set()
  const candidates: unknown[] = []
  for (const key of ['path', 'file_path', 'filePath']) candidates.push(rawInput[key])
  const addFileArray = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value.slice(0, 32)) {
      if (typeof entry === 'string') candidates.push(entry)
      else if (isRecord(entry)) {
        candidates.push(entry.path, entry.file_path, entry.filePath)
      }
    }
  }
  addFileArray(rawInput.files)
  addFileArray(rawInput.file_paths)
  return new Set(
    candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 4096),
  )
}

function knownLocationPaths(locations: unknown): Set<string> {
  if (!Array.isArray(locations)) return new Set()
  return new Set(
    locations
      .slice(0, 32)
      .map((location) => (isRecord(location) ? location.path : undefined))
      .filter((path): path is string => typeof path === 'string' && path.length <= 4096),
  )
}

function typedText(value: unknown, output: string[]): void {
  const remaining = (): number => MAX_UPDATE_TEXT_BYTES - output.reduce((sum, item) => sum + item.length, 0)
  if (output.length >= MAX_TYPED_TEXT_NODES || remaining() <= 0) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_TYPED_TEXT_NODES - output.length)) typedText(item, output)
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'text' && typeof value.text === 'string') {
    output.push(value.text.slice(0, remaining()))
    return
  }
  if (value.type === 'content') {
    typedText(value.content, output)
    return
  }
  if (value.type === 'resource') {
    const resource = value.resource
    if (isRecord(resource) && typeof resource.text === 'string') output.push(resource.text.slice(0, remaining()))
  }
}

function isInformativeSourceLine(line: string): boolean {
  return line.length >= 12 && !/^(?:\/\/|\/\*|\*|\*\/|#)/u.test(line) && !/^[{}()[\]<>;,.:]+$/u.test(line)
}

function matchedSourceLines(source: string, outputText: string, uniqueLines: ReadonlySet<string>): number {
  const candidates = new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => isInformativeSourceLine(line) && uniqueLines.has(line)),
  )
  if (candidates.size === 0) return 0
  const returned = new Set(
    outputText
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*(?:L)?\d+\s*[:|]\s*/u, '').trim())
      .filter((line) => line.length >= 12),
  )
  let matched = 0
  for (const line of candidates) if (returned.has(line)) matched += 1
  return matched
}

/** Collects only current-prompt, allowlisted native read evidence; raw tool input/output is never returned. */
export function createNativeReadObserver(
  options: ReadObserverOptions,
): (notification: unknown) => NativeReadEvidence[] {
  const activeSessionId = options.activeSessionId
  const sources = new Map(options.sources.map((source) => [source.absolutePath, source]))
  const allowed = new Set(sources.keys())
  const lineFrequency = new Map<string, number>()
  for (const source of options.sources) {
    const lines = new Set(
      source.content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(isInformativeSourceLine),
    )
    for (const line of lines) lineFrequency.set(line, (lineFrequency.get(line) ?? 0) + 1)
  }
  const uniqueLinesByPath = new Map(
    options.sources.map((source) => [
      source.absolutePath,
      new Set(
        source.content
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => isInformativeSourceLine(line) && lineFrequency.get(line) === 1),
      ),
    ]),
  )
  const calls = new Map<string, CallSnapshot>()
  const evidenceByCall = new Map<string, Set<string>>()

  return (notification: unknown): NativeReadEvidence[] => {
    if (!isRecord(notification) || notification.sessionId !== activeSessionId || !isRecord(notification.update))
      return []
    const update = notification.update
    if (
      (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') ||
      typeof update.toolCallId !== 'string' ||
      update.toolCallId.length === 0
    )
      return []
    const callId = update.toolCallId
    let snapshot = calls.get(callId)
    if (snapshot === undefined) {
      snapshot = {
        failed: false,
        inputPaths: new Set(),
        locationPaths: new Set(),
        outputText: '',
      }
      calls.set(callId, snapshot)
    }
    if (typeof update.kind === 'string') snapshot.kind = update.kind
    if (typeof update.status === 'string') snapshot.status = update.status
    if (update.rawInput !== undefined && update.rawInput !== null) {
      snapshot.inputPaths = new Set([...snapshot.inputPaths, ...knownPaths(update.rawInput)])
    }
    if (update.locations !== undefined && update.locations !== null) {
      snapshot.locationPaths = new Set([...snapshot.locationPaths, ...knownLocationPaths(update.locations)])
    }
    if (update.isError === true || update.error !== undefined) snapshot.failed = true
    if (isRecord(update.rawOutput) && update.rawOutput.isError === true) snapshot.failed = true
    const textParts: string[] = []
    if (update.content !== undefined && update.content !== null) typedText(update.content, textParts)
    if (update.rawOutput !== undefined && update.rawOutput !== null) typedText(update.rawOutput, textParts)
    if (textParts.length > 0)
      snapshot.outputText = `${snapshot.outputText}\n${textParts.join('\n')}`.slice(0, MAX_UPDATE_TEXT_BYTES)
    if (snapshot.kind !== 'read' || snapshot.status !== 'completed' || snapshot.failed) return []

    const callEvidence = evidenceByCall.get(callId) ?? new Set<string>()
    evidenceByCall.set(callId, callEvidence)
    const result: NativeReadEvidence[] = []
    const declaredPaths =
      snapshot.inputPaths.size > 0 && snapshot.locationPaths.size > 0
        ? [...snapshot.inputPaths].filter((path) => snapshot.locationPaths.has(path))
        : snapshot.inputPaths.size > 0
          ? [...snapshot.inputPaths]
          : [...snapshot.locationPaths]
    for (const path of declaredPaths) {
      if (!allowed.has(path) || callEvidence.has(path)) continue
      const source = sources.get(path)
      if (source === undefined) continue
      const matchedLines = matchedSourceLines(
        source.content,
        snapshot.outputText,
        uniqueLinesByPath.get(path) ?? new Set(),
      )
      if (matchedLines < 2) continue
      callEvidence.add(path)
      result.push({
        session: options.hashIdentifier('dsh-session', options.sessionEvidenceId ?? activeSessionId ?? ''),
        callId: options.hashIdentifier('acp-tool-call', callId),
        path: source.relativePath,
        matchedLines,
        verified: true,
      })
    }
    return result
  }
}
