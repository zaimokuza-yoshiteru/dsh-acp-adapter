/**
 * host-compat 结构门（fail closed）：宿主 dsh-agent-loop 版本不得低于
 * {@link MIN_HOST_VERSION}，且 ACP 路径实际消费的宿主 seam 必须在场且形态正确。
 * 精确钉版会让每次 DSH 发布都成为人工阻断，而无限宽范围会把结构破坏推给
 * 用户——版本只作下限
 * （更高版本不因版本号被拒），真实兼容性由 seam 结构检查兜底。
 *
 * 上游钉版：dsh-v0.1.2-alpha.1（commit cd5ef8148158）。host-compat/agent-loop.ts 的
 * 协议帧逐函数复制自该版本的 agent-loop 私有实现（prepare 发布顺序、resumeWith
 * load 屏障、FactoryOwnership 语义）——父类私有协议漂移没有任何编译期信号，
 * 只能靠运行时的版本地板 + 结构检查兜底。
 *
 * 版本解析机制沿用旧版本门：`import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'`
 * 实际命中的那份（子类化对象本体）。解析主路径复用宿主级联 ESM loader 的
 * resolveSync（宿主模块实例一致性 同一理由：tsx 源启形态下 CJS resolve 不吃 tsconfig
 * paths，会落到构建产物的第二实例）；`ctx.loader` 缺席（单测 harness 等无
 * loader 宿主）回退本包树自锚 createRequire。命中入口文件后**向上走查**
 * package.json（name 必须匹配）——不直接 resolve `./package.json` 子路径，
 * 避开 exports map / tsconfig paths 对子路径的形态差异，源码启动（src 入口）、
 * 构建形态（lib 入口）、npm/pnpm 安装三形态同一条走查逻辑。
 *
 * 版本判定是最低版本制（prerelease 感知）：>= 0.1.2-alpha.1 即接受（后续 alpha/正式版、
 * 0.1.1、0.1.2、0.2.0 都接受；0.1.1-rc.1、0.1.0-* 拒绝），不因版本号更高而拒绝
 * （{@link compareVersions}，手写小型 semver 比较，不新增依赖）。
 *
 * 结构检查（缺失即 ACP incompatible）在 ctx 上验证 ACP 路径实际消费的 seam：
 * `agents` 服务的 enter/announce/setFactory/get；`sessions` 服务的
 * prepare/enter/announce/flush；`SessionPreparation.create` 是函数且其实例原型
 * 上有 Symbol.dispose 方法；`ctx.fiber.state` 是 number。每项失败点名到具体成员。
 *
 * 结算语义：首次 init 结算即权威（插件进程级加载一次），后续 init 返回同一
 * 结果不翻案。**init 永不 reject**；失败缓存 + logger.error + stderr 双写，
 * ACP 路由在 createAgent/resume 分支经 {@link assertHostCompatible} 复抛
 * （错误码 ACP_HOST_INCOMPATIBLE + 升级指引）；native 路由在分支判定前已委托
 * super，不经过此门。
 *
 * @module @zaimokuza/dsh-acp-adapter/host-compat/structure-gate
 */

/// <reference types="node" />

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import { esmResolve } from './host-scope.ts'
import type { HostLoaderLike, HostScopeLogger } from './host-scope.ts'

/** 宿主 dsh-agent-loop 的最低支持版本（package.json devDep 精确钉版即此版本；差异测试钉死两端一致）。 */
export const MIN_HOST_VERSION = '0.1.2-alpha.1'
/** 上游对照 tag（host-compat 岛全部注释头与差异测试共用）。 */
export const UPSTREAM_TAG = 'dsh-v0.1.2-alpha.1'
/** 上游对照 commit（reference/deepseek-harness）。 */
export const UPSTREAM_COMMIT = 'cd5ef8148158'

const AGENT_LOOP_PACKAGE = '@deepseek-ai/dsh-agent-loop'

/** 本模块 URL：静态 import 与结构门解析共用同一解析起点（同一棵包树，同一套 loader 级联）。 */
const MODULE_URL = import.meta.url

/** host-compat 结构门失败：code 稳定可机判，message 列出全部失败项并带升级指引。 */
export class AcpHostIncompatibleError extends Error {
  override readonly name = 'AcpHostIncompatibleError'
  readonly code = 'ACP_HOST_INCOMPATIBLE'
}

