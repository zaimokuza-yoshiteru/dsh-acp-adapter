/**
 * Resume / fork / reconciliation。
 *
 * DSH session log 是产品历史真源；ACP binding 保存在 sidecar。恢复时必须先对账，
 * 任何无法证明连续性的情况都 fail closed，不能静默降级为 session/new。ACP 专属
 * binding 与审计不直接写 session log，以免未知事件破坏宿主事件顺序。
 *
 * 本模块只含纯函数与文案常量，接线在 src/host/factory/agent-loop.ts（marker-first
 * 路由：sidecar binding 优先，无记录回退 `request/header` 窥测）与 ./agent.ts
 * （session/load 预检 + staging 回放 + 对账 + 阻断闩锁 + 说明消息）。
 *
 * 恢复流程（设计说明字面顺序）：binding 在场且非 forceBlank → initialize 后
 * 逐项预检（canonicalCwd → launchFingerprint → agent 身份 → protocolVersion →
 * loadSession 能力 → 广告 list 则先查列表确定 miss）→ staging 式 session/load
 * （回放期更新经 ReplayTranslator 入有界 staging，不落盘）→ 对账（{@link resolveExpectedRange} 定期望区间
 * → {@link expectedVisibleHistory} 折出 DSH 侧期望可见历史 →
 * {@link reconcileVisibleHistory} 与 {@link replayVisibleHistory} 折出的回放侧分段比对）→ 任何一步失败：
 * 置 continuity 闩锁（blocked）、落 sidecar `reconciliation` 记录、抛
 * {@link AcpReconciliationError}（turn/end error code
 * `ACP_RECONCILIATION_REQUIRED`），**不再自动 session/new**。崩溃尾巴（锚点后
 * 全部可见事件都属于以 `turn/end{interrupted}` 收束的 turn）可纳入对账，
 * 但 remote outcome 仍不可证明；构造器会将会话置为 outcome-unknown，必须由
 * 用户显式重连、放弃上下文或新建会话后才能继续。
 *
 * binding 语义门槛与双绑守卫（增补保留，出口从降级改为阻断）：
 * - **主键纪律** dsh sessionId 永远是 UI/路由/审计主键；ACP session id 只是
 *   sidecar binding 的载荷（`session/load` 的输入），不作任何索引键。
 * - **双绑守卫** 同一 ACP session 不得同时绑定两个活动 dsh session——路由层
 *   （agent-loop.ts `guardBindingReuse`）冲突时不再降级，而是预置 blocked
 *   （cause 'binding-in-use'），会话拒绝启动直到用户处置。
 * - **重连残留警告** `session/load` 响应后、首个 prompt 前的观察窗内收到的
 *   内容类更新没有 record id / turn 边界可去重——内容照常无损落盘 + 一次性
 *   {@link ACP_RESUME_RESIDUE_NOTE}（./agent.ts `residueWatchArmed`）。已知
 *   边界：观察窗外落盘的游离内容会使下次 resume 对账判 'dsh-log-diverged'
 *   阻断——有意的诚实失败，不静默合并。
 *
 * 说明性 assistant 消息走正常 `Session.append`（非 marker、非自定义事件），
 * 进 model-visible surface——恢复/中断事实要对用户可见且留在派生历史里。
 * **它们一律省略 `sourceEventSeqs`**，因此不会进入对账的期望序列（
 * {@link expectedVisibleHistory}）只统计带该字段的 assistant/message，据此把
 * 本适配器自己的说明消息排除在期望之外。
 *
 * （无损恢复对账摘要）：逐条比较的不再是 title/status/text 的字段相等，
 * 而是每条目的 canonical `digest`（{@link acpCanonicalHash16}，键序无关的
 * stableStringify + sha256-16）。user/assistant 文本先经
 * {@link normalizeVisibleText} 规范化（CRLF/CR→LF + NFC，聚合后执行）；tool
 * 摘要覆盖跨侧稳定身份事实集 {@link AcpToolHistoryFacts}（kind、locations、
 * 有界 canonical raw input、终态 status、规范化 result/meta——terminal/diff
 * 结局事实含在 result meta 的 acpToolContent 条目内）。**title 刻意不在事实
 * 集内** ACP 协议允许 tool_call_update 随时改写 title——Claude Agent ACP
 * 0.70.0 实证（被拒工具回放不对称，Claude ACP live evidence）在 tool_call 帧
 * 发进行态占位标题（`Preparing file…`），终态标题（`Write <path>`）经后续
 * tool_call_update 到达；DSH 的 tool/call.name 落盘即不可变（= 占位标题），
 * 而 session/load 回放帧带终态标题。title 若进 digest，任何用过工具的 claude
 * 会话跨重启必判 replay-diverged——它是展示事实漂移，不是上下文连续性问题。
 * title 仅保留在 {@link AcpVisibleHistoryEntry} 的 tool 变体里供分叉 detail
 * 的人类可读摘要（summarizeEntry）使用。两侧对称事实源：DSH 侧的
 * kind/locations 由 translate.ts 随 tool/call `meta.acpToolCall` 落盘，raw
 * input 在 `arguments` JSON 串，result/meta 在 tool/result；回放侧直接取
 * tool_call/tool_call_update 帧。**非对称工具回放（终态快照）** title 移出
 * digest 后 claude 会话仍发散——live 首帧的占位事实不止 title：rawInput 缺席
 * （arguments="{}"）、locations 空、tool/result content 空（终态 content 经
 * 进行中 update 帧到达，终态帧不带），而回放帧是终态合并形态（rawInput/
 * locations/content 全量）。translate.ts 因此把各帧 latest-wins 累积的终态
 * 快照随配对 tool/result 的 `meta.acpToolCall.terminal` 回写（仅在有 update
 * 帧携带过身份事实时落盘；首帧即全量的 agent 不产生该键，devin 路径日志形状
 * 不变），{@link expectedVisibleHistory} 优先读快照、缺席才回退首帧事实；
 * digest 身份（toolKind + locations + input + status + result）两侧同为终态
 * 快照，天然对称。敏感原文（raw input、result 全文）从不进
 * sidecar——`reconciliation` 记录只携带 cause 与有界 detail（摘要经
 * summarizeEntry 截断，tool 摘要只含 title/status/digest）。Devin 被拒工具回放不对称 纪律保留且
 * 不受影响：被拒 tool call 整条缺席回放 → 段内多重集缺项 → 照样判
 * replay-diverged 阻断；title 篡改仅是展示层漂移，不构成上下文连续性破坏，
 * 因此移除 title 不放宽任何事实级防线（input/status/result 篡改仍判分叉）。
 *
 * （回放共轨 + PresentationSegmenter）：回放侧不再单独规范化 wire 更新
 * （旧 normalizeReplayUpdates 已删除）——session/load 回放更新经 translate.ts
 * {@link ReplayTranslator} 喂入与 live **同一个** TurnTranslator（staging sink
 * 只记录不落盘），两侧可见历史都由 {@link expectedVisibleHistory} 这同一提取
 * 函数折出（回放侧入口 {@link replayVisibleHistory}）。 的 synthetic
 * presentation step 只是 DSH 展示 identity，从不进任何 digest 输入；分段数量
 * 差异由 的段内拼接比较天然吸收。对账检出力（Devin 被拒工具回放不对称 被拒 tool 缺项、
 * input/status/result 篡改）不变。
 *
 * （混合 turn 分段对账）：逐位保序比较对「文本 + tool call 混合 turn」
 * 结构性误判——live 落盘 tool/call 即时、assistant/message 恒在 endTurn 聚合
 * 落盘（translate.ts），期望序列（按 seq）恒为 tool 先于 assistant；回放规范化
 * 保 wire 序，文本先于 tool。两侧同一段历史因此序列不同。对账改为
 * {@link reconcileVisibleHistory} 的「turn 间保序、turn 内分层」：两侧按 user
 * 锚点切 turn 段，段内 user 锚点比 digest、assistant 聚合文本整体比 digest
 * （免疫同 turn 多 messageId 的聚合条数差异）、tool 按 digest 多重集比计数
 * （免疫段内顺序差异）。Devin 被拒工具回放不对称 检出力不变：被拒/篡改 tool 不进回放 → 段内多重集
 * 不符（回放缺项）→ 仍判 replay-diverged。reason 词表不变
 * （replay-diverged / dsh-log-truncated），detail 从「首个分叉 index」改为
 * 段级描述（第几 turn 段、user/assistant/tool 哪一层不符）。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/session/resume
 */

