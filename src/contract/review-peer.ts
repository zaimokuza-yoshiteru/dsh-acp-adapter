import type { Implementation } from '@agentclientprotocol/sdk'

const peers = {
  devin: { name: 'affogato', title: 'Devin Agent', version: '3000.14.30821' },
  opencode: { name: 'OpenCode', title: undefined, version: '2.3.2' },
} as const

export type ReviewAgent = keyof typeof peers

/** Only an identified CLI with a concrete release version can report a version mismatch. */
export function reviewPeerStatus(agent: ReviewAgent, info: Implementation | null | undefined) {
  const peer = peers[agent]
  if (!info || info.name !== peer.name || (peer.title !== undefined && info.title !== peer.title)) return undefined
  if (info.version === peer.version) return 'verified'
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(info.version) ? 'unsupported-version' : undefined
}