/** 解析链的可注入缝隙（单测用；生产一律走默认值）。 */
export interface StructureGateDeps {
  /** 本包树自锚兜底解析（默认 createRequire(本模块) 解 agent-loop 入口）。 */
  readonly resolveOwn: () => string
  /** 读一个 package.json（默认 fs 读 + JSON.parse；缺席/非法由调用方 catch）。 */
  readonly readPackageJson: (path: string) => Promise<{ name?: unknown; version?: unknown }>
}

function defaultDeps(): StructureGateDeps {
  return {
    resolveOwn: () => createRequire(MODULE_URL).resolve(AGENT_LOOP_PACKAGE),
    readPackageJson: async (path) => JSON.parse(await readFile(path, 'utf8')) as { name?: unknown; version?: unknown },
  }
}

/** 从命中的入口文件向上走查 agent-loop 的 package.json（name 必须匹配；三形态共用）。 */
async function findHostPackage(
  entryFile: string,
  readPackageJson: StructureGateDeps['readPackageJson'],
): Promise<{ path: string; version: string } | undefined> {
  let dir = dirname(entryFile)
  for (;;) {
    const candidate = join(dir, 'package.json')
    const pkg = await readPackageJson(candidate).catch((): undefined => undefined)
    if (pkg?.name === AGENT_LOOP_PACKAGE && typeof pkg.version === 'string') {
      return { path: candidate, version: pkg.version }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// ---------- 最低版本判定（prerelease 感知的小型 semver 比较；不新增依赖） ----------

interface SemverParts {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** 预发布标识符序列（数字标识符已转 number）；空数组 = 正式版。 */
  readonly pre: readonly (number | string)[]
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(version: string): SemverParts | undefined {
  const match = VERSION_RE.exec(version)
  if (match === null) return undefined
  const pre = (match[4] ?? '').split('.').filter((id) => id !== '')
    .map((id) => (/^\d+$/.test(id) ? Number(id) : id))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/**
 * semver 比较：a < b 返回负数、相等返回 0、a > b 返回正数；任一不可解析返回
 * undefined（调用方按不兼容处理）。prerelease 规则：同 x.y.z 下正式版 > 预发布版；
 * 标识符逐位比较——数字标识符小于字母标识符、数字按数值、字母按 ASCII；前缀
 * 相同则标识符少者小。build metadata（+…）忽略。
 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === undefined || pb === undefined) return undefined
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  for (let index = 0; index < Math.max(pa.pre.length, pb.pre.length); index += 1) {
    const x = pa.pre[index]
    const y = pb.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) return x < y ? -1 : 1
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

// ---------- seam 结构检查 ----------

// agent-loop.ts 同款注：本包 tsconfig 钉 lib ES2024（无 esnext.disposable），
// Symbol.dispose 类型不在作用域——经运行时 symbol 值触达（Node >= 22 原生提供）。
const symbolDispose: symbol = (Symbol as unknown as { readonly dispose: symbol }).dispose

const isMissingMethod = (service: unknown, name: string): boolean =>
  typeof (service as Record<string, unknown> | null | undefined)?.[name] !== 'function'

/**
 * ACP 路径实际消费的宿主 seam 逐项点名检查；返回缺失/异形成员清单（空数组 =
 * 结构齐备）。检查面与 host-compat/agent-loop.ts 协议帧 + 路由层的真实消费一致。
 */
function collectSeamFailures(ctx: unknown): string[] {
  const failures: string[] = []
  const holder = ctx as { agents?: unknown; sessions?: unknown; fiber?: unknown } | null | undefined
  const agents = holder?.agents
  for (const name of ['enter', 'announce', 'setFactory', 'get'] as const) {
    if (isMissingMethod(agents, name)) failures.push(`agents.${name}`)
  }
  const sessions = holder?.sessions
  for (const name of ['prepare', 'enter', 'announce', 'flush'] as const) {
    if (isMissingMethod(sessions, name)) failures.push(`sessions.${name}`)
  }
  if (typeof SessionPreparation.create !== 'function') {
    failures.push('SessionPreparation.create')
  } else if (typeof (SessionPreparation.prototype as unknown as Record<symbol, unknown>)[symbolDispose] !== 'function') {
    failures.push('SessionPreparation.prototype[Symbol.dispose]')
  }
  const fiber = holder?.fiber as { state?: unknown } | undefined
  if (typeof fiber?.state !== 'number') failures.push('ctx.fiber.state')
  return failures
}

// cordis logger 不落 stdout/stderr（踩过这个观测盲区）：error 双写
// process.stderr，与 host-scope 同款先例。
function reportError(logger: HostScopeLogger, message: string): void {
  logger.error(message)
  process.stderr.write(`[dsh-acp structure-gate] ERROR ${message}\n`)
}

const GUIDANCE = `this adapter requires host dsh >= ${MIN_HOST_VERSION} (${UPSTREAM_TAG}, commit ${UPSTREAM_COMMIT}); ACP sessions are `
  + 'disabled (fail closed) while native routes stay available — upgrade the host dsh to '
  + `${MIN_HOST_VERSION} or newer, or pin @zaimokuza/dsh-acp-adapter to a release built for the host's dsh version`

let inflight: Promise<void> | undefined
let settled = false
let cachedFailure: AcpHostIncompatibleError | undefined

/**
 * 校验宿主版本地板与 ACP seam 结构（插件加载期调用，见 index.ts）。**永不
 * reject**；首次结算即权威（重复调用返回同一 Promise，deps 与 ctx 以首调为准）。
 * 失败：logger.error + stderr 双写并缓存——ACP 路由经 {@link assertHostCompatible}
 * 复抛，原生会话路径不受影响。
 */
export function initStructureGate(
  logger: HostScopeLogger,
  loader: HostLoaderLike | undefined,
  ctx: unknown,
  deps: StructureGateDeps = defaultDeps(),
): Promise<void> {
  inflight ??= (async () => {
    try {
      const failures: string[] = []
      const errors: string[] = []
      let entry: string | undefined
      const internal = loader?.internal
      if (internal !== undefined) {
        try {
          entry = fileURLToPath(esmResolve(internal, MODULE_URL, AGENT_LOOP_PACKAGE))
        } catch (error: unknown) {
          errors.push(`host ESM chain: ${errorChain(error)}`)
        }
      }
      if (entry === undefined) {
        try {
          entry = deps.resolveOwn()
        } catch (error: unknown) {
          errors.push(`own-tree anchor: ${errorChain(error)}`)
        }
      }
      const found = entry === undefined ? undefined : await findHostPackage(entry, deps.readPackageJson)
      if (found === undefined) {
        failures.push(entry === undefined
          ? `cannot resolve the host ${AGENT_LOOP_PACKAGE} entry (${errors.join('; ')})`
          : `resolved the host ${AGENT_LOOP_PACKAGE} entry at ${entry} but no ancestor package.json carries that name`)
      } else {
        const cmp = compareVersions(found.version, MIN_HOST_VERSION)
        if (cmp === undefined) {
          failures.push(`host ${AGENT_LOOP_PACKAGE} version ${JSON.stringify(found.version)} (${found.path}) is not a parsable semver`)
        } else if (cmp < 0) {
          failures.push(`host ${AGENT_LOOP_PACKAGE} is version ${found.version} (${found.path}), below the minimum ${MIN_HOST_VERSION}`)
        }
      }
      for (const seam of collectSeamFailures(ctx)) failures.push(`missing host seam: ${seam}`)
      if (failures.length > 0) {
        cachedFailure = new AcpHostIncompatibleError(`dsh-acp: host incompatible: ${failures.join('; ')}; ${GUIDANCE}`)
      }
      if (cachedFailure !== undefined) reportError(logger, cachedFailure.message)
    } finally {
      settled = true
    }
  })()
  return inflight
}

/**
 * ACP 路由分支的结构门断言（调用前必须已 await initStructureGate 返回的
 * Promise）：失败复抛缓存的 {@link AcpHostIncompatibleError}（同一错误对象）。
 */
export function assertHostCompatible(): void {
  if (cachedFailure !== undefined) throw cachedFailure
  if (!settled) {
    throw new Error('dsh-acp: host structure gate has not settled (initStructureGate runs at plugin load and is awaited on ACP routes)')
  }
}
