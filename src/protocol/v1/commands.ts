/**
 * Slash 命令桥。
 *
 * ACP `available_commands_update` → 名称合法性过滤（dsh 命令名正则
 * `^[a-z][a-z0-9_-]*$`，与 dsh-commands `normalizeDefinition` 同款）→
 * agent 作用域 `ctx.commands.register`（描述透传）；handler 把 `/name args`
 * 原文作为 prompt 发给 ACP agent。渲染走通用命令卡片 fallback：执行经
 * dsh-commands `CommandRuntime.execute` 落 `command/run|done` 事件，命令的
 * 实际产出是被唤醒 turn 里的 assistant 消息。与原生 `/` 菜单共存：同名全局
 * 命令被 agent 作用域注册 shadow——这是 `CommandRuntime` 的 scoped-layer
 * 语义，桥自身无需特判。
 *
 * 本模块只实现纯适配逻辑，不直接依赖 dsh-commands；`ctx.commands` 收窄为
 * {@link AcpCommandRegistry}。src/domain/session/agent.ts 负责把
 * `AcpAgent.availableCommands` 接到 `applyAvailableCommands`，并把命令输入交给
 * `agent.followup`。
 * @module @zaimokuza/dsh-acp-adapter/protocol/v1/commands
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk'

/** dsh 命令名正则（dsh-commands `normalizeDefinition` 同款）；越字符集的 ACP 命令名过滤并记日志。 */
export const ACP_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/**
 * 注入命令桥的最小命令服务面：agent 作用域 `ctx.commands`（dsh-commands
 * `CommandRuntime.register`）的结构子集。
 */
export interface AcpCommandRegistry {
  /**
   * 注册一条命令定义。
   * @param definition - 名称/描述/handler。
   * @returns 撤销该注册的 disposer（真实服务是 cordis effect disposer）。
   */
  register(definition: AcpCommandDefinition): () => void
}

/** 桥注册的命令定义：dsh-commands `CommandDefinition` 的结构子集。 */
export interface AcpCommandDefinition {
  /** 不含斜杠的小写命令名（已按 {@link ACP_COMMAND_NAME} 过滤）。 */
  readonly name: string
  /** 发现 UI 用的描述；透传 agent 给的 description。 */
  readonly description: string
  /** 执行入口：把 `/name args` 原文作为 prompt 发给 ACP agent。 */
  readonly handler: (invocation: AcpCommandInvocation) => Promise<AcpCommandResult>
}

/** dsh-commands `CommandInvocation` 的结构子集：桥只用 rawInput。 */
export interface AcpCommandInvocation {
  /** 跟在命令名后的原文（含前导分隔空白；无参数时为 `''`）。 */
  readonly rawInput: string
}

/** dsh-commands `CommandResult` 成功分支的结构子集。 */
export interface AcpCommandResult {
  readonly kind: 'success'
}

/** 桥的诊断出口（真实接线传 `ctx.logger`）。 */
export interface AcpCommandBridgeLogger {
  warn(message: string): void
}

/** {@link createAcpCommandBridge} 的注入依赖。 */
export interface AcpCommandBridgeDeps {
  /** agent 作用域命令服务（真实接线：agent 命令注入后的 `ctx.commands`）。 */
  readonly commands: AcpCommandRegistry
  /**
   * 把文本作为 prompt 发给 ACP agent（真实接线包装 `agent.followup`：文本包成
   * 文本 UserMessage；`user/message` 落盘与 turn 驱动都在那一侧）。
   */
  readonly sendPrompt: (text: string) => void | Promise<void>
  /** 诊断出口。 */
  readonly logger: AcpCommandBridgeLogger
}

/** Slash 命令桥；每 ACP agent 会话一个实例，注册集是实例私有状态。 */
export interface AcpCommandBridge {
  /**
   * 全量应用一份可用命令清单（`available_commands_update` 的语义即全量替换）。
   * diff 当前注册集：新命令 register、消失的 unregister、描述变更的先撤销再
   * 重注册；名称不符 {@link ACP_COMMAND_NAME} 的条目过滤并记 warn。幂等：
   * 重复 apply 同内容清单（顺序无关）零副作用；空清单 = 全部注销。
   */
  applyAvailableCommands(list: readonly AvailableCommand[]): void
}

/** 创建 slash 命令桥。 */
export function createAcpCommandBridge(deps: AcpCommandBridgeDeps): AcpCommandBridge {
  /** 当前注册集：name → {描述, 注销 disposer}。 */
  const registered = new Map<string, { description: string; unregister: () => void }>()

  const buildDefinition = (name: string, description: string): AcpCommandDefinition => ({
    name,
    description,
    handler: async (invocation) => {
      // 原文重放：dsh-commands `parseCommand` 的 rawInput 含前导分隔空白，
      // 拼回的串与用户提交的整行逐字一致。
      await deps.sendPrompt(`/${name}${invocation.rawInput}`)
      return { kind: 'success' }
    },
  })

  return {
    applyAvailableCommands(list) {
      // 过滤非法名 + 同名去重（同名出现多次时 last wins）
      const next = new Map<string, string>()
      for (const command of list) {
        if (!ACP_COMMAND_NAME.test(command.name)) {
          deps.logger.warn(
            `dsh-acp: ignored ACP command with invalid name ${JSON.stringify(command.name)} ` +
            `(must match ${String(ACP_COMMAND_NAME)})`,
          )
          continue
        }
        next.set(command.name, command.description)
      }
      // 消失的注销
      for (const [name, entry] of registered) {
        if (next.has(name)) continue
        entry.unregister()
        registered.delete(name)
      }
      // 新增的注册；描述变更的先撤销再重注册（顺序保证不撞 NamedEntries 重名错）
      for (const [name, description] of next) {
        const current = registered.get(name)
        if (current?.description === description) continue
        current?.unregister()
        registered.set(name, { description, unregister: deps.commands.register(buildDefinition(name, description)) })
      }
    },
  }
}