import { createHash } from 'node:crypto'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ACP_NOTE_STEP, ACP_UNKNOWN_MODEL } from '../../protocol/v1/translate.ts'
import { ACP_TOOL_INPUT_SUMMARY_MAX_CHARS } from '../../protocol/v1/tool-presentation.ts'
import { acpCanonicalHash16 } from '../../persistence/sidecar.ts'
import type { AcpReconciliationCause } from '../../persistence/sidecar.ts'

// ACP_TOOL_INPUT_SUMMARY_MAX_CHARS 住在 protocol/v1/tool-presentation.ts
// （对账折叠与展示信封 inputSummary 的共用界限，单一事实源）；此处 re-export
// 保持本模块既有导出面（reconciliation.spec 等引用）不变。
export { ACP_TOOL_INPUT_SUMMARY_MAX_CHARS }

/**
 * 崩溃中断检测（恢复连续性规则「崩溃中断 turn」）：coordinator 加载时
 * `interruptedTurnClosers`（core/session/src/repair.ts）会给开口 turn 合成
 * `turn/end {reason:{kind:'interrupted'}}` 并落盘；ACP 会话无 step/*，合成物
 * 只有这条 turn/end。随后 Session 构造在 seed 末尾补 `session/end-seed`
 * （core/session/src/index.ts:545），故恢复出来的崩溃尾巴真实形态是
 * `[turn/end{interrupted}, session/end-seed]`——先跳过尾部 end-seed 再判。
 * 幂等闩锁：追加说明消息后末尾（跳过 end-seed 后）不再是该 turn/end，下次
 * resume 不会重复追加。
 * @param session - 已 prepare 的会话（resume 路径）。
 * @returns 被中断的 turn 号；无中断尾巴 → `undefined`。
 */
export function detectInterruptedTail(session: Session): number | undefined {
  const events = session.events
  let index = events.length - 1
  while (events[index]?.type === 'session/end-seed') index -= 1
  const last = events[index]
  if (last === undefined || last.type !== 'turn/end') return undefined
  if (last.data.reason.kind !== 'interrupted') return undefined
  return last.data.turn
}

/**
 * outcome-unknown 说明文案（恢复连续性规则：如实告知，不自动重试）。append 于被中断 turn
 * 之后（turn 字段 = 被中断的 turn 号）。
 */
export const ACP_RESUME_OUTCOME_UNKNOWN_NOTE =
  '上一对话轮次因宿主进程中断而结局未知：ACP agent 侧上下文可能已推进到本消息之后的状态。dsh 不会自动重试该轮，请核对工作区状态后继续。'

/**
 * 重连残留警告文案（重连 update 无法经 record id / turn 边界证明去重时，
 * 显示恢复警告而非静默合并——ACP session/update 无记录 id，spec 违规者先回
 * session/load 响应再回放的残留与新推送不可区分）。append 于残留内容落盘之后，
 * 每次恢复最多一条（一次性闩锁见 ./agent.ts `residueWatchArmed`）。
 */
export const ACP_RESUME_RESIDUE_NOTE =
  '恢复完成后、下一轮对话开始前收到 ACP agent 的游离更新：无法证明它是新推送还是规范违规（先回 session/load 响应再回放）的残留。内容已如实保留、未静默合并；若与上方历史重复，请以 dsh 侧历史为准核对。'

/**
 * rebindBlank 说明文案（用户显式放弃 ACP 侧上下文后的重开标记）。
 * 追加于新 binding 落盘之后、首个 prompt 之前（turn 字段 = 发起重开的 turn 号）。
 */
export const ACP_REBIND_BLANK_NOTE =
  '用户已显式放弃此前的 ACP 侧上下文，本会话已重新绑定到一个全新的 ACP 会话；上方历史不会再回灌给 agent，但从现在起的对话会正常续接。'

/**
 * fork 说明文案（ACP 会话被 fork 时 agent 侧上下文不继承——fork 防御
 * （host/factory/agent-loop.ts `createAcpMachine`）在 parentSession 在场时丢
 * resumeBinding，agent 以空白 session/new 开始；本说明把这个事实写进产品历史，
 * 免得「UI 历史完整但 agent 已失忆」再成静默分叉）。追加于 fork 出的会话
 * 构造期、首个 turn 之前；幂等闸见 {@link hasForkBlankNote}。
 */
export const ACP_FORK_BLANK_NOTE =
  '此会话由 DSH 历史分支（fork）而来：上方历史仅作展示，ACP agent 侧上下文不继承——agent 从空白开始，对此前的对话内容一无所知。'

/**
 * 空响应说明文案（ACP_EMPTY_RESPONSE）：turn 正常完成（stopReason 非
 * error/cancel）但 agent 全程未产出任何可见输出（无正文、无工具调用、无工具
 * 结果）时，append 一条说明消息代替「静默的空 turn」——不产生空 assistant
 * message（translate.ts 纪律），但要让用户能看见「agent 什么都没回」这个事实。
 * 纯工具 turn 有 tool 事件，不触发；说明消息省略 sourceEventSeqs，不进对账。
 */
export const ACP_EMPTY_RESPONSE_NOTE =
  '本轮对话 ACP agent 已结束，但没有返回任何内容（无正文、无工具调用）。这不能证明请求已完成；可能与 Agent 配置、登录状态或上游行为有关，请检查 Agent 侧日志或重试。'

/**
 * 模型说明文本的单字段长度上限（建立时模型收敛分叉说明用）：模型名来自
 * Agent/DSH 两侧配置，截断防爆 History 文案。
 */
const ACP_MODEL_NOTE_FIELD_MAX = 80

function boundedModelName(model: string): string {
  return model.length <= ACP_MODEL_NOTE_FIELD_MAX ? model : `${model.slice(0, ACP_MODEL_NOTE_FIELD_MAX)}…`
}

/**
 * 建立时模型收敛分叉说明文案（边界，./agent.ts `convergeModelAtEstablishment`）：
 * 会话建立（new 或对账通过的 load）后、首个 prompt 前，插件尝试把 DSH 会话选定
 * 模型一次性应用到 Agent（单向 agent←DSH）；无法收敛（Agent 未暴露可写模型项 /
 * 目标值不在允许集 / 写入未被确认）时**不静默分叉**——追加本条用户可见说明，
 * 无法恢复 DSH 侧选择时，Agent 以其实际模型继续，request/header 如实记录实际模型。每次会话
 * 建立最多一条（闩锁在调用方）；不锁 composer（这是能力/行为降级，不是待定切换
 * 事务的不一致——后者仍归 options-sync 的 pending-switch 守卫）。
 */
export function acpModelDivergenceNote(selectedModel: string, actualModel: string, reason: string): string {
  const selected = boundedModelName(selectedModel)
  const actual = boundedModelName(actualModel)
  return `本会话选择的模型「${selected}」未能应用到 ACP agent（${reason}）。本轮起 agent 将使用其侧实际模型「${actual || '（agent 未报告）'}」继续对话；请求头与历史记录如实反映实际使用的模型。如需改用「${selected}」，请通过模型选择器切换（热切换经 ModelSwitchCoordinator 事务），或新建会话。`
}

/**
 * 各 reconciliation cause 的人类可读说明（{@link AcpReconciliationError} 消息的
 * 前半；后半是 {@link ACP_RECONCILIATION_GUIDANCE}）。
 */
