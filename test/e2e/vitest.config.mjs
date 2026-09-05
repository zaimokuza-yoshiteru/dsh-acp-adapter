import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const host = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
const requireHost = createRequire(resolve(host, 'package.json'))
const { default: tsconfigPaths } = await import(pathToFileURL(requireHost.resolve('vite-tsconfig-paths')).href)
const { standardDecoratorPlugin, vitestExecArgv } = await import(pathToFileURL(resolve(host, 'vitest.shared.ts')).href)

// Reuse the pinned host's real Loader scaffold and source resolver. The browser
// consumes built DSH and adapter bundles; no React or UI primitive stubs exist.
export default {
  root,
  plugins: [tsconfigPaths({ projects: [resolve(host, 'tsconfig.base.json')], loose: true }), standardDecoratorPlugin()],
  resolve: { alias: {
    '#host-scaffold': resolve(host, 'apps/web/tests/scaffold.ts'),
    '#host-support': resolve(host, 'apps/web/tests/support.ts'),
    playwright: createRequire(resolve(host, 'apps/web/package.json')).resolve('playwright'),
  } },
  test: {
    include: ['test/e2e/**/*.e2e.mjs'],
    execArgv: vitestExecArgv,
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    retry: 0,
  },
}
