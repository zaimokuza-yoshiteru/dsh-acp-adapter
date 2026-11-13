/**
 * ACP errors carry stable codes and categories for recovery decisions, plus an
 * opaque correlation ID for matching logs and RemoteError details. Display
 * copy belongs to the Host/client presentation layers.
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/errors
 */

/// <reference types="node" />

import { randomBytes } from 'node:crypto'
import type { AcpProcessExit } from '../../runtime/process/types.ts'
import type { AcpClientErrorDetails, AcpErrorCategory, AcpErrorKind, AcpProbePhase } from './types.ts'

/** Stable codes shared by turn failures, provider diagnostics and Remote errors. */
export const ACP_ERROR_CODES: Record<AcpErrorKind, string> = {
  'spawn-failure': 'ACP_SPAWN_FAILURE',
  auth_required: 'ACP_AUTH_REQUIRED',
  'resource-exhausted': 'ACP_RESOURCE_EXHAUSTED',
  timeout: 'ACP_TIMEOUT',
  'protocol-error': 'ACP_PROTOCOL_ERROR',
  crash: 'ACP_CRASH',
  aborted: 'ACP_ABORTED',
}

/** kind → taxonomy 分类的默认映射（构造点可经 `AcpClientErrorDetails.category` 覆盖）。 */
export const ACP_ERROR_KIND_CATEGORY: Record<AcpErrorKind, AcpErrorCategory> = {
  'spawn-failure': 'not-installed',
  auth_required: 'auth-required',
  'resource-exhausted': 'resource-exhausted',
  timeout: 'timeout',
  'protocol-error': 'protocol-incompatible',
  crash: 'agent-crash',
  aborted: 'user-rejected',
}

/** Timestamp plus 128 random bits; no shared mutable counter or session state. */
export function newAcpCorrelationId(now: Date = new Date(), random: Buffer = randomBytes(16)): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  return `acperr-${stamp}-${random.toString('hex')}`
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
