#!/usr/bin/env node
// Verify the local DSH Alpha reference used by the compatibility lane.
// This intentionally does not alter package.json, pnpm-lock.yaml, or install
// anything from a file/link dependency. Alpha packages are not on npm yet.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const reference = join(root, '..', 'reference', 'deepseek-harness')
const expectedTag = 'dsh-v0.1.2-alpha.1'
const requiredPackages = [
  'packages/api/session-controller/package.json',
  'packages/api/settings-controller/package.json',
  'packages/api/workspace-controller/package.json',
  'packages/client/store/package.json',
]

if (!existsSync(join(reference, '.git'))) {
  throw new Error(`Alpha reference is missing: ${reference}`)
}

const tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
  cwd: reference,
  encoding: 'utf8',
}).trim()
if (tag !== expectedTag) {
  throw new Error(`Alpha reference must be checked out at ${expectedTag}; found ${tag || 'detached/unmatched HEAD'}`)
}

for (const relative of requiredPackages) {
  const file = join(reference, relative)
  if (!existsSync(file)) throw new Error(`Alpha reference package is missing: ${relative}`)
  const packageJson = JSON.parse(readFileSync(file, 'utf8'))
  if (packageJson.version !== '0.1.2-alpha.1') {
    throw new Error(`${relative} is not 0.1.2-alpha.1`)
  }
}

console.log(`DSH Alpha reference verified: ${expectedTag}`)
console.log('npm package publication is not assumed; use the reference monorepo for Alpha builds.')
