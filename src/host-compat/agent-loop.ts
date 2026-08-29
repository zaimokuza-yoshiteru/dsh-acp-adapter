/**
 * host-compat 岛：dsh-agent-loop 私有实现（模块级、未导出）的逐函数复制帧。
 * 复制存在的理由：AgentFactory seam 是单槽设计
 * （`ctx.agents.setFactory` 二次注册抛错），stock `AgentLoop` 构造即抢槽，
 * `ReactLoopAgent` 被 exports map 挡住——composite factory 不可行，
 * `extends AgentLoop` 是唯一形态；而 `prepare`/`setupAndPublish`/`resumeWith`
 * 是 private 且硬编码 `ReactLoopAgent`，无 override 点，ACP 路由只能带一份
 * 钉版副本。dsh-v0.1.2-alpha.1 的单槽 + private 硬编码形态使这份副本仍然必要。
 *
 * 上游钉版：dsh-v0.1.2-alpha.1（commit cd5ef8148158），
 * 源文件 reference/deepseek-harness/packages/core/agent-loop/src/index.ts。
 * 副本与上游的**有意差异**（差异测试按白名单豁免，其余逐字节对齐）：
 *   1. ownership 换成本岛的 {@link AcpFactoryOwnership}（裁掉 startup-task
 *      追踪——声明式 config 路径留在父类；父类的 ownership 是 private，且共享
 *      追踪器会把两波拆除耦合起来）；
 *   2. 机器构造是注入的 {@link AcpMachineFactory} 回调（上游此处硬编码
 *      `new ReactLoopAgent(...)`）；插件增量（fork 防御、sidecar binding、
 *      权限桥）全部收在 index.ts 的回调里，不进本岛；
 *   3. owner effect 标签前缀 `agentLoop.` → `acpAgentLoop.`（可观测性区分）；
 *   4. dispose 闭包的 `await machine.whenIdle()` 包进
 * {@link DISPOSE_IDLE_TIMEOUT_MS} 限时闸（dispose 不能在
 *      kill 前无界 whenIdle；超时告警后继续 scope.dispose）。
 *
 * 各项注释头给出上游行号与签名摘要。漂移检测：test/host-compat.spec.ts 对照
 * node_modules 里 @deepseek-ai/dsh-agent-loop@0.1.2-alpha.1 已构建 lib 机械比较；
 * 宿主结构门见 host-compat/structure-gate.ts（版本过低或 seam 缺失 → ACP 路由
 * fail closed）。
 *
 * @module @zaimokuza/dsh-acp-adapter/host-compat/agent-loop
 */

/// <reference types="node" />

import { clearTimeout, setTimeout } from 'node:timers'
import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import { FIBER_DISPOSED, FIBER_FAILED, FIBER_UNLOADING } from './fiber-state.ts'

/**
 * 隔离项 1：FactoryOwnership（上游 :40-90，模块级未导出 class）。
 * 签名摘要：`new (fiber: Context['fiber'])`；`signal: AbortSignal`；
 * `isActive(): boolean`；`track(dispose): () => void`；
 * `trackWrapper(job: Promise<unknown>): void`；`dispose : Promise<void>`。
 * 复制原因：父类 `ownership` 是 private；ACP 生命周期的 factory 级拆除登记
 * 需要同款语义。裁剪项（对照上游）：无 `inactive`/`startupTasks`/
 * `trackStartup`/`waitWhileActive`（startup 追踪只服务声明式 config 路径，
 * 该路径整体留在父类）。FiberState 数值见 fiber-state.ts。
 */
export class AcpFactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private readonly wrappers = new Set<Promise<void>>()

  constructor(private readonly fiber: Context['fiber']) {}

  /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    if (!this.accepting) return false
    const state: number = this.fiber.state
    return state !== FIBER_FAILED && state !== FIBER_DISPOSED && state !== FIBER_UNLOADING
  }

  /** Track one live agent's shared teardown until it has run. */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** Join one public create/resume continuation; factory dispose awaits its settlement. */
  trackWrapper(job: Promise<unknown>): void {
    const wrapper = job.then(() => undefined, () => undefined)
    this.wrappers.add(wrapper)
    const forget = (): void => { this.wrappers.delete(wrapper) }
    void wrapper.then(forget, forget)
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent loop is not active'))
    await Promise.all([
      ...[...this.liveAgents].map((dispose) => dispose()),
      ...this.wrappers,
    ])
  }
}

