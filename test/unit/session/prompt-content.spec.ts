import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  AcpPromptContentError,
  skillRouteForTools,
  toAcpPrompt,
  validImageLimits,
} from '../../../src/domain/session/prompt-content.ts'

const limits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 4096,
  maxImagePixels: 1024,
  maxImageDimension: 1024,
  mediaTypes: ['image/png'],
} as const

const text = (value: string) =>
  createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
/** Test fixture for DSH plugin context source augmentation, not included in the adapter's compile-time deps. */
function asContextUserMessage(message: unknown): UserMessage {
  return message as UserMessage
}

const skillCatalog = (value: string): UserMessage => {
  const message = createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
  return asContextUserMessage({
    ...message,
    source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'review', description: 'Review code' }] },
  })
}

describe('prompt content conversion', () => {
  it('forwards the native child closing answer without turning its reasoning into prompt text', async () => {
    const message = createUserMessage({
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: 'child' as never,
        summary: 'Child finished',
      },
      content: [
        { type: 'text', text: 'Child finished' },
        { type: 'reasoning', text: 'private thoughts' },
        { type: 'text', text: '2' },
      ],
    })
    expect(await toAcpPrompt([message], { imageEnabled: false, signal: new AbortController().signal })).toEqual([
      { type: 'text', text: 'Child finished' },
      { type: 'text', text: '2' },
    ])
    await expect(
      toAcpPrompt([{ ...message, source: { kind: 'user' } }], {
        imageEnabled: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('reasoning')
  })
  it('carries complete host instructions and logged plugin input without advertising executable tools', async () => {
    const context = createUserMessage({
      content: [{ type: 'text', text: 'Current project guidance' }],
      source: { kind: 'test-plugin', plugin: 'guidance' },
    })
    const result = await toAcpPrompt([context, text('Continue')], {
      system: 'Apply the repository conventions.\nKeep the full instruction text.',
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    expect(result).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Apply the repository conventions.\nKeep the full instruction text.'),
      },
      { type: 'text', text: 'Current project guidance' },
      { type: 'text', text: 'Continue' },
    ])
    expect(result[0]).toMatchObject({ text: expect.stringContaining('do not add tools or grant permissions') })
    const cleared = await toAcpPrompt([text('Continue')], {
      system: '',
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    expect(cleared[0]).toMatchObject({ text: expect.stringContaining('No additional host instructions.') })
    await expect(
      toAcpPrompt([], {
        system: 'Instructions alone cannot trigger a dispatch',
        imageEnabled: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no supported content')
  })

  it('separates generated host and model context while preserving adjacent original text blocks', async () => {
    const original = createUserMessage({
      content: [
        { type: 'text', text: 'first-original-block' },
        { type: 'text', text: 'second-original-block' },
      ],
      source: { kind: 'user' },
    })
    const result = await toAcpPrompt([original], {
      system: 'generated-host-instructions',
      modelContextSnapshots: [{ source: 'runtime-context', text: 'generated-model-context' }],
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const textBlocks = result.filter(
      (block): block is Extract<(typeof result)[number], { type: 'text' }> => block.type === 'text',
    )
    const joinedByTheACPConsumer = textBlocks.map((block) => block.text).join('')

    expect(textBlocks.slice(-2).map((block) => block.text)).toEqual(['first-original-block', 'second-original-block'])
    expect(textBlocks[0]?.text).toMatch(/skill-catalog: no current snapshot; do not apply older DSH skill names\.\n\n$/)
    expect(textBlocks[1]?.text).toMatch(/^\n\nCurrent host instructions/)
    expect(textBlocks[1]?.text).toMatch(/generated-host-instructions\n\n$/)
    expect(joinedByTheACPConsumer).toContain(
      'skill-catalog: no current snapshot; do not apply older DSH skill names.\n\n\n\nCurrent host instructions',
    )
    expect(joinedByTheACPConsumer).toContain('generated-host-instructions\n\nfirst-original-blocksecond-original-block')

    const catalog = skillCatalog('original-catalog-block')
    const ptc = await toAcpPrompt([catalog], {
      skillRoute: 'ptc',
      modelContextSnapshots: [{ source: 'skill-catalog', id: String(catalog.id), text: 'original-catalog-block' }],
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const joinedPtcByTheACPConsumer = ptc
      .filter((block): block is Extract<(typeof ptc)[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(joinedPtcByTheACPConsumer).toContain('original-catalog-block\n\nFor any instruction above to call `skill`')
    expect(joinedPtcByTheACPConsumer).toMatch(/This note adds no tools or permissions\.(?:\n\n)+$/)
  })

  it('delimits an admitted Host context snapshot from surrounding user input without changing its text', async () => {
    const task = text('original-task')
    const runtimeContext = asContextUserMessage({
      ...createUserMessage({
        content: [{ type: 'text', text: 'host-runtime-snapshot' }],
        source: { kind: 'user' },
      }),
      source: { kind: 'runtime-context' },
    })
    const next = text('next-user-block')
    const result = await toAcpPrompt([task, runtimeContext, next], {
      modelContextSnapshots: [
        { source: 'runtime-context', id: String(runtimeContext.id), text: 'host-runtime-snapshot' },
      ],
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const textBlocks = result.filter(
      (block): block is Extract<(typeof result)[number], { type: 'text' }> => block.type === 'text',
    )
    const joinedByTheACPConsumer = textBlocks.map((block) => block.text).join('')
    const originalContentBlocks = textBlocks.filter((block) =>
      ['original-task', 'host-runtime-snapshot', 'next-user-block'].includes(block.text),
    )

    expect(joinedByTheACPConsumer).toContain('original-task\n\nhost-runtime-snapshot\n\nnext-user-block')
    expect(joinedByTheACPConsumer.match(/host-runtime-snapshot/g)).toHaveLength(1)
    expect(originalContentBlocks.map((block) => block.text)).toEqual([
      'original-task',
      'host-runtime-snapshot',
      'next-user-block',
    ])
  })

  it('does not let separators make an empty synthetic Host context dispatchable', async () => {
    const emptyRuntimeContext = asContextUserMessage({
      ...createUserMessage({ content: [], source: { kind: 'user' } }),
      source: { kind: 'runtime-context' },
    })
    await expect(
      toAcpPrompt([emptyRuntimeContext], {
        imageEnabled: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no supported content')
  })

  it('projects complete current DSH snapshots, deduplicates admitted snapshots, and clears absent entries', async () => {
    const current = skillCatalog('Current catalog')
    const result = await toAcpPrompt([text('Do it'), current], {
      modelContextSnapshots: [
        { source: 'skill-catalog', id: String(current.id), text: 'Current catalog' },
        { source: 'runtime-context', id: 'old-context', text: 'Mode: read-only.' },
      ],
      skillRoute: 'direct',
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    expect(result[0]).toMatchObject({
      text: expect.stringContaining('skill-catalog: current replacement snapshot is already present'),
    })
    expect(result[0]).toMatchObject({ text: expect.stringContaining('Mode: read-only.') })
    expect(result.filter((block) => block.type === 'text' && block.text === 'Current catalog')).toHaveLength(1)

    const disabled = await toAcpPrompt([text('Continue')], {
      modelContextSnapshots: [{ source: 'skill-catalog', id: 'old', text: 'Previously available skill' }],
      skillRoute: 'disabled',
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const disabledText = disabled.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(disabledText).toContain('no direct `skill` or PTC `run_code` entry point is available')
    expect(disabledText).not.toContain('Previously available skill')

    await expect(
      toAcpPrompt([], {
        modelContextSnapshots: [{ source: 'runtime-context', id: 'context', text: 'Mode: read-only.' }],
        skillRoute: 'direct',
        imageEnabled: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no supported content')
  })

  it('routes current and snapshot skill catalogs only through the request tools', async () => {
    const catalog = skillCatalog('Catalog: call the skill tool to load `review`.')

    expect(skillRouteForTools([{ name: 'skill' }, { name: 'run_code' }])).toBe('direct')
    expect(skillRouteForTools([{ name: 'run_code' }])).toBe('ptc')
    expect(skillRouteForTools([])).toBe('disabled')

    const direct = await toAcpPrompt([catalog], {
      skillRoute: 'direct',
      skillCatalogAvailable: true,
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    expect(direct.map((block) => (block.type === 'text' ? block.text : ''))).toContain(
      'Catalog: call the skill tool to load `review`.',
    )

    const ptc = await toAcpPrompt([catalog], {
      skillRoute: 'ptc',
      skillCatalogAvailable: true,
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const ptcText = ptc.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(ptcText).toContain('Catalog: call the skill tool to load `review`.')
    expect(ptcText).toContain('For any instruction above to call `skill`, use only `tools.skill(...)`')
    expect(ptcText.indexOf('For any instruction above to call `skill`')).toBeGreaterThan(
      ptcText.indexOf('Catalog: call the skill tool to load `review`.'),
    )
    expect(ptcText.toLowerCase().match(/for any instruction above to call `skill`/g)).toHaveLength(1)

    const disabled = await toAcpPrompt([text('Continue. Please explain the skill command.'), catalog], {
      skillRoute: 'disabled',
      skillCatalogAvailable: true,
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const disabledText = disabled.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(disabledText).toContain('no direct `skill` or PTC `run_code` entry point is available')
    expect(disabledText).toContain('Continue. Please explain the skill command.')
    expect(disabledText).not.toContain('Catalog: call the skill tool to load `review`.')
    await expect(
      toAcpPrompt([catalog], {
        skillRoute: 'disabled',
        skillCatalogAvailable: true,
        imageEnabled: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no supported content')

    const ptcWithoutSkillScope = await toAcpPrompt([text('Continue'), catalog], {
      skillRoute: 'ptc',
      skillCatalogAvailable: false,
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const ptcWithoutSkillScopeText = ptcWithoutSkillScope
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    expect(ptcWithoutSkillScopeText).toContain('the `skill` tool is not available in this Agent scope')
    expect(ptcWithoutSkillScopeText).not.toContain('tools.skill(...)')
    expect(ptcWithoutSkillScopeText).not.toContain('Catalog: call the skill tool to load `review`.')

    const oldSnapshotPtc = await toAcpPrompt([text('Continue')], {
      modelContextSnapshots: [{ source: 'skill-catalog', id: 'old', text: 'Old catalog: review' }],
      skillRoute: 'ptc',
      imageEnabled: false,
      signal: new AbortController().signal,
    })
    const oldSnapshotPtcText = oldSnapshotPtc.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(oldSnapshotPtcText).toContain('Old catalog: review')
    expect(oldSnapshotPtcText).toContain('For any instruction above to call `skill`, use only `tools.skill(...)`')
    expect(oldSnapshotPtcText.indexOf('For any instruction above to call `skill`')).toBeGreaterThan(
      oldSnapshotPtcText.indexOf('Old catalog: review'),
    )
    expect(oldSnapshotPtcText.toLowerCase().match(/for any instruction above to call `skill`/g)).toHaveLength(1)
  })

  it('preserves text ordering and reads durable images into ACP blocks', async () => {
    const image = { attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const readImage = vi.fn().mockResolvedValue({ ref: image, data: Uint8Array.of(1, 2, 3) })

    await expect(
      toAcpPrompt(
        [
          text('before'),
          createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } }),
          text('after'),
        ],
        { imageEnabled: true, attachments: { readImage, imageLimits: limits }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ])
    expect(readImage).toHaveBeenCalledWith(image, expect.any(AbortSignal))
  })

  it('rejects image input before reading when the negotiated capability or local store is missing', async () => {
    const image = { attachmentId: 'att-2' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } })
    await expect(
      toAcpPrompt([message], { imageEnabled: false, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(AcpPromptContentError)
    await expect(toAcpPrompt([message], { imageEnabled: true, signal: new AbortController().signal })).rejects.toThrow(
      'attachment storage is unavailable',
    )
  })

  it('enforces aggregate declaration limits and validates stored bytes before producing a prompt', async () => {
    const first = { attachmentId: 'att-a' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const second = { attachmentId: 'att-b' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: first }], source: { kind: 'user' } })
    await expect(
      toAcpPrompt([message], {
        imageEnabled: true,
        attachments: { readImage: vi.fn(), imageLimits: { ...limits, maxMessageImageBytes: 2 } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('prompt images exceed')
    await expect(
      toAcpPrompt(
        [
          createUserMessage({
            content: [
              { type: 'image', attachment: first },
              { type: 'image', attachment: second },
            ],
            source: { kind: 'user' },
          }),
        ],
        {
          imageEnabled: true,
          attachments: { readImage: vi.fn(), imageLimits: { ...limits, maxImagesPerMessage: 1 } },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('prompt images exceed')

    const mismatched = vi.fn().mockResolvedValue({ ref: { ...first, bytes: 4 }, data: Uint8Array.of(1, 2, 3, 4) })
    await expect(
      toAcpPrompt([message], {
        imageEnabled: true,
        attachments: { readImage: mismatched, imageLimits: limits },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('stored image bytes')
  })

  it('rejects empty and unsupported content, and validates limit shape', async () => {
    await expect(
      toAcpPrompt([createUserMessage({ content: [], source: { kind: 'user' } })], {
        imageEnabled: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no supported content')
    expect(validImageLimits(limits)).toBe(true)
    expect(validImageLimits({ ...limits, maxImageBytes: 0 })).toBe(false)
    expect(validImageLimits({ ...limits, mediaTypes: ['text/plain'] as never })).toBe(false)
  })
})
