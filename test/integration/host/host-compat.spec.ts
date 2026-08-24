// host-compat.spec.ts — host-compat 兼容岛的漂移检测（要求 3）与结构门
// fail closed（版本地板 + seam 结构检查）。
//
// 上游真源：node_modules 里 @deepseek-ai/dsh-agent-loop@0.1.1-rc.2 的已构建 lib
// （devDeps 精确钉版，node_modules 即上游真源；对应 reference/deepseek-harness
// tag dsh-v0.1.1-rc.2，commit b150a551b8）。本套件钉住：
//   1. 版本钉：devDep 版本 === host-compat/structure-gate.ts 的 MIN_HOST_VERSION
//      常量 === '0.1.1-rc.2'，UPSTREAM_TAG/COMMIT 常量不被改；
//   2. raceAbort / raceAbortCall / assertAgentOptions（隔离项 2/3/4）：host-compat
//      TS 源经 ts.transpileModule 脱类型后与上游 lib 同名函数体机械比较
//      （规范化：去注释、统一引号、void 0/语句位 void、花括号/分号/空白）；
//   3. FiberState 数值镜像（隔离项 8）：上游 INACTIVE_STATES = Set([5,4,3])
//      ↔ fiber-state.ts 三常量；
//   4. 发布协议事件顺序（隔离项 5）：publish 闭包里 assertLive ×
//      sessions.enter → agents.enter → sessions.announce → agents.announce →
//      agent/session-start 的调用序列逐位相等；
//   5. FactoryOwnership 方法面（隔离项 1）：本岛方法集是上游的精确子集
//      （裁 trackStartup/waitWhileActive 是有文档的裁剪，上游方法清单同步钉死）；
//   6. resumeWith load 屏障协议序列（隔离项 7）：owner effect → AbortSignal.any
//      三源融合 → raceAbortCall(释放 preparation) → unfollowOwner →
//      fiber.assertActive → isActive 复查 → setupAndPublish → 释放 →
//      trackWrapper；Symbol.dispose ↔ disposePreparation 与 setupAndPublish ↔
//      setupAndPublishAcpLifecycle 是有文档的改名（豁免映射见 canonToken）。
// 任一断言红 = 上游漂移或副本被改：先回 host-compat 同步，再评估结构门版本地板。
//
// 附：host-compat/typert-protocol/{index,types}.ts 是 typert Remote 生成管线
// 的 staged 源码（scripts/gen-typert.mjs 拷入合成 workspace 顶替 generator 的
// package.json 解析），同样 vendored 自同一上游 HEAD 的 packages/typert/protocol/src
// （index/types 不引用 invariant.ts，无需 vendor），sha256 钉死防静默漂移
// （与结构门同一 commit 真源）。
//
// 结构门单测：注入缝隙（fake loader internal / readPackageJson 表驱动 / mock ctx）
// 覆盖版本低于地板、版本等于/高于地板、解析失败、seam 缺失、未结算五条失败/放行
// 路径与幂等结算；compareVersions 的 prerelease 语义表驱动钉死；集成用例证明
// fail closed 只关 ACP 路由（native 路由照常委托 super）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { FIBER_DISPOSED, FIBER_FAILED, FIBER_UNLOADING } from '../../../src/host-compat/fiber-state.ts'
import { MIN_HOST_VERSION, UPSTREAM_COMMIT, UPSTREAM_TAG, compareVersions } from '../../../src/host-compat/structure-gate.ts'
import type { StructureGateDeps } from '../../../src/host-compat/structure-gate.ts'
import type { HostModuleLoader } from '../../../src/host-compat/host-scope.ts'

type StructureGateModule = typeof import('../../../src/host-compat/structure-gate.ts')

// ---------- 上游 lib 与本岛源码的读取/抽取/归一化 ----------

const require_ = createRequire(import.meta.url)
const UPSTREAM_PKG_JSON = require_.resolve('@deepseek-ai/dsh-agent-loop/package.json')
const UPSTREAM_LIB = fs.readFileSync(path.join(path.dirname(UPSTREAM_PKG_JSON), 'lib', 'index.js'), 'utf8')
const COMPAT_SRC = fs.readFileSync(new URL('../../../src/host-compat/agent-loop.ts', import.meta.url), 'utf8')
/** 脱类型：与 rolldown 产物的差距只剩排版/注释/void 习惯（归一化吸收）。 */
const COMPAT_JS = ts.transpileModule(COMPAT_SRC, {
  compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
}).outputText