/**
 * 隔离项 2：raceAbort（上游 :93-106，模块级未导出函数）。
 * 签名摘要：`raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal,
 * id: SessionId): Promise<T>`。
 * 复制原因：resume 的日志窥测与协议帧的 setup await 需要与上游逐字节一致的
 * abort 竞速语义（signal.reason 透传 / 非 Error 包装）。
 */
export async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/**
 * 隔离项 3：raceAbortCall（上游 :109-130，模块级未导出函数）。
 * 签名摘要：`raceAbortCall<T>(operation: => PromiseLike<T> | T,
 * signal: AbortSignal, id: SessionId, releaseAbandoned?: (value: T) => void):
 * Promise<T>`。
 * 复制原因：resume 的 load 竞速需要「取消后到达的值按 releaseAbandoned 释放」
 * 的同款语义（上游用它释放被遗弃的 SessionPreparation）。
 */
export async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}

/**
 * 隔离项 4：assertAgentOptions（上游 :142-147，模块级未导出函数）。
 * 签名摘要：`assertAgentOptions(options: AgentOptions): void`。
 * 复制原因：协议帧入口的同款入参校验（maxTokens 必须是正安全整数），
 * ACP 路由不得放宽父类约束。
 */
export function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

// 隔离项 10：SessionPreparation[Symbol.dispose] 的运行时触达。上游以 `using`
// 声明（create :590 / setupAndPublish :634）与 `preparation?.[Symbol.dispose]()`
// （resumeWith :688,:705）释放；本包 tsconfig 钉 lib ES2024（无
// esnext.disposable），`using` 与 Symbol.dispose 类型都不在作用域——经运行时
// symbol 值触达（Node >= 22 原生提供，父类编译产物的 `using` 输出依赖同一契约）。
const symbolDispose: symbol = (Symbol as unknown as { readonly dispose: symbol }).dispose

/** Release one preparation exactly where the parent's `using` scope would end. */
export function disposePreparation(preparation: SessionPreparation): void {
  const release: unknown = (preparation as unknown as Record<symbol, unknown>)[symbolDispose]
  if (typeof release === 'function') (release as (this: unknown) => void).call(preparation)
}

/**
 * The resume backend, narrowed structurally to the two members the ACP path
 * calls. dsh-session-persistence is deliberately not a dependency of this
 * package (execution-plan dependency rule); the real service satisfies this
 * shape (`inspect`/`prepare` are its exact signatures). 随隔离项 7 迁入本岛
 * （上游 resumeWith 的 persistence 形参类型 SessionPersistence 的结构子集）。
 */
export interface AcpResumePersistence {
  /** Read-only routing peek: the stored header and logical log, without committing recovery. */
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  /** Load the exact unpublished Session resume publishes. */
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>
}

/**
 * Read the optional `sessionPersistence` service. The slot's Context
 * augmentation lives in dsh-session-persistence; whether or not that package's
 * types happen to be in this compilation, the widened accessor overload keeps
 * the lookup compiling, and the result is narrowed structurally.
 */
export function getResumePersistence(ctx: Context): AcpResumePersistence | undefined {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  return holder.get('sessionPersistence') as AcpResumePersistence | undefined
}

/** 协议帧消费的机器面：dsh Agent 公共接口 + 作用域卸载（ReactLoopAgent/AcpAgent 实例均有 scope）。 */
export interface AcpLifecycleMachine extends Agent {
  readonly scope: { dispose(): Promise<void> }
}

/** 协议帧与 AcpAgentLoop 之间的宿主缝：父类 private 成员（runtime.ctx / ownership）的显式等价物。 */
export interface AcpLoopInternals {
  /** The factory's own service context (parent's private `runtime.ctx`). */
  readonly loopCtx: Context
  /** Factory-level ownership twin ({@link AcpFactoryOwnership}). */
  readonly ownership: AcpFactoryOwnership
}

