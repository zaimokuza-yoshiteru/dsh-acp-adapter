#!/usr/bin/env node
/** Release metadata only: never publishes npm packages or creates/moves Git tags. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

export interface Manifest {
  name: string
  version: string
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  gitHead?: string
  dist?: { integrity?: string }
}
export interface Packument {
  versions: Record<string, Manifest>
  time: Record<string, string>
}
type Git = (...args: string[]) => string
export type Github = <T>(endpoint: string, body?: Record<string, unknown>) => T
const packageName = '@zaimokuza/dsh-acp-adapter'
const repository = 'zaimokuza-yoshiteru/dsh-acp-adapter'
const versionPattern = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

export function validatePublished(tag: string, source: Manifest, registry: Packument, sha: string, tarball?: Uint8Array) {
  const version = tag.match(versionPattern)?.[1]
  if (!version || source.version !== version || source.name !== packageName) throw new Error('Tag/package version mismatch')
  const published = registry.versions[version]
  const publishedAt = registry.time[version]
  if (!published || !publishedAt) throw new Error(`Not published on npm: ${version}`)
  if (published.name !== source.name || published.version !== version) throw new Error('npm package identity mismatch')
  if (published.gitHead && published.gitHead !== sha) throw new Error('npm gitHead does not match the tag')
  if (!published.dist?.integrity) throw new Error('npm dist.integrity is missing')
  if (tarball && published.dist.integrity !== `sha512-${createHash('sha512').update(tarball).digest('base64')}`) {
    throw new Error('npm integrity does not match the tested CI tarball')
  }
  return { published, publishedAt }
}

/** Use npm publication order: squash merges can make the previous release a non-ancestor. */
export function previousPublishedTag(tag: string, registry: Packument, git: Git): string | undefined {
  const currentTime = registry.time[tag.slice(1)]
  return git('tag', '--list', 'v*').split('\n')
    .filter(candidate => candidate !== tag && versionPattern.test(candidate)
      && registry.versions[candidate.slice(1)] && registry.time[candidate.slice(1)]! < currentTime!)
    .sort((a, b) => registry.time[b.slice(1)]!.localeCompare(registry.time[a.slice(1)]!))[0]
}

export function changelogSection(changelog: string, version: string): string | undefined {
  const parts = changelog.replaceAll('\r\n', '\n').split(/^## /m)
  const section = parts.slice(1).find(part => part.split('\n')[0]?.trim() === version)
  return section?.slice(section.indexOf('\n') + 1).trim() || undefined
}

export function renderNotes(input: {
  tag: string; source: Manifest; published: Manifest; publishedAt: string
  sha: string; previous?: string | undefined; highlights?: string | undefined; commits: string
}) {
  const { tag, source, published, publishedAt, sha, previous, highlights, commits } = input
  const base = `https://github.com/${repository}`
  const compatibility = published.engines?.dsh ?? published.peerDependencies?.['@deepseek-ai/dsh-session']
  const host = source.devDependencies?.['@deepseek-ai/dsh'] ?? source.devDependencies?.['@deepseek-ai/dsh-session']
  const changes = highlights ?? [
    '### 变更记录 / Changes',
    '以下内容自动取自本次发布的提交，保留原始标题。用户影响和升级注意事项请查看对应提交。',
    'Generated from commits in this release; original titles are preserved. Follow the links for user impact and upgrade details.',
    commits || '此标签没有新增非合并提交。 / No new non-merge commits for this tag.',
  ].join('\n\n')
  // Never suggest an unpinned host (or a development file/link dependency) for historical installs.
  const install = host && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(host)
    ? `\`\`\`sh\nnpx @deepseek-ai/dsh@${host} plugin --profile web add ${packageName}@${source.version}\n\`\`\``
    : `在该版本的 [安装说明](${base}/blob/${tag}/README.md) 中选择匹配的宿主，并使用精确插件版本 \`${packageName}@${source.version}\`。\n\nChoose the matching host from this version's [installation guide](${base}/blob/${tag}/README.en.md) and install the exact plugin version above.`
  return [
    changes,
    '### 兼容与安装 / Compatibility and installation',
    `- DSH 声明兼容范围 / Declared DSH compatibility: ${compatibility ? `\`${compatibility}\`` : '该版本未声明 / Not declared in this version'}。`,
    `- Node.js: \`${published.engines?.node ?? '未声明 / Not declared'}\`。`,
    '- 请在升级前匹配宿主版本；声明范围不代表每个版本均已测试。 / Match the host before upgrading; a declared range does not imply every version was tested.',
    install,
    '更新后重启 DSH 并刷新页面。此发行是插件包；桌面安装包需另行更新。\n\nRestart DSH and refresh the page after updating. This is a plugin release; desktop installers are updated separately.',
    '### 发布记录 / Publication',
    `- npm 发布时间 / npm published at: ${publishedAt}（UTC）`,
    `- [npm ${source.version}](https://www.npmjs.com/package/${packageName}/v/${source.version}) · [源码 / Source](${base}/tree/${sha})`,
    `- npm integrity: \`${published.dist!.integrity}\``,
    `[完整变更 / Full changelog](${base}/${previous ? `compare/${previous}...${tag}` : `commits/${tag}`})`,
  ].join('\n\n') + '\n'
}

