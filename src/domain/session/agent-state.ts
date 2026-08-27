/**
 * ACP agent 配置的五态状态机：把「宿主结构兼容 / 配置有效 / probe
 * 缓存」三路事实折成一个用户可行动的稳定词表。
 * 本模块是 domainSession 层的零 import 叶子——remote 层（health 行的 `state`
 * 字段，src/remote/service.ts）与 hostFactory 层（会话创建门，
 * src/host/factory/agent-loop.ts）共同下行消费同一实现，五态语义只写一次。
 *
 * 词表语义：
 * - `saved-unverified`：配置已存但从未（以当前配置）探测过——既不能说 ready
 *   也不能说有故障。
 * - `ready`：新鲜 probe 成功，表示命令可启动、ACP initialize/session 探测可用。
 *   它**不表示已登录**：模型目录与 config option 都不是凭证有效性的证据。UI
 *   只展示“协议可用”，不虚构持续登录状态；明确的 auth_required 只作为本次
 *   检查诊断和外部登录指引展示。
 * - `auth-required`：新鲜 probe 明确以 ACP `auth_required` 失败。出路 = 按
 *   loginHint 在 agent 自家 CLI 登录（external-login-only，面板不发起
 *   authenticate，也不读取凭证文件）。
 * - `unavailable`：新鲜 probe 以其余 kind 失败（spawn-failure/timeout/crash/
 *   protocol-error），或配置无效。
 * - `incompatible`：宿主结构门未通过（ACP 路由整体不可用）。
 *
 * 新鲜度纪律（包含 TTL）：「新鲜」= 缓存条目的 key 与当前配置的
 * `acpProbeConfigKey(config)` 相等且未过 TTL（ok 10min / error 30s）——判定
 * 集中在 agent-config.ts `acpProbeFresh`，由**调用方**完成（health 与创建门
 * 各自先过该 helper，不匹配/过期/无条目则把 probe 传 undefined），本函数只收
 * 已按新鲜度过滤后的视图，不自行读缓存。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/session/agent-state
 */

/** 五态词表（wire 面经 src/contract/remote.ts 的同名字面量联合过线）。 */
export type AcpAgentConfigState = 'saved-unverified' | 'ready' | 'auth-required' | 'unavailable' | 'incompatible'

/** probe 缓存条目的最小视图（新鲜度过滤后；ok 只留目录事实，error 只留分流 kind）。 */
export interface AcpAgentStateProbeView {
  readonly result:
    | {
        readonly kind: 'ok'
        readonly modelCount: number
        /**
         * configOptions 是否含 `category=model` 项（configOptions-only 目录
         * 口径——kimi 的 legacy `models` 恒空，目录只经 configOptions 提供；此项在场
         * 即视为有目录）。消费处由缓存条目的同名字段收窄，恒有定义。
         */
        readonly hasModelConfigOption: boolean
      }
    | { readonly kind: 'error'; readonly failureKind: string }
}

/** {@link deriveAcpAgentState} 的输入事实。 */
export interface AcpAgentStateInput {
 /** 宿主结构门是否通过；不通过即 `incompatible`，其余事实不再消费。 */
  readonly hostCompatible: boolean
  /**
   * 配置是否有效（settings schema 口径）。五态无独立的 invalid 桶：registry
   * 层 schema 拒绝写入使该输入实际恒 true，本字段兜住「外部编辑写坏、
   * settings 服务保留旧值」以外的理论路径——false 归 `unavailable`（配置
   * 问题同样是「该 agent 不可用」，出路是修配置，与 probe 故障同桶如实）。
   */
  readonly configValid: boolean
  /** 新鲜 probe 视图；undefined = 从未探测或缓存已随配置漂移失效。 */
  readonly probe: AcpAgentStateProbeView | undefined
}

/** 三路事实 → 五态（判定顺序即词表优先级，先结构后配置再 probe）。 */
export function deriveAcpAgentState(input: AcpAgentStateInput): AcpAgentConfigState {
  if (!input.hostCompatible) return 'incompatible'
  if (!input.configValid) return 'unavailable'
  const probe = input.probe
  if (probe === undefined) return 'saved-unverified'
  if (probe.result.kind === 'error') {
    return probe.result.failureKind === 'auth_required' ? 'auth-required' : 'unavailable'
  }
  // initialize/session 探测成功只证明协议运行时可用。Agent 可以在未登录时仍
  // 返回模型目录（Kimi 实证），也可以在已登录时不返回目录；二者均不能推导 auth。
  return 'ready'
}