/** 机器构造回调：上游 `new ReactLoopAgent(loopCtx, id, options, session)` 的注入缝（差异 2）。 */
export type AcpMachineFactory<A extends AcpLifecycleMachine> = (loopCtx: Context, session: Session) => A

/**
 * 差异 4：dispose 闭包 `await machine.whenIdle()` 的限时闸默认预算。
 * turn 驱动的 wedge 由各 RPC deadline + prompt 取消梯子保证收敛；这 10s 是
 * 最后一道闸，只兜底失控 agent——超时告警后继续 scope.dispose。
 */
export const DISPOSE_IDLE_TIMEOUT_MS = 10_000

/** 差异 4 的可注入旋钮（生产恒缺省；测试用短预算/告警 spy 驱动超时路径）。 */
export interface AcpDisposeIdleGate {
  /** whenIdle 等待上限（毫秒）；缺省 {@link DISPOSE_IDLE_TIMEOUT_MS}。 */
  readonly idleTimeoutMs?: number
  /** 闸超时告警通道；缺省 stderr 双写（结构门同款响亮通道）。 */
  readonly onIdleTimeout?: (message: string) => void
}

/**
 * 差异 4 的限时闸本体：有界等待 machine.whenIdle()，超时告警后返回（调用方
 * 继续 scope.dispose）。岛自给自足（架构守卫禁止 hostCompat import runtime），
 * 自含限时竞速，不复用 runtime/process/timeout.ts；whenIdle 的迟到 settle
 * 已被 race 观察，不泄漏 unhandled。
 */
