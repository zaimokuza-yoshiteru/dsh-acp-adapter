import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const verifyRelease = fileURLToPath(new URL('scripts/verify-release.mjs', root))

describe('npm release contract', () => {
  it.each([
    ['1.2.3-alpha.1', 'alpha'],
    ['1.2.3-rc.1', 'next'],
    ['1.2.3', 'latest'],
  ])('routes release %s to %s', (version, distTag) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-release-'))
    const output = join(directory, 'output')
    try {
      mkdirSync(join(directory, 'scripts'))
      for (const file of ['verify-release.mjs', 'dsh-target.mjs']) cpSync(new URL(`scripts/${file}`, root), join(directory, 'scripts', file))
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...pkg, version }))
      execFileSync(
      process.execPath,
      [join(directory, 'scripts/verify-release.mjs'), `v${version}`],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: `v${version}`,
        },
      },
      )
      expect(readFileSync(output, 'utf8')).toContain(`dist-tag=${distTag}\n`)
      expect(readFileSync(output, 'utf8')).toContain(`tarball=zaimokuza-dsh-acp-adapter-${version}.tgz`)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('still blocks local source dependencies from publishing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-source-release-'))
    try {
      mkdirSync(join(directory, 'scripts'))
      for (const file of ['verify-release.mjs', 'dsh-target.mjs']) cpSync(new URL(`scripts/${file}`, root), join(directory, 'scripts', file))
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, '@deepseek-ai/dsh-llm': 'link:../source' } }))
      expect(() => execFileSync(process.execPath, [join(directory, 'scripts/verify-release.mjs'), `v${pkg.version}`], {
        stdio: 'pipe', env: { ...process.env, GITHUB_REF_TYPE: 'tag' },
      })).toThrow('has not passed the published-package lane')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('rejects a branch ref even when its name resembles the expected tag', () => {
    expect(() => execFileSync(
      process.execPath,
      [verifyRelease],
      {
        stdio: 'pipe',
        env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: `v${pkg.version}` },
      },
    )).toThrow()
  })

  it('uses OIDC and never wires a long-lived npm token into the workflow', () => {
    const workflow = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8').replaceAll('\r\n', '\n')
    expect(workflow).toContain("tags:\n      - 'v*'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('pnpm/action-setup@v4')
    expect(workflow).toContain('version: 10.7.0')
    expect(workflow).not.toContain('corepack')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('environment: npm-publish')
    expect(workflow).toContain('npm publish "dist/npm/${{ needs.pack.outputs.tarball }}"')
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/)
  })

  it('checks release eligibility before installing development dependencies', () => {
    const workflow = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8')
    expect(workflow).not.toContain('if: ${{ false }}')
    expect(workflow).not.toContain('alpha-release-block')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow.indexOf('node scripts/verify-release.mjs')).toBeLessThan(workflow.indexOf('pnpm install --frozen-lockfile'))
  })

  it('runs validation through prepack once and gates the same tarball before publishing', () => {
    const workflow = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8')
    expect(pkg.scripts.prepack).toBe('node scripts/prepack.mjs')
    const prepack = readFileSync(new URL('scripts/prepack.mjs', root), 'utf8')
    expect(prepack).toContain("['typecheck', 'test', 'build']")
    expect(workflow).toContain('npm pack --pack-destination dist/npm')
    expect(workflow).not.toMatch(/--ignore-scripts|pnpm (?:typecheck|test|build)/)
    expect(workflow).toContain('node scripts/install-gate.mjs --tgz "dist/npm/${{ steps.release.outputs.tarball }}"')
    expect(workflow.indexOf('npm pack --pack-destination')).toBeLessThan(workflow.indexOf('node scripts/install-gate.mjs'))
    expect(workflow).toContain('needs: pack')
  })

  it('keeps current documentation and CI aligned with the manifest host target', () => {
    const hostVersion = pkg.engines.dsh
    for (const name of ['README.md', 'README.en.md']) {
      const doc = readFileSync(new URL(name, root), 'utf8')
      expect(doc).toContain(`**${pkg.version}**`)
      expect(doc).toContain(`**DSH ${hostVersion}**`)
      const versions = [...doc.matchAll(/@deepseek-ai\/dsh@([^\s`]+)/g)].map(match => match[1])
      expect(versions.length).toBeGreaterThan(0)
      expect(new Set(versions)).toEqual(new Set([hostVersion]))
    }
    const guide = readFileSync(new URL('test/e2e/README.md', root), 'utf8')
    expect(guide).toContain(`宿主目标为 \`${hostVersion}\``)
    expect([...guide.matchAll(/dsh-v([0-9A-Za-z.-]+)/g)].map(match => match[1])).toEqual([hostVersion])
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
    expect(workflow).toContain('ref: ${{ steps.dsh-target.outputs.tag }}')
    expect(workflow).toContain('import { DSH_SOURCE_TAG } from "./scripts/dsh-target.mjs"')
    expect(workflow).not.toMatch(/ref: dsh-v/)
  })
})