/** 具名函数体抽取（括号配平；模板串 ${} 自配平）。 */
function extractFunction(text: string, name: string): string {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text)
  if (match === null) throw new Error(`function not found: ${name}`)
  return extractBlockAt(text, match.index)
}

/** 锚点起的配平块抽取（类体/闭包用）。 */
function extractBlock(text: string, anchor: RegExp): string {
  const match = anchor.exec(text)
  if (match === null) throw new Error(`anchor not found: ${anchor}`)
  return extractBlockAt(text, match.index)
}

function extractBlockAt(text: string, start: number): string {
  const open = text.indexOf('{', start)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced block at ${start}`)
}

/**
 * 排版归一化：去注释；统一引号；`void 0`→`undefined`、语句位 `void` 删除；
 * 花括号/分号消解为空白（吸收单语句 if 的括号风格差）；空白与标点间距压平。
 * 只保语义 token 流——两侧同一算法，漂移必然改变 token 流。
 */
function normalizeJs(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'([^'\\\n]*)'/g, '"$1"')
    .replace(/\bvoid 0\b/g, 'undefined')
    .replace(/\bvoid (?=\S)/g, '')
    .replace(/\s*=>\s*/g, '=>')
    .replace(/[;{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([()\[\],:<>|&!?+*/=-])\s*/g, '$1')
    .trim()
}

/** 类体方法名清单（字段声明无 `(` 不匹配；get/async 前缀吸收）。 */
function methodNames(classText: string): string[] {
  const names: string[] = []
  const pattern = /(?:^|\n)\s*(?:async\s+)?(?:get\s+)?(\w+)\s*\([^)]*\)\s*\{/g
  let match
  while ((match = pattern.exec(classText)) !== null) names.push(match[1]!)
  return names
}

describe('host-compat 差异钉版（上游 dsh-v0.1.1-rc.2, commit b150a551b8）', () => {
  it('版本钉：devDep 精确 0.1.1-rc.2 === MIN_HOST_VERSION 常量；tag/commit 常量不被改', () => {
    const upstreamManifest = JSON.parse(fs.readFileSync(UPSTREAM_PKG_JSON, 'utf8')) as { version: string }
    expect(upstreamManifest.version).toBe('0.1.1-rc.2')
    expect(MIN_HOST_VERSION).toBe(upstreamManifest.version)
    expect(UPSTREAM_TAG).toBe('dsh-v0.1.1-rc.2')
    expect(UPSTREAM_COMMIT).toBe('b150a551b8')
    const manifest = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    expect(manifest.devDependencies?.['@deepseek-ai/dsh-agent-loop']).toBe(MIN_HOST_VERSION)
  })

  it.each(['raceAbort', 'raceAbortCall', 'assertAgentOptions'])('隔离项 2/3/4：%s 函数体与上游 lib 机械一致', (name) => {
    const upstream = normalizeJs(extractFunction(UPSTREAM_LIB, name))
    const island = normalizeJs(extractFunction(COMPAT_JS, name))
    expect(island).toBe(upstream)
  })

  it('隔离项 8：FiberState 数值镜像 === 上游 INACTIVE_STATES {UNLOADING:5, DISPOSED:4, FAILED:3}', () => {
    const raw = /INACTIVE_STATES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(UPSTREAM_LIB)?.[1]
    expect(raw).toBeDefined()
    const upstreamValues = (raw ?? '').split(',').map((entry) => Number(entry.trim())).sort()
    expect(upstreamValues).toEqual([FIBER_FAILED, FIBER_DISPOSED, FIBER_UNLOADING].sort())
    expect([FIBER_FAILED, FIBER_DISPOSED, FIBER_UNLOADING]).toEqual([3, 4, 5])
  })

  it('隔离项 5：publish 发布协议事件序列（assertLive × enter/announce/session-start）逐位相等', () => {
    const PUBLISH_TOKENS = /assertLive\(\)|sessions\.enter|agents\.enter|sessions\.announce|agents\.announce|agent\/session-start/g
    const upstream = extractBlock(UPSTREAM_LIB, /publish:\s*\(source\)\s*=>\s*\{/).match(PUBLISH_TOKENS)
    const island = extractBlock(COMPAT_JS, /publish:\s*\(source\)\s*=>\s*\{/).match(PUBLISH_TOKENS)
    expect(island).toEqual([
      'assertLive()',
      'sessions.enter',
      'agents.enter',
      'sessions.announce',
      'assertLive()',
      'agents.announce',
      'assertLive()',
      'agent/session-start',
      'assertLive()',
    ])
    expect(island).toEqual(upstream)
  })

  it('隔离项 1：AcpFactoryOwnership 方法面是上游 FactoryOwnership 的精确子集（裁剪集钉死）', () => {
    const upstream = methodNames(extractBlock(UPSTREAM_LIB, /var FactoryOwnership = class\s*\{/))
    const island = methodNames(extractBlock(COMPAT_JS, /class AcpFactoryOwnership\s*\{/))
    // 裁剪面钉死：startup 追踪（trackStartup/waitWhileActive/inactive）不复制——
    // 声明式 config 路径整体留在父类。上游若新增/改名方法，此断言报警。
    expect(upstream).toEqual(['constructor', 'signal', 'isActive', 'track', 'trackStartup', 'trackWrapper', 'waitWhileActive', 'dispose'])
    expect(island).toEqual(['constructor', 'signal', 'isActive', 'track', 'trackWrapper', 'dispose'])
    for (const name of island) expect(upstream).toContain(name)
  })

  it('隔离项 7：resumeWith load 屏障协议序列逐位相等（豁免：Symbol.dispose→disposePreparation、setupAndPublish→ACP 帧名）', () => {
    const RESUME_TOKENS = /ownerCtx\.effect|AbortSignal\.any|raceAbortCall|Symbol\.dispose|disposePreparation|await unfollowOwner|fiber\.assertActive|isActive\(\)|setupAndPublish\w*|trackWrapper/g
    const canonToken = (token: string): string =>
      token === 'Symbol.dispose' ? 'disposePreparation' : token.startsWith('setupAndPublish') ? 'setupAndPublish' : token
    const upstream = extractBlock(UPSTREAM_LIB, /resumeWith\(ownerCtx, persistence, options\)\s*\{/).match(RESUME_TOKENS)?.map(canonToken)
    const island = extractFunction(COMPAT_JS, 'resumeAcpLifecycle').match(RESUME_TOKENS)?.map(canonToken)
    expect(island).toEqual(upstream)
    expect(island).toEqual([
      'ownerCtx.effect',
      'AbortSignal.any',
      'raceAbortCall',
      'disposePreparation',
      'await unfollowOwner',
      'fiber.assertActive',
      'isActive()',
      'setupAndPublish',
      'disposePreparation',
      'trackWrapper',
    ])
  })

  it('有文档的改名钉版：上游 effect 标签前缀 agentLoop. ↔ 本岛 acpAgentLoop.', () => {
    expect(UPSTREAM_LIB).toContain('agentLoop.lifecycle(')
    expect(UPSTREAM_LIB).toContain('agentLoop.resume-load(')
    expect(COMPAT_JS).toContain('acpAgentLoop.lifecycle(')
    expect(COMPAT_JS).toContain('acpAgentLoop.resume-load(')
  })

 // typert Remote 生成管线的 staged 源码（gen-typert.mjs 顶替 generator 的
  // package.json 解析）。vendored 自同一上游 HEAD（packages/typert/protocol/src），
  // sha256 钉死——改动必须先回 reference 仓同步上游，再更新钉值。
  it.each([
    ['index.ts', '41915d362b5a77dc08c673390114c721dec4dbe868d83307816dfe98e72f2933'],
    ['types.ts', 'ded3485928ffca9ba6eaee881b0281bb840bd0732e3a8f72241c4240fef16efc'],
  ])('vendored 钉：host-compat/typert-protocol/%s 与上游 b150a551b8 逐字节一致（sha256）', (file, sha256) => {
    const content = fs.readFileSync(new URL(`../../../src/host-compat/typert-protocol/${file}`, import.meta.url))
    expect(createHash('sha256').update(content).digest('hex')).toBe(sha256)
  })
})

// ---------- compareVersions（prerelease 感知的最低版本判定） ----------

describe('compareVersions：semver 比较（含 prerelease 语义）', () => {
  it.each([
    ['0.1.1-rc.2', '0.1.1-rc.2', 0],
    ['0.1.1-rc.3', '0.1.1-rc.2', 1],
    ['0.1.1', '0.1.1-rc.2', 1],
    ['0.1.2', '0.1.1-rc.2', 1],
    ['0.2.0', '0.1.1-rc.2', 1],
    ['1.0.0', '0.1.1-rc.2', 1],
    ['0.1.1-rc.1', '0.1.1-rc.2', -1],
    ['0.1.0-rc.8', '0.1.1-rc.2', -1],
    ['0.1.0', '0.1.1-rc.2', -1],
    // prerelease 语义：数字标识符 < 字母；前缀相同则标识符少者小；正式版 > 预发布
    ['0.1.1-rc.2', '0.1.1-rc.10', -1],
    ['0.1.1-rc.1', '0.1.1-rc.alpha', -1],
    ['0.1.1-rc', '0.1.1-rc.1', -1],
    ['0.1.1-alpha.1', '0.1.1-alpha', 1],
    ['0.1.1-rc.2+build.5', '0.1.1-rc.2', 0],
  ])('compareVersions(%s, %s) 的符号为 %d', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? Number.NaN)).toBe(sign)
    if (sign !== 0) expect(Math.sign(compareVersions(b, a) ?? Number.NaN)).toBe(-sign)
  })

  it('不可解析的版本返回 undefined（调用方按不兼容处理）', () => {
    expect(compareVersions('not-a-version', '0.1.1-rc.2')).toBeUndefined()
    expect(compareVersions('0.1.1-rc.2', '0.1')).toBeUndefined()
    expect(compareVersions('', '0.1.1-rc.2')).toBeUndefined()
  })
})

// ---------- 结构门（fail closed）单测 ----------

const FAKE_ENTRY = '/fake/host/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
const FAKE_PKG_JSON = '/fake/host/node_modules/@deepseek-ai/dsh-agent-loop/package.json'

function fakeLoaderV2(entry: string): { internal: HostModuleLoader; calls: { parentURL: string; specifier: string }[] } {
  const calls: { parentURL: string; specifier: string }[] = []
  const internal: HostModuleLoader = {
    version: 'v2',
    resolveSync(parentURL, request) {
      calls.push({ parentURL, specifier: request.specifier })
      return { url: pathToFileURL(entry).href }
    },
  }
  return { internal, calls }
}

/** 表驱动 readPackageJson：命中键返回给定值，未命中按 ENOENT 风格 reject（走查继续向上）。 */
function readPackageJsonTable(table: Record<string, { name?: unknown; version?: unknown }>): StructureGateDeps['readPackageJson'] {
  return async (candidate) => {
    const hit = table[candidate]
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${candidate}'`), { code: 'ENOENT' })
    return hit
  }
}

