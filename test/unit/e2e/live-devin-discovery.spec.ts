import { describe, expect, it, vi } from 'vitest'
import type { AcpActivityView } from '../../../src/contract/remote.ts'
import type { AcpRemoteService } from '../../../src/remote/service.ts'
import { assertDevinDiscovery, captureDevinDiscovery, observeDevinDiscovery } from '../../e2e/live-devin-discovery.ts'

const root = '/var/folders/test/T/fixture/tmp'
const path = `${root}/devin-overflows-501/current/content.txt`
const row = (
  seq: number,
  method: string,
  detail: object,
  overrides: Partial<AcpActivityView> = {},
): AcpActivityView => ({
  dshSessionId: 'session',
  ownerDshSessionId: 'session',
  promptAnchorMessageId: 'prompt',
  activityId: `prompt:tool:${method}:${seq}#id`,
  activitySeq: seq,
  revisionSeq: seq,
  time: seq,
  kind: 'tool',
  status: 'completed',
  presentation: 'Agent tool activity',
  rawDetail: JSON.stringify(detail),
  ...overrides,
})
const catalog = (seq = 1, output = path) =>
  row(seq, 'mcp_list_tools', {
    rawInput: { server_name: 'dsh' },
    content: [{ type: 'content', content: { type: 'text', text: output } }],
  })
const read = (seq = 2, file = path) =>
  row(seq, 'read', { toolKind: 'read', rawInput: { file_path: file, offset: 1, limit: 80 } })
const grep = row(3, 'grep', { toolKind: 'search', rawInput: { path, query: 'sensitive query' } })
const inspect = (...rows: AcpActivityView[]) => observeDevinDiscovery(rows, root)

