#!/usr/bin/env node
// 陈旧构建产物验收（独立 gate 脚本，不进 prepack——两次完整 build 对每次
// 打包太慢；复现命令登记在 release-evidence/README.md）。
//
// 证明「删除源文件后重新 build，旧产物不再留在 lib/ 与 npm tarball」：
//   1. 写入一次性 throwaway 源文件 src/remote/__stale-build-check__.ts
//      （落在 files[] 的 lib/remote/**/*.js 与 lib/types/**/*.d.ts 覆盖内）；
//   2. pnpm build → 断言三个产物（.js / .d.ts / .d.ts.map）在 lib/ 存在，
//      且 .js 与 .d.ts 出现在 pnpm pack --dry-run --json 清单（.d.ts.map
//      按 verify-bundle 纪律不进 tarball）；
//   3. 删除源文件 → pnpm build → 断言三个产物从 lib/ 消失，且 pack 清单
//      不含任何 __stale-build-check__ 路径。
//
// 安全：marker 源文件已存在即 fail loud（绝不覆盖用户文件）；任何失败在
// finally 里删除 marker 源，绝不留仓内垃圾。只用 node: 标准库，无 shell。
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER_SOURCE = join(root, 'src', 'remote', '__stale-build-check__.ts')
const MARKER_ARTIFACTS = [
  'lib/remote/__stale-build-check__.js',
  'lib/remote/__stale-build-check__.js.map',
  'lib/types/remote/__stale-build-check__.d.ts',
  'lib/types/remote/__stale-build-check__.d.ts.map',
]
// 进 tarball 的子集（宿主半 .js.map 与全部 .d.ts.map 按 verify-bundle 纪律被
// files[] 排除）。
const MARKER_TARBALL_PATHS = [
  'lib/remote/__stale-build-check__.js',
  'lib/types/remote/__stale-build-check__.d.ts',
]

if (existsSync(MARKER_SOURCE)) {
  console.error(`[stale-build] FAIL: ${MARKER_SOURCE} 已存在——拒绝覆盖，先人工确认该文件归属`)
  process.exit(1)
}

/** corepack 直调优先（理由见 prepack.mjs 同款注释），ENOENT 回退 PATH pnpm。 */
function pnpm(args, options = {}) {
  const opts = { cwd: root, stdio: 'inherit', ...options }
  try {
    return execFileSync('corepack', ['pnpm', ...args], opts)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return execFileSync('pnpm', args, opts)
  }
}

function build() {
  console.log('[stale-build] pnpm build')
  pnpm(['run', 'build'])
}

/** pnpm pack --dry-run --json 的 tarball 文件清单（嵌套标记防 prepack 递归）。 */
function packFileList() {
  const env = { ...process.env, DSH_ACP_PREPACK_NESTED: '1' }
  const out = pnpm(['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const tar = JSON.parse(out.slice(out.indexOf('{')))
  return new Set((tar.files ?? []).map((file) => file.path))
}

const failures = []
const fail = (msg) => failures.push(msg)

try {
  writeFileSync(MARKER_SOURCE, 'export const __staleBuildCheck = true\n')

  build()
  for (const rel of MARKER_ARTIFACTS) {
    if (!existsSync(join(root, rel))) fail(`首轮 build 后产物缺失: ${rel}`)
  }
  const withMarker = packFileList()
  for (const rel of MARKER_TARBALL_PATHS) {
    if (!withMarker.has(rel)) fail(`首轮 pack 清单缺少 marker 产物: ${rel}`)
  }
  if (failures.length === 0) console.log('[stale-build] 首轮：marker 产物在 lib/ 与 tarball 均在场（符合预期）')

  rmSync(MARKER_SOURCE)

  build()
  for (const rel of MARKER_ARTIFACTS) {
    if (existsSync(join(root, rel))) fail(`删除源文件重 build 后陈旧产物仍留在 lib/: ${rel}`)
  }
  const withoutMarker = packFileList()
  for (const path of withoutMarker) {
    if (path.includes('__stale-build-check__')) fail(`删除源文件重 build 后 tarball 仍含陈旧产物: ${path}`)
  }
  if (failures.length === 0) console.log('[stale-build] 次轮：marker 产物从 lib/ 与 tarball 同时消失（陈旧产物已根除）')
} finally {
  if (existsSync(MARKER_SOURCE)) {
    rmSync(MARKER_SOURCE)
    console.log('[stale-build] finally: 已删除 marker 源文件')
  }
}

if (failures.length > 0) {
  console.error(`[stale-build] FAIL（${String(failures.length)} 项）:`)
  for (const msg of failures) console.error(`  - ${msg}`)
  console.error('[stale-build] 注意：失败可能把 lib/ 留在中间态，请再跑一次 pnpm build 还原')
  process.exit(1)
}
console.log('[stale-build] OK: 删除源文件后重新 build/pack，旧产物不再出现在 lib/ 与 tarball')
