import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk'
import { activityToolOutput, joinActivityToolOutput } from '../../../src/client/ui/activity-tool-output.ts'
import { en, zh, type AcpLocaleKey } from '../../../src/client/ui/locales.ts'

const translate =
  (locale: typeof en | typeof zh) =>
  (key: AcpLocaleKey, params: Record<string, unknown> = {}) =>
    locale[key].replace(/\{([^}]+)\}/g, (_match, name: string) => String(params[name] ?? ''))
const t = translate(en)
const wrap = (...content: ContentBlock[]): ToolCallContent[] =>
  content.map((item) => ({ type: 'content', content: item }))
const codexResult = (content: unknown[]) => ({ result: { content, structuredContent: null, _meta: null }, error: null })
type RawEnvelope = { result: Record<string, unknown>; error?: unknown; [key: string]: unknown }

describe('ACP tool output for native plain-text cards', () => {
  it('unwraps the recorded Codex MCP envelope without changing its raw result', () => {
    const text =
      'DSH_WAIT_DEFERRED_TEAM_MESSAGE: A Team message is already queued for this caller, so DSH did not execute wait_agent. End this ACP response now; DSH will deliver the queued message for you to handle.'
    const raw = codexResult([{ type: 'text', text }])
    const before = JSON.stringify(raw)
    expect(activityToolOutput(raw, undefined, t)).toEqual({
      items: [{ kind: 'text', text }],
      text,
      hasUnrepresentedSupplement: false,
    })
    expect(JSON.stringify(raw)).toBe(before)
  })

  it.each([undefined, false, true])('keeps Codex MCP text independent of isError=%s', (isError) => {
    const raw = codexResult([{ type: 'text', text: 'actual output' }])
    if (isError !== undefined) Object.assign(raw.result, { isError })
    expect(activityToolOutput(raw, [], t).text).toBe('actual output')
    expect(raw.result).toMatchObject({ content: [{ type: 'text', text: 'actual output' }] })
  })

  it('keeps ordered mixed resources in the Codex envelope without exposing binary payloads', () => {
    const raw = codexResult([
      { type: 'text', text: 'Export' },
      { type: 'resource_link', name: 'Report', uri: 'https://example.test/report?secret=private' },
      { type: 'resource', resource: { uri: 'file:///tmp/readme.txt', text: 'Embedded body' } },
      { type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE_BASE64' },
      { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO_BASE64' },
      { type: 'text', text: 'Export' },
    ])
    const result = activityToolOutput(raw, undefined, t)
    expect(result.items.map((item) => item.kind)).toEqual(['text', 'resource', 'resource', 'image', 'audio', 'text'])
    expect(result.text).toContain('Embedded body')
    expect(result.items.filter((item) => item.text === 'Export')).toHaveLength(2)
    expect(result.text).not.toMatch(/SECRET_|private/)
    expect(result.hasUnrepresentedSupplement).toBe(true)
    expect(raw.result.content).toHaveLength(6)
  })

  it.each([
    {
      label: 'transport error',
      mutate: (raw: RawEnvelope) => {
        raw.error = { code: -1, message: 'connection failed' }
      },
    },
    {
      label: 'outer metadata',
      mutate: (raw: RawEnvelope) => {
        raw.requestId = 'id'
      },
    },
    {
      label: 'missing error discriminator',
      mutate: (raw: RawEnvelope) => {
        delete raw.error
      },
    },
    {
      label: 'structured result',
      mutate: (raw: RawEnvelope) => {
        raw.result.structuredContent = { extra: 'important' }
      },
    },
    {
      label: 'metadata',
      mutate: (raw: RawEnvelope) => {
        raw.result._meta = { cursor: 'next' }
      },
    },
    {
      label: 'unknown result member',
      mutate: (raw: RawEnvelope) => {
        raw.result.extension = 'important'
      },
    },
    {
      label: 'nonboolean error flag',
      mutate: (raw: RawEnvelope) => {
        raw.result.isError = 'failed'
      },
    },
    {
      label: 'malformed text',
      mutate: (raw: RawEnvelope) => {
        raw.result.content = [
          { type: 'text', text: 'visible' },
          { type: 'text', text: { reason: 'important' } },
        ]
      },
    },
    {
      label: 'unknown atom',
      mutate: (raw: RawEnvelope) => {
        raw.result.content = [
          { type: 'text', text: 'visible' },
          { type: 'future-content', value: 'important' },
        ]
      },
    },
    {
      label: 'noncontent result',
      mutate: (raw: RawEnvelope) => {
        raw.result = { status: 'queued' }
      },
    },
  ])('preserves the complete raw representation for $label', ({ mutate }) => {
    const raw = codexResult([{ type: 'text', text: 'visible' }])
    mutate(raw)
    const before = JSON.stringify(raw)
    expect(activityToolOutput(raw, undefined, t).text).toBe(before)
    expect(JSON.stringify(raw)).toBe(before)
  })

  it.each([{ content: [] }, { content: [{ type: 'text', text: '' }] }])(
    'keeps an empty Codex MCP result empty: $content',
    ({ content }) => {
      expect(activityToolOutput(codexResult(content), undefined, t).text).toBe('')
    },
  )

  it('retains ACP display precedence without duplicating Codex envelope text', () => {
    const raw = codexResult([{ type: 'text', text: 'visible output' }])
    expect(activityToolOutput(raw, wrap({ type: 'text', text: 'visible output' }), t).text).toBe('visible output')
    expect(activityToolOutput(raw, wrap({ type: 'text', text: 'authored display' }), t).text).toBe('authored display')
    expect(
      activityToolOutput(raw, wrap({ type: 'resource_link', name: 'Report', uri: 'https://example.test/report' }), t)
        .text,
    ).toMatch(/^visible output\nThis tool record contains a resource reference/)
  })

  it('retains ordered text and every independent resource in a legal mixed ACP result', () => {
    const result = activityToolOutput(
      undefined,
      wrap(
        { type: 'text', text: 'Report ready' },
        { type: 'resource_link', name: 'Report A', uri: 'https://example.test/a' },
        { type: 'text', text: 'Second export' },
        { type: 'resource_link', name: 'Report B', uri: 'https://example.test/b' },
      ),
      t,
    )
    expect(result.items.map((item) => item.kind)).toEqual(['text', 'resource', 'text', 'resource'])
    expect(result.text).toBe(
      'Report ready\n' +
        'This tool record contains a resource reference that cannot be opened here. Report A · https://example.test/a\n' +
        'Second export\n' +
        'This tool record contains a resource reference that cannot be opened here. Report B · https://example.test/b',
    )
    expect(result.hasUnrepresentedSupplement).toBe(true)
  })

  it('preserves repeated text atoms and their authored newline boundaries', () => {
    const result = activityToolOutput(
      undefined,
      wrap({ type: 'text', text: 'same\n' }, { type: 'text', text: 'same' }),
      t,
    )
    expect(result.text).toBe('same\nsame')
    expect(result.hasUnrepresentedSupplement).toBe(false)
    expect(
      joinActivityToolOutput([
        { kind: 'text', text: 'first' },
        { kind: 'text', text: '\nsecond' },
      ]),
    ).toBe('first\nsecond')
  })

  it('prefers display content over duplicate raw output and keeps content when raw output is empty', () => {
    const content = wrap({ type: 'text', text: 'visible result' })
    expect(activityToolOutput('visible result', content, t).text).toBe('visible result')
    expect(activityToolOutput({}, content, t).text).toBe('visible result')
    expect(activityToolOutput('', content, t).text).toBe('visible result')
    expect(activityToolOutput('raw fallback', [], t).text).toBe('raw fallback')
    expect(activityToolOutput('raw fallback', wrap({ type: 'text', text: '  ' }), t).text).toBe('raw fallback')
  })

  it('recognizes MCP result content without converting ACP media into saved DSH attachments', () => {
    const result = activityToolOutput(
      {
        content: [
          { type: 'text', text: 'Screenshot' },
          { type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE_BASE64' },
          { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO_BASE64' },
        ],
      },
      undefined,
      t,
    )
    expect(result.items.map((item) => item.kind)).toEqual(['text', 'image', 'audio'])
    expect(result.text).toContain('This image cannot be previewed in this tool record. image/png')
    expect(result.text).toContain('This audio cannot be played in this tool record. audio/wav')
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|attachment|saved/)
    expect(result.hasUnrepresentedSupplement).toBe(true)
  })

  it('keeps the raw textual result when display content only references a resource', () => {
    const result = activityToolOutput(
      'Export completed with warnings',
      wrap({ type: 'resource_link', name: 'Report', uri: 'https://example.test/report' }),
      t,
    )
    expect(result.items.map((item) => item.kind)).toEqual(['text', 'resource'])
    expect(result.text).toMatch(/^Export completed with warnings\n/)
    expect(result.text).toContain('Report · https://example.test/report')
  })

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,' + 'A'.repeat(32_000),
    'blob:https://example.test/private-payload',
    'https://example.test/line\nsecret',
  ])('omits unsafe or payload resource addresses: %s', (uri) => {
    const result = activityToolOutput(undefined, wrap({ type: 'resource_link', name: 'Report', uri }), t)
    expect(result.text).toBe('This tool record contains a resource reference that cannot be opened here. Report')
    expect(result.text.length).toBeLessThan(150)
  })

  it('removes credentials, query tokens and fragments from displayed resource locations', () => {
    const result = activityToolOutput(
      undefined,
      wrap({
        type: 'resource_link',
        name: 'Report',
        uri: 'https://private-user:private-pass@example.test/report?token=private-token#private-fragment',
      }),
      t,
    )
    expect(result.text).toContain('https://example.test/report')
    expect(result.text).not.toContain('private-')
    expect(result.text).not.toMatch(/\]\(|<a|href=/)
  })

  it('preserves embedded resource text while omitting binary payloads and bounding metadata', () => {
    const result = activityToolOutput(
      undefined,
      wrap(
        {
          type: 'resource',
          resource: { uri: 'file:///tmp/readme.txt', mimeType: 'text/plain', text: 'Embedded body' },
        },
        {
          type: 'resource',
          resource: { uri: 'memory://blob', mimeType: 'application/octet-stream', blob: 'SECRET_BLOB' },
        },
        { type: 'resource_link', name: 'A'.repeat(2_000), uri: 'https://example.test/' },
      ),
      t,
    )
    expect(result.text).toContain('Embedded text resource: text/plain · file:///tmp/readme.txt\nEmbedded body')
    expect(result.text).toContain(
      'This binary resource cannot be previewed in this tool record. application/octet-stream',
    )
    expect(result.text).not.toContain('SECRET_BLOB')
    expect(result.text).not.toContain('A'.repeat(241))
    expect(result.items).toHaveLength(3)
  })

  it('labels omitted resource text explicitly and preserves unknown content as an unavailable item', () => {
    const result = activityToolOutput(
      undefined,
      [
        ...wrap({ type: 'resource', resource: { uri: 'file:///tmp/long.txt', text: 'x'.repeat(5_000) } }),
        { type: 'content', content: { type: 'future-media', data: 'SECRET_FUTURE_PAYLOAD' } },
      ],
      t,
    )
    expect(result.text).toContain('Resource text is too long; the remaining content is omitted.')
    expect(result.text).not.toContain('x'.repeat(4_097))
    expect(result.text).toContain('This tool output type cannot be displayed: future-media')
    expect(result.text).not.toContain('SECRET_FUTURE_PAYLOAD')
    expect(result.hasUnrepresentedSupplement).toBe(true)
  })

  it('retains different dedicated-card atoms without mistaking same-kind diffs for duplicates', () => {
    const content: ToolCallContent[] = [
      { type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' },
      { type: 'diff', path: '/w/b.ts', oldText: 'c', newText: 'd' },
      { type: 'terminal', terminalId: 'terminal-1' },
    ]
    const result = activityToolOutput(undefined, content, t)
    expect(result.items.map((item) => item.kind)).toEqual(['diff', 'diff', 'terminal'])
    expect(result.text).toContain('File difference: /w/a.ts\nFile difference: /w/b.ts')
    expect(result.text).toContain('Terminal reference that cannot be opened in this tool record: terminal-1')
    expect(result.hasUnrepresentedSupplement).toBe(true)
  })

  it('uses locale-owned wording and keeps empty output empty', () => {
    const result = activityToolOutput(
      undefined,
      wrap({ type: 'image', mimeType: 'image/png', data: 'SECRET' }),
      translate(zh),
    )
    expect(result.text).toBe('图片无法在此工具记录中预览。image/png')
    expect(activityToolOutput(undefined, undefined, t)).toEqual({
      items: [],
      text: '',
      hasUnrepresentedSupplement: false,
    })
    expect(activityToolOutput({ result: 'done' }, undefined, t).text).toBe('{"result":"done"}')
  })
})
