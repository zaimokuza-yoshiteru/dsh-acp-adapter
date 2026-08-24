// sidecar-crash-child.mjs — 崩溃恢复验收的子进程夹具。
//
// 用真实 sidecar（node:sqlite WAL）先写 5 条 permission asked（同步 durable 路径，
// 逐条 commit），stdout 报 `batch1-committed` 后进入无限写循环，由父进程 kill -9
// 夹死——模拟「写一半」崩溃。WAL 保证：已 commit 的记录在重开库后仍在，未 commit
// 的半点痕迹不留（事务原子性），库可读可继续写。
//
// 用法：node sidecar-crash-child.mjs <sidecarRoot> <dshSessionId>
// 依赖 Node 24 原生 type stripping 直跑 src/*.ts（同 permission-bridge-child.mjs）。

import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../src/persistence/sidecar.ts'
import { createPermissionAskedAudit } from '../../src/domain/policy/events.ts'

const [root, dshSessionId] = process.argv.slice(2)
if (root === undefined || dshSessionId === undefined) {
  console.error('usage: node sidecar-crash-child.mjs <sidecarRoot> <dshSessionId>')
  process.exit(2)
}

const sidecar = createAcpSidecar({ root })

function asked(index) {
  return createPermissionAskedAudit({
    requestId: `req-${index}`,
    agentSessionId: 'agent-crash',
    toolCall: { toolCallId: `tc-${index}`, title: `Run: ${index}`, kind: 'execute' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
  })
}

// 第一批：5 条逐条 commit（durable），随后报告父进程可以动手杀
for (let index = 0; index < 5; index += 1) {
  await sidecar.append(SessionId(dshSessionId), { kind: 'permission', time: index + 1, data: asked(index) })
}
process.stdout.write('batch1-committed\n')

// 之后无限写（每条独立 commit），直到被 SIGKILL——崩溃点落在某两条 commit 之间
for (let index = 5; ; index += 1) {
  await sidecar.append(SessionId(dshSessionId), { kind: 'permission', time: index + 1, data: asked(index) })
  if (index % 200 === 0) process.stdout.write(`progress:${index}\n`)
}
