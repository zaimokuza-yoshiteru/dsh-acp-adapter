#!/usr/bin/env node
// 跨平台安全 clean：删除生成产物目录（repo 内 lib/ 与 .typert/，以及经
// 命令行参数显式给出的 pack staging 目录），替代 POSIX-only 的 `rm -rf`，为
// 未来 Windows 构建留可运行基础（构建基建可移植 ≠ 承诺 Windows 产品支持）。
//
// 安全设计（删除是不可逆操作，宁可 fail loud 不可误删）：
//   1. 内置目标只有固定相对名 `lib` 与 `.typert`，不接受任何形式的改写；
//      额外目标只能经 argv 显式给出，且必须是仓根内的相对路径（拒绝绝对
//      路径与 `..` 逃逸）。
//   2. 删除前对每个目标做 realpath 校验：realpath(target) 必须逐字节等于
//      realpath(root) 拼上目标相对名——符号链接/挂载点替换会改变
//      realpath，检出即 fail loud，一个字节都不删。
//   3. 目标必须是目录；缺席视为 already clean，不算错误。
//
// 只用 node:fs / node:path，无 shell、无 POSIX-only API。
// Usage: node scripts/clean.mjs [额外的仓内相对目录 ...]
import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_REAL = realpathSync(root)
const BUILTIN_TARGETS = ['lib', '.typert']

const failures = []
const fail = (msg) => failures.push(msg)

/** 把 argv 额外目标收窄为仓内相对路径；非法形态返回 null 并登记失败。 */
function resolveExtraTarget(arg) {
  if (isAbsolute(arg)) {
    fail(`拒绝绝对路径目标: ${arg}（额外目标必须是仓根内相对路径）`)
    return null
  }
  const abs = resolve(root, arg)
  if (abs !== ROOT_REAL && !abs.startsWith(ROOT_REAL + sep)) {
    fail(`拒绝逃逸仓根的目标: ${arg}`)
    return null
  }
  if (abs === ROOT_REAL) {
    fail(`拒绝把仓根本身当作 clean 目标: ${arg}`)
    return null
  }
  return abs
}

const targets = [...BUILTIN_TARGETS.map((name) => join(root, name))]
for (const arg of process.argv.slice(2)) {
  const abs = resolveExtraTarget(arg)
  if (abs !== null) targets.push(abs)
}
// argv 解析失败即整体中止：目标清单都不可信时一个字节都不删。
if (failures.length > 0) {
  console.error(`[clean] FAIL（${String(failures.length)} 项）:`)
  for (const msg of failures) console.error(`  - ${msg}`)
  process.exit(1)
}

for (const target of targets) {
  const rel = target.slice(root.length + 1)
  // lstat 检测存在性（覆盖悬死符号链接；existsSync 对悬死链接误报缺席）。
  const stat = lstatSync(target, { throwIfNoEntry: false })
  if (stat === undefined) {
    console.log(`[clean] already clean: ${rel}`)
    continue
  }
  // realpath 守卫：target 的真实落点必须就是「仓根 realpath + 目标相对名」。
  // target 若是符号链接/挂载点，realpath 指向仓外即在此响亮失败。
  const expected = join(ROOT_REAL, rel)
  let actual
  try {
    actual = realpathSync(target)
  } catch {
    fail(`realpath 守卫拒绝删除 ${target}: 目标无法解析（悬死符号链接？）`)
    continue
  }
  if (actual !== expected) {
    fail(`realpath 守卫拒绝删除 ${target}: 真实落点是 ${actual}（符号链接/挂载点替换？）`)
    continue
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`拒绝删除非目录目标: ${target}`)
    continue
  }
  rmSync(target, { recursive: true })
  console.log(`[clean] removed: ${rel}`)
}

if (failures.length > 0) {
  console.error(`[clean] FAIL（${String(failures.length)} 项）:`)
  for (const msg of failures) console.error(`  - ${msg}`)
  process.exit(1)
}
