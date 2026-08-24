/**
 * `ctx.subprocess` seam 的宿主解析：插件加载期从 ctx 解析一次
 * （`ctx.get('subprocess')` + 结构化窄化），产物（{@link SubprocessSeamResolution}）
 * 沿既有依赖方向注入各消费点——registry（probe）/ AcpAgent 懒启动（会话 spawn）
 * / dshAcp Remote service（version 探针）。
 *
 * fail closed：服务缺席或窄化失败时解析为 `{ok:false}`，消费点在各自操作边界
 * 把 `message` 包装成 `AcpClientError('spawn-failure', …)`（ACP 路由响亮失败，
 * native 路由不经过本解析、不受影响）。绝不回退自制 child_process。
 *
 * 结构化窄化先例：src/domain/policy/sandbox.ts 的 `AcpSandboxProviderLike`、
 * 本模块同目录 registry.ts 对 dsh-settings 的 `ctx.get('settings')` 窄化。
 * @module @zaimokuza/dsh-acp-adapter/host/composition/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ACP_SUBPROCESS_UNAVAILABLE_MESSAGE,
  narrowSubprocessSeam,
} from '../../runtime/process/subprocess.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'

/**
 * 解析一次 `ctx.subprocess`。宿主 composition 必须加载 subprocess-local provider
 * （dsh-base 默认装配）；缺席/形态不符 → `{ok:false}` + 统一诊断文案。
 */
export function resolveSubprocessSeam(ctx: Context): SubprocessSeamResolution {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  const seam = narrowSubprocessSeam(holder.get('subprocess'))
  if (seam === undefined) return { ok: false, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE }
  return { ok: true, seam }
}