export const ACP_RECONCILIATION_CAUSE_DETAILS: Record<AcpReconciliationCause, string> = {
  'cwd-changed': '会话工作目录与 binding 记录不一致（cwd 已变化），无法证明 ACP 侧上下文与当前环境对应',
  'profile-changed': 'ACP agent 启动配置（command/args/env 键名）与 binding 记录不一致',
  'agent-changed': '对端 agent 身份（name/version）与 binding 记录不一致',
  'protocol-changed': '对端协商的 ACP 协议版本与 binding 记录不一致',
  'capability-missing': '该 ACP agent 未声明会话恢复（loadSession）能力，无法续接上次 ACP 上下文',
  'id-not-found': '该 ACP agent 的会话列表中未找到上次会话（可能已被清理）',
  'load-failed': 'session/load 调用失败',
  'replay-overflow': 'session/load 回放超出 staging 缓冲上限，无法完整对账',
  'replay-diverged': 'agent 回放的历史与 DSH 日志担保前缀不一致',
  'dsh-log-diverged': 'DSH 日志在 binding 担保前缀之后存在非崩溃尾巴的可见事件',
  'dsh-log-truncated': 'agent 回放的历史多于 DSH 日志的可见记录（DSH 侧历史缺失）',
  'binding-in-use': '上次绑定的 ACP 会话正绑定在另一个活动 dsh 会话上（sidecar 记录冲突），拒绝共享同一份 ACP 上下文',
  'binding-missing': '会话日志包含 ACP 历史但 sidecar 中不存在 binding 记录（sidecar 数据丢失或不可读）',
  'binding-outdated': 'sidecar binding 记录缺少必需字段（版本过旧或已损坏）',
  'backend-conflict': '会话的 execution backend 事实互相矛盾；为防止恢复到错误 Agent，已拒绝继续',
}

/**
 * reconciliation-required 的统一出路文案（{@link AcpReconciliationError} 消息的
 * 后半）：本进程内闩锁不重试；重启宿主会重走对账（修好成因可自愈）。
 */
export const ACP_RECONCILIATION_GUIDANCE =
  '出路：① 修复成因（如恢复原 cwd / agent 配置 / sidecar 数据）后重启宿主重试；② 调用 rebindBlank 显式放弃旧 ACP 上下文并重开全新 ACP 会话；③ 新建会话。DSH 侧历史在所有出路下都完整保留。'

/**
 * 对账失败 / 恢复预检失败的错误类型（turn/end error code =
 * `ACP_RECONCILIATION_REQUIRED`）。不进 AcpClientError 的 ACP 连接错误
 * taxonomy——这是会话连续性失败，不是协议/传输失败。
 */
export class AcpReconciliationError extends Error {
  readonly code = 'ACP_RECONCILIATION_REQUIRED' as const
  /** 失败分类（{@link AcpReconciliationCause} 词表；覆盖 Error.cause 的 unknown 位）。 */
  override readonly cause: AcpReconciliationCause
  readonly detail?: string

  constructor(cause: AcpReconciliationCause, detail?: string) {
    super(
      `${ACP_RECONCILIATION_CAUSE_DETAILS[cause]}${detail !== undefined && detail.length > 0 ? `（${detail}）` : ''}。${ACP_RECONCILIATION_GUIDANCE}`,
    )
    this.name = 'AcpReconciliationError'
    this.cause = cause
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * binding 落盘失败的错误类型（fail-closed：建立会话后、首个 prompt 前
 * 写 binding 失败即拒绝启动，不留「在跑但恢复无据」的 ACP 会话）。
 */
export class AcpBindingPersistError extends Error {
  readonly code = 'ACP_BINDING_PERSIST_FAILED' as const

  constructor(detail: string) {
    super(
      `ACP binding 持久化失败（${detail}）：为保证恢复有据，该 ACP 会话未启动。请检查 DSH_HOME 下 dsh-acp 目录的可写性后重试。`,
    )
    this.name = 'AcpBindingPersistError'
  }
}

/**
 * 对账用的可见历史条目（两侧规范化后的共同形态）。此后比较键是 canonical
 * `digest`（{@link acpCanonicalHash16}，sha256-16 hex）：user/assistant 只比规范化
 * 文本（连续 chunk 已聚合；规范化规则见 {@link normalizeVisibleText}）；tool 比跨侧
 * 稳定身份事实集（{@link AcpToolHistoryFacts}：kind、locations、有界 canonical
 * raw input、终态 status、规范化 result/meta——**不含 title** ACP 允许
 * tool_call_update 随时改写 title，它是展示事实不是跨侧稳定身份，见模块头
 * 段与 被拒工具回放不对称 实证——回放侧 tool_call 立条目、终态 tool_call_update
 * 回填；DSH 侧 tool/call 立条目、配对 tool/result 回填，无配对 → 'pending'）。
 * thought/plan/usage/状态槽类更新不参与对账。
 *
 * `text`/`title`/`status` 仅为分叉 detail 的人类可读摘要保留（有界、无秘密，
 * 见 summarizeEntry——tool 摘要只含 title/status/digest，绝不含 raw input 原文）。
 */
export type AcpVisibleHistoryEntry =
  | { readonly kind: 'user'; readonly text: string; readonly digest: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly digest: string }
  | {
      readonly kind: 'tool'
      readonly title: string
      readonly status: string
      readonly digest: string
      /**
       * 无原文的分量指纹，只用于解释 replay 分叉；不写入 DSH 历史，也不包含
       * raw input、路径或结果正文。缺席兼容旧测试夹具/调用方。
       */
      readonly fingerprint?: AcpToolHistoryFingerprint
    }

/** 工具对账分量的安全诊断投影（presence/count/length + hash16，绝不含原文）。 */
export interface AcpToolHistoryFingerprint {
  readonly toolKind: string | null
  readonly locationCount: number
  readonly locationsHash: string
  readonly inputHash: string
  readonly status: string
  readonly resultPresent: boolean
  readonly resultTextChars: number | null
  readonly resultTextHash: string | null
  readonly resultMetaHash: string | null
}

/**
 * 文本规范化（user/assistant 文本、tool title、locations path、result
 * text 共用）：行尾 CRLF/CR 统一为 LF，再做 Unicode NFC。刻意保守——不 trim、
 * 不折叠空白、不改字符内容；除此两项之外的任何逐字符差异仍判分叉。聚合类文本
 * 一律在**聚合完成后**规范化（NFC 对拼接不可交换：chunk 级先规范化再拼会漏掉
 * 跨 chunk 边界的组合字符）。两侧 fold 共用同一函数，保证确定性。
 */
export function normalizeVisibleText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC')
}

/** raw input 进入工具摘要前的 canonical JSON 字符数上限（超界折叠为截断标记 + hash16）。
 * 定义在 protocol/v1/tool-presentation.ts（模块头部 import + re-export）。 */

/** tool 摘要里的单个 location（path 原样 [finalize 时规范化]、line 缺席归 null）。 */
export interface AcpToolHistoryLocation {
  readonly path: string
  readonly line: number | null
}

/** tool 摘要里的规范化结果（可见 text 块拼接 + tool/result meta；两者同源见 translate.ts mapToolContent）。 */
export interface AcpToolHistoryResult {
  readonly text: string
  readonly meta: unknown
}

/**
 * 工具摘要的跨侧稳定身份事实集（canonical digest 的输入；两侧对称构造）。
 * **title 刻意排除** ACP 允许 tool_call_update 随时改写 title（Claude 0.70.0
 * 实证 被拒工具回放不对称：tool_call 发占位标题、终态标题随 update 到达；DSH 侧 name 落盘
 * 不可变、回放侧带终态标题）——title 漂移是展示事实，不是上下文连续性问题。
 * - `toolKind`：ACP ToolKind（DSH 侧优先读配对 tool/result 的终态快照
 *   `meta.acpToolCall.terminal`，缺席回退 tool/call `meta.acpToolCall`，见
 *   translate.ts AcpToolCallTerminalMeta / AcpToolCallMeta），缺席归 null；
 * - `locations`：tool_call 帧的 locations（同 meta 双通道），wire 顺序保持；
 * - `input`：有界 canonical raw input（JSON round-trip 归一 + 键序由 digest 的
 *   stableStringify 承担；超 {@link ACP_TOOL_INPUT_SUMMARY_MAX_CHARS} 折叠为
 *   `{truncated, originalChars, hash16}`——raw input 可能含秘密，超界后摘要里
 *   只留哈希，比较仍无损）。DSH 侧优先取终态快照 input（缺席回退 `arguments`
 *   JSON 串），折叠统一由 boundToolInput 在读取侧执行；
 * - `status`：终态（pending/completed/failed；terminal/diff 结局事实在 result.meta
 *   的 acpToolContent 条目里，同属 digest 输入）；
 * - `result`：规范化结果投影（无配对结果 → null）。rawOutput 不参与：DSH 侧从不
 *   翻译它（translate.ts 明示），无可比较的对称事实。
 */
export interface AcpToolHistoryFacts {
  readonly toolKind: string | null
  readonly locations: readonly AcpToolHistoryLocation[]
  readonly input: unknown
  readonly status: string
  readonly result: AcpToolHistoryResult | null
}

/** Runtime-specific compatibility policy for history projection. It is passed
 * explicitly to both DSH and replay extraction so a Devin workaround cannot
 * silently become a protocol-wide relaxation. */
export interface AcpHistoryProjectionPolicy {
  readonly runtime?: string
}

/** user/assistant 条目的 canonical digest（比较键；输入必须是已规范化文本）。 */
export function acpVisibleTextDigest(kind: 'user' | 'assistant', normalizedText: string): string {
  return acpCanonicalHash16([kind, normalizedText])
}

/** tool 条目的 canonical digest（比较键；stableStringify 键序无关，两侧事实集同构即同值；title 不在输入内——见 {@link AcpToolHistoryFacts} 的排除理由）。 */
export function acpToolHistoryDigest(facts: AcpToolHistoryFacts): string {
  return acpCanonicalHash16([
    'tool',
    facts.toolKind,
    facts.locations,
    facts.input,
    facts.status,
    facts.result,
  ])
}

/**
 * JSON 值归一（raw input 对称化）：经 `JSON.stringify → JSON.parse` round-trip
 * 消掉 undefined 属性/非 JSON 值——DSH 侧的 input 来自 `arguments` JSON 串的
 * parse，天然是这个形态；回放侧 rawInput 是活对象，必须过同一通道才能保证
 * 两侧 canonical 形态逐键一致。不可序列化 → null。
 */
function canonicalJsonValue(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined) return null
  return JSON.parse(json) as unknown
}

