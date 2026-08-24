// commands.spec.ts — .8t：slash 命令桥（src/protocol/v1/commands.ts）黑盒契约测试。
//
// 契约来源（不读实现、只按规格断言）：
//   - ACP available_commands_update 语义：名称合法性过滤 → agent 作用域
//     ctx.commands.register；handler 把 /name args 文本作为 prompt 发给 ACP agent
//   - dsh 命令 API（reference/deepseek-harness/packages/interaction/commands/src/index.ts）：
//     register 返回注销 disposer；名称正则 ^[a-z][a-z0-9_-]*$；
//     invocation.rawInput = 命令名后的原文（含前导分隔空白）
//   - ACP AvailableCommand 类型（@agentclientprotocol/sdk）
//
// 假 commands 服务记录 register/unregister 调用并维护有效注册集；
// 假发送回调记录收到的 prompt 文本。
//
// shadow 语义说明：同名全局命令被 agent 作用域注册遮蔽，是 dsh-commands
// CommandRuntime 的 scoped-layer 行为（其自身测试覆盖），桥不做任何特判，
// 这里仅注释不断言——「同名内建命令照常注册」用例只验证桥的行为无分支。

import { describe, expect, it } from 'vitest'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  createAcpCommandBridge,
  type AcpCommandBridge,
  type AcpCommandDefinition,
  type AcpCommandRegistry,
} from '../../../src/protocol/v1/commands.ts'

// ---------- 记录型假件 ----------

class FakeCommandRegistry implements AcpCommandRegistry {
  /** 当前有效注册集（disposer 调用后移除）。 */
  readonly effective = new Map<string, AcpCommandDefinition>()
  /** 历次 register 的定义（含已被注销的），按调用顺序。 */
  readonly registered: AcpCommandDefinition[] = []
  /** 历次 unregister 的命令名，按调用顺序。 */
  readonly unregistered: string[] = []

  register(definition: AcpCommandDefinition): () => void {
    this.registered.push(definition)
    this.effective.set(definition.name, definition)
    return () => {
      this.unregistered.push(definition.name)
      if (this.effective.get(definition.name) === definition) {
        this.effective.delete(definition.name)
      }
    }
  }
}

class FakeLogger {
  readonly warnings: string[] = []

  warn(message: string): void {
    this.warnings.push(message)
  }
}

interface Harness {
  bridge: AcpCommandBridge
  registry: FakeCommandRegistry
  logger: FakeLogger
  /** 假发送回调收到的 prompt 文本，按发送顺序。 */
  sent: string[]
}

function setup(): Harness {
  const registry = new FakeCommandRegistry()
  const logger = new FakeLogger()
  const sent: string[] = []
  const bridge = createAcpCommandBridge({
    commands: registry,
    sendPrompt: (text) => {
      sent.push(text)
    },
    logger,
  })
  return { bridge, registry, logger, sent }
}

function cmd(name: string, description: string): AvailableCommand {
  return { name, description }
}

/** 取出有效注册集里的定义，缺失时直接失败。 */
function requireDefinition(registry: FakeCommandRegistry, name: string): AcpCommandDefinition {
  const definition = registry.effective.get(name)
  if (definition === undefined) throw new Error(`expected command "${name}" to be registered`)
  return definition
}

// ---------- 契约用例 ----------

