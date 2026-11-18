// CognitionAI/devin-cli publishes these native packages through its publish-npm workflow.
// Keep the public npm SRI pin and the CLI build ID independent of the download.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { devinCiRelease } from './devin-ci-release.ts'

const { version, build } = devinCiRelease
const platform = `${process.platform}-${process.arch}`
const integrity = devinCiRelease.integrity[platform]
assert.ok(integrity, `Unsupported Devin CI platform: ${platform}`)
assert.ok(process.argv[2], 'Pass the disposable CI directory')

const response = await fetch(`https://registry.npmjs.org/devin/-/devin-${version}-${platform}.tgz`, {
  integrity,
  redirect: 'error',
  signal: AbortSignal.timeout(180_000),
})
assert.ok(response.ok, `Devin download returned HTTP ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
const directory = await mkdtemp(join(resolve(process.argv[2]), 'devin-npm-'))
execFileSync('tar', ['-xzf', '-', '-C', directory], { input: archive })
const exe = join(directory, 'package', 'bin', process.platform === 'win32' ? 'devin.exe' : 'devin')
const reported = execFileSync(exe, ['version'], {
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory, USERPROFILE: directory },
  encoding: 'utf8',
  timeout: 15_000,
}).trim()
assert.equal(reported, `devin ${version} (${build})`)
console.error(reported)
console.log(exe)
