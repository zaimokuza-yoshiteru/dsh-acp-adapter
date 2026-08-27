// host-scope.spec.ts — 宿主模块实例一致性 宿主 dsh-scope 运行时解析（src/host-compat/host-scope.ts）
// 的单测 + 依赖面守卫（ESM 语义）。
//
// 早期 CJS createRequire 锚链在 dev 源启形态分叉（tsx 的
// tsconfig paths 只挂全进程 ESM 链）——当前实现每跳改用宿主级联 loader 的
// resolveSync（ctx.loader.internal，v1/v2 签名按 version 判别分发）。
//
// 覆盖：v2 loader 正常锚链（parentURL 逐跳推进 + 命中宿主 namespace + 本包树
// 分歧 warn）；v1 loader 签名分叉；loader 缺席直走兜底不抛；宿主链断裂回退
// 本包树（warn 文案 + stderr 双写）；宿主链与兜底同路径（npm 生产形态，不 warn——
// install-gate 实证钉）；全部失败时 init 不 reject、error 含锚点/
// 断点/环境形态提示、hostCreateScope 复抛同一错误对象、stderr ERROR 双写；
// 未 init 即取用的响亮失败。
//
// 注意：本包树兜底解析（resolveViaOwnTree）不再经注入缝——它用真实
// createRequire 从 src/host-compat/ 直解，单测里命中的就是 devDep 那份真 dsh-scope
// （与 vitest 形态语义一致：测试的 agent-presets 也用这份）。
//
// 守卫：package.json 的 dependencies/peerDependencies 不得出现
// @deepseek-ai/dsh-scope（静态值导入会让产物解析到第二实例，宿主模块实例一致性 原样复现，
// 见 src/host-compat/host-scope.ts 模块头）；dsh-agent-presets 同属仅测试/dev 面。

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { HostModuleLoader, HostScopeDeps } from '../../../src/host-compat/host-scope.ts'

type HostScopeModule = typeof import('../../../src/host-compat/host-scope.ts')

const HOST_BIN = '/host/bin/dsh'
const HOST_BASE_ENTRY = '/host/node_modules/@deepseek-ai/dsh-base/src/index.ts'
const HOST_LOOP_ENTRY = '/host/node_modules/@deepseek-ai/dsh-agent-loop/src/index.ts'
const HOST_SCOPE_ENTRY = '/host/node_modules/@deepseek-ai/dsh-scope/src/index.ts'
// resolveViaOwnTree 用真实 createRequire 从 src/host-compat/ 直解 devDep 那份（registry 副本）。
const OWN_SCOPE_ENTRY = createRequire(new URL('../../../src/host-compat/__anchor__.js', import.meta.url)).resolve('@deepseek-ai/dsh-scope')

function fakeNamespace(tag: string) {
  return {
    createScope: vi.fn().mockName(`createScope:${tag}`),
    scopeOf: vi.fn().mockName(`scopeOf:${tag}`),
  }
}

interface FakeHarness {
  readonly deps: HostScopeDeps
  readonly logger: { warn: Mock<(message: string) => void>, error: Mock<(message: string) => void> }
  /** 依序记录的 `${parentURL} -> ${specifier}` ESM 解析事件。 */
  readonly resolveLog: string[]
  /** 依序记录的动态 import href。 */
  readonly importLog: string[]
}

/**
 * 组装注入缝隙：resolveTable 键为 `${parentURL}::${specifier}`，namespaces 键为
 * `pathToFileURL(realpath(entry)).href`；缺席键一律抛 MODULE_NOT_FOUND 风格的错。
 * version 选 v1/v2 各走一种 resolveSync 签名（宿主级联 loader 的判别联合）。
 */
