/**
 * host-compat 隔离项：FiberState 数值镜像。
 *
 * 上游钉版：dsh-v0.1.2-alpha.1（commit cd5ef8148158；vendored cordis 4.0.1），
 * 源文件 reference/deepseek-harness/vendor/cordis/src/fiber.ts:147-154：
 * `export const enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }`
 * —— const enum 编译期擦除，产物无运行时可导入对象。
 *
 * 复制原因：agent-loop 的 `FactoryOwnership.isActive`（上游 packages/core/
 * agent-loop/src/index.ts:33-37 的 INACTIVE_STATES = {UNLOADING, DISPOSED, FAILED}）
 * 与 installed-profile-registry.ts 的 isUnloading 只需 FAILED=3 / DISPOSED=4 / UNLOADING=5 三值；
 * dsh-settings 的 installSettingsSection 有同款数值镜像先例。
 *
 * 漂移检测：test/host-compat.spec.ts 对照 node_modules 已构建 lib 的
 * `INACTIVE_STATES = new Set([5, 4, 3])` 钉死这三值。
 *
 * @module @zaimokuza/dsh-acp-adapter/host-compat/fiber-state
 */

/** FiberState.FAILED（插件回调或其 config 抛错）。 */
export const FIBER_FAILED = 3
/** FiberState.DISPOSED（fiber 已移除，不可重启）。 */
export const FIBER_DISPOSED = 4
/** FiberState.UNLOADING（disposer 正在运行）。 */
export const FIBER_UNLOADING = 5
