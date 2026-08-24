/**
 * ACP agent 配置的五态状态机：把「宿主结构兼容 / 配置有效 / probe
 * 缓存 / descriptor auth 引用声明（边界）」四路事实折成一个用户可行动的稳定词表。
 * 本模块是 domainSession 层的零 import 叶子——remote 层（health 行的 `state`
 * 字段，src/remote/service.ts）与 hostFactory 层（会话创建门，
 * src/host/factory/agent-loop.ts）共同下行消费同一实现，五态语义只写一次。
 *
 * 词表语义：
 * - `saved-unverified`：配置已存但从未（以当前配置）探测过——既不能说 ready
 *   也不能说有故障。
 * - `ready`：新鲜 probe 成功，且（descriptor 声明了 auth refs 时）模型目录非空——
 *   登录态可由 symlink 读到。目录口径：`models` 非空，**或**
 *   configOptions 含 `category=model` 项（kimi 形态：实际 ACP 行为其 legacy `models`
 *   为空、目录只经 configOptions 提供，零 models 不等于读不到登录态）。
 * - `auth-required`：新鲜 probe 以 auth_required 失败，或 descriptor 声明了
 *   auth refs 的 agent probe 成功但模型目录为空（既无 models 也无 model 类
 *   configOption；认证状态注入 形态：读不到登录态时 devin 的目录即空）。出路 = 按 loginHint 在 agent 自家 CLI 登录
 * （external-login-only，面板不发起 authenticate）。
 * - `unavailable`：新鲜 probe 以其余 kind 失败（spawn-failure/timeout/crash/
 *   protocol-error/sandbox-unavailable），或配置无效。
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
  /**
   * 该 profile 绑定的 runtime descriptor 是否声明了非空 opaqueRefs/envRefs
 * （口径；无 descriptor = false）。计算落点 =
   * agent-config.ts `descriptorDeclaresAuthRefs(descriptorOf(id, config))`。
   */
  readonly declaresAuthRefs: boolean
}

/** 四路事实 → 五态（判定顺序即词表优先级，先结构后配置再 probe）。 */
export function deriveAcpAgentState(input: AcpAgentStateInput): AcpAgentConfigState {
  if (!input.hostCompatible) return 'incompatible'
  if (!input.configValid) return 'unavailable'
  const probe = input.probe
  if (probe === undefined) return 'saved-unverified'
  if (probe.result.kind === 'error') {
    return probe.result.failureKind === 'auth_required' ? 'auth-required' : 'unavailable'
  }
  if (!input.declaresAuthRefs) return 'ready'
  // 认证状态注入 形态：descriptor 声明了 auth refs 的 agent 读不到登录态时模型目录为空
 // （devin 实证）——probe 本身成功不代表可用，目录非空才算 ready。
  //  目录口径：models 非空，或 configOptions 含 category=model 项（kimi 的
  // 目录只经 configOptions 提供，实际 ACP 行为 models 为空——零 models 对该形态是误判）。
  return probe.result.modelCount > 0 || probe.result.hasModelConfigOption ? 'ready' : 'auth-required'
}
