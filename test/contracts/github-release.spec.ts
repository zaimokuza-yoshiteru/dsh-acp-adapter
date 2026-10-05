import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertRemoteTagMatchesLocal,
  assertNpmTarballFilename,
  changelogSection,
  createRelease,
  ensureReleaseTarball,
  npmTarballFilename,
  previousPublishedTag,
  readRegistry,
  renderNotes,
  validatePublished,
  writeReleaseIfEnabled,
} from '../../scripts/github-release.ts'
import type { Github, Manifest, Packument, ReleaseAssetIO } from '../../scripts/github-release.ts'

const name = '@zaimokuza/dsh-acp-adapter'
const version = '1.2.3-alpha.2'
const tag = `v${version}`
const sha = '1234567890abcdef'
const tarball = Buffer.from('exact CI artifact')
const manifest: Manifest = {
  name,
  version,
  engines: { dsh: '1.2.3-alpha.1', node: '>=24' },
  devDependencies: { '@deepseek-ai/dsh': '1.2.3-alpha.1' },
  dist: { integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` },
}
const registry: Packument = { versions: { [version]: manifest }, time: { [version]: '2026-09-18T01:00:00.000Z' } }

function assetFixture(initial: { id: number; name: string; bytes: Uint8Array }[] = []) {
  const files = [...initial]
  const io: ReleaseAssetIO = {
    list: vi.fn(async () => files.map(({ id, name }) => ({ id, name }))),
    download: vi.fn(async (_tag, asset) => {
      const found = files.find((file) => file.id === asset.id)
      if (!found) throw new Error('asset missing')
      return found.bytes
    }),
    upload: vi.fn(async (_tag, path) => {
      files.push({ id: 2, name: basename(path), bytes: readFileSync(path) })
    }),
  }
  return { files, io }
}

describe('GitHub release publication', () => {
  it('checks remote tag identity from a SHA-only CLI projection', () => {
    const github = vi.fn(() => ({ sha })) as unknown as Github
    expect(() => assertRemoteTagMatchesLocal(tag, sha, github)).not.toThrow()
    expect(github).toHaveBeenCalledWith(`commits/${tag}`, undefined, '{sha: .sha}')
    expect(() => assertRemoteTagMatchesLocal(tag, 'different-sha', (() => ({ sha })) as Github)).toThrow(
      'Local and remote tag commits differ',
    )
    expect(() => assertRemoteTagMatchesLocal(tag, sha, (() => ({})) as Github)).toThrow(
      'Local and remote tag commits differ',
    )
  })

  it('requires the exact npm package and tested tarball, not just a successful tag push', () => {
    expect(validatePublished(tag, manifest, registry, sha, tarball).published).toEqual(manifest)
    expect(() => validatePublished(tag, manifest, { ...registry, versions: {} }, sha)).toThrow('Not published on npm')
    expect(() => validatePublished('v9.9.9', manifest, registry, sha)).toThrow('Tag/package version mismatch')
    expect(() => validatePublished(tag, manifest, registry, sha, Buffer.from('rebuilt locally'))).toThrow('integrity')
    expect(() =>
      validatePublished(
        tag,
        manifest,
        { ...registry, versions: { [version]: { ...manifest, gitHead: 'other' } } },
        sha,
      ),
    ).toThrow('gitHead')
    expect(() =>
      validatePublished(
        tag,
        manifest,
        { ...registry, versions: { [version]: { ...manifest, name: 'wrong-package' } } },
        sha,
      ),
    ).toThrow('identity')
    expect(() =>
      validatePublished(tag, manifest, { ...registry, versions: { [version]: { ...manifest, dist: {} } } }, sha),
    ).toThrow('integrity is missing')
  })

  it('requires the standard npm package/version filename for a Release asset', () => {
    const expected = 'zaimokuza-dsh-acp-adapter-1.2.3-alpha.2.tgz'
    expect(npmTarballFilename(name, version)).toBe(expected)
    expect(assertNpmTarballFilename(`/tmp/${expected}`, manifest)).toBe(expected)
    expect(() => assertNpmTarballFilename('/tmp/rebuilt.tgz', manifest)).toThrow(`filename must be ${expected}`)
  })

  it('uploads a missing tarball without clobbering and verifies the uploaded bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-asset-test-'))
    try {
      const path = join(directory, npmTarballFilename(name, version))
      writeFileSync(path, tarball)
      const { files, io } = assetFixture()
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), io)).resolves.toBe('uploaded')
      expect(files).toHaveLength(1)
      expect(files[0]?.bytes).toEqual(tarball)
      expect(io.upload).toHaveBeenCalledOnce()
      expect(io.list).toHaveBeenCalledTimes(2)
      expect(io.download).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('treats an identical existing asset as idempotent and never uploads it again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-asset-test-'))
    try {
      const path = join(directory, npmTarballFilename(name, version))
      writeFileSync(path, tarball)
      const { io } = assetFixture([{ id: 1, name: basename(path), bytes: tarball }])
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), io)).resolves.toBe('already-present')
      expect(io.upload).not.toHaveBeenCalled()
      expect(io.download).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a conflicting existing asset and stops when its download fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-asset-test-'))
    try {
      const path = join(directory, npmTarballFilename(name, version))
      writeFileSync(path, tarball)
      const conflict = assetFixture([{ id: 1, name: basename(path), bytes: Buffer.from('different') }])
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), conflict.io)).rejects.toThrow('differs')
      expect(conflict.io.upload).not.toHaveBeenCalled()
      const unavailable = assetFixture([{ id: 1, name: basename(path), bytes: tarball }])
      vi.mocked(unavailable.io.download).mockRejectedValueOnce(new Error('download failed'))
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), unavailable.io)).rejects.toThrow(
        'download failed',
      )
      expect(unavailable.io.upload).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails if upload is absent or altered after upload, and never retries an upload error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-asset-test-'))
    try {
      const path = join(directory, npmTarballFilename(name, version))
      writeFileSync(path, tarball)
      const missing = assetFixture()
      vi.mocked(missing.io.upload).mockImplementationOnce(async () => {})
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), missing.io)).rejects.toThrow('did not create')
      expect(missing.io.upload).toHaveBeenCalledOnce()

      const altered = assetFixture()
      vi.mocked(altered.io.upload).mockImplementationOnce(async () => {
        altered.files.push({ id: 2, name: basename(path), bytes: Buffer.from('wrong bytes') })
      })
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), altered.io)).rejects.toThrow(
        'failed byte verification',
      )
      expect(altered.io.upload).toHaveBeenCalledOnce()

      const uploadError = assetFixture()
      vi.mocked(uploadError.io.upload).mockRejectedValueOnce(new Error('upload failed'))
      await expect(ensureReleaseTarball(tag, 9, path, basename(path), uploadError.io)).rejects.toThrow('upload failed')
      expect(uploadError.io.upload).toHaveBeenCalledOnce()
      expect(uploadError.io.list).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps metadata-only backfill behavior when no tarball is supplied', async () => {
    const api = vi.fn((endpoint: string) =>
      endpoint.startsWith('git/')
        ? [{ ref: `refs/tags/${tag}` }]
        : endpoint.startsWith('releases/tags/')
          ? null
          : { id: 8 },
    )
    const { io } = assetFixture()
    await expect(writeReleaseIfEnabled(true, tag, 'notes', api as Github, io)).resolves.toEqual({
      created: true,
      id: 8,
      url: undefined,
    })
    expect(io.list).not.toHaveBeenCalled()
    expect(io.upload).not.toHaveBeenCalled()
  })

  it('leaves GitHub and assets untouched in dry-run mode', async () => {
    const github = vi.fn() as unknown as Github
    const { io } = assetFixture()
    await expect(writeReleaseIfEnabled(false, tag, 'notes', github, io)).resolves.toBeUndefined()
    expect(github).not.toHaveBeenCalled()
    expect(io.list).not.toHaveBeenCalled()
    expect(io.upload).not.toHaveBeenCalled()
  })

  it('uses npm publication order across squash merges, skipping failed tags and later publications', () => {
    const git = vi.fn(() => [tag, 'v1.2.3-alpha.3', 'v1.2.3-alpha.1', 'v1.2.2', 'v1.2.1'].join('\n'))
    const history: Packument = {
      versions: { ...registry.versions, '1.2.3-alpha.3': manifest, '1.2.2': manifest, '1.2.1': manifest },
      time: {
        ...registry.time,
        '1.2.3-alpha.3': '2026-09-19',
        '1.2.3-alpha.1': '2026-09-17',
        '1.2.2': '2026-09-16',
        '1.2.1': '2026-09-15',
      },
    }
    expect(previousPublishedTag(tag, history, git)).toBe('v1.2.2')
    expect(git).toHaveBeenCalledWith('tag', '--list', 'v*')
    expect(previousPublishedTag(tag, registry, () => tag)).toBeUndefined()
  })

  it('selects only this version’s bilingual highlights and otherwise uses actual commit titles', () => {
    const text =
      '# Changes\r\n\r\n## 1.2.3-alpha.2\r\n\r\n### 中文\r\n修复\r\n### English\r\nFix\r\n\r\n## 1.2.3-alpha.1\r\nold'
    const highlights = changelogSection(text, version)
    expect(highlights).toBe('### 中文\n修复\n### English\nFix')
    expect(changelogSection(text, '9.9.9')).toBeUndefined()
    const input = {
      tag,
      source: manifest,
      published: manifest,
      publishedAt: registry.time[version]!,
      sha,
      previous: 'v1.2.2',
      commits: '- real commit title',
    }
    const notes = renderNotes({ ...input, highlights })
    expect(notes).toContain('### 中文\n修复\n### English\nFix')
    expect(notes).not.toContain('real commit title')
    expect(notes).toContain(`@deepseek-ai/dsh@1.2.3-alpha.1 plugin --profile web add ${name}@${version}`)
    expect(notes).toContain(`compare/v1.2.2...${tag}`)
    expect(notes).toContain(registry.time[version])
    expect(notes).toContain(manifest.dist!.integrity)
    const packaged = renderNotes({ ...input, tarballAsset: npmTarballFilename(name, version) })
    expect(packaged).toContain('Prebuilt plugin package')
    expect(packaged).toContain('CI tarball verified against npm')
    expect(packaged).toContain('source archives contain source code')
    expect(renderNotes(input)).not.toContain('Prebuilt plugin package')
    const generated = renderNotes(input)
    expect(generated).toContain('real commit title')
    expect(generated).toContain('original titles are preserved')
  })

  it('does not invent host compatibility or suggest installing a development path', () => {
    const legacy = { name, version, devDependencies: { '@deepseek-ai/dsh': 'link:../source' } }
    const notes = renderNotes({
      tag,
      source: legacy,
      published: { ...legacy, dist: manifest.dist! },
      publishedAt: '2026-09-18',
      sha,
      commits: '',
    })
    expect(notes).toContain('Not declared in this version')
    expect(notes).toContain('installation guide')
    expect(notes).not.toContain('npx')
    expect(notes).toContain(`/commits/${tag}`)
  })

  it('creates a prerelease for an existing tag without promoting it to Latest', () => {
    const api = vi.fn((endpoint: string) =>
      endpoint.startsWith('git/')
        ? [{ ref: `refs/tags/${tag}` }]
        : endpoint.startsWith('releases/tags/')
          ? null
          : { id: 8, html_url: 'created-url' },
    )
    expect(createRelease(tag, '中英文 notes', api as Github)).toEqual({ created: true, id: 8, url: 'created-url' })
    expect(api).toHaveBeenLastCalledWith('releases', {
      tag_name: tag,
      name: tag,
      body: '中英文 notes',
      draft: false,
      prerelease: true,
      make_latest: 'false',
    })
  })

  it('preserves existing notes on a retry and never creates tags', () => {
    const api = vi.fn((endpoint: string) =>
      endpoint.startsWith('git/') ? [{ ref: `refs/tags/${tag}` }] : { id: 7, html_url: 'existing-url' },
    )
    expect(createRelease(tag, 'replacement', api as Github)).toEqual({
      created: false,
      id: 7,
      url: 'existing-url',
    })
    expect(api).toHaveBeenCalledTimes(2)
    expect(() => createRelease(tag, 'notes', (() => []) as Github)).toThrow('Remote tag is missing')
    expect(() => createRelease(tag, 'notes', (() => [{ ref: `refs/tags/${tag}.1` }]) as Github)).toThrow(
      'Remote tag is missing',
    )
  })

  it('does not interpret a GitHub read failure as permission to create a duplicate', () => {
    const api = vi.fn((endpoint: string) => {
      if (endpoint.startsWith('git/')) return [{ ref: `refs/tags/${tag}` }]
      throw new Error('HTTP 403')
    })
    expect(() => createRelease(tag, 'notes', api as Github)).toThrow('403')
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('allows bounded npm propagation delay but never publishes notes for an absent package', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ versions: {}, time: {} }))
      .mockResolvedValue(Response.json(registry))
    const wait = vi.fn(async () => {})
    expect(await readRegistry(version, fetcher, wait)).toEqual(registry)
    expect(wait).toHaveBeenCalledOnce()
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ versions: {}, time: {} }))
    await expect(readRegistry(version, missing, wait)).rejects.toThrow('Not published on npm')
    expect(missing).toHaveBeenCalledTimes(6)
    await expect(
      readRegistry(version, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 })), wait),
    ).rejects.toThrow('HTTP 500')
  })

  it('gates GitHub writes on npm success and limits write permission to the Release job', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8')
    const [before, release] = workflow.split('  github-release:')
    expect(before).not.toContain('contents: write')
    expect(release).toContain('needs: [pack, publish]')
    expect(release).toContain('contents: write')
    expect(release).toContain(
      'node scripts/github-release.ts --tarball "dist/npm/${{ needs.pack.outputs.tarball }}" --write',
    )
    expect(release).not.toContain('npm publish')
    expect(release).not.toContain('--backfill')
  })
})