/**
 * raw input 的有界 canonical 摘要（{@link AcpToolHistoryFacts.input}）：未超界
 * 原样（canonical JSON 值，digest 的 stableStringify 负责键序）；超界折叠为
 * `{truncated:true, originalChars, hash16}` 标记对象——两侧同函数同输入同折叠，
 * digest 比较不受截断影响，而 sidecar/摘要从始至终不携带 raw input 原文。
 */
function boundToolInput(rawInput: unknown): unknown {
  const canonical = canonicalJsonValue(rawInput ?? {})
  const json = JSON.stringify(canonical)
  if (json !== undefined && json.length <= ACP_TOOL_INPUT_SUMMARY_MAX_CHARS) return canonical
  return {
    truncated: true,
    originalChars: json?.length ?? 0,
    hash16: acpCanonicalHash16(canonical),
  }
}

/**
 * ACP session/load 可合法回放为信息更少的终态快照。Devin 3000.5.20 的文件编辑
 * 实证形态是：live rawInput={file_path,content}，load rawInput={file_path}，而终态
 * diff 的 path/newText 摘要与结构化结果（含完整 newText 的 hash16）逐字节相同。
 * 仅对明确 runtime=devin、`kind=edit` 且结果确有同路径 diff 的工具，且
 * `sha256(content).slice(0,16)` 与 diff.hash16、originalChars 与 content.length
 * 全部匹配时，才把 `content` 视为结果通道已完整证明的冗余字段并剔除。工具
 * 存在性、kind、locations、其余 input（含 file_path）、status 与完整的有界
 * result/meta 仍参与 digest，Devin 被拒工具回放不对称 的缺工具防线不变。非 Devin、非 edit、无 diff、
 * 路径/hash/长度不匹配或非字符串 content 均不改写。
 */
function contentHash16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

export function stableToolInputProjection(
  rawInput: unknown,
  toolKind: string | null,
  resultMeta: unknown,
  policy: AcpHistoryProjectionPolicy,
): unknown {
  const canonical = canonicalJsonValue(rawInput ?? {})
  if (policy.runtime !== 'devin') return canonical
  if (toolKind !== 'edit' || typeof canonical !== 'object' || canonical === null || Array.isArray(canonical)) {
    return canonical
  }
  if (typeof resultMeta !== 'object' || resultMeta === null) return canonical
  const envelope = (resultMeta as Record<string, unknown>).acpToolContent
  if (typeof envelope !== 'object' || envelope === null) return canonical
  const items = (envelope as Record<string, unknown>).items
  if (!Array.isArray(items)) return canonical
  const record = canonical as Record<string, unknown>
  const filePath = record.file_path
  const content = record.content
  if (typeof filePath !== 'string' || typeof content !== 'string') return canonical
  // Devin can report several diffs in one terminal result.  Search every diff
  // for a complete byte-for-byte/path/hash/length proof; relying on the first
  // item incorrectly diverges when the requested edit is later in the list.
  const matchedDiff = items.find((item: unknown) => {
    if (typeof item !== 'object' || item === null || (item as Record<string, unknown>).type !== 'diff') return false
    const diffRecord = item as Record<string, unknown>
    // This is deliberately byte-for-byte equality. Normalizing separators or
    // dot segments would widen a runtime-specific compatibility exception into
    // a claim that two differently reported resources are the same file.
    return diffRecord.path === filePath
      && typeof diffRecord.hash16 === 'string'
      && contentHash16(content) === diffRecord.hash16
      && typeof diffRecord.originalChars === 'number'
      && diffRecord.originalChars === content.length
  })
  if (matchedDiff === undefined) return canonical
  const projected = { ...record }
  delete projected.content
  return projected
}

/** DSH 侧 tool/call `arguments` JSON 串 → raw input 值；损坏/外来日志按原串计（与任何规范回放判分叉，诚实 fail-closed）。 */
function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown
  } catch {
    return args
  }
}

/**
 * 读回 tool/call 事件 meta 里的 ACP 摘要事实（translate.ts `AcpToolCallMeta` 的
 * 消费侧；schema 无此字段，故结构窄化 + 逐字段防御——畸形/缺席一律归
 * null/空集，不抛：写坏的事实会让 digest 与规范回放分叉，fail-closed 而非崩溃）。
 * meta 还携带首帧 title（name 恒为稳定名后的展示标题通道）——title
 * 只进条目的展示摘要字段，不进 digest 事实集（被拒工具回放不对称 纪律不变）。
 */
