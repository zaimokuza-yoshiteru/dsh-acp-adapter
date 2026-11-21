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
 * 结构化窄化先例：src/domain/policy/sandbox.ts 的权限策略类型、
 * 本模块同目录 installed-profile-registry.ts 对 dsh-settings 的 `ctx.get('settings')` 窄化。
 * @module @zaimokuza/dsh-acp-adapter/host/composition/subprocess
 */

import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE, narrowSubprocessSeam } from '../../runtime/process/subprocess.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'

/**
 * 解析一次 `ctx.subprocess`。宿主 composition 必须加载 subprocess-local provider
 * （dsh-base 默认装配）；缺席/形态不符 → `{ok:false}` + 统一诊断文案。
 */
export function resolveSubprocessSeam(ctx: Context): SubprocessSeamResolution {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  if (typeof holder.get !== 'function') return { ok: false, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE }
  const provider = holder.get('subprocess')
  const seam = narrowSubprocessSeam(provider)
  if (seam === undefined) return { ok: false, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE }
  if (isHostLocal(ctx, provider)) return { ok: true, seam: { ...seam, localExecution: true } }
  return { ok: true, seam }
}

/** Resolve the actual provider, including Loader-mounted source scaffolds with their own module identity. */
function isHostLocal(ctx: Context, provider: unknown): boolean {
  if (!provider || typeof provider !== 'object') return false
  const ctor: unknown = Object.getPrototypeOf(provider)?.constructor
  if (typeof ctor !== 'function' || ctor.name !== 'LocalSubprocessRuntime') return false
  const isolate = ctx[Context.isolate]?.subprocess
  const entry = isolate && ctx.reflect?.store[isolate]?.ctx.fiber.entry
  if (entry?.options.name === '@deepseek-ai/dsh-subprocess-local') {
    // Loader owns the actual namespace, including a source scaffold or an HMR replacement.
    // Child providers inherit an entry; spelling the same constructor name does not confer its identity.
    const loaded = entry.moduleNamespace
    return (
      loaded === ctor ||
      (typeof loaded === 'object' &&
        loaded !== null &&
        'LocalSubprocessRuntime' in loaded &&
        loaded.LocalSubprocessRuntime === ctor)
    )
  }
  try {
    // Directly mounted embedders have no Loader entry. Compare the official constructor;
    // the optional peer is absent on installations that provide only a remote execution world.
    const local = createRequire(import.meta.url)('@deepseek-ai/dsh-subprocess-local') as {
      LocalSubprocessRuntime: unknown
    }
    return ctor === local.LocalSubprocessRuntime
  } catch {
    return false
  }
}