/**
 * 结构齐备的 mock ctx（缺省即全 seam 在场）：drop* 点名要摘掉的 seam 成员，
 * fiberState 覆盖 ctx.fiber.state 的形态。SessionPreparation 两项由结构门对真实
 * 导入类检查（devDep 真源），mock 无法也不应伪造。
 */
function fakeSeamCtx(overrides?: {
  dropAgents?: readonly string[]
  dropSessions?: readonly string[]
  fiberState?: unknown
}): unknown {
  const record = (methods: readonly string[], drop: readonly string[] = []): Record<string, unknown> =>
    Object.fromEntries(methods.filter((name) => !drop.includes(name)).map((name) => [name, () => undefined]))
  return {
    agents: record(['enter', 'announce', 'setFactory', 'get'], overrides?.dropAgents),
    sessions: record(['prepare', 'enter', 'announce', 'flush'], overrides?.dropSessions),
    fiber: { ...('fiberState' in (overrides ?? {}) ? { state: overrides?.fiberState } : { state: 1 }) },
  }
}

describe('structure-gate：fail closed', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未结算即取用：响亮失败', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    expect(() => gate.assertHostCompatible()).toThrow(/host structure gate has not settled/)
  })

  it('宿主链命中 rc.2（fake loader + 表驱动 package.json 走查 + 结构齐备 mock ctx）：门开；parentURL 锚在本模块', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2' } }),
    })
    expect(() => gate.assertHostCompatible()).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
    // 解析起点 = 本模块文件 URL（与静态 import AgentLoop 同一解析起点）
    expect(loader.calls).toHaveLength(1)
    expect(loader.calls[0]?.specifier).toBe('@deepseek-ai/dsh-agent-loop')
    expect(loader.calls[0]?.parentURL).toContain('host-compat/structure-gate.ts')
  })

  it.each(['0.1.1-rc.2', '0.1.1-rc.3', '0.1.1', '0.1.2', '0.2.0'])('最低版本制：宿主 %s 接受（不因版本号更高而拒绝）', async (version) => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version } }),
    })
    expect(() => gate.assertHostCompatible()).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each(['0.1.1-rc.1', '0.1.0-rc.8', '0.1.0'])('最低版本制：宿主 %s 低于地板，门关（ACP_HOST_INCOMPATIBLE + 升级指引 + stderr 双写）', async (version) => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version } }),
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    let first: unknown
    let second: unknown
    try { gate.assertHostCompatible() } catch (error) { first = error }
    try { gate.assertHostCompatible() } catch (error) { second = error }
    expect(first).toBe(second)
    expect(first).toBeInstanceOf(gate.AcpHostIncompatibleError)
    const failure = first as InstanceType<StructureGateModule['AcpHostIncompatibleError']>
    expect(failure.code).toBe('ACP_HOST_INCOMPATIBLE')
    expect(failure.message).toContain(version)
    expect(failure.message).toContain(FAKE_PKG_JSON)
    expect(failure.message).toContain('0.1.1-rc.2')
    expect(failure.message).toContain('dsh-v0.1.1-rc.2')
    expect(failure.message).toContain('b150a551b8')
    expect(failure.message).toContain('native routes stay available')
    const stderrText = stderr.mock.calls.map((call) => String(call[0])).join('')
    expect(stderrText).toContain('[dsh-acp structure-gate] ERROR')
  })

  it('loader 缺席：自锚 createRequire 兜底命中 devDep 真源（0.1.1-rc.2），门开', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const logger = { warn: vi.fn(), error: vi.fn() }
    await gate.initStructureGate(logger, undefined, fakeSeamCtx())
    expect(() => gate.assertHostCompatible()).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('seam 缺失（残缺 mock ctx）：门关，message 点名每个缺失成员；版本合格也不放行', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx({
      dropAgents: ['setFactory'],
      dropSessions: ['flush'],
      fiberState: 'active',
    }), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2' } }),
    })
    let failure: unknown
    try { gate.assertHostCompatible() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(gate.AcpHostIncompatibleError)
    const message = (failure as Error).message
    expect(message).toContain('missing host seam: agents.setFactory')
    expect(message).toContain('missing host seam: sessions.flush')
    expect(message).toContain('missing host seam: ctx.fiber.state')
    expect(message).not.toContain('below the minimum')
    expect(message).toContain('native routes stay available')
  })

  it('seam 全缺（空对象 ctx）：门关，agents/sessions 八项与 fiber 全部点名', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await gate.initStructureGate(logger, { internal: loader.internal }, {}, {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2' } }),
    })
    let failure: unknown
    try { gate.assertHostCompatible() } catch (error) { failure = error }
    const message = (failure as Error).message
    for (const seam of ['agents.enter', 'agents.announce', 'agents.setFactory', 'agents.get', 'sessions.prepare', 'sessions.enter', 'sessions.announce', 'sessions.flush', 'ctx.fiber.state']) {
      expect(message).toContain(seam)
    }
  })

  it('解析全失败（宿主链 throw + 自锚 throw）：门关，两条原因都在 message 里', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const broken: HostModuleLoader = {
      version: 'v2',
      resolveSync() { throw new Error('ERR_MODULE_NOT_FOUND simulated') },
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await gate.initStructureGate(logger, { internal: broken }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('no own-tree copy') },
      readPackageJson: readPackageJsonTable({}),
    })
    let failure: unknown
    try { gate.assertHostCompatible() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(gate.AcpHostIncompatibleError)
    const message = (failure as Error).message
    expect(message).toContain('cannot resolve the host @deepseek-ai/dsh-agent-loop entry')
    expect(message).toContain('ERR_MODULE_NOT_FOUND simulated')
    expect(message).toContain('no own-tree copy')
    expect(message).toContain('native routes stay available')
  })

  it('命中入口但向上走查无同名 package.json：门关并报入口路径', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({}),
    })
    let failure: unknown
    try { gate.assertHostCompatible() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(gate.AcpHostIncompatibleError)
    expect((failure as Error).message).toContain(FAKE_ENTRY)
    expect((failure as Error).message).toContain('no ancestor package.json')
  })

  it('结算幂等：首次结算即权威，二次 init（不同 deps/ctx）不翻案', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const loader = fakeLoaderV2(FAKE_ENTRY)
    const failingDeps: StructureGateDeps = {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.0-rc.8' } }),
    }
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), failingDeps)
    // 二次 init 换「会成功」的 deps 与结构齐备 ctx：结果不翻案（进程级首次结算权威）
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx(), {
      resolveOwn: () => { throw new Error('unused') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2' } }),
    })
    expect(() => gate.assertHostCompatible()).toThrow(gate.AcpHostIncompatibleError)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