async function waitMachineIdle(machine: AcpLifecycleMachine, id: SessionId, gate: AcpDisposeIdleGate | undefined): Promise<void> {
  const timeoutMs = gate?.idleTimeoutMs ?? DISPOSE_IDLE_TIMEOUT_MS
  const onTimeout = gate?.onIdleTimeout ?? ((message: string): void => { process.stderr.write(`[dsh-acp] WARN ${message}\n`) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const window = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
  })
  try {
    const outcome = await Promise.race([machine.whenIdle().then(() => 'idle' as const), window])
    if (outcome === 'idle') return
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  onTimeout(
    `agent "${id}" did not become idle within ${String(timeoutMs)}ms during dispose; ` +
    'continuing teardown (scope.dispose) anyway — a wedged agent must not hang DSH shutdown',
  )
}

/** Prepared-but-unpublished ACP agent resources sharing one memoized teardown. (AgentLoop's `PreparedAgent` twin.) */
export interface PreparedAcpLifecycle<A extends AcpLifecycleMachine> {
  readonly agent: A
  /** Aborts when the factory unloads, the caller cancels, or teardown begins — ends any setup await. */
  readonly signal: AbortSignal
  /** Enter registries, announce, notify session-start. */
  publish(source: SessionStartSource): AgentHandle
  /** Reverse teardown: stop the machine, unregister, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/**
 * 隔离项 5：private prepare 发布协议帧（上游 :459-578）。
 * 签名摘要：`prepare(ownerCtx, id, options, session, callerSignal?): PreparedAgent`。
 * 复制原因：abort 三源融合（caller × owner fiber × factory teardown）、memoized
 * reverse teardown（cancel → whenIdle → scope.dispose → 出注册表 → 簿记释放）、
 * 发布顺序 `sessions.enter → agents.enter → sessions.announce → agents.announce
 * → agent/session-start`、每步 assertLive 复查——任一顺序/融合语义漂移都会改变
 * ACP 会话的注册表可见性与拆除边界。
 * 有意差异：仅模块头所列四条（ownership 孪生、机器工厂注入、effect 标签前缀、
 * dispose 的 whenIdle 有界闸）。
 *
 * 差异 4（「dispose 不能在 kill 前无界 whenIdle」）：prepare 帧
 * dispose 闭包里的 `await machine.whenIdle()` 包进 {@link DISPOSE_IDLE_TIMEOUT_MS}
 * 限时闸——turn 驱动的 wedge 由各 RPC deadline + prompt 取消梯子保证收敛，
 * 这道闸只兜底失控 agent；超时响亮告警（stderr 双写）后继续 scope.dispose，
 * 拆卸绝不因此被吊死。岛自给自足（架构守卫禁止 hostCompat import runtime），
 * 限时竞速自含实现，不复用 runtime/process/timeout.ts。
 */
export function prepareAcpLifecycle<A extends AcpLifecycleMachine>(
  internals: AcpLoopInternals,
  ownerCtx: Context,
  id: SessionId,
  options: AgentOptions,
  session: Session,
  callerSignal: AbortSignal | undefined,
  createMachine: AcpMachineFactory<A>,
  disposeIdleGate?: AcpDisposeIdleGate,
): PreparedAcpLifecycle<A> {
  assertAgentOptions(options)
  ownerCtx.fiber.assertActive()
  // Every caller reaches prepareAcpLifecycle synchronously from a service method
  // whose Cordis dispatch already requires the live factory fiber, or
  // re-checks ownership itself after its awaits (resume's load barrier).
  if (!internals.ownership.isActive()) throw new Error('agent loop is not active')
  if (callerSignal?.aborted) {
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
  }
  const loopCtx = internals.loopCtx

  // Deactivation fuses three owners, each with its own reason: the caller's
  // cancellation signal, the owner fiber's unload, and factory teardown. It
  // is registered BEFORE any resource exists, over mutable slots, so an
  // unload arriving while the scope is still minting finds a working
  // disposer instead of a leak.
  const abort = new AbortController()
  const onCallerAbort = (): void => {
    abort.abort(callerSignal?.reason instanceof Error
      ? callerSignal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
  }
  const onFactoryTeardown = (): void => { abort.abort(internals.ownership.signal.reason) }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  internals.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

  let machine: A | undefined
  let detachSession: (() => void) | undefined
  let detachAgent: (() => void) | undefined
  let disposing: Promise<void> | undefined
  const machineReady = Promise.withResolvers<void>()
  // Reverse teardown, memoized so every racing owner awaits one quiescence:
  // stop the machine, leave the registries, unwind the scope, release
  // bookkeeping.
  const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
    abort.abort(new Error(`agent "${id}" lifecycle disposed`))
    callerSignal?.removeEventListener('abort', onCallerAbort)
    internals.ownership.signal.removeEventListener('abort', onFactoryTeardown)
    try {
      // Disposal IS a disposed-cause cancel followed by quiescence. New work
      // sent after this point is the sender's bug — the registries are about
      // to drop the agent, so nothing should still hold it.
      if (machine === undefined) await machineReady.promise
      if (machine !== undefined) {
        machine.cancel({ kind: 'disposed' })
 // 差异 4：whenIdle 只能有界等待——失控 agent 不得把 dispose
        // 永远吊住；超时告警后继续 scope.dispose（waitMachineIdle 不抛）
        await waitMachineIdle(machine, id, disposeIdleGate)
        await machine.scope.dispose()
      }
    } finally {
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
        if (!ownerTriggered) await unfollowOwner()
      }
    }
  })())
  const untrack = internals.ownership.track(dispose)
  let unfollowOwner: () => Promise<void> | void
  try {
    unfollowOwner = ownerCtx.effect(() => () => {
      // Owner disposal owns the same quiescence boundary. Its teardown skips
      // unregistering this already-running owner effect from inside itself.
      if (disposing !== undefined) return
      abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      return dispose(true)
    }, `acpAgentLoop.lifecycle(${id})`)
  } catch (error: unknown) {
    // ctx.effect throws only on an inactive fiber, which assertActive above already rejected
    untrack()
    callerSignal?.removeEventListener('abort', onCallerAbort)
    internals.ownership.signal.removeEventListener('abort', onFactoryTeardown)
    throw error
  }

  const assertLive = (): void => {
    if (!abort.signal.aborted) return
    // Every fused abort source carries an Error reason: onCallerAbort and
    // raceAbort wrap non-Error caller reasons, and the factory/lifecycle
    // owners abort with constructed Errors.
    throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
  }
  try {
    const agent = machine = createMachine(loopCtx, session)
    machineReady.resolve()
    assertLive()

    return {
      agent,
      signal: abort.signal,
      publish: (source) => {
        assertLive()
        detachSession = agent.ctx.sessions.enter(session)
        detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent)
        agent.ctx.sessions.announce(session)
        assertLive()
        loopCtx.agents.announce(agent)
        assertLive()
        // A synchronous announce/session-start listener may have started
        // teardown; the machine is already live (delivery works from the
        // session-start extension point), so only the liveness recheck is owed.
        emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
        assertLive()
        return { agent, dispose }
      },
      dispose,
    }
  } catch (error: unknown) {
    machineReady.resolve()
    void dispose()
    throw error
  }
}

