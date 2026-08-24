// permissions-xproc.spec.ts — 验收：权限审计 ID 跨进程唯一。
//
// 两个独立 Node 进程先后（连续、非并发）驱动真实审批桥 + 真实 sidecar 各完成一次
// 完整审批，断言两次审批都有且只有一组 asked/decided。回归场景：旧模块级计数器
// requestId（dsh-acp-permission-1, -2…）在第二个进程里重新从 1 计数，decided 的
// recordId 撞名被去重跳过——留下新 asked 而丢失对应 decided。的
// randomUUID requestId + 复合去重键（ACP session/tool call/request occurrence，
// DSH session 即行键）根除该碰撞。sidecar 是 SQLite 单库：断言改经
// AcpSidecar 公开读取面（list），不再逐行 parse JSONL。
//
// 子进程夹具 test/fixtures/permission-bridge-child.mjs 依赖 Node 24 原生 type
// stripping（toolchain 门禁钉死 Node 24.19.0），直跑 src/*.ts 生产代码，不经过
// 构建产物。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

const FIXTURE = fileURLToPath(new URL('../../fixtures/permission-bridge-child.mjs', import.meta.url))

/** 跑一次子进程审批（非零退出带 stderr 拒绝对测试可见的失败语义）。 */
async function runChild(root: string, dshSessionId: string, toolCallId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, root, dshSessionId, toolCallId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`permission bridge child exited ${String(code)}: ${stderr}`))
    })
  })
}

describe('权限审计 ID 跨进程唯一', () => {
  it('两个独立 Node 进程连续写同一 sidecar，两次审批都有且只有一组 asked/decided', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-permission-xproc-'))
    try {
      await runChild(root, 'sess-xproc', 'tc-alpha')
      await runChild(root, 'sess-xproc', 'tc-beta')

      // sidecar 已是 SQLite 单库——经公开读取面（而非逐行 parse JSONL）断言
      const sidecar = createAcpSidecar({ root })
      const entries = await sidecar.list(SessionId('sess-xproc'))
      const permissions = entries.filter((entry) => entry.kind === 'permission')
      const asked = permissions.filter((entry) => entry.data.phase === 'asked')
      const decided = permissions.filter((entry) => entry.data.phase === 'decided')
      expect(asked).toHaveLength(2)
      expect(decided).toHaveLength(2)

      // 两个进程的 requestId 全局唯一（旧计数器实现下两者同为 dsh-acp-permission-1）
      const requestIds = [...new Set(asked.map((entry) => entry.data.phase === 'asked' ? entry.data.requestId : ''))]
      expect(requestIds).toHaveLength(2)
      for (const requestId of requestIds) {
        expect(requestId).toMatch(/^dsh-acp-permission-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        // 每个 asked 恰有一条 decided 配对（跨进程去重不再误吞新决定）
        const pair = decided.filter((entry) => entry.data.phase === 'decided' && entry.data.requestId === requestId)
        expect(pair).toHaveLength(1)
        expect(pair[0]?.data.phase === 'decided' && pair[0].data.outcome).toBe('selected')
      }

      // decided 的 recordId = 复合去重键（ACP session + tool call + request occurrence）
      for (const entry of decided) {
        if (entry.data.phase !== 'decided') continue
        expect(entry.recordId).toBe(
          `decided:${entry.data.agentSessionId ?? ''}:${entry.data.toolCallId ?? ''}:${entry.data.requestId}`,
        )
        expect(entry.acpSessionId).toBe('acp-session-xproc')
      }
      await sidecar.dispose()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
