// permission-bridge-child.mjs — 跨进程验收的子进程夹具。
//
// 每个进程用真实 sidecar + 真实审批桥完成一次完整审批（asked → approval → decided），
// 模拟两次独立 DSH 进程先后写同一 sidecar 文件。旧模块级计数器 requestId 会让第二个
// 进程的 decided 因 recordId 撞名被去重跳过（新 asked 保留、decided 丢失）；
// 的 randomUUID requestId 使两进程各落完整一组。
//
// 用法：node permission-bridge-child.mjs <sidecarRoot> <dshSessionId> <toolCallId>
// 依赖 Node 24 原生 type stripping 直跑 src/*.ts（本夹具的 import 图不含 TC39
// 装饰器文件——@Remote 只在 src/remote/service.ts，不在此链上）。

import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../src/persistence/sidecar.ts'
import { createAcpPermissionHandler } from '../../src/domain/policy/permissions.ts'

const [root, dshSessionId, toolCallId] = process.argv.slice(2)
if (root === undefined || dshSessionId === undefined || toolCallId === undefined) {
  console.error('usage: node permission-bridge-child.mjs <sidecarRoot> <dshSessionId> <toolCallId>')
  process.exit(2)
}

const sidecar = createAcpSidecar({ root })
const handler = createAcpPermissionHandler({
  agent: {},
  approval: { request: async () => 'allowed-once' },
  audit: { append: (record) => sidecar.append(SessionId(dshSessionId), record) },
  hasOpenTurn: () => true,
})

const response = await handler({
  sessionId: 'acp-session-xproc',
  toolCall: { toolCallId, title: `Run: ${toolCallId}`, kind: 'execute', rawInput: { command: toolCallId } },
  options: [
    { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
  ],
})
process.stdout.write(`${JSON.stringify(response)}\n`)
