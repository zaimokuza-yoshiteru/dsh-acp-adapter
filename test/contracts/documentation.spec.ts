import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const rootPath = fileURLToPath(root)

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

describe('public documentation contract', () => {
  it('publishes one concise Chinese README with an English companion', () => {
    const pkg = JSON.parse(read('package.json')) as { description?: string, files?: string[] }
    expect(pkg.description).toBe('Use AI agents from the DSH session UI.')
    expect(pkg.files).toContain('README.md')
    expect(pkg.files).toContain('README.en.md')
    expect(pkg.files).not.toContain('docs/**/*.md')
    expect(pkg.files?.some(path => path.startsWith('SECURITY'))).toBe(false)
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
    expect(zh).toContain('通过 DeepSeek Harness（DSH）会话页面使用智能体')
    expect(en).toContain('from the DeepSeek Harness (DSH) session UI')
  })

  it('documents Native Agent Access and external-login-only truthfully', () => {
    expect(read('README.md')).toContain('原生 Agent 访问')
    expect(read('README.md')).toContain('无法限制绕过 ACP 审批的 Agent 工具')
    expect(read('README.md')).toContain('插件不会要求你把 token')
    expect(read('README.en.md')).toContain('Native Agent Access')
    expect(read('README.en.md')).toContain('cannot constrain Agent tools that bypass that flow')
  })

  it('keeps every local README link resolvable', () => {
    for (const path of ['README.md', 'README.en.md']) {
      const links = [...read(path).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]!)
      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/.test(link)) continue
        const target = link.split('#', 1)[0]!
        expect(existsSync(resolve(dirname(resolve(rootPath, path)), target)), `${path} -> ${link}`).toBe(true)
      }
    }
  })
})