describe('createAcpCommandBridge', () => {
  it('首次 apply 注册全部命令，描述透传', () => {
    const { bridge, registry, logger } = setup()
    bridge.applyAvailableCommands([
      cmd('review', 'Review the current diff'),
      cmd('explain', 'Explain the selected code'),
    ])

    expect([...registry.effective.keys()]).toEqual(['review', 'explain'])
    expect(registry.registered).toHaveLength(2)
    expect(registry.unregistered).toEqual([])
    expect(requireDefinition(registry, 'review').description).toBe('Review the current diff')
    expect(requireDefinition(registry, 'explain').description).toBe('Explain the selected code')
    expect(logger.warnings).toEqual([])
  })

  it('增量 diff：只注册新出现的命令', () => {
    const { bridge, registry } = setup()
    bridge.applyAvailableCommands([cmd('review', 'd1'), cmd('explain', 'd2')])
    bridge.applyAvailableCommands([cmd('review', 'd1'), cmd('explain', 'd2'), cmd('fix', 'd3')])

    expect(registry.registered.map(d => d.name)).toEqual(['review', 'explain', 'fix'])
    expect(registry.unregistered).toEqual([])
    expect([...registry.effective.keys()].sort()).toEqual(['explain', 'fix', 'review'])
  })

  it('消失的命令被注销；空清单注销全部', () => {
    const { bridge, registry } = setup()
    bridge.applyAvailableCommands([cmd('review', 'd1'), cmd('explain', 'd2')])
    bridge.applyAvailableCommands([cmd('review', 'd1')])

    expect(registry.unregistered).toEqual(['explain'])
    expect([...registry.effective.keys()]).toEqual(['review'])

    bridge.applyAvailableCommands([])
    expect(registry.unregistered).toEqual(['explain', 'review'])
    expect(registry.effective.size).toBe(0)
  })

  it('描述变更触发先撤销再重注册', () => {
    const { bridge, registry } = setup()
    bridge.applyAvailableCommands([cmd('review', 'old description')])
    bridge.applyAvailableCommands([cmd('review', 'new description')])

    expect(registry.registered).toHaveLength(2)
    expect(registry.unregistered).toEqual(['review'])
    expect(requireDefinition(registry, 'review').description).toBe('new description')
  })

  it('非法名称过滤并记 warn，合法命令不受影响', () => {
    const { bridge, registry, logger } = setup()
    bridge.applyAvailableCommands([
      cmd('Review', 'uppercase'),
      cmd('1bad', 'leading digit'),
      cmd('bad name', 'contains space'),
      cmd('', 'empty'),
      cmd('ok_name-2', 'valid'),
    ])

    expect([...registry.effective.keys()]).toEqual(['ok_name-2'])
    expect(logger.warnings).toHaveLength(4)
    for (const bad of ['Review', '1bad', 'bad name', '""']) {
      expect(logger.warnings.some(w => w.includes(bad.replaceAll('"', '')))).toBe(true)
    }
  })

  it('重复 apply 同内容清单零副作用（顺序无关）', () => {
    const { bridge, registry, logger } = setup()
    const list = [cmd('review', 'd1'), cmd('explain', 'd2')]
    bridge.applyAvailableCommands(list)
    bridge.applyAvailableCommands(list)
    // 深拷贝 + 乱序的同内容清单
    bridge.applyAvailableCommands([cmd('explain', 'd2'), cmd('review', 'd1')])

    expect(registry.registered).toHaveLength(2)
    expect(registry.unregistered).toEqual([])
    expect(logger.warnings).toEqual([])
  })

  it('handler 把 /name args 原文作为 prompt 发送', async () => {
    const { bridge, registry, sent } = setup()
    bridge.applyAvailableCommands([cmd('review', 'Review the current diff')])
    const { handler } = requireDefinition(registry, 'review')

    // rawInput 含前导分隔空白（dsh-commands parseCommand 的切分契约）
    const withArgs = await handler({ rawInput: ' src/ --quick' })
    expect(withArgs).toEqual({ kind: 'success' })
    const noArgs = await handler({ rawInput: '' })
    expect(noArgs).toEqual({ kind: 'success' })

    expect(sent).toEqual(['/review src/ --quick', '/review'])
  })

  it('同名内建命令照常走 agent 作用域注册（shadow 语义见文件头注释）', () => {
    const { bridge, registry } = setup()
    bridge.applyAvailableCommands([cmd('model', 'Switch model (agent-defined)')])

    expect(registry.registered.map(d => d.name)).toEqual(['model'])
    expect(requireDefinition(registry, 'model').description).toBe('Switch model (agent-defined)')
  })
})
