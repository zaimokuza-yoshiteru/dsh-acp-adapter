/**
 * 通过宿主 ESM loader 解析并复用 DSH 自己的 `dsh-scope` 模块实例。
 *
 * `dsh-scope` 使用模块级 Symbol 与 WeakMap 保存私有状态。若插件静态导入另一份实例，
 * `agent-presets` 将无法识别插件创建的 scope，并拒绝挂载会话。这里从 DSH 入口沿
 * `dsh-base → dsh-agent-loop → dsh-scope` 逐级解析，确保开发与发布形态都命中宿主实例。
 *
 * 该逻辑依赖 DSH `0.1.2-alpha.1` 的模块结构，受 structure gate 和契约测试保护；结构
 * 漂移时 ACP 路由 fail closed，不影响 native DSH。`dsh-scope` 只作为类型依赖，禁止
 * 产生静态运行时 import。
 *
 * @module @zaimokuza/dsh-acp-adapter/host-compat/host-scope
 */

/// <reference types="node" />

import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import process from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type * as DshScope from '@deepseek-ai/dsh-scope'

/** 运行时只消费 dsh-scope 的这两个函数（createScope 建 agent 作用域；scopeOf 留作诊断面）。 */
export type HostScope = Pick<typeof DshScope, 'createScope' | 'scopeOf'>

/** initHostScope 的日志面（cordis Logger 的结构子集）。 */
export interface HostScopeLogger {
  warn(message: string): void
  error(message: string): void
}

/** 宿主级联 ESM loader 的 resolve 结果（cordis-plugin-loader ResolveResult 的结构子集）。 */
export interface HostEsmResolveResult {
  readonly url: string
}

/** Node 22/23 内部 ModuleLoader 面：`resolveSync(specifier, parentURL, attributes)`。 */
export interface HostModuleLoaderV1 {
  readonly version: 'v1'
  resolveSync(specifier: string, parentURL: string, attributes: Record<string, string>): HostEsmResolveResult
}

/** Node 24+ 内部 ModuleLoader 面：`resolveSync(parentURL, { specifier, attributes })`。 */
export interface HostModuleLoaderV2 {
  readonly version: 'v2'
  resolveSync(parentURL: string, request: { specifier: string; attributes: Record<string, string> }): HostEsmResolveResult
}

/** 宿主级联 ESM loader（判别联合；未来版本按 v2 形调用，失败落在 cause 里）。 */
export type HostModuleLoader = HostModuleLoaderV1 | HostModuleLoaderV2

/** `ctx.loader` 的结构子集：只要它的 `internal`（Loader 服务构造期由 ModuleLoader.fromInternal 赋值）。 */
export interface HostLoaderLike {
  readonly internal?: HostModuleLoader | undefined
}

/**
 * 解析链其余的可注入缝隙（单测用；生产一律走默认值）。宿主 ESM loader 不作为
 * deps 成员——它是 initHostScope 的显式第二参（语义必需品，非实现细节）。
 */
export interface HostScopeDeps {
  /** 宿主 bin 锚点（默认 `process.argv[1]`）。 */
  readonly argv1: string | undefined
  readonly realpath: (path: string) => Promise<string>
  readonly importModule: (href: string) => Promise<unknown>
}

function defaultDeps(): HostScopeDeps {
  return {
    argv1: process.argv[1],
    realpath: async (path) => await realpath(path),
    importModule: async (href) => await import(href),
  }
}

/** 解析链的已完成步骤（总失败时的诊断素材）。 */
interface ChainStep {
  readonly label: string
  readonly path: string
}

/** 宿主锚链断点错误（message 自带断点位置；cause 是底层 resolve/realpath 错误）。 */
class HostChainError extends Error {
  override readonly name = 'HostChainError'
}

/** 经宿主级联 loader 解一跳（v1/v2 签名分叉在此吸收，tsx 等钩子在此链上生效）。structure-gate 复用同一跳。 */
export function esmResolve(internal: HostModuleLoader, parentURL: string, specifier: string): string {
  return internal.version === 'v1'
    ? internal.resolveSync(specifier, parentURL, {}).url
    : internal.resolveSync(parentURL, { specifier, attributes: {} }).url
}