function dshToolCallMetaFacts(data: SessionEvent<'tool/call'>['data']): {
  title: string | null
  toolKind: string | null
  locations: AcpToolHistoryLocation[]
} {
  const meta = (data as { readonly meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return { title: null, toolKind: null, locations: [] }
  const acpToolCall = (meta as Record<string, unknown>).acpToolCall
  if (typeof acpToolCall !== 'object' || acpToolCall === null) return { title: null, toolKind: null, locations: [] }
  const record = acpToolCall as Record<string, unknown>
  const title = typeof record.title === 'string' && record.title !== '' ? record.title : null
  const toolKind = typeof record.kind === 'string' ? record.kind : null
  const locations = Array.isArray(record.locations)
    ? record.locations.flatMap((loc): AcpToolHistoryLocation[] => {
        if (typeof loc !== 'object' || loc === null) return []
        const entry = loc as Record<string, unknown>
        if (typeof entry.path !== 'string') return []
        return [{ path: entry.path, line: typeof entry.line === 'number' ? entry.line : null }]
      })
    : []
  return { title, toolKind, locations }
}

/**
 * 读回 tool/result 事件 meta 里的 ACP 终态快照（translate.ts
 * `AcpToolCallTerminalMeta` 的消费侧；非对称工具回放）。缺席/畸形一律归
 * undefined 或字段缺席，不抛（与 {@link dshToolCallMetaFacts} 同一 fail-closed
 * 纪律）。返回值的字段语义：title 缺席 → 保持 tool/call 首帧名；toolKind/
 * locations 缺席 → 保持首帧 meta 事实；hasInput=false → 保持 `arguments` 来源。
 */
function dshToolResultTerminalFacts(data: SessionEvent<'tool/result'>['data']): {
  readonly title?: string
  readonly toolKind?: string
  readonly locations?: AcpToolHistoryLocation[]
  readonly hasInput: boolean
  readonly input?: unknown
} | undefined {
  const meta = (data as { readonly meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const acpToolCall = (meta as Record<string, unknown>).acpToolCall
  if (typeof acpToolCall !== 'object' || acpToolCall === null) return undefined
  const terminal = (acpToolCall as Record<string, unknown>).terminal
  if (typeof terminal !== 'object' || terminal === null) return undefined
  const record = terminal as Record<string, unknown>
  const locations = Array.isArray(record.locations)
    ? record.locations.flatMap((loc): AcpToolHistoryLocation[] => {
        if (typeof loc !== 'object' || loc === null) return []
        const entry = loc as Record<string, unknown>
        if (typeof entry.path !== 'string') return []
        return [{ path: entry.path, line: typeof entry.line === 'number' ? entry.line : null }]
      })
    : undefined
  return {
    ...(typeof record.title === 'string' && record.title !== '' ? { title: record.title } : {}),
    ...(typeof record.kind === 'string' ? { toolKind: record.kind } : {}),
    ...(locations === undefined ? {} : { locations }),
    hasInput: 'input' in record,
    ...('input' in record ? { input: record.input } : {}),
  }
}

/**
 * tool/result meta 的对账投影（非对称工具回放）：digest 的 result.meta 事实只计
 * `acpToolContent` 键（起回放侧事件也经同一 translate.ts mapToolContent
 * 通道产生，meta 形态天然逐键对称）；
 * 被拒工具回放不对称 引入的 `acpToolCall.terminal` 终态快照键是身份事实通道（kind/locations/
 * input 经它进 digest），不重复计入 result。meta 缺席或无 acpToolContent → null
 * （与回放侧无降级项时的缺省对齐）。
 */
function dshToolResultProjectionMeta(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null) return null
  const acpToolContent = (meta as Record<string, unknown>).acpToolContent
  return typeof acpToolContent === 'object' && acpToolContent !== null ? { acpToolContent } : null
}

/**
 * fold 期的可变条目构件：文本类聚合 raw 文本、tool 类累积事实集，统一在
 * {@link finalizeBuilder} 规范化并计算 digest（聚合后规范化，见
 * {@link normalizeVisibleText} 的 NFC 交换性说明）。
 */
type HistoryEntryBuilder =
  | { readonly kind: 'user' | 'assistant'; text: string }
  | {
      readonly kind: 'tool'
      title: string
      toolKind: string | null
      locations: AcpToolHistoryLocation[]
      input: unknown
      status: string
      result: { text: string; meta: unknown } | null
    }

function finalizeBuilder(builder: HistoryEntryBuilder, policy: AcpHistoryProjectionPolicy): AcpVisibleHistoryEntry {
  if (builder.kind !== 'tool') {
    const text = normalizeVisibleText(builder.text)
    const digest = acpVisibleTextDigest(builder.kind, text)
    return builder.kind === 'user' ? { kind: 'user', text, digest } : { kind: 'assistant', text, digest }
  }
  const title = normalizeVisibleText(builder.title)
  const result: AcpToolHistoryResult | null = builder.result === null
    ? null
    : { text: normalizeVisibleText(builder.result.text), meta: builder.result.meta }
  const input = boundToolInput(stableToolInputProjection(builder.input, builder.toolKind, result?.meta ?? null, policy))
 // title 只进条目的展示摘要字段，不进 digest 事实集（被拒工具回放不对称：ACP 允许 title 漂移）
  const facts: AcpToolHistoryFacts = {
    toolKind: builder.toolKind,
    locations: builder.locations.map((loc) => ({ path: normalizeVisibleText(loc.path), line: loc.line })),
    input,
    status: builder.status,
    result,
  }
  const digest = acpToolHistoryDigest(facts)
  return {
    kind: 'tool',
    title,
    status: builder.status,
    digest,
    fingerprint: {
      toolKind: facts.toolKind,
      locationCount: facts.locations.length,
      locationsHash: acpCanonicalHash16(facts.locations),
      inputHash: acpCanonicalHash16(facts.input),
      status: facts.status,
      resultPresent: facts.result !== null,
      resultTextChars: facts.result?.text.length ?? null,
      resultTextHash: facts.result === null ? null : acpCanonicalHash16(facts.result.text),
      resultMetaHash: facts.result === null ? null : acpCanonicalHash16(facts.result.meta),
    },
  }
}

/** 判定 DSH 事件是否属于可见历史（assistant/message 必须带 sourceEventSeqs——见模块注释）。 */
function isVisibleDshEvent(event: SessionEvent): boolean {
  if (event.type === 'user/message' || event.type === 'tool/call' || event.type === 'tool/result') return true
  return event.type === 'assistant/message' && event.sourceEventSeqs !== undefined
}

/**
 * 定期望区间（对账第一步）：`[historyBaseSeq, dshCommittedSeq)` 是 binding
 * 担保的前缀。锚点之后（`[dshCommittedSeq, baselineSeq)`）若存在可见事件：
 * 全部属于以 `turn/end{interrupted}` 收束的 turn（崩溃尾巴）→ 区间扩展到
 * baselineSeq（崩溃尾巴可纳入期望，但会话仍进入 outcome-unknown）；否则 →
 * 'dsh-log-diverged'（有未解释的可见事件，拒绝猜）。`baselineSeq` 由调用方在
 * 追加本 run 自己的说明消息**之前**捕获，把说明消息排除在本检查之外
 * （说明消息省略 sourceEventSeqs，本就不算可见事件，双保险）。
 * @param events - session.events（seq 顺序）。
 * @param historyBaseSeq - binding.historyBaseSeq（本代际可见历史起点，含）。
 * @param dshCommittedSeq - binding.dshCommittedSeq（担保前缀上界，不含）。
 * @param baselineSeq - 本 run 追加说明消息前捕获的 session.seq。
 */
export function resolveExpectedRange(
  events: readonly SessionEvent[],
  historyBaseSeq: number,
  dshCommittedSeq: number,
  baselineSeq: number,
): { readonly ok: true; readonly from: number; readonly to: number }
  | { readonly ok: false; readonly cause: 'dsh-log-diverged'; readonly detail: string } {
  const turnEndKind = new Map<number, string>()
  let currentTurn: number | undefined
  const postAnchorTurns = new Map<number, number>() // turn → 锚点后可见事件数
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.type === 'turn/end') turnEndKind.set(event.data.turn, event.data.reason.kind)
    if (event.seq < dshCommittedSeq || event.seq >= baselineSeq || !isVisibleDshEvent(event)) continue
    // user/message 的 data 无 turn 字段，取外围 turn/start 的 currentTurn；其余可见事件自带 turn
    const dataTurn = (event.data as { turn?: unknown }).turn
    const turn = typeof dataTurn === 'number' ? dataTurn : currentTurn
    if (turn !== undefined) postAnchorTurns.set(turn, (postAnchorTurns.get(turn) ?? 0) + 1)
  }
  if (postAnchorTurns.size === 0) return { ok: true, from: historyBaseSeq, to: dshCommittedSeq }
  const unexplained: string[] = []
  for (const turn of postAnchorTurns.keys()) {
    const kind = turnEndKind.get(turn)
    if (kind !== 'interrupted') unexplained.push(`turn ${String(turn)} (ended ${kind ?? 'unknown'})`)
  }
  if (unexplained.length > 0) {
    return {
      ok: false,
      cause: 'dsh-log-diverged',
      detail: `visible events after committed seq ${String(dshCommittedSeq)} belong to non-crash-tail turn(s): ${unexplained.join(', ')}`,
    }
  }
  return { ok: true, from: historyBaseSeq, to: baselineSeq }
}

/**
 * 折出 DSH 侧期望可见历史（`[from, to)` 区间内的可见事件，seq 顺序）：
 * user/message → user（text 块拼接；同一 DSH turn 开头的连续多条
 * user/message 再拼成一个锚点——DSH 会把宿主注入与真实用户输入分条记录，
 * 而 ACP Agent 可在 session/load 中按实际 prompt 边界合并回放）；
 * assistant/message（**仅带
 * sourceEventSeqs 字段的**——省略该字段的是本适配器的说明消息，不参与）→
 * assistant（type==='text' 块拼接）；tool/call → tool（title 优先取
 * `meta.acpToolCall.title`（起 name 恒为稳定名，首帧 wire title 的落盘
 * 通道）、缺席回退 name，仅作展示摘要字段、不进 digest；kind/locations 读事件
 * `meta.acpToolCall`，raw input
 * 取 `arguments` JSON 串的有界 canonical 值；配对 tool/result 回填 status：
 * isError → 'failed'，否则 'completed'，并回填规范化 result/meta；无配对 →
 * 'pending'）。**非对称工具回放** 配对 tool/result 带 `meta.acpToolCall.terminal`
 * 终态快照时，title/kind/locations/input 逐项以快照为准（逐项缺席即保持首帧
 * 来源）——live 首帧占位事实（claude 形态）据此与回放侧终态合并帧对称；
 * result.meta 只计 acpToolContent 投影（终态快照键是身份事实通道，不进
 * result）。孤儿 tool/result（无配对 tool/call）跳过。所有条目带 canonical
 * digest（{@link finalizeBuilder}），文本在聚合后统一规范化。
 */
export function expectedVisibleHistory(
  events: readonly SessionEvent[],
  from: number,
  to: number,
  policy: AcpHistoryProjectionPolicy = {},
): AcpVisibleHistoryEntry[] {
  const builders: HistoryEntryBuilder[] = []
  const toolIndexByCallId = new Map<string, number>()
  // user/message 自身没有 turn 字段，所以从原始日志的 turn 括号恢复归属。
  // 不能把“一条 user 事件”当成“一次 ACP prompt”：DSH 可在首个模型步前
  // 先注入宿主上下文（例如 user-approval 策略变更），再追加真实用户输入。
  // Codex ACP 会把这些 content block 按一次 prompt 合并回放；只合并同 turn、
  // 且在可见历史中仍连续的 user 事件，避免吞掉跨 turn 或工具交互边界。
  let currentTurn: number | undefined
  let lastUserTurn: number | undefined
  for (const event of events) {
    // 即使 turn/start 在 from 之前，也要扫描它以恢复区间起点的 turn 归属。
    if (event.seq >= to) break
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.seq < from) {
      if (event.type === 'turn/end' && event.data.turn === currentTurn) currentTurn = undefined
      continue
    }
    if (event.type === 'user/message') {
      const text = event.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const previous = builders.at(-1)
      if (currentTurn !== undefined && lastUserTurn === currentTurn && previous?.kind === 'user') {
        previous.text += text
      } else {
        builders.push({ kind: 'user', text })
      }
      lastUserTurn = currentTurn
    } else if (event.type === 'assistant/message') {
      if (event.sourceEventSeqs === undefined) continue // 本适配器的说明消息
      const text = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      builders.push({ kind: 'assistant', text })
    } else if (event.type === 'tool/call') {
      toolIndexByCallId.set(event.data.callId, builders.length)
      const { title: metaTitle, toolKind, locations } = dshToolCallMetaFacts(event.data)
      builders.push({
        kind: 'tool',
 // name 恒为稳定名（ACP_EXTERNAL_TOOL_NAME）后，展示标题优先取
        // meta.acpToolCall.title（首帧 wire title）；旧日志无该键，回退 name
        // （当时的动态标题），行为与既往一致。title 仅作展示摘要，不进 digest。
        title: metaTitle ?? event.data.name,
        toolKind,
        locations,
        // 保留 raw 值到 finalize：只有拿到配对 result 后，才能判断 edit.content
        // 是否已由 diff 结果重复承载并做稳定投影。
        input: parseToolArguments(event.data.arguments),
        status: 'pending',
        result: null,
      })
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const index = toolIndexByCallId.get(block.toolCallId)
      if (index === undefined) continue
      const builder = builders[index]
      if (builder?.kind === 'tool') {
 // 非对称工具回放：终态快照优先——tool/result meta.acpToolCall.terminal
        // 携带各帧 latest-wins 累积的终态 title/kind/locations/input（claude
        // live 形态：首帧是进行态占位，终态事实经 update 帧到达，见 translate.ts
        // AcpToolCallTerminalMeta）；快照缺席（旧日志 / 首帧即全量的 agent）回退
        // tool/call 首帧事实，行为与既往一致。快照内字段逐项缺席即逐项保持首帧来源。
        const terminal = dshToolResultTerminalFacts(event.data)
        if (terminal !== undefined) {
          if (terminal.title !== undefined) builder.title = terminal.title
          if (terminal.toolKind !== undefined) builder.toolKind = terminal.toolKind
          if (terminal.locations !== undefined) builder.locations = terminal.locations
          if (terminal.hasInput) builder.input = terminal.input
        }
        builder.status = block.isError === true ? 'failed' : 'completed'
        builder.result = {
          text: block.content.filter((item) => item.type === 'text').map((item) => item.text).join(''),
          // meta 只计 acpToolContent 投影（终态快照键是身份事实通道，不进 result——
          // 回放侧经同一 mapToolContent 通道产生该 meta，形态逐键对称）
          meta: dshToolResultProjectionMeta(event.data.meta ?? null),
        }
      }
    }
    if (event.type === 'turn/end' && event.data.turn === currentTurn) currentTurn = undefined
  }
  return builders.map((builder) => finalizeBuilder(builder, policy))
}

