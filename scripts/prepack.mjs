#!/usr/bin/env node
// prepack.mjs — 发布前门：npm 包只携带预构建产物，故不设 prepare（用户安装
// 时不跑构建）；打包前在本脚本里把完整门禁跑一遍：
// check-toolchain → clean（realpath 守卫的跨平台清理，build 自身也会先
//   clean，此处再跑一道保证 typecheck/test 阶段也不踩陈旧 .typert 舞台）
//   → typecheck → test → build（build 末尾即 artifact verifier
//   verify-bundle，其 ⑥ 已含一次 pnpm pack --dry-run --json 的 tarball 精确互等断言）
//   → 末尾再做一次人类可读的 pnpm pack --dry-run，让打包日志直接可见文件清单。
//
// 递归守卫：pnpm 11 在 `pnpm pack` / `pnpm publish`（含 --dry-run）前都会执行
// prepack；而 build 末尾的 verify-bundle ⑥ 与本脚本末尾都会再触发一次
// `pnpm pack --dry-run`。嵌套调用统一以 env DSH_ACP_PREPACK_NESTED=1 标记——
// 检出即空转退出，否则 prepack → pack --dry-run → prepack 无限递归。
// （verify-bundle.mjs 的 packDryRun 给子进程带同一标记。）
import { execFileSync } from 'node:child_process'
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

/** pnpm 解析：先 `corepack pnpm`（corepack 生命周期内 PATH 上的裸 pnpm shim 可能钉在
 * 别的版本且拒切 packageManager 钉版；corepack 直调每进程重读项目钉版），ENOENT 回退 PATH pnpm。 */
function pnpm(args) {
  const options = {
    stdio: 'inherit',
    // Windows 经 .cmd shim 解析 pnpm，CVE-2024-27980 加固后无 shell 拒绝 spawn
    // （与 reference apps/cli/src/plugin.ts 同一姿势）。
    shell: process.platform === 'win32',
    env: { ...process.env, DSH_ACP_PREPACK_NESTED: '1' },
  }
  try {
    execFileSync('corepack', ['pnpm', ...args], options)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    execFileSync('pnpm', args, options)
  }
}

for (const step of ['typecheck', 'test', 'build']) {
  console.log(`[prepack] pnpm ${step}`)
  pnpm(['run', step])
}
console.log('[prepack] pnpm pack --dry-run（门禁后的文件清单总览）')
pnpm(['pack', '--dry-run'])
console.log('[prepack] OK: typecheck / test / build(含 verify-bundle) / pack --dry-run 全部通过')
