import { describe, expect, it } from 'vitest'
import { acpActivityDefinition, activityJournalSessionId, activityRowElement, createAcpActivityDefinition, visibleActivityRows } from '../../../src/client/ui/AcpActivityNode.ts'
import { AcpActivityJournalStore } from '../../../src/client/data/activity-journal.ts'
import { AcpActivityJournalHub } from '../../../src/client/data/activity-journal.ts'
import { acpReplayPayloadOf } from '../../../src/client/data/acp-replay-payload.ts'

const payload = {
  kind: 'dsh-acp' as const,
  version: 1 as const,
  ownerDshSessionId: 'dsh-1',
  profileId: 'codex',
  profileGeneration: 1,
  agentSessionId: 'acp-1',
  bindingEpoch: 1,
  launchFingerprint: 'fp',
  committedPromptOrdinal: 3,
  committedActivitySeq: 4,
  activityAnchorMessageId: 'user-3',
}

function assistantEvent() {
  return {
    type: 'assistant/message',
    seq: 10,
    time: 10,
    data: { message: { source: { replayState: { response: payload } } } },
  } as never
}

describe('ACP activity conversation node', () => {
  it('only matches durable ACP replay evidence, never native assistant messages', () => {
    expect(acpActivityDefinition.match(assistantEvent())).toEqual({ id: 'legacy:user-3', role: 'start' })
    expect(acpActivityDefinition.match({ type: 'assistant/message', seq: 11, time: 11, data: {} } as never)).toBeNull()
  })

  it('reads compact assistant replay envelopes without changing the rendered identity', () => {
    const compact = {
      type: 'assistant/message',
      seq: 12,
      data: { replayState: payload },
    }
    expect(acpReplayPayloadOf(compact)).toEqual(payload)
    expect(acpActivityDefinition.match(compact as never)).toEqual({ id: 'legacy:user-3', role: 'start' })
  })

  it('starts immediately for an exact managed request route and ignores another plugin route', () => {
    const definition = createAcpActivityDefinition(provider => provider === 'acp-codex')
    expect(definition.match({
      type: 'request/header', seq: 42, time: 42,
      data: { header: { config: { provider: 'acp-codex', model: 'GPT-5' } } },
    } as never)).toEqual({ id: 'request:42', role: 'start' })
    expect(definition.match({
      type: 'request/header', seq: 43, time: 43,
      data: { header: { config: { provider: 'acp-third-party', model: 'x' } } },
    } as never)).toBeNull()
  })

  it('anchors finalized ACP activity at the answer boundary so stock process folding cannot hide it', () => {
    const definition = createAcpActivityDefinition(provider => provider === 'acp-codex')
    const location = { kind: 'session' }
    const started = definition.start({} as never, {
      event: {
        type: 'request/header', seq: 42, time: 42,
        data: { header: { config: { provider: 'acp-codex', model: 'GPT-5' } } },
      },
      location,
    } as never, { previous: () => undefined } as never)
    const finalized = definition.update({ state: started } as never, {
      event: {
        type: 'assistant/message', seq: 93, time: 93,
        data: { message: { source: { replayState: { response: { ...payload, activityRequestHeaderSeq: 42 } } } } },
      },
      location,
    } as never)
    const node = definition.buildViewNode!({ key: 'activity', id: 'request:42', state: finalized } as never)
    expect((node as { readonly anchorSeq: number } | null)?.anchorSeq).toBe(93)
  })

  it('leaves projected child pages to the native message renderers', () => {
    const definition = createAcpActivityDefinition(() => false)
    expect(definition.match({
      type: 'subagent/descriptor', seq: 0, time: 1,
      data: { version: 3, mode: 'one-shot', provider: 'dsh-acp-adapter', label: 'Research' },
    } as never)).toBeNull()
    expect(definition.match({
      type: 'subagent/descriptor', seq: 0, time: 1,
      data: { version: 3, mode: 'one-shot', provider: 'another-plugin', label: 'Research' },
    } as never)).toBeNull()
  })

  it('keeps activity order stable while replacing a running row in place', () => {
    const store = new AcpActivityJournalStore()
    store.apply({ type: 'opened', cursor: 2, head: 2, activities: [
      { dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3', activityId: 'b', activitySeq: 2, revisionSeq: 2, time: 2, kind: 'tool', status: 'running', presentation: 'B' },
      { dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3', activityId: 'a', activitySeq: 1, revisionSeq: 1, time: 1, kind: 'tool', status: 'running', presentation: 'A' },
    ] })
    store.apply({ type: 'entry', activity: { dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3', activityId: 'a', activitySeq: 1, revisionSeq: 3, time: 3, kind: 'tool', status: 'completed', presentation: 'A done' } })
    expect(store.values('dsh-1', 'user-3').map((row) => `${row.activityId}:${row.status}`)).toEqual(['a:completed', 'b:running'])
  })

  it('updates one anchor without scanning or mutating another anchor index', () => {
    const store = new AcpActivityJournalStore()
    const row = (anchor: string, id: string, revisionSeq: number) => ({
      dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: anchor,
      activityId: id, activitySeq: 1, revisionSeq, time: revisionSeq, kind: 'tool' as const,
      status: 'running' as const, presentation: id,
    })
    store.apply({ type: 'opened', cursor: 2, head: 2, activities: [row('anchor-a', 'a', 1), row('anchor-b', 'b', 2)] })
    const indexes = store as unknown as { readonly rowsByAnchor: Map<string, Map<string, unknown>> }
    const bIndex = indexes.rowsByAnchor.get('dsh-1\u0000anchor-b')
    store.apply({ type: 'entry', activity: { ...row('anchor-a', 'a', 3), status: 'completed' } })
    expect(indexes.rowsByAnchor.get('dsh-1\u0000anchor-b')).toBe(bIndex)
    expect(store.values('dsh-1', 'anchor-b').map(item => item.activityId)).toEqual(['b'])
  })

  it('renders a native disclosure summary, status, and read-only detail', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-1', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'delegated', status: 'completed', presentation: 'Spawned helper',
        rawDetail: JSON.stringify({ secret: 'must stay in audit' }),
      },
      t: (key) => key === 'activity.kind.delegated' ? 'Subagent details' : key,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('Spawned helper')
    expect(rendered).toContain('activity.status.completed')
    expect(rendered).toContain('Subagent details')
    expect(rendered).toContain('must stay in audit')
    expect(rendered).toContain('"expandable":true')
  })

  it('does not offer an empty disclosure for absent tool details', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-empty', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Editing files',
        rawDetail: JSON.stringify({ rawInput: {}, rawOutput: {}, content: [] }),
      },
      t: key => key,
    })
    expect(JSON.stringify(element)).toContain('"expandable":false')
  })

  it('projects formatted command output through the native TerminalBlock', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-terminal', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'sed -n 1,2p example.ts',
        rawDetail: JSON.stringify({
          toolKind: 'execute',
          rawInput: { command: 'sed -n 1,2p example.ts', cwd: '/workspace' },
          rawOutput: { formatted_output: 'line one\nline two', exit_code: 0, signal: 'SIGTERM' },
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('"command":"sed -n 1,2p example.ts"')
    expect(rendered).toContain('"cwd":"/workspace"')
    expect(rendered).toContain('"output":"line one\\nline two"')
    expect(rendered).toContain('"exitCode":0')
    expect(rendered).toContain('"signal":"SIGTERM"')
    expect(rendered).toContain('"running":false')
    expect(rendered).not.toContain('formatted_output')
  })

  it('projects the captured Devin nested exit text as terminal status, not JSON output', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-devin-terminal', activitySeq: 1, revisionSeq: 4, time: 4,
        kind: 'tool', status: 'completed', presentation: 'Ran printf',
        rawDetail: JSON.stringify({
          content: [{ content: { text: 'Exited with code 0', type: 'text' }, type: 'content' }],
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('"command":"Ran printf"')
    expect(rendered).toContain('"exitCode":0')
    expect(rendered).toContain('"running":false')
    expect(rendered).not.toContain('Exited with code 0')
    expect(rendered).not.toContain('"type":"text"')
  })

  it('keeps other Devin nested content readable as settled terminal output', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-devin-output', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Ran printf',
        rawDetail: JSON.stringify({
          toolKind: 'execute',
          rawInput: { command: 'printf DEVIN_TOOL_OK', cwd: '/workspace' },
          content: [{ content: { text: 'DEVIN_TOOL_OK', type: 'text' }, type: 'content' }],
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('"output":"DEVIN_TOOL_OK"')
    expect(rendered).toContain('"running":false')
    expect(rendered).not.toContain('"type":"text"')
  })

  it('marks an in-progress execute shape as a running native terminal', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-devin-running', activitySeq: 1, revisionSeq: 1, time: 1,
        kind: 'tool', status: 'running', presentation: 'Ran printf',
        rawDetail: JSON.stringify({ toolKind: 'execute', rawInput: { command: 'printf DEVIN_TOOL_OK' } }),
      },
      t: key => key,
      open: true,
    })
    expect(JSON.stringify(element)).toContain('"running":true')
  })

  it('leaves unknown non-terminal detail on the JsonTree path', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'tool-custom', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Custom tool',
        rawDetail: JSON.stringify({ content: [{ type: 'custom', payload: 'kept in JSON' }] }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('kept in JSON')
    expect(rendered).toContain('activity.kind.tool')
  })

  it('projects protocol diff content through the native DiffBlock primitive', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'diff-1', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'diff', status: 'completed', presentation: 'File change · example.ts',
        rawDetail: JSON.stringify({ type: 'diff', path: '/workspace/example.ts', oldText: 'old', newText: 'new' }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('/workspace/example.ts')
    expect(rendered).toContain('old')
    expect(rendered).toContain('new')
    expect(rendered).toContain('activity.copy')
  })

  it('projects Kimi complete-file writes through the native DiffBlock primitive', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'kimi-write', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Write fixture',
        rawDetail: JSON.stringify({
          toolKind: 'edit',
          rawInput: { path: '/workspace/kimi.txt', content: 'KIMI_UI_FILE_OK\n' },
          rawOutput: 'Wrote 16 bytes to /workspace/kimi.txt',
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('/workspace/kimi.txt')
    expect(rendered).toContain('KIMI_UI_FILE_OK')
    expect(rendered).not.toContain('Wrote 16 bytes')
    expect(rendered).not.toContain('toolKind')
  })

  it('projects Kimi numbered reads through the native ReadBlock primitive', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'kimi-read', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Read fixture',
        rawDetail: JSON.stringify({
          toolKind: 'read',
          rawInput: { path: '/workspace/fixture.ts' },
          rawOutput: '41\tconst marker = true\n42\texport { marker }',
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('"label":"/workspace/fixture.ts"')
    expect(rendered).toContain('"number":41')
    expect(rendered).toContain('const marker = true')
    expect(rendered).toContain('"lang":"ts"')
    expect(rendered).not.toContain('toolKind')
  })

  it('accepts a trailing newline and omits Kimi read status metadata', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'kimi-read-status', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Read fixture',
        rawDetail: JSON.stringify({
          toolKind: 'read', rawInput: { path: '/workspace/fixture.txt' },
          rawOutput: '7\tvisible\n8\tcontent\n<system>status metadata</system>\n',
        }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('"number":7')
    expect(rendered).toContain('visible')
    expect(rendered).not.toContain('status metadata')
  })

  it('does not misclassify Kimi Grep or malformed line windows as file reads', () => {
    const row = (rawInput: Record<string, unknown>, rawOutput: string) => activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'kimi-read-shape', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Read-shaped tool',
        rawDetail: JSON.stringify({ toolKind: 'read', rawInput, rawOutput }),
      },
      t: key => key,
      open: true,
    })
    expect(JSON.stringify(row({ path: '/workspace', pattern: 'needle' }, '1\tmatch'))).toContain('pattern')
    expect(JSON.stringify(row({ path: '/workspace/file' }, '1\tone\n3\tthree'))).toContain('rawOutput')
  })

  it('maps an empty Kimi write but not a local replacement edit as a whole-file diff', () => {
    const render = (rawInput: Record<string, unknown>) => JSON.stringify(activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'kimi-edit-shape', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Edit fixture',
        rawDetail: JSON.stringify({ toolKind: 'edit', rawInput }),
      },
      t: key => key,
      open: true,
    }))
    expect(render({ path: '/workspace/empty.txt', content: '' })).toContain('/workspace/empty.txt')
    expect(render({ path: '/workspace/file.txt', old_string: 'old', new_string: 'new' })).toContain('old_string')
  })

  it('keeps an unrecognized read payload on the lossless JsonTree path', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'user-3',
        activityId: 'custom-read', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'tool', status: 'completed', presentation: 'Read custom resource',
        rawDetail: JSON.stringify({ toolKind: 'read', rawInput: { uri: 'custom://item' }, rawOutput: { value: 'kept' } }),
      },
      t: key => key,
      open: true,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('custom://item')
    expect(rendered).toContain('kept')
  })

  it('renders external task and summary as read-only Agent-provided text', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'child', ownerDshSessionId: 'child', promptAnchorMessageId: 'external-subagent-record',
        activityId: 'external-subagent-record', activitySeq: 1, revisionSeq: 2, time: 2,
        kind: 'delegated', status: 'completed', presentation: 'Research',
        rawDetail: JSON.stringify({ kind: 'dsh-acp-external-subagent', task: { text: 'Find evidence' }, result: { text: 'Found it', completeness: 'summary' } }),
      },
      t: key => key,
    })
    const rendered = JSON.stringify(element)
    expect(rendered).toContain('Find evidence')
    expect(rendered).toContain('Found it')
    expect(rendered).toContain('subagent.summary')
  })

  it('offers a direct read-only record entry only when the parent activity proves a projected child', () => {
    const element = activityRowElement({
      row: {
        dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
        activityId: 'delegated-record:child-1', activitySeq: 1, revisionSeq: 1, time: 1,
        kind: 'delegated', status: 'completed', presentation: 'Research',
        rawDetail: JSON.stringify({ projectedChildSessionId: 'child-1' }),
      },
      t: key => key,
      onOpenProjectedChild: () => undefined,
    })
    expect(JSON.stringify(element)).toContain('subagent.openRecord')
  })

  it('keeps the source delegation tool and hides its duplicate projection metadata', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      revisionSeq: 1, time: 1, status: 'completed' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'tool:call-1', activitySeq: 1, kind: 'tool', presentation: 'Compute 2+2' },
      { ...base, activityId: 'tool:call-1:0:content', activitySeq: 2, kind: 'other', presentation: 'Tool output' },
      {
        ...base, activityId: 'delegated-record:child-1', activitySeq: 3, kind: 'delegated', presentation: 'Compute 2+2',
        rawDetail: JSON.stringify({ projectedChildSessionId: 'child-1', sourceToolCallId: 'call-1' }),
      },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['tool:call-1'])
  })

  it('collapses the prompt-anchored tool ids written by the production sidecar', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      revisionSeq: 1, time: 1, status: 'completed' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'user-1:tool:call-1', activitySeq: 1, kind: 'tool', presentation: 'Compute 2+2' },
      { ...base, activityId: 'user-1:tool:call-1:0:content', activitySeq: 2, kind: 'other', presentation: 'Tool output' },
      {
        ...base, activityId: 'user-1:delegated-record:child-1', activitySeq: 3, kind: 'delegated', presentation: 'Compute 2+2',
        rawDetail: JSON.stringify({ projectedChildSessionId: 'child-1', sourceToolCallId: 'call-1' }),
      },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['user-1:tool:call-1'])
  })

  it('keeps one delegation row while suppressing interleaved child tools and failed projection metadata', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      revisionSeq: 1, time: 1, status: 'completed' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'user-1:tool:delegate-1', activitySeq: 5, kind: 'tool', presentation: 'Ran explore subagent' },
      { ...base, activityId: 'user-1:tool:edit-1', activitySeq: 6, kind: 'tool', presentation: 'Edited fixture' },
      { ...base, activityId: 'user-1:tool:child-root', activitySeq: 8, kind: 'tool', presentation: 'Agent tool activity' },
      { ...base, activityId: 'user-1:tool:child-read', activitySeq: 9, kind: 'tool', presentation: 'Read file' },
      {
        ...base, activityId: 'user-1:delegated-record:child-1', activitySeq: 10, kind: 'delegated', presentation: 'Research',
        status: 'failed' as const,
        rawDetail: JSON.stringify({ projection: 'unavailable', sourceToolCallId: 'child-root' }),
      },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['user-1:tool:delegate-1', 'user-1:tool:edit-1'])
  })

  it('keeps one top-level row for an ordinary tool and absorbs all content children', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      revisionSeq: 1, time: 1, status: 'completed' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'tool:call-1', activitySeq: 1, kind: 'tool', presentation: 'Ran printf' },
      { ...base, activityId: 'tool:call-1:0:content', activitySeq: 2, kind: 'other', presentation: 'Tool output' },
      { ...base, activityId: 'tool:call-1:1:terminal', activitySeq: 3, kind: 'terminal', presentation: 'Terminal activity' },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['tool:call-1'])
  })

  it('hides an id-only Agent placeholder before delegation metadata arrives', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      activitySeq: 1, revisionSeq: 1, time: 1, status: 'running' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'user-1:tool:opaque-child', kind: 'tool', presentation: 'Agent tool activity', rawDetail: '{}' },
      { ...base, activityId: 'user-1:tool:real-call', activitySeq: 2, kind: 'tool', presentation: 'Read file', rawDetail: '{"toolKind":"read","rawInput":{"file_path":"/w/a.ts"}}' },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['user-1:tool:real-call'])
  })

  it('also hides legacy projection rows without replacing their source tool', () => {
    const base = {
      dshSessionId: 'parent', ownerDshSessionId: 'parent', promptAnchorMessageId: 'user-1',
      revisionSeq: 1, time: 1, status: 'completed' as const,
    }
    const rows = visibleActivityRows([
      { ...base, activityId: 'tool:call-1', activitySeq: 1, kind: 'tool', presentation: 'Research' },
      { ...base, activityId: 'tool:call-1:0:content', activitySeq: 2, kind: 'other', presentation: 'Tool output' },
      {
        ...base, activityId: 'delegated-record:child-1', activitySeq: 3, kind: 'delegated', presentation: 'Research',
        rawDetail: JSON.stringify({ projectedChildSessionId: 'child-1' }),
      },
    ])
    expect(rows.map(row => row.activityId)).toEqual(['tool:call-1'])
  })

  it('uses the Gateway reconnecting stream and disposes it when the last node releases', async () => {
    let starts = 0
    let accepted = 0
    let disposed = 0
    let requestLimit: number | undefined
    let releaseStream: (() => void) | undefined
    const remote = {
      activityFollow: async function* (_sessionId: string, request: { readonly limit?: number }, signal: AbortSignal) {
        requestLimit = request.limit
        starts += 1
        yield { type: 'opened' as const, cursor: 0, head: 0, activities: [] }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const factory = {
      $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) {
        const controller = new AbortController()
        const iterable = options.open(controller.signal)
        const wrapped = (async function* () {
          for await (const value of iterable) yield { value, accept: () => { accepted += 1 } }
        }())
        return {
          [Symbol.asyncIterator]: () => wrapped[Symbol.asyncIterator](),
          dispose: async () => { disposed += 1; controller.abort(); releaseStream?.() },
        }
      },
    }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    const handle = hub.acquire('dsh-1', 'dsh-1', 'user-1', () => undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(starts).toBe(1)
    expect(requestLimit).toBe(200)
    expect(accepted).toBe(1)
    handle.release()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(1)
  })

  it('repairs a 2→4 gap through every page before delivering revision 4', async () => {
    const row = (revisionSeq: number) => ({ dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'anchor', activityId: `a-${String(revisionSeq)}`, activitySeq: revisionSeq, revisionSeq, time: revisionSeq, kind: 'tool' as const, status: 'completed' as const, presentation: `A${String(revisionSeq)}` })
    const pages: number[] = []
    const remote = {
      activityFollow: async function* (_sessionId: string, _request: unknown, signal: AbortSignal) {
        yield { type: 'opened' as const, cursor: 2, head: 4, activities: [row(1), row(2)] }
        yield { type: 'entry' as const, activity: row(4) }
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      activityPage: async (_sessionId: string, request: { readonly afterRevision?: number }) => {
        pages.push(request.afterRevision ?? 0)
        return request.afterRevision === 2
          ? { ok: true as const, value: { sessionId: 'dsh-1', cursor: 2, head: 4, activities: [row(3)], nextCursor: 3, hasMore: true } }
          : { ok: true as const, value: { sessionId: 'dsh-1', cursor: 3, head: 4, activities: [row(4)], nextCursor: null, hasMore: false } }
      },
    }
    const factory = {
      $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) {
        const controller = new AbortController()
        const source = options.open(controller.signal)
        const stream = (async function* () { for await (const value of source) yield { value, accept: () => undefined } }())
        return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), dispose: async () => controller.abort() }
      },
    }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    const handle = hub.acquire('dsh-1', 'dsh-1', 'anchor', () => undefined)
    for (let attempt = 0; attempt < 50 && handle.snapshot().length < 4; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(pages).toEqual([2, 3])
    expect(handle.snapshot().map(activity => activity.revisionSeq)).toEqual([1, 2, 3, 4])
    handle.release()
  })

  it('reopens on a non-contiguous retained page and updates the same mounted snapshot', async () => {
    const row = (revisionSeq: number) => ({ dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'anchor', activityId: `a-${String(revisionSeq)}`, activitySeq: revisionSeq, revisionSeq, time: revisionSeq, kind: 'tool' as const, status: 'completed' as const, presentation: `A${String(revisionSeq)}` })
    let starts = 0
    const remote = {
      activityFollow: async function* (_sessionId: string, _request: unknown, signal: AbortSignal) {
        starts += 1
        if (starts === 1) {
          yield { type: 'opened' as const, cursor: 2, head: 4, activities: [row(1), row(2)] }
          yield { type: 'entry' as const, activity: row(4) }
        } else yield { type: 'opened' as const, cursor: 4, head: 4, activities: [row(1), row(2), row(4)] }
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      activityPage: async () => ({ ok: true as const, value: { sessionId: 'dsh-1', cursor: 2, head: 4, activities: [row(4)], nextCursor: null, hasMore: false } }),
    }
    const factory = {
      $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) {
        const controller = new AbortController()
        const source = options.open(controller.signal)
        const stream = (async function* () { for await (const value of source) yield { value, accept: () => undefined } }())
        return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), dispose: async () => controller.abort() }
      },
    }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    const handle = hub.acquire('dsh-1', 'dsh-1', 'anchor', () => undefined)
    for (let attempt = 0; attempt < 100 && (starts < 2 || handle.snapshot().length < 3); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toBeGreaterThanOrEqual(2)
    expect(handle.snapshot().map(activity => activity.revisionSeq)).toEqual([1, 2, 4])
    handle.release()
  })

  it('notifies only the listener for the entry anchor', async () => {
    const entry = { dshSessionId: 'dsh-1', ownerDshSessionId: 'dsh-1', promptAnchorMessageId: 'anchor-a', activityId: 'a', activitySeq: 1, revisionSeq: 1, time: 1, kind: 'tool' as const, status: 'completed' as const, presentation: 'A' }
    let releaseEntry: (() => void) | undefined
    const remote = { activityFollow: async function* (_sessionId: string, _request: unknown, signal: AbortSignal) { yield { type: 'opened' as const, cursor: 0, head: 0, activities: [] }; await new Promise<void>(resolve => { releaseEntry = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) }); if (signal.aborted) return; yield { type: 'entry' as const, activity: entry }; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } }
    const factory = { $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) { const controller = new AbortController(); const source = options.open(controller.signal); const stream = (async function* () { for await (const value of source) yield { value, accept: () => undefined } }()); return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), dispose: async () => controller.abort() } } }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    let a = 0; let b = 0
    const first = hub.acquire('dsh-1', 'dsh-1', 'anchor-a', () => { a += 1 })
    const second = hub.acquire('dsh-1', 'dsh-1', 'anchor-b', () => { b += 1 })
    for (let attempt = 0; attempt < 20 && releaseEntry === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    const beforeA = a; const beforeB = b
    releaseEntry?.()
    for (let attempt = 0; attempt < 20 && a < beforeA + 1; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(a).toBe(beforeA + 1)
    expect(b).toBe(beforeB)
    first.release(); second.release()
  })

  it('reads forked activity from the replay owner while keeping child activity separate', async () => {
    const parent = 'dsh-parent'
    const child = 'dsh-child'
    const data = { ownerDshSessionId: parent }
    const requests: string[] = []
    const parentActivity = {
      dshSessionId: parent, ownerDshSessionId: parent, promptAnchorMessageId: 'user-parent-1',
      activityId: 'parent-tool', activitySeq: 1, revisionSeq: 1, time: 1,
      kind: 'tool' as const, status: 'completed' as const, presentation: 'Ran pwd',
    }
    const childActivity = {
      ...parentActivity, dshSessionId: child, ownerDshSessionId: child, activityId: 'child-tool',
    }
    const remote = {
      activityFollow: async function* (sessionId: string, _request: unknown, signal: AbortSignal) {
        requests.push(sessionId)
        yield { type: 'opened' as const, cursor: 2, head: 2, activities: [parentActivity, childActivity] }
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const factory = {
      $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }) {
        const controller = new AbortController()
        const source = options.open(controller.signal)
        const stream = (async function* () {
          for await (const value of source) yield { value, accept: () => undefined }
        }())
        return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), dispose: async () => controller.abort() }
      },
    }
    const hub = new AcpActivityJournalHub(remote as never, factory as never)
    const handle = hub.acquire(activityJournalSessionId(data), parent, 'user-parent-1', () => undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([parent])
    expect(handle.snapshot().map((row) => row.activityId)).toEqual(['parent-tool'])
    handle.release()
    // The child route will use child as owner on its own replay payload.
    expect(activityJournalSessionId({ ownerDshSessionId: child })).toBe(child)
  })
})
