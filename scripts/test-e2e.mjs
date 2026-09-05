import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
execFileSync(process.execPath, [resolve(root, 'scripts/verify-dsh-reference.mjs')], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, [resolve(root, 'scripts/link-dsh-reference.mjs'), '--check'], { cwd: root, stdio: 'inherit' })
execFileSync(process.env.DSH_E2E_NODE ?? process.execPath, [resolve(host, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(root, 'test/e2e/vitest.config.mjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DSH_SNAPSHOT: 'replay' },
})