/**
 * 隔离项 6：private setupAndPublish （上游 :625-645）。
 * 签名摘要：`setupAndPublish(ownerCtx, id, preparation, agentOptions, setup,
 * signal, source): Promise<AgentHandle>`。
 * 复制原因：setup 竞速（raceAbort）+ commit + publish + 失败回滚
 * （prepared.dispose ）+ finally 释放 preparation 的完整事务边界。
 * 有意差异：上游 `using ownedPreparation = preparation` 改为 finally 里的
 * {@link disposePreparation}（隔离项 10，lib ES2024 无 esnext.disposable）。
 */
export async function setupAndPublishAcpLifecycle<A extends AcpLifecycleMachine>(
  internals: AcpLoopInternals,
  ownerCtx: Context,
  id: SessionId,
  preparation: SessionPreparation,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  signal: AbortSignal | undefined,
  source: SessionStartSource,
  createMachine: AcpMachineFactory<A>,
): Promise<AgentHandle> {
  try {
    const session = preparation.session
    const prepared = prepareAcpLifecycle(internals, ownerCtx, id, agentOptions, session, signal, createMachine)
    try {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
      setupCommit?.commit()
      return prepared.publish(source)
    } catch (error: unknown) {
      await prepared.dispose()
      throw error
    }
  } finally {
    disposePreparation(preparation)
  }
}

/**
 * 隔离项 7：private resumeWith （上游 :662-710）。
 * 签名摘要：`resumeWith(ownerCtx, persistence, options): Promise<AgentHandle>`。
 * 复制原因：load 屏障（caller × owner fiber × factory 三源 AbortSignal.any
 * 融合 + raceAbortCall 释放被遗弃 preparation）+ load 后复查
 * （fiber.assertActive + ownership.isActive）+ trackWrapper 登记——resume 的
 * 每-id 串行化与取消语义依赖这份逐字协议。
 * 有意差异：agentOptions 由调用方（路由层 marker-first 解析后）显式传入，
 * 替代上游的 `options.agentOptions ?? {}`；机器构造走 {@link AcpMachineFactory}。
 */
export function resumeAcpLifecycle<A extends AcpLifecycleMachine>(
  internals: AcpLoopInternals,
  ownerCtx: Context,
  persistence: AcpResumePersistence,
  options: ResumeAgentOptions,
  agentOptions: AgentOptions,
  createMachine: AcpMachineFactory<A>,
): Promise<AgentHandle> {
  const id = options.resumeSessionId
  const published = (async () => {
    // The load may outlive its owner: race it against caller cancellation,
    // owner-fiber unload, and factory teardown so a never-settling backend
    // cannot pin the identity.
    const ownerAbort = new AbortController()
    const unfollowOwner = ownerCtx.effect(() => () => {
      ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
    }, `acpAgentLoop.resume-load(${id})`)
    const fused = AbortSignal.any([
      ...options.signal === undefined ? [] : [options.signal],
      ownerAbort.signal,
      internals.ownership.signal,
    ])
    let preparation: SessionPreparation | undefined
    try {
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => { disposePreparation(abandoned) },
        )
      } finally {
        await unfollowOwner()
      }
      ownerCtx.fiber.assertActive()
      if (!internals.ownership.isActive()) throw new Error('agent loop is not active')
      return await setupAndPublishAcpLifecycle(
        internals,
        ownerCtx,
        id,
        preparation,
        agentOptions,
        options.setup,
        options.signal,
        'resume',
        createMachine,
      )
    } finally {
      if (preparation !== undefined) disposePreparation(preparation)
    }
  })()
  internals.ownership.trackWrapper(published)
  return published
}
