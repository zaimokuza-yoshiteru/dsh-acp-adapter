#!/usr/bin/env node
// 在 test/build/typecheck 前校验发布工具链。
// engines 与 DSH rc.2 对齐（^22.19.0 || >=24.0.0，见 package.json）；
// 开发与真实 E2E 固定 .nvmrc = 24.19.0；pnpm 经 Corepack 固定 11.7.0（packageManager 字段）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pinned = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
const node = process.versions.node
const [major, minor] = node.split('.').map(Number)
const inEngines = (major === 22 && minor >= 19) || major >= 24
const ua = process.env.npm_config_user_agent ?? ''
const pnpm = ua.match(/pnpm\/([\d.]+)/)?.[1] ?? null

console.log(`[toolchain] node=${node} pnpm=${pnpm ?? 'n/a'} pinned-node=${pinned}`)

if (!inEngines) {
  console.error(`[toolchain] FAIL: node ${node} 不在 engines 范围 ^22.19.0 || >=24.0.0`)
  process.exit(1)
}
if (pnpm && pnpm !== '11.7.0') {
  console.error(`[toolchain] FAIL: pnpm ${pnpm} !== 11.7.0；请用 Corepack 激活（corepack enable && corepack install）`)
  process.exit(1)
}
if (node !== pinned) {
  console.warn(`[toolchain] WARN: node ${node} !== 开发固定版本 ${pinned}（.nvmrc）；测试通过不代表发布工具链一致`)
}
