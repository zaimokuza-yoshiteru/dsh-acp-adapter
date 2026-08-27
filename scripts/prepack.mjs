#!/usr/bin/env node
// prepack.mjs — 发布前门：npm 包只携带预构建产物，故不设 prepare（用户安装
// 时不跑构建）；打包前在本脚本里把完整门禁跑一遍：
// check-toolchain → clean（realpath 守卫的跨平台清理，build 自身也会先
//   clean，此处再跑一道保证 typecheck/test 阶段也不踩陈旧 .typert 舞台）
//   → typecheck → test → build（build 末尾即 artifact verifier
//   verify-bundle，其 ⑥ 已含一次 npm pack --dry-run --json 的 tarball 精确互等断言）
//   → 末尾再做一次人类可读的 npm pack --dry-run，让打包日志直接可见文件清单。
//
// 递归守卫保护外层 pnpm pack/publish。内部清单检查使用
// `npm pack --dry-run --ignore-scripts`，不会再次进入生命周期。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.DSH_ACP_PREPACK_NESTED === '1') {
  console.log('[prepack] nested pack invocation (verifier/dry-run) — gates already ran, skipping')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 门禁前先 clean（nested 守卫之后——嵌套 pack 调用绝不触产物目录）。
console.log('[prepack] node scripts/clean.mjs')
execFileSync(process.execPath, [join(root, 'scripts', 'clean.mjs')], { stdio: 'inherit' })

/** Resolve pnpm from PATH, with the Windows .cmd shim enabled explicitly. */
function pnpm(args) {
  const options = {
    stdio: 'inherit',
    // Windows 经 .cmd shim 解析 pnpm，CVE-2024-27980 加固后无 shell 拒绝 spawn
    // （与 reference apps/cli/src/plugin.ts 同一姿势）。
    shell: process.platform === 'win32',
    env: { ...process.env, DSH_ACP_PREPACK_NESTED: '1' },
  }
  execFileSync('pnpm', args, options)
}

for (const step of ['typecheck', 'test', 'build']) {
  console.log(`[prepack] pnpm ${step}`)
  pnpm(['run', step])
}
console.log('[prepack] npm pack --dry-run（门禁后的文件清单总览）')
const npmCache = mkdtempSync(join(os.tmpdir(), 'dsh-acp-npm-cache-'))
try {
  execFileSync('npm', ['--cache', npmCache, 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
} finally {
  rmSync(npmCache, { recursive: true, force: true })
}
console.log('[prepack] OK: typecheck / test / build(含 verify-bundle) / pack --dry-run 全部通过')