/**
 * 折出回放侧可见历史（回放共轨）：`staged` 是 translate.ts
 * {@link ReplayTranslator} 对 session/load 回放更新流的翻译产物（与 live 同一
 * 个 {@link TurnTranslator} + 同一个 {@link PresentationSegmenter}，staging sink
 * 记录、不落盘），本函数就是「对 staging 事件流全区间应用
 * {@link expectedVisibleHistory}」——两侧可见历史由同一提取函数产出，digest
 * 天然同构。合成 user/message（连续 user_message_chunk run 聚合，对齐旧
 * normalizeReplayUpdates 语义）由 ReplayTranslator 生成，本函数不感知。
 *
 * 与旧 normalizeReplayUpdates 的语义对齐点（对账不变量保持）：
 * - tool 身份事实集不变（kind/locations/有界 canonical input/终态 status/
 *   规范化 result+meta）——回放帧经同一 mapToolContent/终态快照通道投影；
 * - title 仍只作展示摘要字段、不进 digest（被拒工具回放不对称）；
 * - 段内 assistant 文本拼接比较， 的 presentation 分段数量
 *   差异不影响 digest——synthetic presentation step 从不进任何 digest 输入。
 *
 * @param staged - ReplayTranslator.finish 的返回（seq 从 0 连续）。
 */
export function replayVisibleHistory(
  staged: readonly SessionEvent[],
  policy: AcpHistoryProjectionPolicy = {},
): AcpVisibleHistoryEntry[] {
  return expectedVisibleHistory(staged, 0, staged.length, policy)
}

/**
 * 单条目的人类可读摘要（分叉 detail 用；文本截 ~40 字符）。纪律：
 * 摘要有界且**无秘密**——tool 条目只含规范化 title/终态/canonical digest，
 * 绝不携带 raw input / result 原文（那些只以 digest 形式参与比较与记录）。
 */
function summarizeEntry(entry: AcpVisibleHistoryEntry | undefined): string {
  if (entry === undefined) return '<absent>'
  const bound = (text: string): string => {
    const flat = text.replaceAll('\n', '⏎')
    return flat.length <= 40 ? `"${flat}"` : `"${flat.slice(0, 39)}…"`
  }
  if (entry.kind === 'tool') return `tool:${bound(entry.title)}(${entry.status})#${entry.digest}`
  return `${entry.kind}:${bound(entry.text)}#${entry.digest}`
}

/**
 * turn 段（对账的比较单元）：两侧条目流各自按 user 锚点切段——每遇到
 * 一个 user 条目开一个新段；首个 user 之前的内容归入带头段（`user: null`）。
 * 正常路径带头段恒空（historyBaseSeq 落在 turn 起点，可见历史由 user/message
 * 开头；见 {@link resolveExpectedRange} 的区间口径），但崩溃尾巴/外来日志等
 * 形态不假设——带头段按同一套分层规则参与比较。回放侧无显式 turn 边界，
 * user 锚点与期望侧（DSH 日志按 turn 组织、turn 由 user/message 起头）口径
 * 对齐；段内不再依赖条目的先后顺序（见 {@link reconcileVisibleHistory}）。
 */
