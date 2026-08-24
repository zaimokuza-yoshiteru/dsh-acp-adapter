#!/usr/bin/env node
// host-latest lane 辅助：不改 package.json（devDep 精确钉版是最低版本的
// 测试真源，钉版守卫测试继续生效），改为向 pnpm-workspace.yaml 写入一段带
// 标记的 overrides 块，把全部 @deepseek-ai/dsh-* 依赖强制解析到给定
// dist-tag/版本（默认 next）。随后 pnpm install --no-frozen-lockfile。
// cordis 有独立版本线（vendor 进 DSH 但独立发版），不在改写面内。
// 用法：node scripts/use-host-tag.mjs [tag]
// 还原：node scripts/use-host-tag.mjs --reset，然后恢复 lockfile——lane 的
// --no-frozen-lockfile install 已把 lockfile 改写成 lane 解析，frozen 会因
// overrides 配置不匹配而拒绝；要么 `git checkout -- pnpm-lock.yaml`（仓内
// 提交态是精确钉版真源）再 `pnpm install --frozen-lockfile`，要么
// `pnpm install --no-frozen-lockfile` 重新生成（实证修订）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tag = process.argv[2] ?? 'next'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'package.json')
const workspacePath = join(root, 'pnpm-workspace.yaml')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

const BEGIN = '# >>> dsh-acp host-lane overrides (scripts/use-host-tag.mjs) >>>'
const END = '# <<< dsh-acp host-lane overrides <<<'

// BEGIN/END 含/. 等正则元字符，构造 RegExp 前必须转义（修复：未转义时
// strip 从不命中、--reset 空转，overrides 块曾被意外提交进 d440623）。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const yaml = readFileSync(workspacePath, 'utf8')
const stripped = yaml.replace(new RegExp(`\\n?${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, 'g'), '\n')
if (stripped.includes(BEGIN)) throw new Error('use-host-tag: strip failed — host-lane markers still present')

if (tag === '--reset') {
  writeFileSync(workspacePath, stripped.endsWith('\n') ? stripped : `${stripped}\n`)
  console.log('use-host-tag: removed host-lane overrides from pnpm-workspace.yaml')
} else {
  const names = Object.keys(pkg.devDependencies ?? {})
    .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
    .sort()
  if (names.length === 0) throw new Error('use-host-tag: no @deepseek-ai/dsh-* devDependencies found')
  const block = `${BEGIN}\noverrides:\n${names.map((name) => `  '${name}': '${tag}'`).join('\n')}\n${END}\n`
  writeFileSync(workspacePath, `${stripped.endsWith('\n') ? stripped : `${stripped}\n`}\n${block}`)
  console.log(`use-host-tag: pinned ${names.length} @deepseek-ai/dsh-* overrides to ${JSON.stringify(tag)}`)
}