describe('real Devin catalog discovery evidence', () => {
  it('requires a completed current-server list and correlates a bounded read or native grep with the exact returned file', () => {
    const result = inspect(read(2, `/private${path}`), catalog(), grep)
    expect(result.reads.map((entry) => entry.kind)).toEqual(['read', 'grep'])
    expect(result.reads.every((entry) => entry.catalogActivityId === catalog().activityId)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sensitive query')
    expect(() => assertDevinDiscovery(result)).not.toThrow()
  })
  it('allows names-only listing and marks read provenance unavailable when only the fresh isolated root can be proven', () => {
    const result = inspect(catalog(1, 'tool names only'), read())
    expect(result.unprovenReads).toEqual([read().activityId])
    expect(() => assertDevinDiscovery(result)).not.toThrow()
    expect(() => assertDevinDiscovery(inspect(catalog(1, 'full listing')))).not.toThrow()
  })
  it.each([
    [
      'native grep via shell',
      row(
        2,
        'exec',
        { toolKind: 'search', rawInput: { command: `grep sensitive ${path}` } },
        { presentation: 'Searched for …' },
      ),
    ],
    ['command field on search', row(2, 'grep', { rawInput: { command: 'sensitive', path, query: 'test' } })],
    ['invalid range', row(2, 'read', { rawInput: { file_path: path, offset: { path: 'other' } } })],
    ['additional input path', row(2, 'grep', { rawInput: { path, query: 'x', paths: ['/outside'] } })],
    ['workspace file', read(2, '/workspace/a')],
    ['older run', read(2, path.replace('/fixture/', '/old/'))],
    ['traversal', read(2, `${path}/../../secret`)],
    ['lookalike filename', read(2, `${path}.bk`)],
    ['unclassified tool', row(2, 'web_search', { rawInput: {} })],
    ['another server', row(2, 'mcp_list_tools', { rawInput: { server_name: 'foreign' } })],
    ['unverified MCP invocation', row(2, 'mcp_call_tool', { toolName: 'team_task_get', rawInput: {} })],
  ])('rejects %s even after names-only discovery', (_, activity) => {
    const result = inspect(catalog(1, 'names only'), activity)
    expect(result.violations).toHaveLength(1)
    expect(() => assertDevinDiscovery(result)).toThrow()
    expect(JSON.stringify(result)).not.toContain('sensitive')
  })
  it.each([
    { file_path: path },
    { file_path: path, offset: 10 },
    { file_path: path, limit: 100 },
    { file_path: path, offset: null, limit: null, image_size: 'full' },
  ])('allows the CLI default bounded read and optional range fields', (input) => {
    const result = inspect(catalog(), row(2, 'read', { rawInput: input }))
    expect(() => assertDevinDiscovery(result)).not.toThrow()
    expect(result.reads[0]?.fields.find((field) => field.key === 'offset')?.value).toBe(
      typeof input.offset === 'number' ? input.offset : undefined,
    )
  })
  it('allows CLI grep filters on exactly one isolated file and keeps matching text out of diagnostics', () => {
    const rawInput = {
      path,
      pattern: 'private-fixture contents',
      glob_pattern: 'private-fixture filter',
      output_mode: 'content',
      case_insensitive: true,
      context_lines: 4,
      max_results: 30,
    }
    const result = inspect(catalog(), row(2, 'grep', { rawInput }))
    expect(() => assertDevinDiscovery(result)).not.toThrow()
    expect(result.reads[0]?.fields).toContainEqual({ key: 'context_lines', type: 'number', value: 4 })
    expect(JSON.stringify(result)).not.toContain('private-fixture')
    const invalid = inspect(
      catalog(),
      row(2, 'grep', { rawInput: { ...rawInput, 'private-fixture-key': ['private-fixture-other-target'] } }),
    )
    expect(invalid.violations[0]?.fields).toContainEqual({ key: '<unrecognized>', type: 'array' })
    expect(JSON.stringify(invalid)).not.toContain('private-fixture')
  })
  it('retains allowed read-only discovery, original reviewed MCP identity and supported names without guessing tool calls', () => {
    const call = row(3, 'mcp_call_tool', { toolName: 'write', rawInput: { file_path: 'fixture' } })
    const list = row(1, 'mcp_list_servers', { rawInput: {} })
    const reviewed = { callId: 'mcp_call_tool:3#id', tool: 'write' }
    const check = (items: (typeof reviewed)[]) =>
      observeDevinDiscovery([list, catalog(2, 'names only'), call], root, items)
    expect(() => assertDevinDiscovery(check([reviewed]))).not.toThrow()
    expect(check([{ ...reviewed, tool: 'read' }]).violations).toHaveLength(1)
    expect(check([{ ...reviewed, callId: 'other' }]).violations).toHaveLength(1)
  })
  it('accepts repeated discovery followed by a read of an exact file from either successful listing', () => {
    const second = catalog(2, path.replace('current', 'second'))
    expect(() => assertDevinDiscovery(inspect(catalog(), second, read(3)))).not.toThrow()
    expect(() =>
      assertDevinDiscovery(inspect(catalog(), second, read(3, path.replace('current', 'second')))),
    ).not.toThrow()
  })
  it('recognizes the original reviewed MCP request after Stop even when the CLI omits its final input and name', () => {
    const write = row(2, 'mcp_call_tool', {}, { status: 'cancelled' })
    const reviewed = { callId: 'mcp_call_tool:2#id', tool: 'write' }
    const check = (activity: AcpActivityView) =>
      observeDevinDiscovery([catalog(1, 'names only'), activity], root, [reviewed])
    expect(() => assertDevinDiscovery(check(write))).not.toThrow()
    expect(() => assertDevinDiscovery(check({ ...write, rawDetail: '[activity detail unavailable]' }))).not.toThrow()
    expect(() => assertDevinDiscovery(check({ ...write, rawDetail: JSON.stringify({ toolName: 'other' }) }))).toThrow()
    expect(() =>
      assertDevinDiscovery(observeDevinDiscovery([write, catalog(3, 'names only')], root, [reviewed])),
    ).toThrow()
  })
  it('rejects a different file, a later catalog or an incomplete list as proof of a catalog read', () => {
    for (const result of [
      inspect(read(), catalog(3)),
      inspect(catalog(), read(2, path.replace('current', 'foreign'))),
      inspect({ ...catalog(), status: 'failed' }, read()),
    ]) {
      expect(result.violations).toHaveLength(1)
      expect(result.reads).toEqual([])
    }
    expect(inspect(catalog(), { ...read(), status: 'running' }).unretrievedCatalogs).toEqual([catalog().activityId])
  })
  it('accepts a complete structured native input when only its output was truncated', () => {
    const complete = read().rawDetail!.slice(0, -1)
    const result = inspect(catalog(), { ...read(), rawDetail: `${complete},"rawOutput":"large… [truncated]` })
    expect(result.truncatedOutputs).toEqual([read().activityId])
    expect(() => assertDevinDiscovery(result)).not.toThrow()
  })
  it.each(['{"rawInput":{"file_path":"private… [truncated]', 'null', '[]', undefined])(
    'fails incomplete input without storing the fragment (%s)',
    (rawDetail) => {
      const { rawDetail: _original, ...activity } = read()
      const result = inspect(catalog(1, 'names only'), rawDetail === undefined ? activity : { ...activity, rawDetail })
      expect(result.unreadableActivities).toEqual([read().activityId])
      expect(() => assertDevinDiscovery(result)).toThrow()
      expect(JSON.stringify(result)).not.toContain('private…')
    },
  )
  it('audits early native activity across pages at the same watermark and uses the latest exact row revision', async () => {
    const old = row(1, 'exec', { rawInput: { command: 'private command' } })
    const current = catalog(2, 'names only')
    const service = {
      activityPage: vi
        .fn()
        .mockResolvedValueOnce({
          activities: [old, { ...current, status: 'running' }],
          head: 4,
          nextCursor: 2,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          activities: [{ ...current, revisionSeq: 4 }],
          head: 4,
          nextCursor: null,
          hasMore: false,
        }),
      activityDetail: vi.fn(async (_session: string, item: AcpActivityView) => item),
    }
    const result = await captureDevinDiscovery(service as unknown as AcpRemoteService, 'session', root, [])
    expect(service.activityPage.mock.calls[1]).toEqual(['session', { afterRevision: 2, limit: 100, snapshotHead: 4 }])
    expect(service.activityDetail).toHaveBeenCalledTimes(2)
    expect(result.violations).toEqual([{ activityId: old.activityId, reason: 'native-command' }])
    expect(result.catalogs).toHaveLength(1)
  })
})