interface TurnSegment {
  /** 段锚（带头段为 null）。 */
  readonly user: AcpVisibleHistoryEntry | null
  /** 段内全部 assistant 条目的已规范化文本按序拼接（比较前再做一次跨边界规范化）。 */
  readonly assistantText: string
  /** 段内全部 tool 条目（顺序无关，比较走 digest 多重集）。 */
  readonly tools: readonly AcpVisibleHistoryEntry[]
}

/** 按 user 锚点切段（{@link TurnSegment} 的构造；返回的首段恒为带头段，可能全空）。 */
function segmentByTurnAnchors(entries: readonly AcpVisibleHistoryEntry[]): TurnSegment[] {
  const segments: TurnSegment[] = []
  let user: AcpVisibleHistoryEntry | null = null
  let assistantText = ''
  let tools: AcpVisibleHistoryEntry[] = []
  const flush = (): void => {
    segments.push({ user, assistantText, tools })
  }
  for (const entry of entries) {
    if (entry.kind === 'user') {
      flush()
      user = entry
      assistantText = ''
      tools = []
    } else if (entry.kind === 'assistant') {
      assistantText += entry.text
    } else {
      tools.push(entry)
    }
  }
  flush()
  return segments
}

/**
 * 分叉 detail 里的段标识：带头段点名「无 user 锚」；锚定段给 1-based turn 段号
 * （带头段不占序号，第一个真实 turn 段恒为 1）与锚点摘要（有界、无秘密）。
 */
function segmentLabel(index: number, segment: TurnSegment): string {
  if (segment.user === null) return 'leading segment (before the first user anchor)'
  return `turn segment ${String(index)} [${summarizeEntry(segment.user)}]`
}

/**
 * 段内 tool 多重集的人类可读摘要（分叉 detail 用）：按 digest 去重逐种列
 * `tool:"title"(status)#digest ×count`。纪律不变：有界（最多种类数上限，
 * 超出折计数后缀）、无秘密（title/status/digest，绝不含 raw input/result 原文）。
 */
function summarizeToolMultiset(tools: readonly AcpVisibleHistoryEntry[]): string {
  const MAX_LISTED_KINDS = 6
  const order: string[] = []
  const counts = new Map<string, number>()
  const samples = new Map<string, AcpVisibleHistoryEntry>()
  for (const tool of tools) {
    if (!counts.has(tool.digest)) {
      order.push(tool.digest)
      samples.set(tool.digest, tool)
    }
    counts.set(tool.digest, (counts.get(tool.digest) ?? 0) + 1)
  }
  const parts = order.slice(0, MAX_LISTED_KINDS).map((digest) => {
    const count = counts.get(digest) ?? 0
    return `${summarizeEntry(samples.get(digest))}${count > 1 ? ` ×${String(count)}` : ''}`
  })
  if (order.length > MAX_LISTED_KINDS) parts.push(`… +${String(order.length - MAX_LISTED_KINDS)} more`)
  return `[${parts.join(', ')}]`
}

/**
 * 单工具分叉的安全分量诊断。只输出协议枚举、计数/长度与 hash16；绝不输出
 * 路径、raw input 或结果正文。多工具段无法可靠配对，宁可省略而不猜。
 */
function singleToolFingerprintDifference(
  replayTools: readonly AcpVisibleHistoryEntry[],
  dshTools: readonly AcpVisibleHistoryEntry[],
): string {
  if (replayTools.length !== 1 || dshTools.length !== 1) return ''
  const replay = replayTools[0]?.kind === 'tool' ? replayTools[0].fingerprint : undefined
  const dsh = dshTools[0]?.kind === 'tool' ? dshTools[0].fingerprint : undefined
  if (replay === undefined || dsh === undefined) return ''
  const compact = (facts: AcpToolHistoryFingerprint): string => [
    `kind=${JSON.stringify(facts.toolKind)}`,
    `locations=${String(facts.locationCount)}#${facts.locationsHash}`,
    `input=#${facts.inputHash}`,
    `status=${facts.status}`,
    `result=${facts.resultPresent ? `text:${String(facts.resultTextChars)}#${facts.resultTextHash ?? '-'},meta:#${facts.resultMetaHash ?? '-'}` : 'absent'}`,
  ].join(';')
  return `; component-fingerprints replay={${compact(replay)}} dsh={${compact(dsh)}}`
}

/** 段内 assistant 聚合文本的比较键：拼接后再规范化一次（NFC 对拼接不可交换，跨条目边界的组合字符不能漏），然后整体取 digest。 */
function assistantLayerDigest(segment: TurnSegment): { readonly text: string; readonly digest: string } {
  const text = normalizeVisibleText(segment.assistantText)
  return { text, digest: acpVisibleTextDigest('assistant', text) }
}

/**
 * 对账（核心判定，纯函数；分段语义）。两侧条目流先各自按 user
 * 锚点切 turn 段（{@link segmentByTurnAnchors}），段间保序逐段比对，段内分三层：
 * - **user 锚点** digest 相等（锚不一致 = 两段根本不是同一轮，立即分叉）；
 * - **assistant 聚合文本** 段内全部 assistant 文本拼接后整体比 digest
 *   （{@link assistantLayerDigest}）——同 turn 多 messageId 时 live 侧聚合成一条
 *   assistant/message、回放侧多条，条数差异不再误判；
 * - **tool 多重集** 段内 tool 条目按 digest 计数量比较——live 落盘（tool/call
 *   即时 + assistant/message 在 endTurn）与回放（wire 序）的段内顺序差异不再误判；
 *   被拒/篡改 tool 不进回放 → 回放侧缺项 → 仍判 replay-diverged（Devin 被拒工具回放不对称 防线保留）。
 *
 * cause 词表与旧保序实现相同：回放侧多出 DSH 没有的内容（多出的 turn 段、段内
 * 多出的 tool/assistant 文本）→ 'dsh-log-truncated'（DSH 可见历史短于 agent
 * 回放）；其余一切不符（少项、锚/文本/工具 digest 相异）→ 'replay-diverged'。
 * detail 为段级描述（第几 turn 段、user/assistant/tool 哪一层不符、两侧有界
 * 摘要），不再给「首个分叉 index」——分段语义下逐位 index 无意义。
 */
