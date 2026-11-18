// CognitionAI/devin-cli publishes these native packages through its publish-npm workflow.
// Keep the public npm SRI pin and the CLI build ID independent of the download.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const version = '3000.12.43'
const platform = `${process.platform}-${process.arch}`
const integrity = {
  'darwin-arm64': 'sha512-NIoYY2S5zPk89CXB+bn6+76pWOsCd75ajJF6NZZ8AQURcLCz1wGRw76j8DHERRVSluNouz+HmYx2Tg8EIpn7dQ==',
  'darwin-x64': 'sha512-jzLL8mQDSfwiJwBn5cpId7Y7ilaJCRTjRjXIlmYk6kevEdWY5721O4lvKoLD0w4l59VgjlvUMXWx6Pecxq4tiA==',
  'win32-x64': 'sha512-nZt7o83MIBYNn1plIIdxqok4NiwNUnKFKwuEQSkpXRafG0IhgvQXXX8OTaDO7u4qrt5bGqqx8zvUQKvcBr/mqQ==',
}[platform]
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
assert.equal(reported, `devin ${version} (517d03d73926)`)
console.error(reported)
console.log(exe)
