import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_SHARD_COUNT = 3
export const NATIVE_PARITY_FILE = 'test/e2e/native-parity.e2e.ts'
export const NATIVE_PARITY_PROFILES = ['claude', 'codex', 'devin', 'kimi'] as const

// Approximate seconds from the full CI run. Unknown files are included with a
// default weight; this balances runners without maintaining a coverage allowlist.
const fileWeights: Record<string, number> = {
  'agent-controls': 102,
  'agent-teams': 82,
  'stream-segments': 62,
  'team-approvals': 56,
  'terminal-jobs': 48,
  settlement: 45,
  'schedule-tools': 40,
  'long-conversation': 27,
  'teams-boundaries': 26,
  'permission-isolation': 25,
  'catalog-recovery': 25,
}

export interface E2eShard {
  files: string[]
  nativeParityProfiles: string[]
  estimatedSeconds: number
}

export function nativeParityProfiles(value: string | undefined): string[] {
  if (value === undefined) return [...NATIVE_PARITY_PROFILES]
  const selected = value.split(',')
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((profile) => !NATIVE_PARITY_PROFILES.some((known) => known === profile))
  ) {
    throw new Error('Native parity profiles must be a nonempty, unique subset of claude,codex,devin,kimi')
  }
  return selected
}

export function createE2eShards(files: readonly string[]): E2eShard[] {
  if (new Set(files).size !== files.length || !files.includes(NATIVE_PARITY_FILE))
    throw new Error('E2E inventory must contain unique files and the native parity fixture')
  const units = files.flatMap<{ file: string; profile: string | undefined; weight: number }>((file) =>
    file === NATIVE_PARITY_FILE
      ? NATIVE_PARITY_PROFILES.map((profile) => ({ file, profile, weight: profile === 'devin' ? 150 : 90 }))
      : [{ file, profile: undefined, weight: fileWeights[file.slice('test/e2e/'.length, -'.e2e.ts'.length)] ?? 15 }],
  )
  units.sort(
    (left, right) =>
      right.weight - left.weight ||
      `${left.file}:${left.profile ?? ''}`.localeCompare(`${right.file}:${right.profile ?? ''}`),
  )
  const shards: E2eShard[] = Array.from({ length: E2E_SHARD_COUNT }, () => ({
    files: [],
    nativeParityProfiles: [],
    estimatedSeconds: 0,
  }))
  for (const unit of units) {
    const shard = shards.reduce((lightest, item) =>
      item.estimatedSeconds < lightest.estimatedSeconds ? item : lightest,
    )
    if (!shard.files.includes(unit.file)) shard.files.push(unit.file)
    if (unit.profile !== undefined) shard.nativeParityProfiles.push(unit.profile)
    shard.estimatedSeconds += unit.weight
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

export function selectE2eShard(value: string, files: readonly string[]): E2eShard {
  const match = /^(\d+)\/(\d+)$/.exec(value)
  const index = Number(match?.[1])
  if (Number(match?.[2]) !== E2E_SHARD_COUNT || index < 1 || index > E2E_SHARD_COUNT || !Number.isInteger(index))
    throw new Error(`E2E shard must be 1/${E2E_SHARD_COUNT} through ${E2E_SHARD_COUNT}/${E2E_SHARD_COUNT}`)
  return createE2eShards(files)[index - 1]!
}

export function e2eInventory(root: string): string[] {
  return [...globSync('test/e2e/**/*.e2e.ts', { cwd: root })].map((file) => file.replaceAll('\\', '/')).sort()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  console.log(JSON.stringify(createE2eShards(e2eInventory(root)), null, 2))
}
