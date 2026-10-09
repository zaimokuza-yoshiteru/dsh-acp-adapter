import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  createE2eShards,
  e2eInventory,
  E2E_SHARD_COUNT,
  nativeParityProfiles,
  NATIVE_PARITY_FILE,
  NATIVE_PARITY_PROFILES,
  selectE2eShard,
} from '../../scripts/e2e-shards.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'))

describe('CI coverage and isolation', () => {
  it('runs one candidate workflow and skips tag/feature pushes without skipping main validation', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    expect(workflow.on).toHaveProperty('pull_request')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
    const publish = parse(readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8'))
    expect(publish.concurrency['cancel-in-progress']).toBe(false)
  })

  it('keeps the existing required check and fails it when any independent runner does not succeed', () => {
    const shards = workflow.jobs['native-ui-shards']
    expect(shards.strategy.matrix.shard).toEqual(Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1))
    expect(shards.strategy['fail-fast']).toBe(false)
    const evidence = shards.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(evidence.if).toBe('failure()')
    expect(evidence.with.name).toBe(
      'native-ui-failures-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}',
    )
    expect(shards.steps.find((step: { run?: string }) => step.run?.startsWith('pnpm test:e2e')).run).toBe(
      'pnpm test:e2e --ci-shard "${{ matrix.shard }}/3"',
    )
    const required = workflow.jobs['native-ui']
    expect(required.name).toBe('Native UI parity (exact source scaffold)')
    expect(required.needs).toBe('native-ui-shards')
    expect(required.if).toBe('always()')
    expect(required.steps[0].env.SHARD_RESULT).toBe('${{ needs.native-ui-shards.result }}')
    expect(required.steps[0].run).toBe('test "$SHARD_RESULT" = success')
    const config = readFileSync(new URL('../../test/e2e/vitest.config.mjs', import.meta.url), 'utf8')
    expect(config).toContain('fileParallelism: false')
    expect(config).toContain('retry: 0')
  })

  it('caches only dependency content and browser binaries, keyed by lock and toolchain', () => {
    for (const job of [workflow.jobs['published-compatibility'], workflow.jobs['native-ui-shards']]) {
      const caches = job.steps.filter((step: { uses?: string }) => step.uses?.startsWith('actions/cache@'))
      expect(caches.length).toBeGreaterThan(0)
      for (const cache of caches) {
        expect(cache.with.path).toMatch(
          /^(?:\$\{\{ runner.temp \}\}\/pnpm-store-(?:host|plugin)|~\/\.cache\/ms-playwright)$/,
        )
        expect(cache.with.key).toContain(
          '${{ runner.os }}-${{ runner.arch }}-node${{ steps.node.outputs.node-version }}',
        )
        expect(cache.with.key).toContain('hashFiles(')
        expect(cache.with).not.toHaveProperty('restore-keys')
      }
    }
    const installGate = readFileSync(new URL('../../scripts/install-gate.ts', import.meta.url), 'utf8')
    expect(installGate).toContain("npm_config_store_dir: join(tempRoot, 'pnpm-store')")
  })

  it('covers every fixture once and every native parity profile once across all shards', () => {
    const files = e2eInventory(root)
    const shards = createE2eShards(files)
    expect(shards).toHaveLength(E2E_SHARD_COUNT)
    const ordinary = shards.flatMap((shard) => shard.files.filter((file) => file !== NATIVE_PARITY_FILE))
    expect(ordinary.sort()).toEqual(files.filter((file) => file !== NATIVE_PARITY_FILE).sort())
    expect(new Set(ordinary).size).toBe(ordinary.length)
    expect(shards.flatMap((shard) => shard.nativeParityProfiles).sort()).toEqual([...NATIVE_PARITY_PROFILES].sort())
    expect(
      shards.every((shard) => shard.nativeParityProfiles.length > 0 && shard.files.includes(NATIVE_PARITY_FILE)),
    ).toBe(true)
    expect(createE2eShards([...files].reverse())).toEqual(shards)
    const added = 'test/e2e/future-regression.e2e.ts'
    expect(
      createE2eShards([...files, added])
        .flatMap((shard) => shard.files)
        .filter((file) => file === added),
    ).toHaveLength(1)
  })

  it('rejects an invalid inventory or shard instead of silently narrowing required coverage', () => {
    const files = e2eInventory(root)
    expect(() => createE2eShards([...files, files[0]!])).toThrow('unique files')
    expect(() => createE2eShards(files.filter((file) => file !== NATIVE_PARITY_FILE))).toThrow('native parity')
    for (const value of ['0/3', '4/3', '1/2', '1/3extra', '', '1'])
      expect(() => selectE2eShard(value, files)).toThrow('E2E shard')
    expect(selectE2eShard('2/3', files)).toEqual(createE2eShards(files)[1])
    expect(nativeParityProfiles(undefined)).toEqual([...NATIVE_PARITY_PROFILES])
    expect(nativeParityProfiles('devin,kimi')).toEqual(['devin', 'kimi'])
    for (const value of ['', 'devin,devin', 'unknown', 'devin,'])
      expect(() => nativeParityProfiles(value)).toThrow('nonempty, unique subset')
  })
})
