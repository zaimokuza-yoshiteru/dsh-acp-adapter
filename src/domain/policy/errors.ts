/**
 * 策略域错误叶子模块（自 sandbox.ts 切出）：spawn 计划组装与凭证镜像
 * 物化共享的配置类错误类型。独立成叶是为了让 platform/ 下的 adapter 与
 * staging 机制可以抛同一类型而不与 sandbox.ts 成环；sandbox.ts 原样
 * re-export，既有 import 路径（test/与 host 侧消费点）不变。
 *
 * 本包 tsconfig 用 `types: []`；本文件不触碰 node 全局（correlation id 生成
 * 在 src/protocol/v1/errors.ts），无需 triple-slash reference。
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/errors
 */

import { newAcpCorrelationId } from '../../protocol/v1/errors.ts'
import type { AcpErrorCategory } from '../../protocol/v1/types.ts'

/** spawn 计划组装的配置类错误码（credential reference、根目录、凭证镜像声明等；沙箱不可用走 AcpClientError）。 */
export type AcpSpawnPlanErrorCode = 'ACP_SPAWN_CONFIG'

/** spawn 计划组装/凭证镜像物化的配置类失败：响亮的配置错误（dsh 惯例：引用缺失/目录不存在绝不静默跳过）。 */
export class AcpSpawnPlanError extends Error {
  readonly code: AcpSpawnPlanErrorCode
 /** taxonomy 分类：恒为 `config`（配置/部署类失败）。 */
  readonly category: AcpErrorCategory = 'config'
 /** correlation id（生成规则见 src/protocol/v1/errors.ts 模块头注释）。 */
  readonly correlationId: string

  constructor(code: AcpSpawnPlanErrorCode, message: string, correlationId: string = newAcpCorrelationId()) {
    super(message)
    this.name = 'AcpSpawnPlanError'
    this.code = code
    this.correlationId = correlationId
  }
}
