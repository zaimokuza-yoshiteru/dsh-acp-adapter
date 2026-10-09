import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { e2eInventory, selectE2eShard } from './e2e-shards.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
let args = process.argv.slice(2)
let shard
if (args[0] === '--ci-shard') {
  // A shard always uses its complete inventory; ad hoc filters must not turn a
  // required CI job green while silently omitting its assigned fixtures.
  if (args.length !== 2)
    throw new Error('--ci-shard requires one index/count value and cannot be combined with filters')
  shard = selectE2eShard(args[1], e2eInventory(root))
  args = shard.files
  console.log(
    `[e2e] shard ${process.argv[3]}: ${args.length} files; native parity: ${shard.nativeParityProfiles.join(',')}`,
  )
}
execFileSync(process.execPath, [resolve(root, 'scripts/verify-dsh-reference.ts')], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, [resolve(root, 'scripts/verify-dev-dependencies.ts')], { cwd: root, stdio: 'inherit' })
execFileSync(
  process.env.DSH_E2E_NODE ?? process.execPath,
  [
    resolve(host, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    resolve(root, 'test/e2e/vitest.config.mjs'),
    ...args,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      DSH_SNAPSHOT: 'replay',
      ...(shard === undefined ? {} : { DSH_E2E_NATIVE_PARITY_PROFILES: shard.nativeParityProfiles.join(',') }),
    },
  },
)
