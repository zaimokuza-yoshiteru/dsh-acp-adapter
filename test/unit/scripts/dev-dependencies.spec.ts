import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyDevelopmentInstall } from '../../../scripts/verify-dev-dependencies.ts'

const target = '0.2.2-rc.3'
const entry = '@deepseek-ai/dsh-fixture-entry'
const consumer = '@deepseek-ai/dsh-fixture-consumer'
const peer = '@deepseek-ai/dsh-fixture-error'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function manifest(directory: string, value: object) {
  const path = join(directory, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
function fixture(optional = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installed-peers-'))
  roots.push(root)
  const modules = join(root, 'node_modules')
  const direct = join(modules, entry)
  const indirect = join(direct, 'node_modules', consumer)
  manifest(root, { devDependencies: { [entry]: target, ...(optional ? {} : { [peer]: target }) } })
  manifest(direct, { name: entry, version: target, dependencies: { [consumer]: target } })
  manifest(indirect, {
    name: consumer,
    version: target,
    peerDependencies: { [peer]: target },
    ...(optional ? { peerDependenciesMeta: { [peer]: { optional: true } } } : {}),
  })
  if (!optional) manifest(join(modules, peer), { name: peer, version: target })
  return { root, privatePeer: join(indirect, 'node_modules', peer) }
}

it('rejects a consumer resolving its own stale peer even when the root has the exact target', () => {
  const { root, privatePeer } = fixture()
  expect(verifyDevelopmentInstall(root, target)).toBe(2)
  manifest(privatePeer, { name: peer, version: '0.2.2-rc.2' })
  expect(() => verifyDevelopmentInstall(root, target)).toThrow(
    `${consumer} requires ${peer}@${target}, resolved ${peer}@0.2.2-rc.2`,
  )
})

it('allows an absent optional peer and checks its installed version when present', () => {
  const { root, privatePeer } = fixture(true)
  expect(verifyDevelopmentInstall(root, target)).toBe(1)
  manifest(privatePeer, { name: peer, version: '0.2.2-rc.2' })
  expect(() => verifyDevelopmentInstall(root, target)).toThrow('0.2.2-rc.2')
})

it('identifies the consumer that cannot resolve a required transitive peer', () => {
  const { root } = fixture()
  rmSync(join(root, 'node_modules', peer), { recursive: true })
  expect(() => verifyDevelopmentInstall(root, target)).toThrow(`${consumer} requires missing ${peer}@${target}`)
})
