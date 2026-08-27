import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

describe('npm release contract', () => {
  it('requires the exact version tag and publishes through the single latest channel', () => {
    const output = join(mkdtempSync(join(tmpdir(), 'dsh-acp-release-')), 'output')
    const stdout = execFileSync(
      process.execPath,
      [new URL('scripts/verify-release.mjs', root).pathname, `v${pkg.version}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: `v${pkg.version}`,
        },
      },
    )

    expect(stdout).toContain(`v${pkg.version} -> npm latest`)
    expect(readFileSync(output, 'utf8')).toContain('dist-tag=latest\n')
    expect(readFileSync(output, 'utf8')).toContain(`tarball=zaimokuza-dsh-acp-adapter-${pkg.version}.tgz\n`)
  })

  it('rejects a branch ref even when its name resembles the expected tag', () => {
    expect(() => execFileSync(
      process.execPath,
      [new URL('scripts/verify-release.mjs', root).pathname],
      {
        stdio: 'pipe',
        env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: `v${pkg.version}` },
      },
    )).toThrow()
  })

  it('uses OIDC and never wires a long-lived npm token into the workflow', () => {
    const workflow = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8')
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
})
