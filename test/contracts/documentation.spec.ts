import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const rootPath = fileURLToPath(root)

const bilingualPairs = [
  ['README.md', 'README.en.md'],
  ['SECURITY.md', 'SECURITY.en.md'],
  ['docs/getting-started.md', 'docs/en/getting-started.md'],
  ['docs/architecture.md', 'docs/en/architecture.md'],
  ['docs/compatibility.md', 'docs/en/compatibility.md'],
  ['docs/operations.md', 'docs/en/operations.md'],
  ['docs/troubleshooting.md', 'docs/en/troubleshooting.md'],
  ['docs/agents/README.md', 'docs/en/agents/README.md'],
  ['docs/agents/devin.md', 'docs/en/agents/devin.md'],
  ['docs/agents/codex.md', 'docs/en/agents/codex.md'],
  ['docs/agents/kimi.md', 'docs/en/agents/kimi.md'],
  ['docs/agents/claude.md', 'docs/en/agents/claude.md'],
] as const

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

describe('public documentation contract', () => {
  it('uses a concise agent-first package description', () => {
    const pkg = JSON.parse(read('package.json')) as { description?: string, files?: string[] }

    expect(pkg.description).toBe('Use AI agents from the DSH session UI.')
    expect(pkg.files).toContain('README.en.md')
    expect(pkg.files).toContain('SECURITY.en.md')
  })

  it.each(bilingualPairs)('%s has a paired English document at %s', (chinese, english) => {
    expect(read(chinese)).toContain('[English]')
    expect(read(english)).toContain('[中文]')
  })

  it('states the current supported-agent scope without making it the product definition', () => {
    expect(read('README.md')).toContain('目前支持通过')
    expect(read('README.md')).toMatch(/Devin、Codex、Kimi\s*\n和 Claude/)
    expect(read('README.en.md')).toMatch(/It\s+currently connects Devin, Codex, Kimi, and Claude/)
  })

  it('keeps every local documentation link resolvable', () => {
    const paths = [...new Set(bilingualPairs.flat())]

    for (const path of paths) {
      const links = [...read(path).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]!)
      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/.test(link)) continue
        const target = link.split('#', 1)[0]!
        expect(existsSync(resolve(dirname(resolve(rootPath, path)), target)), `${path} -> ${link}`).toBe(true)
      }
    }
  })
})