// ---------- fail closed 集成：ACP 路由关门，native 路由照常 ----------

describe('结构门集成：门关时 ACP create/resume 响亮拒绝，native 路由零影响', () => {
  it('createAgent/resume 的 ACP 分支复抛 ACP_HOST_INCOMPATIBLE；native createAgent 跑通完整 turn；ACP 子进程零 spawn', async () => {
    vi.resetModules()
    const gate: StructureGateModule = await import('../../../src/host-compat/structure-gate.ts')
    const logger = { warn: vi.fn(), error: vi.fn() }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // 先投毒（残缺 ctx：seam 缺失），再建 harness——构造器的 init 命中幂等缓存，不翻案。
    const loader = fakeLoaderV2(FAKE_ENTRY)
    await gate.initStructureGate(logger, { internal: loader.internal }, fakeSeamCtx({ dropAgents: ['setFactory'] }), {
      resolveOwn: () => { throw new Error('must not fall back') },
      readPackageJson: readPackageJsonTable({ [FAKE_PKG_JSON]: { name: '@deepseek-ai/dsh-agent-loop', version: '0.1.1-rc.2' } }),
    })
    const helpers = await import('../../fixtures/agent-test-helpers.ts')
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-structure-gate-'))
    const harness = await helpers.createHarness(logDir, {})
    const handles: AgentHandle[] = []
    try {
      const profile = helpers.mockProfile(logDir, 'happy')
      await helpers.registerAcpAgents(harness, [profile])

      // ACP create 路由：门关 → 响亮拒绝（错误码可机判），零 spawn
      await expect(harness.loop.createAgent(harness.ctx, {
        sessionId: SessionId('gate-acp-create'),
        meta: { cwd: logDir },
        agentOptions: { provider: helpers.routeOf(profile) },
      })).rejects.toThrow(gate.AcpHostIncompatibleError)
      await expect(harness.loop.createAgent(harness.ctx, {
        sessionId: SessionId('gate-acp-create'),
        meta: { cwd: logDir },
        agentOptions: { provider: helpers.routeOf(profile) },
      })).rejects.toMatchObject({ code: 'ACP_HOST_INCOMPATIBLE' })
      expect(fs.existsSync(profile.logPath)).toBe(false)

      // ACP resume 路由（隐式 peek 命中注册表）：门关 → 同一拒绝
      harness.persistence.seed(SessionId('gate-acp-resume'), helpers.seedLogWithHeader(helpers.routeOf(profile), 'mock-model-a'))
      await expect(harness.loop.resume(harness.ctx, { resumeSessionId: SessionId('gate-acp-resume') }))
        .rejects.toMatchObject({ code: 'ACP_HOST_INCOMPATIBLE' })
      expect(fs.existsSync(profile.logPath)).toBe(false)

      // native 路由：不经过结构门，父类 ReactLoopAgent 跑通完整 LLM turn
      harness.llm.registerAdapter(['mock'], new helpers.MockLlmAdapter([helpers.textResponse('native reply')]))
      const handle = await harness.loop.createAgent(harness.ctx, {
        sessionId: SessionId('gate-native'),
        meta: { cwd: logDir },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      handles.push(handle)
      handle.agent.followup(helpers.userText('hello'))
      await handle.agent.whenIdle()
      const turnEnds = helpers.eventsOf(handle.agent, 'turn/end')
      expect(turnEnds.at(-1)?.data.reason).toEqual({ kind: 'completed' })
    } finally {
      for (const handle of handles.reverse()) await handle.dispose().catch(() => {})
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  }, 15_000)
})