export function reconcileVisibleHistory(
  staged: readonly AcpVisibleHistoryEntry[],
  expected: readonly AcpVisibleHistoryEntry[],
): { readonly ok: true } | { readonly ok: false; readonly cause: 'replay-diverged' | 'dsh-log-truncated'; readonly detail: string } {
  const replaySegments = segmentByTurnAnchors(staged)
  const dshSegments = segmentByTurnAnchors(expected)
  const shared = Math.min(replaySegments.length, dshSegments.length)
  for (let index = 0; index < shared; index += 1) {
    const replay = replaySegments[index]
    const dsh = dshSegments[index]
    if (replay === undefined || dsh === undefined) continue
    const label = segmentLabel(index, dsh)
    // ① user 锚点层（带头段两侧 user 恒为 null；锚定段比 digest）
    if (replay.user === null !== (dsh.user === null)
      || (replay.user !== null && dsh.user !== null && replay.user.digest !== dsh.user.digest)) {
      return {
        ok: false,
        cause: 'replay-diverged',
        detail: `first divergence in ${label} (user anchor): replay=${summarizeEntry(replay.user ?? undefined)} vs dsh=${summarizeEntry(dsh.user ?? undefined)}`,
      }
    }
    // ② assistant 聚合文本层（空段两侧文本均为 ''，digest 自然相等）
    const replayAssistant = assistantLayerDigest(replay)
    const dshAssistant = assistantLayerDigest(dsh)
    if (replayAssistant.digest !== dshAssistant.digest) {
      // 回放有文本而 DSH 侧为空 = DSH 可见历史缺失（同「多出的尾部」语义）
      const cause = replayAssistant.text !== '' && dshAssistant.text === '' ? 'dsh-log-truncated' : 'replay-diverged'
      return {
        ok: false,
        cause,
        detail: `first divergence in ${label} (assistant text): replay=${summarizeEntry({ kind: 'assistant', text: replayAssistant.text, digest: replayAssistant.digest })} vs dsh=${summarizeEntry({ kind: 'assistant', text: dshAssistant.text, digest: dshAssistant.digest })}`,
      }
    }
    // ③ tool 多重集层（digest 计数；顺序无关）
    const multisetCounts = (tools: readonly AcpVisibleHistoryEntry[]): Map<string, number> => {
      const counts = new Map<string, number>()
      for (const tool of tools) counts.set(tool.digest, (counts.get(tool.digest) ?? 0) + 1)
      return counts
    }
    const replayCounts = multisetCounts(replay.tools)
    const dshCounts = multisetCounts(dsh.tools)
    let missingInReplay = false // DSH 有而回放无（或计数不足）——被拒/漏回放方向
    let extraInReplay = false // 回放有而 DSH 无（或计数超出）——DSH 历史缺失方向
    for (const digest of new Set([...replayCounts.keys(), ...dshCounts.keys()])) {
      const replayCount = replayCounts.get(digest) ?? 0
      const dshCount = dshCounts.get(digest) ?? 0
      if (replayCount < dshCount) missingInReplay = true
      if (replayCount > dshCount) extraInReplay = true
    }
    if (missingInReplay || extraInReplay) {
      return {
        ok: false,
        // 回放 ⊇ 期望（只多不少）= DSH 日志缺失 → truncated；其余（含回放缺项）→ diverged
        cause: !missingInReplay && extraInReplay ? 'dsh-log-truncated' : 'replay-diverged',
        detail: `first divergence in ${label} (tool multiset): replay=${summarizeToolMultiset(replay.tools)} vs dsh=${summarizeToolMultiset(dsh.tools)}${singleToolFingerprintDifference(replay.tools, dsh.tools)}`,
      }
    }
  }
  if (replaySegments.length > dshSegments.length) {
    const extra = replaySegments[dshSegments.length]
    return {
      ok: false,
      cause: 'dsh-log-truncated',
      detail: `replay has ${String(replaySegments.length)} turn segments but the dsh expected history has ${String(dshSegments.length)}; extra replay tail: ${extra === undefined ? '<absent>' : segmentLabel(dshSegments.length, extra)}`,
    }
  }
  if (replaySegments.length < dshSegments.length) {
    const missing = dshSegments[replaySegments.length]
    return {
      ok: false,
      cause: 'replay-diverged',
      detail: `replay stopped at ${String(replaySegments.length)} turn segments but the dsh expected history has ${String(dshSegments.length)}; missing from replay: ${missing === undefined ? '<absent>' : segmentLabel(replaySegments.length, missing)}`,
    }
  }
  return { ok: true }
}

/**
 * 说明性 assistant 消息的共享 append 通道：正常 `Session.append`（surfaceOp
 * 'append'，**无 sourceEventSeqs**——surface.ts:221 允许 assistant/message 省略；
 * 对账期望序列据该字段的缺席排除说明消息，见模块注释）。step 恒为专用泳道
 * {@link ACP_NOTE_STEP}=0（上游 ui-conversation 以 `turn:step` 为
 * assistant 节点身份，说明消息若与内容 segment 共享 step 会折叠进同一节点并
 * 顶替其内容；内容段从 1 起编号，step 0 恒不与内容段冲突）。
 *
 * source.model 兜底链（修复）：调用点已知模型 → 日志末个 request/header
 * 的模型 → {@link ACP_UNKNOWN_MODEL} 哨兵。此处曾硬编码空串落盘，Session 构造的
 * seed 校验（core/session assertMessageEventShape → hasProviderModel 要求
 * provider/model 均非空）会在下次加载拒绝整条日志——会话永久不可 resume/fork
 * （由恢复矩阵测试覆盖）。
 * @param model - 调用点已知的当前 ACP 模型；缺省/空串时走兜底链。
 */
function appendAssistantNote(session: Session, providerRoute: string, turn: number, text: string, model?: string): void {
  const headerModel = session.requestHeader()?.config.model
  const sourceModel = model !== undefined && model !== '' ? model
    : headerModel !== undefined && headerModel !== '' ? headerModel
    : ACP_UNKNOWN_MODEL
  const message = createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: providerRoute, model: sourceModel },
  })
  session.append('assistant/message', { turn, step: ACP_NOTE_STEP, message }, { surfaceOp: 'append' })
}

/**
 * 追加 outcome-unknown 说明（构造期调用：resume 路径下经 prepare 的缓冲在
 * enter 时随 suffix 落盘；该持久化路径由恢复矩阵测试覆盖。
 * 构造期 translator 尚不存在，source.model 走兜底链：日志末个 header → 哨兵。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - 被中断的 turn 号（{@link detectInterruptedTail} 的返回值）。
 */
export function appendOutcomeUnknownNote(session: Session, providerRoute: string, turn: number): void {
  appendAssistantNote(session, providerRoute, turn, ACP_RESUME_OUTCOME_UNKNOWN_NOTE)
}

/**
 * fork 说明是否已落盘（幂等闸：fork 出的会话此后每次 resume 都会重建
 * AcpAgent，构造期追加前据此刻重判定）。说明消息省略 sourceEventSeqs，匹配
 * 只认「无 sourceEventSeqs 且文本全等」的 assistant/message。
 */
export function hasForkBlankNote(session: Session): boolean {
  return session.events.some((event) =>
    event.type === 'assistant/message'
    && event.sourceEventSeqs === undefined
    && event.data.message.content.some((block) => block.type === 'text' && block.text === ACP_FORK_BLANK_NOTE))
}

/**
 * 追加 fork 说明（构造期调用，随 prepare/attachPrepared 的 suffix 机制落盘，
 * 与 outcome-unknown 说明同通道）。调用方负责 fork 判定与幂等闸。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - fork 源日志的末个 turn 号（说明挂在既有历史末尾）。
 */
export function appendForkBlankNote(session: Session, providerRoute: string, turn: number): void {
  appendAssistantNote(session, providerRoute, turn, ACP_FORK_BLANK_NOTE)
}

/**
 * 追加重连残留警告（内容类残留更新落盘后调用，每次恢复最多一次）。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - 当前 turn 号（游离更新到达时无 open turn，通常为末个已收束 turn）。
 * @param model - 调用点已知的当前 ACP 模型（translator route）；缺省/空串时走兜底链。
 */
export function appendResumeResidueNote(session: Session, providerRoute: string, turn: number, model?: string): void {
  appendAssistantNote(session, providerRoute, turn, ACP_RESUME_RESIDUE_NOTE, model)
}

/**
 * 追加 rebindBlank 说明（新 binding 落盘成功后、首个 prompt 前调用；文案见
 * {@link ACP_REBIND_BLANK_NOTE}）。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - 发起重开的 turn 号。
 * @param model - 调用点已知的当前 ACP 模型（translator route）；缺省/空串时走兜底链。
 */
export function appendRebindBlankNote(session: Session, providerRoute: string, turn: number, model?: string): void {
  appendAssistantNote(session, providerRoute, turn, ACP_REBIND_BLANK_NOTE, model)
}

/**
 * 追加建立时模型收敛分叉说明（边界；文案由 {@link acpModelDivergenceNote} 组装）。
 * 每次会话建立最多一条（闩锁在调用方 ./agent.ts）；落盘失败仅 warn 的纪律同
 * 其他说明消息。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - 发起建立的 turn 号。
 * @param text - {@link acpModelDivergenceNote} 的组装产物。
 * @param model - 调用点已知的当前 ACP 模型（translator route）；缺省/空串时走兜底链。
 */
export function appendModelDivergenceNote(session: Session, providerRoute: string, turn: number, text: string, model?: string): void {
  appendAssistantNote(session, providerRoute, turn, text, model)
}

/**
 * 追加空响应说明（ACP_EMPTY_RESPONSE；turn 正常完成但全程零可见输出时
 * 调用，文案见 {@link ACP_EMPTY_RESPONSE_NOTE}）。说明消息失败仅 warn 不炸
 * turn 的纪律在调用方（./agent.ts turn 收尾路径）。
 * @param session - 已 prepare 的会话。
 * @param providerRoute - 当前路由（`acp-<id>`）。
 * @param turn - 刚收束的空响应 turn 号。
 * @param model - 调用点已知的当前 ACP 模型（translator route）；缺省/空串时走兜底链。
 */
export function appendEmptyResponseNote(session: Session, providerRoute: string, turn: number, model?: string): void {
  appendAssistantNote(session, providerRoute, turn, ACP_EMPTY_RESPONSE_NOTE, model)
}
