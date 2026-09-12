import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { ACP_FS_MAX_LINES, createAcpFileSystemHandlers } from '../../../src/runtime/client-capabilities/filesystem.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

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

  it('durably records absolute-path success and I/O failure without storing file contents', async () => {
    const dir = root()
    const sidecar = createAcpSidecar({ root: dir })
    const handlers = createAcpFileSystemHandlers({
      profileId: 'devin',
      audit: event => sidecar.append('dsh-fs-audit' as never, { kind: 'filesystem', data: event }),
    })
    const absolutePackage = path.join(process.cwd(), 'package.json')
    await expect(handlers.readTextFile({ sessionId: 'acp-devin', path: absolutePackage, limit: 1 })).resolves.toHaveProperty('content')
    const missing = path.join(dir, 'does-not-exist.json')
    await expect(handlers.readTextFile({ sessionId: 'acp-devin', path: missing })).rejects.toThrow(/failed/)
    const entries = await sidecar.list('dsh-fs-audit' as never)
    expect(entries.filter(entry => entry.kind === 'filesystem')).toHaveLength(2)
    expect(entries.every(entry => entry.kind !== 'filesystem' || entry.data.path !== absolutePackage || !('content' in entry.data))).toBe(true)
    expect(entries.filter(entry => entry.kind === 'filesystem').map(entry => entry.data.outcome)).toEqual(['ok', 'error'])
    await sidecar.dispose()
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
    const audit: Array<{ outcome: string; reason?: string; line?: number; limit?: number }> = []
    const handlers = createAcpFileSystemHandlers({ profileId: 'codex', audit: (event) => { audit.push(event) } })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, limit: -1 })).rejects.toThrow(/limit/)
    expect(audit.at(-1)?.outcome).toBe('error')
    expect(audit.at(-1)?.reason).toBe('invalid-limit')
    expect(audit.at(-1)?.limit).toBe(-1)
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, line: 1, limit: ACP_FS_MAX_LINES + 1 })).resolves.toEqual({ content: 'a\n' })
    expect(audit.at(-1)).toMatchObject({ outcome: 'ok', line: 1, limit: ACP_FS_MAX_LINES + 1 })
    await expect(handlers.readTextFile({ sessionId: 'acp-1', path: file, limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(/safe/)
    expect(audit.at(-1)?.reason).toBe('invalid-limit')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uses a deterministic request deadline and preserves successful write semantics if audit storage fails', async () => {
    const dir = root(); const file = path.join(dir, 'a.txt'); fs.writeFileSync(file, 'old')
    const auditErrors: unknown[] = []
    const timeoutAudits: Array<{ outcome: string }> = []
    let blocked = true
    let release = () => {}
    let entered = () => {}
    const reading = new Promise<void>(resolve => { entered = resolve })
    const deadline = new AbortController()
    // Exercise the request deadline deterministically; real disk I/O is not a 10 ms benchmark.
    const timeout = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(deadline.signal)
      .mockReturnValueOnce(new AbortController().signal)
    const handlers = createAcpFileSystemHandlers({
      profileId: 'codex', timeoutMs: 10,
      audit: (event) => { timeoutAudits.push(event) },
      io: { beforeRead: async () => blocked ? await new Promise<void>((resolve) => { release = resolve; entered() }) : undefined },
    })
    try {
      const failed = expect(handlers.readTextFile({ sessionId: 'acp-1', path: file })).rejects.toThrow(/failed|aborted/)
      await reading
      expect(timeout).toHaveBeenCalledWith(10)
      deadline.abort(new DOMException('Deadline expired', 'TimeoutError'))
      await failed
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
    } finally { release(); timeout.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }) }
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


it('streams oversized old files while retaining exact hashes and atomic replacement', async () => {
  const dir = root(), file = path.join(dir, 'large.txt')
  const old = Buffer.alloc(256 * 1024, 'x')
  fs.writeFileSync(file, old)
  const audit: Array<{ beforeHash: string | null; afterHash: string | null }> = []
  const fullRead = vi.spyOn(fs.promises, 'readFile')
  const handlers = createAcpFileSystemHandlers({ profileId: 'test', maxBytes: 16, audit: event => { audit.push(event) } })
  try {
    await handlers.writeTextFile({ sessionId: 's', path: file, content: 'small' })
    expect(fullRead).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('small')
    const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
    expect(audit.at(-1)).toMatchObject({ beforeHash: digest(old), afterHash: digest('small') })
  } finally { fullRead.mockRestore(); handlers.dispose(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('retains concurrent-edit detection during streamed old-file hashing', async () => {
  const dir = root(), file = path.join(dir, 'file.txt')
  fs.writeFileSync(file, 'original')
  const handlers = createAcpFileSystemHandlers({ profileId: 'test', io: {
    writeFile: async (...args) => { await fs.promises.writeFile(...args); fs.writeFileSync(file, 'other edit') },
  } })
  try {
    await expect(handlers.writeTextFile({ sessionId: 's', path: file, content: 'replacement' })).rejects.toThrow('concurrent file change')
    expect(fs.readFileSync(file, 'utf8')).toBe('other edit')
    expect(fs.readdirSync(dir)).toEqual(['file.txt'])
  } finally { handlers.dispose(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it.each([1, 2])('aborts and closes old-file hash stream %i without replacing the target', async pass => {
  const dir = root(), file = path.join(dir, 'file.txt'); fs.writeFileSync(file, 'original')
  const controller = new AbortController()
  const audits: Array<{ outcome: string }> = []
  const original = fs.createReadStream
  let count = 0
  let stalled: Readable | undefined
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    if (++count !== pass) return original(...args)
    stalled = new Readable({ read() { controller.abort() }, signal: controller.signal })
    return stalled as fs.ReadStream
  })
  const handlers = createAcpFileSystemHandlers({ profileId: 'test', signal: controller.signal, audit: event => { audits.push(event) } })
  try {
    await expect(handlers.writeTextFile({ sessionId: 's', path: file, content: 'replacement' })).rejects.toThrow(/abort/i)
    expect(stalled?.destroyed).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
    expect(fs.readdirSync(dir)).toEqual(['file.txt'])
    expect(audits.at(-1)?.outcome).toBe('aborted')
  } finally { spy.mockRestore(); handlers.dispose(); fs.rmSync(dir, { recursive: true, force: true }) }
})
