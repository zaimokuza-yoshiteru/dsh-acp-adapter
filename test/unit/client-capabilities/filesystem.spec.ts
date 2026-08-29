import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpFileSystemHandlers } from '../../../src/runtime/client-capabilities/filesystem.ts'

function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-fs-')) }

describe('ACP native filesystem handlers', () => {
  it('reads bounded UTF-8 windows and records real session correlation', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'a\nb\nc\n')
    const audit: unknown[] = []
    const handlers = createAcpFileSystemHandlers({ profileId: 'codex', audit: (event) => { audit.push(event) } })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, limit: 2 })).resolves.toEqual({ content: 'a\nb' })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, limit: 0 })).resolves.toEqual({ content: '' })
    expect(audit).toHaveLength(2); expect((audit[0] as { acpSessionId: string }).acpSessionId).toBe('acp-1')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('atomically creates/overwrites regular files and refuses symlink replacement', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); const link = path.join(dir, 'link.txt');
    const handlers = createAcpFileSystemHandlers({ profileId: 'codex' })
    await handlers.writeTextFile({ sessionId: 'acp-1', path: file, content: 'one' }); const mode = fs.statSync(file).mode & 0o777
    await handlers.writeTextFile({ sessionId: 'acp-1', path: file, content: 'two' }); expect(fs.readFileSync(file, 'utf8')).toBe('two'); expect(fs.statSync(file).mode & 0o777).toBe(mode)
    const other = path.join(dir, 'other.txt'); fs.writeFileSync(other, 'safe'); fs.symlinkSync(other, link)
    await expect(handlers.writeTextFile({ sessionId: 'acp-1', path: link, content: 'bad' })).rejects.toThrow(/symlink/)
    expect(fs.readFileSync(other, 'utf8')).toBe('safe'); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects invalid paths/UTF-8 and aborts before dispatch', async () => {
    const dir = root(); const invalid = path.join(dir, 'bad'); fs.writeFileSync(invalid, Buffer.from([0xff]))
    const audit: unknown[] = []
    const handlers = createAcpFileSystemHandlers({ profileId: 'codex', audit: (event) => { audit.push(event) } })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: invalid })).rejects.toThrow(/UTF-8/)
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: 'relative' })).rejects.toThrow(/absolute/)
    expect(audit.length).toBe(2)
    expect((audit[0] as { outcome: string }).outcome).toBe('error')
    expect((audit[1] as { outcome: string }).outcome).toBe('error')
    const controller = new AbortController(); controller.abort()
    const aborted = createAcpFileSystemHandlers({ profileId: 'codex', signal: controller.signal })
    await expect(aborted.writeTextFile({ sessionId: 'acp-1', path: path.join(dir, 'x'), content: 'x' })).rejects.toThrow(/aborted/)
    const disposed = createAcpFileSystemHandlers({ profileId: 'codex' })
    disposed.dispose()
    await expect(disposed.readTextFile({ sessionId: 'acp-1', path: invalid })).rejects.toThrow(/aborted/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('audits invalid read windows instead of silently refusing them', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'a\n')
    const audit: Array<{ outcome: string }> = []
    const handlers = createAcpFileSystemHandlers({ profileId: 'codex', audit: (event) => { audit.push(event) } })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, limit: -1 })).rejects.toThrow(/limit/)
    expect(audit.at(-1)?.outcome).toBe('error')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uses a deterministic request deadline and preserves successful write semantics if audit storage fails', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'old')
    const auditErrors: unknown[] = []
    const timeoutAudits: Array<{ outcome: string }> = []
    let blocked = true
    let release = () => {}
    const handlers = createAcpFileSystemHandlers({
      profileId: 'codex', timeoutMs: 10,
      audit: (event) => { timeoutAudits.push(event) },
      io: { beforeRead: async () => blocked ? await new Promise<void>((resolve) => { release = resolve }) : undefined },
    })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file })).rejects.toThrow(/failed|aborted/)
    expect(timeoutAudits.at(-1)?.outcome).toBe('timeout')
    blocked = false; release()
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file })).resolves.toEqual({ content: 'old' })
    const writeHandlers = createAcpFileSystemHandlers({
      profileId: 'codex',
      audit: async () => { throw new Error('audit store unavailable') },
      onAuditError: (error) => { auditErrors.push(error) },
    })
    await expect(writeHandlers.writeTextFile({ sessionId: 'acp-1', path: file, content: 'new' })).resolves.toEqual({})
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    expect(auditErrors).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('bounds a hanging rename and removes its temporary file', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'old')
    const audit: Array<{ outcome: string }> = []
    const handlers = createAcpFileSystemHandlers({
      // 给进入注入 rename 前的真实 lstat/read/write/chmod 留足时间；5ms 在全量
      // 并行套件受调度抖动影响，可能在 rename 之前超时而把本用例误判成 error。
      profileId: 'codex', timeoutMs: 1_000, audit: (event) => { audit.push(event) },
      io: { rename: async () => await new Promise<never>(() => {}) },
    })
    await expect(handlers.writeTextFile({ sessionId: 'acp-1', path: file, content: 'new' })).rejects.toThrow(/failed/)
    expect(audit.at(-1)?.outcome).toBe('timeout')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(fs.readdirSync(dir).filter((entry) => entry.includes('.dsh-acp-'))).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