/**
 * 宿主锚链（ESM 语义）：bin 文件 URL → dsh-base 入口 → dsh-agent-loop 入口 →
 * dsh-scope 入口。每跳把上一跳解析出的**入口文件 URL** 作下一跳的 parentURL
 * （probe-esm-resolve.mjs 验证过的姿势）；返回末跳入口的文件路径（与兜底解析
 * 的返回形态对齐，供 realpath 对比与动态 import）。
 */
async function resolveViaHostChain(
  internal: HostModuleLoader,
  deps: HostScopeDeps,
  steps: ChainStep[],
): Promise<string> {
  const argv1 = deps.argv1
  if (argv1 === undefined || argv1 === '') {
    throw new HostChainError('process.argv[1] is absent; no host dsh bin to anchor on')
  }
  let anchor: string
  try {
    anchor = await deps.realpath(argv1)
  } catch (error) {
    throw new HostChainError(`cannot realpath the host bin anchor ${argv1}`, { cause: error })
  }
  steps.push({ label: 'anchor', path: anchor })
  let parentURL = pathToFileURL(anchor).href
  let url = ''
  for (const specifier of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-scope'] as const) {
    try {
      url = esmResolve(internal, parentURL, specifier)
    } catch (error) {
      throw new HostChainError(`cannot ESM-resolve ${specifier} from ${parentURL}`, { cause: error })
    }
    steps.push({ label: specifier, path: url })
    parentURL = url
  }
  return fileURLToPath(url)
}

/**
 * 本包树的兜底解析（vitest 环境：与测试所用 agent-presets 的 dsh-scope 同一
 * realpath）。走 CJS createRequire——本包树没有 tsconfig paths 诉求，构建形态
 * 与源码形态在此语义一致。
 */
function resolveViaOwnTree(): string {
  const req = createRequire(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '__anchor__.js')))
  return req.resolve('@deepseek-ai/dsh-scope')
}

/** import 解析出的入口文件并核验导出面。 */
async function importScopeModule(deps: HostScopeDeps, entry: string): Promise<HostScope> {
  const realEntry = await deps.realpath(entry).catch(() => entry)
  const namespace = await deps.importModule(pathToFileURL(realEntry).href) as Partial<HostScope>
  if (typeof namespace.createScope !== 'function' || typeof namespace.scopeOf !== 'function') {
    throw new Error(`resolved dsh-scope at ${realEntry} does not expose createScope/scopeOf`)
  }
  return { createScope: namespace.createScope, scopeOf: namespace.scopeOf }
}

// cordis logger 不落 stdout/stderr（踩过这个观测盲区）：warn/error 双写
// process.stderr，活体日志缺失时仍能从进程输出看到解析走向。
function reportWarn(logger: HostScopeLogger, message: string): void {
  logger.warn(message)
  if (process.env['VITEST'] !== 'true' || process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR'] === '1') {
    process.stderr.write(`[dsh-acp host-scope] WARN ${message}\n`)
  }
}

function reportError(logger: HostScopeLogger, message: string): void {
  logger.error(message)
  if (process.env['VITEST'] !== 'true' || process.env['DSH_ACP_TEST_HOST_SCOPE_STDERR'] === '1') {
    process.stderr.write(`[dsh-acp host-scope] ERROR ${message}\n`)
  }
}

let cached: HostScope | undefined
let cachedFailure: Error | undefined

/**
 * 解析宿主 dsh-scope 并缓存结果（插件加载期调用，见 index.ts）。**永不
 * reject** `loader` 或其 `internal` 缺席（单测 harness 形态）跳过宿主链直走
 * 本包树兜底；宿主链任一环节失败同样回退；全部失败则 logger.error + stderr
 * （含锚点、断点、原因、环境形态提示）并缓存错误——AcpAgent 构造时经
 * {@link hostCreateScope} 复抛，ACP 会话创建响亮失败，原生会话路径不受影响。
 */
