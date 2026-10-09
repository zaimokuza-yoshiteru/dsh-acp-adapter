/** Read native peer-message attribution without relying on model-facing send tool results. */
export interface DevinPeerMessage {
  readonly kind: 'agent-message' | 'team-message'
  readonly id: string
  readonly senderId: string
  readonly text: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * Read a current native inbox relay or a historical mailbox delivery.
 * The caller supplies acceptance/claim evidence from the actual Host event;
 * this projection never says the receiving model has processed the message.
 */
export function devinPeerMessageOf(value: unknown): DevinPeerMessage | undefined {
  if (!record(value) || !record(value.source) || !Array.isArray(value.content)) return undefined
  const source = value.source
  let kind: DevinPeerMessage['kind']
  let id: string
  let senderId: string
  if (source.kind === 'agent-message') {
    if (source.form !== 'relay' || !identity(source.senderSessionId) || !identity(value.id)) return undefined
    kind = source.kind
    id = value.id
    senderId = source.senderSessionId
  } else if (source.kind === 'team-message') {
    if (!identity(source.messageId) || !identity(source.senderId)) return undefined
    kind = source.kind
    id = source.messageId
    senderId = source.senderId
  } else return undefined

  let content = value.content
  const first: unknown = content[0]
  // These are the exact native Team/adjacent-Agent framing blocks, separate
  // from the sender-authored content used by the test's reply-marker proof.
  if (kind === 'agent-message' && record(first) && first.type === 'text' && typeof first.text === 'string') {
    if (/^Team message from [^\r\n]+:$/u.test(first.text) || first.text === `Agent ${senderId} sent a message: `)
      content = content.slice(1)
  }
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        record(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('')
  return { kind, id, senderId, text }
}
