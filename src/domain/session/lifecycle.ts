/**
 * AcpAgent 会话生命周期的显式状态机（显式会话生命周期）：把此前分散在
 * `conn`/`startPromise`/`acpSessionId` 字段存在性组合上的会话生命周期
 * （懒启动/拆除中/已 disposed）收敛为一个 union 状态 + 合法转换表。
 *
 * 边界（勿混淆）：
 * - busy/idle/maintenance 的 **turn 相位机**（agent.ts 的 `Phase` union）逐行镜像
 * 上游 ReactLoopAgent，不在本模块管辖。
 * - 本机只覆盖 **会话生命周期** cold（懒启动前）→ starting（懒启动在飞）→
 *   live（会话建立）→ closing（拆除在飞）→ disposed（已拆除）。
 *
 * 转换表（{@link ACP_LIFECYCLE_TRANSITIONS}）与驱动点：
 * - cold → starting：首个 turn 的懒启动进场（`ensureStarted` 新建 startPromise）。
 * - starting → live：`startSession` 成功（连接 + ACP 会话 + translator 就位）。
 * - starting → cold：懒启动失败（startPromise 不缓存，下个 turn 全新重试）。
 * - starting → closing：懒启动在飞时作用域拆除进场（竞态窗口，见 agent.ts
 *   closeConnection；启动臂随后以「仅当仍是 starting」的守卫让位，不再回迁）。
 * - live → cold：`rebindBlank`显式放弃旧 ACP 上下文并拆除连接，
 *   会话回到懒启动前形态，下个 turn 以 session/new 全新建立。
 * - cold/live → closing：`closeConnection` 进场（作用域 effect 拆除；cold 进场
 *   = 从未启动即 disposed）。
 * - closing → disposed：拆除梯子完成。
 *
 * 纪律：**非法转换 fail loud**（抛 {@link AcpLifecycleError}）——全部驱动点都在
 * 本包内，违表即编程错误，响亮失败优于静默漂移。幂等重入（dispose 梯子被
 * cordis effect/兜底路径重复调用）不算非法转换：由调用点在转换前以
 * `closing/disposed` 守卫显式短路（agent.ts closeConnection 头部）。
 *
 * 本模块是纯 datum + 状态缸：无外部依赖，直接 vitest 可测。
 * @module @zaimokuza/dsh-acp-adapter/domain/session/lifecycle
 */

/** 会话生命周期状态词表（语义见模块头注释）。 */
export type AcpLifecycleKind = 'cold' | 'starting' | 'live' | 'closing' | 'disposed'

/** 合法转换表：key 状态可迁往的状态集（不在表中即非法，转换时 fail loud）。 */
export const ACP_LIFECYCLE_TRANSITIONS: Record<AcpLifecycleKind, readonly AcpLifecycleKind[]> = {
  cold: ['starting', 'closing'],
  starting: ['live', 'cold', 'closing'],
  live: ['closing', 'cold'],
  closing: ['disposed'],
  disposed: [],
}

/** 非法生命周期转换（fail loud；编程错误信号，非用户错误）。 */
export class AcpLifecycleError extends Error {
  constructor(
    readonly from: AcpLifecycleKind,
    readonly to: AcpLifecycleKind,
  ) {
    super(`illegal ACP session lifecycle transition: ${from} -> ${to}`)
    this.name = 'AcpLifecycleError'
  }
}

/**
 * 生命周期状态缸：持有当前状态，按 {@link ACP_LIFECYCLE_TRANSITIONS} 校验转换。
 * 实例归 AcpAgent 私有；{@link AcpLifecycle.kind} 只读暴露供诊断/测试。
 */
export class AcpLifecycle {
  private state: AcpLifecycleKind = 'cold'

  get kind(): AcpLifecycleKind {
    return this.state
  }

  /** 是否已进拆除收敛（closing/disposed）；幂等重入守卫用（见模块头纪律）。 */
  get settling(): boolean {
    return this.state === 'closing' || this.state === 'disposed'
  }

  /** 申请转换；非法转换抛 {@link AcpLifecycleError}（fail loud）。 */
  transition(to: AcpLifecycleKind): void {
    if (!ACP_LIFECYCLE_TRANSITIONS[this.state].includes(to)) {
      throw new AcpLifecycleError(this.state, to)
    }
    this.state = to
  }
}