export async function initHostScope(
  logger: HostScopeLogger,
  loader: HostLoaderLike | undefined,
  deps: HostScopeDeps = defaultDeps(),
): Promise<void> {
  const steps: ChainStep[] = []
  let hostEntry: string | undefined
  let hostError: unknown
  const internal = loader?.internal
  if (internal === undefined) {
    hostError = new HostChainError('ctx.loader(.internal) is absent at plugin load; skipping the host ESM chain')
  } else {
    try {
      hostEntry = await resolveViaHostChain(internal, deps, steps)
    } catch (error) {
      hostError = error
    }
  }
  let ownEntry: string | undefined
  try {
    ownEntry = resolveViaOwnTree()
  } catch {
    // 生产里本包树无 dsh-scope 运行时副本，resolve 失败是预期形态。
  }
  // 诊断：宿主链成功而本包树另有一份不同实例（可能解释"修而复现"的部署异常；
  // dev 源启形态下宿主落 src、本包树落 lib，此 warn 是预期且信息量高）
  if (hostEntry !== undefined && ownEntry !== undefined) {
    const hostReal = await deps.realpath(hostEntry).catch(() => hostEntry)
    const ownReal = await deps.realpath(ownEntry).catch(() => ownEntry)
    if (hostReal !== ownReal) {
      reportWarn(
        logger,
        'dsh-acp: this package tree carries a dsh-scope copy differing from the host installation '
        + `(host: ${hostReal}; own: ${ownReal}); the host copy wins (module-instance identity, 宿主模块实例一致性)`,
      )
    }
  }
  const candidates = [...new Set([hostEntry, ownEntry].filter((entry): entry is string => entry !== undefined))]
  let importError: unknown
  for (const entry of candidates) {
    try {
      cached = await importScopeModule(deps, entry)
      cachedFailure = undefined
      // 只在真正回退到「宿主链之外的另一份」时 warn。npm 生产形态下宿主的
      // healProfilesModuleFallback 会在 profiles/node_modules 播种宿主依赖图
      // symlink，own-tree 兜底与宿主链命中同一 realpath（hostEntry === ownEntry
 // —— install-gate 实证）——此时兜底即宿主实例，旧条件会以
      // errorChain(importError=undefined) 的 "(undefined)" 文案误报。
      if (entry === ownEntry && entry !== hostEntry) {
        reportWarn(
          logger,
          hostEntry === undefined
            ? `dsh-acp: host dsh-scope resolution failed (${errorChain(hostError)}); using this package tree's copy`
            : `dsh-acp: importing the host dsh-scope failed (${errorChain(importError)}); using this package tree's copy`,
        )
      }
      return
    } catch (error) {
      importError = error
    }
  }
  const trace = steps.length === 0 ? '(no step completed)' : steps.map((step) => `${step.label} = ${step.path}`).join('; ')
  cached = undefined
  cachedFailure = new Error(
    'dsh-acp: cannot locate the host dsh-scope module; ACP sessions are unavailable. '
    + `anchor: ${deps.argv1 ?? '(absent)'}; chain progress: ${trace}; `
    + `chain error: ${errorChain(hostError)}; import error: ${errorChain(importError)}. `
    + 'environment note: dev 源启形态（tsx）下 dsh-scope 必须经宿主级联 ESM loader 解析'
    + '（tsconfig paths 只挂在 ESM 链上，CJS resolve 会落到构建产物的第二实例）；'
    + '构建形态下落 lib。若本错误在 dev 形态出现，检查 ctx.loader.internal 是否在插件加载期在场。',
  )
  reportError(logger, cachedFailure.message)
}

/**
 * 宿主 dsh-scope 的 `createScope`（同步 getter：AcpAgent 构造是同步的，解析
 * 必须在插件加载期已由 {@link initHostScope} 完成）。init 失败过则复抛缓存
 * 的错误；从未 init 则抛「host scope not initialized」。
 */
export function hostCreateScope(): HostScope['createScope'] {
  if (cached !== undefined) return cached.createScope
  if (cachedFailure !== undefined) throw cachedFailure
  throw new Error('dsh-acp: host scope not initialized (initHostScope has not completed; AcpAgentLoop runs it at plugin load)')
}
