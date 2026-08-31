/**
 * 结构化 ACP 连接错误（自 acp-client.ts 切出； 扩为统一错误 taxonomy
 * 的落点）。`kind`（./types.ts `AcpErrorKind`）供上层
 * （src/host/composition/llm-stub.ts 失败文案、src/remote/service.ts 方法、
 * turn 错误）分流；`message` 面向用户可读。
 *
 * 统一 taxonomy（错误分类；八分类词表见 ./types.ts
 * `AcpErrorCategory` 的逐类注释）：
 * - 每个用户可见错误携带三件套：**稳定 code**（`ACP_*`，kind → code 映射见
 *   {@link ACP_ERROR_CODES}，turn/end 与 llm-stub 沿用同一张表）、**taxonomy
 *   分类**（{@link AcpClientError.category}，默认按 kind 映射，构造点可覆盖）、
 *   **correlation id**（{@link AcpClientError.correlationId}）。
 * - correlation id 生成规则（{@link newAcpCorrelationId}，确定性规则 + 可检索）：
 *   `acperr-<UTC 紧凑时间戳>-<会话内单调序号 base36>-<随机 3 字节 hex>`，如
 *   `acperr-20260820T184752Z-c-9f3a2b`。时间戳给出与日志/sidecar 时间列的粗对账，
 *   序号+随机保证同毫秒唯一；全文 grep `acperr-` 或具体 id 即可检索。id 只挂在
 *   error 对象与日志/落盘文案后缀上（`[acperr-…]`），**不进** remote service 的
 *   抛出 message（throw → gateway 折叠成 RemoteResult 错误分支的纪律被
 *   test/integration/host/health.spec.ts 钉死）。
 * - 中文文案的呈现层分工（测试钉死的协议层英文诊断 message 不动）：选择器/面板
 *   中文文案在 src/host/composition/llm-stub.ts 与 src/client/ui/locales.ts，
 *   恢复/中断说明在 provider runtime。
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/errors
 */

/// <reference types="node" />

import { randomBytes } from 'node:crypto'
import type { AcpProcessExit } from '../../runtime/process/types.ts'
import type { AcpClientErrorDetails, AcpErrorCategory, AcpErrorKind, AcpProbePhase } from './types.ts'

/**
 * `AcpClientError.kind` → 稳定 code（前在 src/domain/session/agent.ts 私有，
 * 上移到本模块成为全包唯一真源；词表逐字节不变）。
 */
export const ACP_ERROR_CODES: Record<AcpErrorKind, string> = {
  'spawn-failure': 'ACP_SPAWN_FAILURE',
  auth_required: 'ACP_AUTH_REQUIRED',
  timeout: 'ACP_TIMEOUT',
  'protocol-error': 'ACP_PROTOCOL_ERROR',
  crash: 'ACP_CRASH',
  aborted: 'ACP_ABORTED',
}

/** kind → taxonomy 分类的默认映射（构造点可经 `AcpClientErrorDetails.category` 覆盖）。 */
export const ACP_ERROR_KIND_CATEGORY: Record<AcpErrorKind, AcpErrorCategory> = {
  'spawn-failure': 'not-installed',
  auth_required: 'auth-required',
  timeout: 'timeout',
  'protocol-error': 'protocol-incompatible',
  crash: 'agent-crash',
  aborted: 'user-rejected',
}

/** 进程内单调序号（同毫秒防撞；base36 编码进 id 第三段）。 */
let correlationSeq = 0

/**
 * 生成一个 correlation id（规则见模块头注释）。`now`/`random` 可注入以便测试
 * 确定性；生产缺省 `new Date()` + `crypto.randomBytes(3)`。
 */
export function newAcpCorrelationId(now: Date = new Date(), random: Buffer = randomBytes(3)): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  correlationSeq = (correlationSeq + 1) % 1296
  const seq = correlationSeq.toString(36)
  return `acperr-${stamp}-${seq}-${random.toString('hex')}`
}

export class AcpClientError extends Error {
  readonly kind: AcpErrorKind
  /** 稳定 code（`ACP_*`；kind → code 的唯一映射表 {@link ACP_ERROR_CODES}）。 */
  readonly code: string
 /** taxonomy 分类（默认按 kind 映射；构造点可经 details.category 覆盖）。 */
  readonly category: AcpErrorCategory
  /** correlation id（构造期生成或 details.correlationId 覆盖；规则见模块头注释）。 */
  readonly correlationId: string
  readonly exit: AcpProcessExit | undefined
  readonly stderrTail: readonly string[] | undefined
  /** probe 失败阶段（仅 probe 路径标记；./types.ts `AcpProbePhase`）。 */
  readonly probePhase: AcpProbePhase | undefined

  constructor(kind: AcpErrorKind, message: string, details: AcpClientErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined)
    this.name = 'AcpClientError'
    this.kind = kind
    this.code = ACP_ERROR_CODES[kind]
    this.category = details.category ?? ACP_ERROR_KIND_CATEGORY[kind]
    this.correlationId = details.correlationId ?? newAcpCorrelationId()
    this.exit = details.exit
    this.stderrTail = details.stderrTail
    this.probePhase = details.probePhase
  }
}
