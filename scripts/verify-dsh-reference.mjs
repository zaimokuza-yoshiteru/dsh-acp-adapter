#!/usr/bin/env node
// Verify the local DSH source reference used by the compatibility lane.
// This intentionally does not alter package.json, pnpm-lock.yaml, or install
// anything from a file/link dependency.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DSH_SOURCE_TAG, DSH_SOURCE_VERSION } from './dsh-target.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const reference = process.env.DSH_UPSTREAM_CHECKOUT ?? join(root, '..', 'reference', 'deepseek-harness')
const expectedTag = DSH_SOURCE_TAG
const requiredPackages = [
  'packages/api/session-controller/package.json',
  'packages/api/settings-controller/package.json',
  'packages/api/workspace-controller/package.json',
  'packages/client/store/package.json',
]
// The clean-install gate invokes the bundled CLI (not the TypeScript source)
// and the web profile serves the frontend build. A source-only checkout is not
// enough; fail here instead of letting a pre-existing build in a developer's
// tree mask an incomplete CI build.
const requiredBuildArtifacts = [
  'apps/cli/lib/bin.js',
  'apps/web/dist/index.html',
]

if (!existsSync(join(reference, '.git'))) {
  throw new Error(`DSH reference is missing: ${reference}`)
}

const tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
  cwd: reference,
  encoding: 'utf8',
}).trim()
if (tag !== expectedTag) {
  throw new Error(`DSH reference must be checked out at ${expectedTag}; found ${tag || 'detached/unmatched HEAD'}`)
}

for (const relative of requiredPackages) {
  const file = join(reference, relative)
  if (!existsSync(file)) throw new Error(`DSH reference package is missing: ${relative}`)
  const packageJson = JSON.parse(readFileSync(file, 'utf8'))
  if (packageJson.version !== DSH_SOURCE_VERSION) {
    throw new Error(`${relative} is not ${DSH_SOURCE_VERSION}`)
  }
}

for (const relative of requiredBuildArtifacts) {
  if (!existsSync(join(reference, relative))) {
    throw new Error(`DSH reference is not fully built: missing ${relative}; run pnpm build in the reference checkout first`)
  }
}

const llm = await import(pathToFileURL(join(reference, 'packages/llm/llm/lib/index.js')).href)
if (typeof llm.AssistantStreamAccumulator !== 'function') {
  throw new Error('DSH reference has stale pre-v2 runtime artifacts; rebuild the exact source tag')
}
console.log(`DSH source reference verified: ${expectedTag}`)
