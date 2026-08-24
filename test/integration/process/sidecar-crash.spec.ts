// sidecar-crash.spec.ts — 崩溃恢复验收：进程级 kill -9 夹死「写一半」的
// sidecar 子进程（夹具 test/fixtures/sidecar-crash-child.mjs，同
// permission-bridge-child.mjs 的模式），重开库断言：
// - 已 commit 的记录（崩溃前第一批 5 条 permission）全部仍在；
// - 库完整性无损（quick_check ok）、无半行/撕裂态（WAL 事务原子性）；
// - 读路径正常（list/readLatestBinding/listBindings/exportAudit）；
// - 恢复后同一库可继续 append，seq 接续不冲突。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAcpSidecar, ACP_SIDECAR_DB_FILENAME } from '../../../src/persistence/sidecar.ts'
import { createPermissionAskedAudit } from '../../../src/domain/policy/events.ts'

const FIXTURE = fileURLToPath(new URL('../../fixtures/sidecar-crash-child.mjs', import.meta.url))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('崩溃恢复（kill -9 + WAL）', () => {
  it('子进程写一半被 SIGKILL：已 commit 记录仍在、库完整、读路径正常、恢复后续写', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-sidecar-crash-'))
    try {
      const child = spawn(process.execPath, [FIXTURE, root, 'sess-crash'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      // 等第一批 5 条 commit 落齐，再放行一小段「写一半」窗口后 SIGKILL
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`crash child did not commit batch1 in time; stderr: ${stderr}`)), 20_000)
        child.stdout.on('data', () => {
          if (stdout.includes('batch1-committed')) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.on('error', reject)
        child.on('exit', (code) => reject(new Error(`crash child exited early (${String(code)}); stderr: ${stderr}`)))
      })
      await sleep(150) // 让崩溃点落在无限写循环中段（第二条批次写了一半）
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve())
      })

      // 重开库：崩溃恢复路径
      const store = createAcpSidecar({ root })
      const health = await store.health()
      expect(health.exists).toBe(true)
      expect(health.integrity).toBe('ok') // quick_check：无半行/撕裂态

      const entries = await store.list(SessionId('sess-crash'))
      const permissions = entries.filter((entry) => entry.kind === 'permission')
      // 已 commit 的第一批 5 条全部仍在（崩溃点在第二批中段，第二批落了多少不计，只断首批不丢）
      expect(permissions.length).toBeGreaterThanOrEqual(5)
      const requestIds = permissions.map((entry) => entry.data.phase === 'asked' ? entry.data.requestId : undefined)
      for (let index = 0; index < 5; index += 1) {
        expect(requestIds).toContain(`req-${String(index)}`)
      }
      // seq 严格单调无重复（WAL 恢复不制造半条记录）
      const seqs = permissions.map((entry) => entry.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
      // 读路径全家桶正常
      expect(await store.readLatestBinding(SessionId('sess-crash'))).toBeUndefined()
      expect(await store.listBindings()).toEqual([])
      expect((await store.exportAudit({ sessionId: SessionId('sess-crash') })).split('\n').filter((line) => line.length > 0).length).toBe(permissions.length)

      // 恢复后续写：seq 从库里 MAX+1 接续，不与崩溃前记录冲突
      await store.append(SessionId('sess-crash'), {
        kind: 'permission',
        time: 999_999,
        data: createPermissionAskedAudit({
          requestId: 'req-post-crash',
          agentSessionId: 'agent-crash',
          toolCall: { toolCallId: 'tc-post', title: 'Run: post', kind: 'execute' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        }),
      })
      const after = await store.list(SessionId('sess-crash'))
      expect(after).toHaveLength(permissions.length + 1)
      expect(after.at(-1)?.data).toMatchObject({ requestId: 'req-post-crash' })
      expect(after.at(-1)?.seq).toBe(Math.max(...seqs) + 1)
      await store.dispose()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('WAL 文件在崩溃后不阻碍重开（wal/shm 旁生被正常恢复接管）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-sidecar-crash-wal-'))
    try {
      const store = createAcpSidecar({ root })
      await store.append(SessionId('sess-1'), {
        kind: 'permission',
        time: 1,
        data: createPermissionAskedAudit({
          requestId: 'req-wal',
          agentSessionId: 'agent-crash',
          toolCall: { toolCallId: 'tc-wal', title: 'Run: wal', kind: 'execute' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        }),
      })
      // 不 dispose（模拟进程消失：连接不关闭，wal/shm 留在盘上）
      expect(fs.existsSync(path.join(root, `${ACP_SIDECAR_DB_FILENAME}-wal`))).toBe(true)
      const reopened = createAcpSidecar({ root })
      const entries = await reopened.list(SessionId('sess-1'))
      expect(entries).toHaveLength(1)
      expect(entries[0]?.data).toMatchObject({ requestId: 'req-wal' })
      expect((await reopened.health()).integrity).toBe('ok')
      await reopened.dispose()
      await store.dispose() // 旧连接仍可正常关闭（WAL 已被接管/checkpoint）
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
