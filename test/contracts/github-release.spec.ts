import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { changelogSection, createRelease, previousPublishedTag, readRegistry, renderNotes, validatePublished } from '../../scripts/github-release.ts'
import type { Github, Manifest, Packument } from '../../scripts/github-release.ts'

const name = '@zaimokuza/dsh-acp-adapter'
const version = '1.2.3-alpha.2'
const tag = `v${version}`
const sha = '1234567890abcdef'
const tarball = Buffer.from('exact CI artifact')
const manifest: Manifest = {
  name, version, engines: { dsh: '1.2.3-alpha.1', node: '>=24' },
  devDependencies: { '@deepseek-ai/dsh': '1.2.3-alpha.1' },
  dist: { integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` },
}
const registry: Packument = { versions: { [version]: manifest }, time: { [version]: '2026-09-18T01:00:00.000Z' } }

describe('GitHub release publication', () => {
  it('requires the exact npm package and tested tarball, not just a successful tag push', () => {
    expect(validatePublished(tag, manifest, registry, sha, tarball).published).toEqual(manifest)
    expect(() => validatePublished(tag, manifest, { ...registry, versions: {} }, sha)).toThrow('Not published on npm')
    expect(() => validatePublished('v9.9.9', manifest, registry, sha)).toThrow('Tag/package version mismatch')
    expect(() => validatePublished(tag, manifest, registry, sha, Buffer.from('rebuilt locally'))).toThrow('integrity')
    expect(() => validatePublished(tag, manifest, { ...registry, versions: { [version]: { ...manifest, gitHead: 'other' } } }, sha)).toThrow('gitHead')
    expect(() => validatePublished(tag, manifest, { ...registry, versions: { [version]: { ...manifest, name: 'wrong-package' } } }, sha)).toThrow('identity')
    expect(() => validatePublished(tag, manifest, { ...registry, versions: { [version]: { ...manifest, dist: {} } } }, sha)).toThrow('integrity is missing')
  })

  it('uses npm publication order across squash merges, skipping failed tags and later publications', () => {
    const git = vi.fn(() => [tag, 'v1.2.3-alpha.3', 'v1.2.3-alpha.1', 'v1.2.2', 'v1.2.1'].join('\n'))
    const history: Packument = {
      versions: { ...registry.versions, '1.2.3-alpha.3': manifest, '1.2.2': manifest, '1.2.1': manifest },
      time: { ...registry.time, '1.2.3-alpha.3': '2026-09-19', '1.2.3-alpha.1': '2026-09-17', '1.2.2': '2026-09-16', '1.2.1': '2026-09-15' },
    }
    expect(previousPublishedTag(tag, history, git)).toBe('v1.2.2')
    expect(git).toHaveBeenCalledWith('tag', '--list', 'v*')
    expect(previousPublishedTag(tag, registry, () => tag)).toBeUndefined()
  })

  it('selects only this version’s bilingual highlights and otherwise uses actual commit titles', () => {
    const text = '# Changes\r\n\r\n## 1.2.3-alpha.2\r\n\r\n### 中文\r\n修复\r\n### English\r\nFix\r\n\r\n## 1.2.3-alpha.1\r\nold'
    const highlights = changelogSection(text, version)
    expect(highlights).toBe('### 中文\n修复\n### English\nFix')
    expect(changelogSection(text, '9.9.9')).toBeUndefined()
    const input = { tag, source: manifest, published: manifest, publishedAt: registry.time[version]!, sha, previous: 'v1.2.2', commits: '- real commit title' }
    const notes = renderNotes({ ...input, highlights })
    expect(notes).toContain('### 中文\n修复\n### English\nFix')
    expect(notes).not.toContain('real commit title')
    expect(notes).toContain(`@deepseek-ai/dsh@1.2.3-alpha.1 plugin --profile web add ${name}@${version}`)
    expect(notes).toContain(`compare/v1.2.2...${tag}`)
    expect(notes).toContain(registry.time[version])
    expect(notes).toContain(manifest.dist!.integrity)
    const generated = renderNotes(input)
    expect(generated).toContain('real commit title')
    expect(generated).toContain('original titles are preserved')
  })

  it('does not invent host compatibility or suggest installing a development path', () => {
    const legacy = { name, version, devDependencies: { '@deepseek-ai/dsh': 'link:../source' } }
    const notes = renderNotes({ tag, source: legacy, published: { ...legacy, dist: manifest.dist! }, publishedAt: '2026-09-18', sha, commits: '' })
    expect(notes).toContain('Not declared in this version')
    expect(notes).toContain('installation guide')
    expect(notes).not.toContain('npx')
    expect(notes).toContain(`/commits/${tag}`)
  })

  it('creates a prerelease for an existing tag without promoting it to Latest', () => {
    const api = vi.fn((endpoint: string) => endpoint.startsWith('git/') ? [{ ref: `refs/tags/${tag}` }] : endpoint.startsWith('releases/tags/') ? null : { html_url: 'created-url' })
    expect(createRelease(tag, '中英文 notes', api as Github)).toEqual({ created: true, url: 'created-url' })
    expect(api).toHaveBeenLastCalledWith('releases', {
      tag_name: tag, name: tag, body: '中英文 notes', draft: false, prerelease: true, make_latest: 'false',
    })
  })

  it('preserves existing notes on a retry and never creates tags', () => {
    const api = vi.fn((endpoint: string) => endpoint.startsWith('git/') ? [{ ref: `refs/tags/${tag}` }] : { id: 7, html_url: 'existing-url' })
    expect(createRelease(tag, 'replacement', api as Github)).toEqual({ created: false, url: 'existing-url' })
    expect(api).toHaveBeenCalledTimes(2)
    expect(() => createRelease(tag, 'notes', (() => []) as Github)).toThrow('Remote tag is missing')
    expect(() => createRelease(tag, 'notes', (() => [{ ref: `refs/tags/${tag}.1` }]) as Github)).toThrow('Remote tag is missing')
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
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ versions: {}, time: {} }))
      .mockResolvedValue(Response.json(registry))
    const wait = vi.fn(async () => {})
    expect(await readRegistry(version, fetcher, wait)).toEqual(registry)
    expect(wait).toHaveBeenCalledOnce()
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ versions: {}, time: {} }))
    await expect(readRegistry(version, missing, wait)).rejects.toThrow('Not published on npm')
    expect(missing).toHaveBeenCalledTimes(6)
    await expect(readRegistry(version, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 })), wait)).rejects.toThrow('HTTP 500')
  })

  it('gates GitHub writes on npm success and limits write permission to the Release job', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8')
    const [before, release] = workflow.split('  github-release:')
    expect(before).not.toContain('contents: write')
    expect(release).toContain('needs: [pack, publish]')
    expect(release).toContain('contents: write')
    expect(release).toContain('node scripts/github-release.ts --tarball "dist/npm/${{ needs.pack.outputs.tarball }}" --write')
    expect(release).not.toContain('npm publish')
    expect(release).not.toContain('--backfill')
  })
})