/** Read errors are not treated as absence. Preserve existing editorial notes on retries. */
export function createRelease(tag: string, body: string, github: Github) {
  const refs = github<{ ref: string }[]>(`git/matching-refs/tags/${tag}`)
  if (!refs.some(ref => ref.ref === `refs/tags/${tag}`)) throw new Error(`Remote tag is missing: ${tag}`)
  // A 404 on this public release endpoint means absent; other failures must stop the job.
  const existing = github<{ id?: number; html_url?: string } | null>(`releases/tags/${tag}`)
  if (existing?.id) return { created: false, url: existing.html_url }
  const result = github<{ html_url: string }>('releases', {
    tag_name: tag, name: tag, body, draft: false,
    prerelease: tag.includes('-'), make_latest: 'false',
  })
  return { created: true, url: result.html_url }
}

export async function readRegistry(version: string, fetcher: typeof fetch = fetch, wait: (ms: number) => Promise<void> = delay): Promise<Packument> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
    const registry = await response.json() as Packument
    if (registry.versions[version] && registry.time[version]) return registry
    if (attempt < 5) await wait(5_000)
  }
  throw new Error(`Not published on npm: ${version}`)
}

async function main() {
  const { values } = parseArgs({ options: {
    tag: { type: 'string' }, tarball: { type: 'string' }, changelog: { type: 'string' },
    backfill: { type: 'boolean' }, write: { type: 'boolean' },
  } })
  const tag = values.tag ?? process.env.GITHUB_REF_NAME ?? ''
  if (!versionPattern.test(tag)) throw new Error('An existing v<version> tag is required')
  if (!values.tarball && !values.backfill) throw new Error('--tarball is required (use --backfill only for historical metadata)')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const git: Git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const github: Github = <T>(endpoint: string, body?: Record<string, unknown>): T => {
    const args = ['api', `repos/${repository}/${endpoint}`]
    if (body) args.push('--method', 'POST', '--input', '-')
    try {
      return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, stdio: ['pipe', 'pipe', 'pipe'] })) as T
    } catch (error) {
      const failure = error as { stderr?: Buffer | string }
      if (!body && endpoint.startsWith('releases/tags/') && String(failure.stderr).includes('(HTTP 404)')) return null as T
      throw error
    }
  }
  const source = JSON.parse(git('show', `${tag}:package.json`)) as Manifest
  const sha = git('rev-parse', `${tag}^{commit}`)
  if (github<{ sha: string }>(`commits/${tag}`).sha !== sha) throw new Error('Local and remote tag commits differ')
  const registry = await readRegistry(tag.slice(1))
  const { published, publishedAt } = validatePublished(tag, source, registry, sha, values.tarball ? readFileSync(values.tarball) : undefined)
  const previous = previousPublishedTag(tag, registry, git)
  let changelog = values.changelog ? readFileSync(values.changelog, 'utf8') : ''
  if (!values.changelog && git('ls-tree', '--name-only', tag, 'CHANGELOG.md') === 'CHANGELOG.md') changelog = git('show', `${tag}:CHANGELOG.md`)
  const commits = git('log', '--no-merges', '--reverse', '--format=%H %s', previous ? `${previous}..${tag}` : tag)
    .split('\n').filter(Boolean).map(line => {
      const hash = line.slice(0, 40)
      // Escape source titles so they remain text in release Markdown.
      const title = line.slice(41).replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')
      return `- ${title} ([${hash.slice(0, 7)}](https://github.com/${repository}/commit/${hash}))`
    }).join('\n')
  const body = renderNotes({ tag, source, published, publishedAt, sha, previous, highlights: changelogSection(changelog, source.version), commits })
  const directory = join(root, '.local', 'releases')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${tag}.md`)
  writeFileSync(file, body)
  console.log(`Release notes: ${file}`)
  if (values.write) console.log(JSON.stringify(createRelease(tag, body, github)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
