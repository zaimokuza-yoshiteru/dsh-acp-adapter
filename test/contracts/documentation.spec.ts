import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, relative as relativePath, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const rootPath = fileURLToPath(root)

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

function packedPaths(): Set<string> {
  const cache = mkdtempSync(resolve(tmpdir(), 'dsh-acp-doc-pack-'))
  try {
    const output = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['--cache', cache, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: rootPath,
        env: { ...process.env, npm_config_update_notifier: 'false' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        timeout: 30_000,
      },
    )
    const parsed: unknown = JSON.parse(output)
    const tarball = Array.isArray(parsed)
      ? parsed[0]
      : parsed !== null && typeof parsed === 'object'
        ? Object.values(parsed)[0]
        : undefined
    if (tarball === undefined || tarball === null || typeof tarball !== 'object' || !('files' in tarball)) {
      throw new Error('npm pack --dry-run returned an unsupported manifest shape')
    }
    const files = (tarball as { files: unknown }).files
    if (
      !Array.isArray(files) ||
      !files.every(
        (file): file is { path: string } =>
          file !== null && typeof file === 'object' && 'path' in file && typeof file.path === 'string',
      )
    ) {
      throw new Error('npm pack --dry-run manifest has no valid file list')
    }
    return new Set(files.map((file) => file.path.replaceAll('\\', '/')))
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

describe('public documentation contract', () => {
  it('publishes one concise Chinese README with an English companion', () => {
    const pkg = JSON.parse(read('package.json')) as { description?: string; files?: string[] }
    expect(pkg.files).toContain('README.md')
    expect(pkg.files).toContain('README.en.md')
    expect(pkg.files).not.toContain('docs/**/*.md')
    expect(pkg.files?.some((path) => path.startsWith('SECURITY'))).toBe(false)
    expect(read('README.md')).toContain('[English](README.en.md)')
    expect(read('README.en.md')).toContain('[中文](README.md)')
  })

  it('covers the complete user installation path without defining the product by one Agent', () => {
    const zh = read('README.md')
    const en = read('README.en.md')
    for (const token of ['@deepseek-ai/dsh', '@zaimokuza/dsh-acp-adapter', 'Devin', 'Codex', 'Kimi', 'Claude']) {
      expect(zh).toContain(token)
      expect(en).toContain(token)
    }
  })

  it('keeps every local README link resolvable', () => {
    for (const path of ['README.md', 'README.en.md']) {
      const contents = read(path)
      const links = [
        ...[...contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]!),
        ...[...contents.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]!),
      ]
      for (const link of links) {
        const githubBlob = link.match(
          /^https:\/\/github\.com\/zaimokuza-yoshiteru\/dsh-acp-adapter\/blob\/main\/([^?#]+)/,
        )
        if (githubBlob) {
          const repoTarget = decodeURIComponent(githubBlob[1]!)
          expect(existsSync(resolve(rootPath, repoTarget)), `${path} -> ${link}`).toBe(true)
          continue
        }
        if (/^(?:https?:|mailto:|#)/.test(link)) continue
        const target = link.split('#', 1)[0]!
        expect(existsSync(resolve(dirname(resolve(rootPath, path)), target)), `${path} -> ${link}`).toBe(true)
      }
    }
  })

  it('keeps every relative README link available in the published tarball', () => {
    const packed = packedPaths()
    for (const path of ['README.md', 'README.en.md']) {
      const contents = read(path)
      const links = [
        ...[...contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]!),
        ...[...contents.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]!),
      ]
      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/.test(link)) continue
        const target = link.split('#', 1)[0]!
        const relative = resolve(dirname(resolve(rootPath, path)), target)
        const packagePath = relativePath(rootPath, relative).replaceAll('\\', '/')
        expect(packed.has(packagePath), `${path} -> ${link} (${packagePath})`).toBe(true)
      }
    }
  }, 45_000)
})
