/**
 * AcpContextUsage: composer dock 的 ACP context 统计行（「独立 ACP
 * context 统计」的 UI 落点），挂在 `conversation.composer.dock`（list 槽，
 * session scope；id 'acp-context-usage'，order 在宿主 stats(0) 之后——上游
 * ui-conversation/apply.ts:431 同款注册形态）。
 *
 * 显示口径（诚实优先）：
 * - 仅当 host `backendOf` 判定会话 backend 已锁定且为 acp-* 路由时渲染；
 *   RPC 失败归 null（未知）同样不渲染；
 * - contextUsage 为 null（会话未懒启动/重启后未收到新 usage_update）不渲染
 *   ——诚实空缺，绝不显示 0；
 * - 文案 = `上下文 <used>/<size> · <percent>%`（紧凑数字格式见
 *   selector-logic 的 formatCompactTokens），agent 明确提供 cost 时原样
 *   追加 `· 成本 <amount> <currency>`（不换算、不聚合）；
 * - native token in/out、cache、TTFT、TPS 不由本组件显示——上游 StatsLine
 *   对无 usage 的 ACP 会话本就不渲染这些组，无需此处再藏。
 *
 * 数据通道：复用 live-options 的会话级通道（picker-service 按 sessionId 键控
 * 的 LiveOptionsController，它带 `subscribe`）。挂载时 backendOf
 * 判定 → 订阅 + 首拉；Alpha SessionSnapshot 的 `running` 从 true 收束为 false
 * 时再拉一次，从而接住 turn 内最后的 usage_update，同时不穿透已被拆出的 Chat
 * 私有结构；load 的 inflight 去重吸收重复触发。
 * 渲染规则与文案的纯逻辑在 selector-logic.ts `acpContextUsageLine`（测试钉
 * 在数据层——vitest 下 react 是模块加载 stub，组件渲染不被测试消费）。
 * @module @zaimokuza/dsh-acp-adapter/client/AcpContextUsage
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { acpContextUsageLine } from '../data/selector-logic.ts'
import type { LiveContextUsage, PickerBackendState } from '../data/selector-logic.ts'
import type { AcpModelKey } from '../host-compat/model-picker/selector-locales.ts'
import css from './AcpContextUsage.module.css'

/** The dock entry's translate seat (slot renderer binds it from the entry's `locale` declaration). */
export type AcpContextUsageTranslate = (key: AcpModelKey, params?: Record<string, string | number>) => string

/** Live glue 的窄化面（LiveOptionsController 的读/订/拉三件套）。 */
export interface ContextUsageLiveLike {
  getSnapshot(): { snapshot: { contextUsage: LiveContextUsage | null } | null }
  load(): Promise<void>
  subscribe(fn: () => void): () => void
}

/** 组件消费的服务面（apply 里以 pickerService 组装；backendOf RPC 失败归 null）。 */
export interface AcpContextUsageServiceLike {
  backendOf(sessionId: string): Promise<PickerBackendState | null>
  /** 可能抛（session scope 未就位）——组件按诚实空缺降级，不渲染。 */
  liveFor(sessionId: string): ContextUsageLiveLike
}

/** Injected props of the dock entry; Partial because the renderer erases the share boundary. */
export interface AcpContextUsageProps {
  sessionId?: string | undefined
  t?: AcpContextUsageTranslate | undefined
  useSession?: SnapshotSelectorHook<{ running: boolean }> | undefined
  service?: AcpContextUsageServiceLike | undefined
}

/**
 * The ACP context-usage dock row. All gating flows through
 * {@link acpContextUsageLine}: nothing renders for non-ACP, unknown-backend,
 * or no-usage-yet sessions.
 */
export function AcpContextUsage(props: AcpContextUsageProps): ReactNode {
  const { sessionId, t, useSession, service } = props
  const [backend, setBackend] = useState<PickerBackendState | null>(null)
  const [usage, setUsage] = useState<LiveContextUsage | null>(null)
  const running = useSession?.((snapshot) => snapshot.running) ?? false
  // backend 判定 + ACP 会话的活体订阅（sessionId 切换即重建）。
  useEffect(() => {
    if (service === undefined || sessionId === undefined) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    setBackend(null)
    setUsage(null)
    void service.backendOf(sessionId).then((resolved) => {
      if (disposed || resolved === null || resolved.state !== 'established') return
      setBackend(resolved)
      let live: ContextUsageLiveLike
      try {
        live = service.liveFor(sessionId)
      } catch {
        // session scope 未就位：诚实空缺，不渲染
        return
      }
      const sync = () => { if (!disposed) setUsage(live.getSnapshot().snapshot?.contextUsage ?? null) }
      unsubscribe = live.subscribe(sync)
      sync()
      void live.load().catch(() => undefined)
    }, () => { /* backendOf 面已把 RPC 失败折叠为 null；rejection 只来自组装 bug，按未知降级 */ })
    return () => { disposed = true; unsubscribe?.() }
  }, [service, sessionId])

  // usage_update 是 turn 内状态；在 Session 从 running 收束为空闲时重拉一次，
  // 既能刷新最终占用量，也不会为每个 assistant chunk 发 RPC。
  useEffect(() => {
    if (running || service === undefined || sessionId === undefined) return
    if (backend?.state !== 'established') return
    let live: ContextUsageLiveLike
    try {
      live = service.liveFor(sessionId)
    } catch {
      return
    }
    void live.load().catch(() => undefined)
  }, [service, sessionId, backend, running])

  if (t === undefined) return null
  const line = acpContextUsageLine(backend, usage, t)
  if (line === null) return null
  return h('div', { className: css.root }, line)
}

/**
 * 带服务闭包的注册位组件工厂：`client/index.ts` 不在 clientUi 层、不得
 * import react（test/contracts/architecture.spec.ts 钉），slot 注册用的包装组件由本工厂
 * 在 ui 层产出——service 闭包绑定，sessionId/t/useSession 由槽运行时按
 * session scope 标准件下发。
 * @param service - pickerService 组装的窄化服务面。
 * @returns 可直接传给 slots.register 的组件。
 */
export function createAcpContextUsageComponent(service: AcpContextUsageServiceLike): (props: AcpContextUsageProps) => ReactNode {
  return function AcpContextUsageEntry(props: AcpContextUsageProps): ReactNode {
    return h(AcpContextUsage, { ...props, service })
  }
}
