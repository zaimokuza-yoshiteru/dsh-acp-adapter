export type LongTurnKind =
  'markdown' | 'reasoning' | 'fixture-tool' | 'read' | 'edit' | 'run-code' | 'present' | 'failed-read'

export interface LongTurnSpec {
  readonly index: number
  readonly marker: string
  readonly kind: LongTurnKind
  readonly deltas: readonly string[]
}

export const LONG_CONVERSATION_TURNS = 100

/** One shared work script for the native LLM adapter and the ACP fixture. */
export function longTurnSpec(index: number, turnCount = LONG_CONVERSATION_TURNS): LongTurnSpec {
  const marker = `LONG_FLOW_${String(index).padStart(3, '0')}`
  let kind: LongTurnKind = 'markdown'
  if (index === 2 || index % 13 === 0) kind = 'reasoning'
  if (index === 5 || index === 25) kind = 'fixture-tool'
  if (index === 6) kind = 'read'
  if (index === 7) kind = 'edit'
  if (index === 8) kind = 'run-code'
  if (index === 9) kind = 'present'
  if (index === 10) kind = 'failed-read'

  const count = index === turnCount ? 36 : 4
  const deltas = Array.from({ length: count }, (_, chunk) => {
    if (chunk === 0) return `${marker}_FIRST\n\n`
    if (chunk === count - 1) return `${marker}_DONE.`
    const section = `Evidence ${String(index)}.${String(chunk)}`
    switch ((chunk - 1) % 3) {
      case 0:
        return `## ${section}\n\nKeep decision-${String(index)} stable; **verify** each finding.\n\n`
      case 1:
        return `| Check | Result |\n| --- | --- |\n| prior requirement | retained |\n| sample ${String(index)} | verified |\n\n- Keep the earlier constraint.\n- Record the new evidence.\n\n`
      default:
        return `> Decision-${String(index)} remains stable while this stream continues.\n\n\`\`\`ts\nconst evidence = { turn: ${String(index)}, section: '${section}' }\nreturn evidence\n\`\`\`\n\n`
    }
  })
  return { index, marker, kind, deltas }
}

export function parseLongTurn(text: string): number | undefined {
  const match = /E2E_LONG_CONVERSATION\s+turn=(\d+)/.exec(text)
  if (match === null) return undefined
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index > 0 ? index : undefined
}

export const LONG_FLOW_FILE = 'long-flow-target.txt'
export const LONG_FLOW_DELIVERY = 'long-flow-delivery.txt'