function makeHarness(overrides?: {
  argv1?: string | undefined
  version?: 'v1' | 'v2'
  resolveTable?: Record<string, string>
  realpathTable?: Record<string, string>
  namespaces?: Record<string, unknown>
}): FakeHarness & { internal: HostModuleLoader } {
  const version = overrides?.version ?? 'v2'
  const resolveTable = overrides?.resolveTable ?? {}
  const realpathTable = overrides?.realpathTable ?? {}
  const namespaces = overrides?.namespaces ?? {}
  const logger = { warn: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() }
  const resolveLog: string[] = []
  const importLog: string[] = []
  const lookup = (parentURL: string, specifier: string): { url: string } => {
    resolveLog.push(`${parentURL} -> ${specifier}`)
    const hit = resolveTable[`${parentURL}::${specifier}`]
    if (hit === undefined) {
      throw Object.assign(new Error(`Cannot find package '${specifier}' imported from ${parentURL}`), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    return { url: hit }
  }
  const internal: HostModuleLoader = version === 'v2'
    ? { version, resolveSync: (parentURL, request) => lookup(parentURL, request.specifier) }
    : { version, resolveSync: (specifier, parentURL) => lookup(parentURL, specifier) }
  const deps: HostScopeDeps = {
    argv1: overrides !== undefined && 'argv1' in overrides ? overrides.argv1 : HOST_BIN,
    realpath: async (path) => realpathTable[path] ?? path,
    importModule: async (href) => {
      importLog.push(href)
      const namespace = namespaces[href]
      if (namespace === undefined) throw new Error(`Cannot find module '${href}'`)
      return namespace
    },
  }
  return { deps, logger, resolveLog, importLog, internal }
}

const hrefOf = (path: string): string => pathToFileURL(path).href

/** v2 正常锚链的三跳（parentURL 逐跳取上一跳解析出的入口 URL）。 */
const V2_RESOLVE_TABLE: Record<string, string> = {
  [`${hrefOf(HOST_BIN)}::@deepseek-ai/dsh-base`]: hrefOf(HOST_BASE_ENTRY),
  [`${hrefOf(HOST_BASE_ENTRY)}::@deepseek-ai/dsh-agent-loop`]: hrefOf(HOST_LOOP_ENTRY),
  [`${hrefOf(HOST_LOOP_ENTRY)}::@deepseek-ai/dsh-scope`]: hrefOf(HOST_SCOPE_ENTRY),
}

/** process.stderr 双写断言的 spy；afterEach 统一恢复。 */
function spyStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
}

const stderrText = (spy: ReturnType<typeof spyStderr>): string => spy.mock.calls.map((call) => String(call[0])).join('')

describe('host-scope (ESM 语义)', () => {
  let mod: HostScopeModule
  let previousStderrFlag: string | undefined

  beforeEach(async () => {
    previousStderrFlag = process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR']
    process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR'] = '1'
    vi.resetModules()
    mod = await import('../../../src/host-compat/host-scope.ts')
  })

  afterEach(() => {
    if (previousStderrFlag === undefined) delete process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR']
    else process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR'] = previousStderrFlag
    vi.restoreAllMocks()
  })

  it('v2 loader 正常锚链：parentURL 逐跳推进，import 宿主那份；本包树分歧 warn + stderr 双写', async () => {
    const host = fakeNamespace('host')
    const harness = makeHarness({
      resolveTable: { ...V2_RESOLVE_TABLE },
      namespaces: { [hrefOf(HOST_SCOPE_ENTRY)]: host },
    })
    const stderr = spyStderr()

    await mod.initHostScope(harness.logger, { internal: harness.internal }, harness.deps)

    expect(harness.resolveLog).toEqual([
      `${hrefOf(HOST_BIN)} -> @deepseek-ai/dsh-base`,
      `${hrefOf(HOST_BASE_ENTRY)} -> @deepseek-ai/dsh-agent-loop`,
      `${hrefOf(HOST_LOOP_ENTRY)} -> @deepseek-ai/dsh-scope`,
    ])
    expect(harness.importLog).toEqual([hrefOf(HOST_SCOPE_ENTRY)])
    expect(mod.hostCreateScope()).toBe(host.createScope)
    // 本包树兜底总会解析（分歧诊断）；dev 形态宿主落 src、兜底落 lib，warn 是预期。
    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain('the host copy wins')
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain(OWN_SCOPE_ENTRY)
    expect(stderrText(stderr)).toContain('[dsh-acp host-scope] WARN')
    expect(stderrText(stderr)).toContain('the host copy wins')
    expect(harness.logger.error).not.toHaveBeenCalled()
  })

  it('v1 loader 签名分叉：resolveSync(specifier, parentURL, attributes) 同样走通锚链', async () => {
    const host = fakeNamespace('host-v1')
    const harness = makeHarness({
      version: 'v1',
      resolveTable: { ...V2_RESOLVE_TABLE },
      namespaces: { [hrefOf(HOST_SCOPE_ENTRY)]: host },
    })
    spyStderr()

    await mod.initHostScope(harness.logger, { internal: harness.internal }, harness.deps)

    expect(harness.resolveLog).toHaveLength(3)
    expect(harness.importLog).toEqual([hrefOf(HOST_SCOPE_ENTRY)])
    expect(mod.hostCreateScope()).toBe(host.createScope)
  })

  it('loader 缺席：跳过宿主链直走本包树兜底，不抛', async () => {
    const own = fakeNamespace('own')
    const harness = makeHarness({
      namespaces: { [hrefOf(OWN_SCOPE_ENTRY)]: own },
    })
    const stderr = spyStderr()

    await mod.initHostScope(harness.logger, undefined, harness.deps)

    expect(harness.resolveLog).toEqual([])
    expect(harness.importLog).toEqual([hrefOf(OWN_SCOPE_ENTRY)])
    expect(mod.hostCreateScope()).toBe(own.createScope)
    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain('ctx.loader(.internal) is absent')
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain('using this package tree\'s copy')
    expect(stderrText(stderr)).toContain('[dsh-acp host-scope] WARN')
    expect(harness.logger.error).not.toHaveBeenCalled()
  })

  it('宿主链中途断裂：回退本包树副本并 warn', async () => {
    const own = fakeNamespace('own')
    const harness = makeHarness({
      resolveTable: {
        [`${hrefOf(HOST_BIN)}::@deepseek-ai/dsh-base`]: hrefOf(HOST_BASE_ENTRY),
        // dsh-agent-loop 跳缺席 → 宿主链在此断开。
      },
      namespaces: { [hrefOf(OWN_SCOPE_ENTRY)]: own },
    })
    spyStderr()

    await mod.initHostScope(harness.logger, { internal: harness.internal }, harness.deps)

    expect(mod.hostCreateScope()).toBe(own.createScope)
    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain('using this package tree\'s copy')
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain('cannot ESM-resolve @deepseek-ai/dsh-agent-loop')
    expect(harness.logger.error).not.toHaveBeenCalled()
  })

  it('宿主链与兜底同路径（npm 生产形态）：不 warn——兜底命中的就是宿主实例', async () => {
 // install-gate 实证：npm 形态下宿主 healProfilesModuleFallback 在
    // profiles/node_modules 播种宿主依赖图 symlink，own-tree 兜底与宿主锚链
    // 命中同一 realpath（hostEntry === ownEntry）；旧实现此时以 "(undefined)"
    // 文案误报回退 warn（importError 从未被赋值）。
    const shared = fakeNamespace('shared')
    const harness = makeHarness({
      resolveTable: {
        [`${hrefOf(HOST_BIN)}::@deepseek-ai/dsh-base`]: hrefOf(HOST_BASE_ENTRY),
        [`${hrefOf(HOST_BASE_ENTRY)}::@deepseek-ai/dsh-agent-loop`]: hrefOf(HOST_LOOP_ENTRY),
        [`${hrefOf(HOST_LOOP_ENTRY)}::@deepseek-ai/dsh-scope`]: hrefOf(OWN_SCOPE_ENTRY),
      },
      namespaces: { [hrefOf(OWN_SCOPE_ENTRY)]: shared },
    })
    spyStderr()

    await mod.initHostScope(harness.logger, { internal: harness.internal }, harness.deps)

    expect(harness.importLog).toEqual([hrefOf(OWN_SCOPE_ENTRY)])
    expect(mod.hostCreateScope()).toBe(shared.createScope)
    expect(harness.logger.warn).not.toHaveBeenCalled()
    expect(harness.logger.error).not.toHaveBeenCalled()
  })

  it('全部失败：init 不 reject，error 含锚点/断点/环境形态提示，取用复抛同一错误对象，stderr ERROR 双写', async () => {
    const harness = makeHarness({ argv1: undefined })
    const stderr = spyStderr()

    await expect(
      mod.initHostScope(harness.logger, { internal: harness.internal }, harness.deps),
    ).resolves.toBeUndefined()

    expect(harness.logger.error).toHaveBeenCalledTimes(1)
    const message = String(harness.logger.error.mock.calls[0]?.[0])
    expect(message).toContain('cannot locate the host dsh-scope module')
    expect(message).toContain('anchor: (absent)')
    expect(message).toContain('(no step completed)')
    expect(message).toContain('environment note')
    expect(message).toContain('ctx.loader.internal')
    expect(stderrText(stderr)).toContain('[dsh-acp host-scope] ERROR')
    expect(stderrText(stderr)).toContain('cannot locate the host dsh-scope module')
    let first: unknown
    let second: unknown
    try {
      mod.hostCreateScope()
    } catch (error) {
      first = error
    }
    try {
      mod.hostCreateScope()
    } catch (error) {
      second = error
    }
    expect(first).toBeInstanceOf(Error)
    expect(first).toBe(second)
    expect((first as Error).message).toBe(message)
  })

  it('未 init 即取用：响亮失败', () => {
    expect(() => mod.hostCreateScope()).toThrow(/host scope not initialized/)
  })

  it('依赖面守卫：dsh-scope / dsh-agent-presets 不出现在 dependencies/peerDependencies', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    for (const name of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-agent-presets']) {
      expect(manifest.dependencies ?? {}).not.toHaveProperty(name)
      expect(manifest.peerDependencies ?? {}).not.toHaveProperty(name)
      expect(manifest.devDependencies ?? {}).toHaveProperty(name)
    }
  })
})
