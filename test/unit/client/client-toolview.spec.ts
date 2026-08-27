// client-toolview.spec.ts — ACP 外部工具 toolview 的 client 半钉版
// （src/client/data/tool-presentation.ts 的解码/决策纯逻辑 + 注册形态在
// client-registration.spec.ts）。
//
// 被测模块零 import（clientData 纪律），直接 vitest 可测；组件渲染不被测试
// 消费（UI 层 AcpToolRow 是纯渲染）。双侧钉版：常量/界限与 host 真源
// src/protocol/v1/tool-presentation.ts 逐值相等（本测试是镜像漂移的报警器）。
//
// 覆盖：
//   - 常量双侧钉版（稳定名 / 版本号，字面值 + 双侧相等）
//   - decodeAcpToolPresentation：合法往返；version≠1 / 核心结构破损 / meta
//     缺席 → undefined（fail-closed）；可选字段畸形丢字段保信封；未知 content
//     变体 → 占位文本项（不静默消失）；已知变体字段逐一带回
//   - acpToolIconKey：ACP ToolKind 词表归并（read/edit/delete/move/search/
//     execute/think/fetch → 对应图标键；缺席/未知 → other）
//   - acpToolRowModel：state 三态；title 信封优先；summary（location 相对化 /
//     多 location 计数 / running argsRaw 预览）；filePath 恰单 location；
//     IN/OUT 分节（信封 inputSummary 优先于 argsRaw；无信封回退 resultText）；
//     diff 卡片材料（oldText 恒 null 由 UI 侧固定）；truncated 聚合；expandable

import { describe, expect, it } from 'vitest'
import {
  ACP_EXTERNAL_TOOL_NAME as HOST_NAME,
  ACP_TOOL_PRESENTATION_VERSION as HOST_VERSION,
} from '../../../src/protocol/v1/tool-presentation.ts'
import {
  ACP_EXTERNAL_TOOL_NAME,
  ACP_TOOL_PRESENTATION_VERSION,
  acpToolIconKey,
  acpToolRowModel,
  decodeAcpToolPresentation,
} from '../../../src/client/data/tool-presentation.ts'
import type { AcpToolPresentation } from '../../../src/client/data/tool-presentation.ts'

// ---------- 常量双侧钉版 ----------

describe('常量双侧钉版（client 镜像 ≡ protocol 真源）', () => {
  it('稳定名 / 版本号字面值 + 双侧相等', () => {
    expect(ACP_EXTERNAL_TOOL_NAME).toBe('dsh_acp_external_tool')
    expect(ACP_TOOL_PRESENTATION_VERSION).toBe(1)
    expect(ACP_EXTERNAL_TOOL_NAME).toBe(HOST_NAME)
    expect(ACP_TOOL_PRESENTATION_VERSION).toBe(HOST_VERSION)
  })
})

// ---------- decodeAcpToolPresentation ----------

const VALID_META = {
  acpToolPresentation: {
    version: 1,
    title: 'Write /repo/a.txt',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: '/repo/a.txt', line: 3 }, { path: '/repo/b.txt' }],
    inputSummary: { file_path: '/repo/a.txt' },
    content: [
      { type: 'text', text: 'done' },
      { type: 'diff', path: '/repo/a.txt', operation: '新建', linesAdded: 3, linesRemoved: 0, patch: 'a\nb\nc', originalChars: 5 },
      { type: 'terminal', terminalId: 'term-1', text: '[terminal 占位] …' },
      { type: 'image', ref: 'sha256:abc', mimeType: 'image/png', size: 8, hash16: 'abc' },
      { type: 'resource', uri: 'file:///x.txt', summary: 'body' },
    ],
  },
}

describe('decodeAcpToolPresentation', () => {
  it('解码受控 Codex 子 Agent 扩展；未知扩展 fail-closed 丢字段', () => {
    const envelope = decodeAcpToolPresentation({
      acpToolPresentation: {
        version: 1,
        title: 'spawnAgent',
        status: 'completed',
        content: [],
        agentExtension: {
          runtime: 'codex',
          type: 'collaboration',
          tool: 'spawnAgent',
          senderThreadId: 'parent',
          receiverThreadIds: ['child'],
        },
      },
    })
    expect(envelope?.agentExtension).toEqual({
      runtime: 'codex', type: 'collaboration', tool: 'spawnAgent', senderThreadId: 'parent', receiverThreadIds: ['child'],
    })
    const unknown = decodeAcpToolPresentation({
      acpToolPresentation: { version: 1, title: 'T', status: 'completed', content: [], agentExtension: { runtime: 'vendor', payload: 'x' } },
    })
    expect(unknown?.agentExtension).toBeUndefined()
  })

  it('合法信封逐字段往返', () => {
    const envelope = decodeAcpToolPresentation(VALID_META)
    expect(envelope).toEqual({
      version: 1,
      title: 'Write /repo/a.txt',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: '/repo/a.txt', line: 3 }, { path: '/repo/b.txt' }],
      inputSummary: { file_path: '/repo/a.txt' },
      content: [
        { type: 'text', text: 'done' },
        { type: 'diff', path: '/repo/a.txt', operation: '新建', linesAdded: 3, linesRemoved: 0, patch: 'a\nb\nc', originalChars: 5 },
        { type: 'terminal', terminalId: 'term-1', text: '[terminal 占位] …' },
        { type: 'image', ref: 'sha256:abc', mimeType: 'image/png', size: 8, hash16: 'abc' },
        { type: 'resource', uri: 'file:///x.txt', summary: 'body' },
      ],
    })
  })

  it('fail-closed：meta 缺席/非对象、缺键、version≠1、title 空、status 非法、content 非数组 → undefined', () => {
    expect(decodeAcpToolPresentation(undefined)).toBeUndefined()
    expect(decodeAcpToolPresentation(null)).toBeUndefined()
    expect(decodeAcpToolPresentation('string')).toBeUndefined()
    expect(decodeAcpToolPresentation({})).toBeUndefined()
    expect(decodeAcpToolPresentation({ acpToolPresentation: 'nope' })).toBeUndefined()
    const base = VALID_META.acpToolPresentation
    expect(decodeAcpToolPresentation({ acpToolPresentation: { ...base, version: 2 } })).toBeUndefined()
    expect(decodeAcpToolPresentation({ acpToolPresentation: { ...base, title: '' } })).toBeUndefined()
    expect(decodeAcpToolPresentation({ acpToolPresentation: { ...base, title: 42 } })).toBeUndefined()
    expect(decodeAcpToolPresentation({ acpToolPresentation: { ...base, status: 'pending' } })).toBeUndefined()
    expect(decodeAcpToolPresentation({ acpToolPresentation: { ...base, content: {} } })).toBeUndefined()
  })

  it('最小信封（仅 version/title/status/content）合法；可选字段畸形丢字段保信封', () => {
    expect(decodeAcpToolPresentation({
      acpToolPresentation: { version: 1, title: 'T', status: 'failed', content: [] },
    })).toEqual({ version: 1, title: 'T', status: 'failed', content: [] })
    const envelope = decodeAcpToolPresentation({
      acpToolPresentation: {
        version: 1,
        title: 'T',
        status: 'completed',
        content: [],
        kind: 42,
        locations: [{ path: '/ok' }, { nope: true }, 'junk', { path: '/also-ok', line: 'NaN' }],
      },
    })
    expect(envelope?.kind).toBeUndefined()
    expect(envelope?.locations).toEqual([{ path: '/ok' }, { path: '/also-ok' }])
  })

  it('未知 content 变体 → 占位文本项（点名类型，不静默消失）；已知变体核心字段畸形 → 占位', () => {
    const envelope = decodeAcpToolPresentation({
      acpToolPresentation: {
        version: 1,
        title: 'T',
        status: 'completed',
        content: [
          { type: 'hologram', payload: 1 },
          { type: 'diff', patch: '/missing-path' },
          'junk',
        ],
      },
    })
    expect(envelope?.content.map((item) => item.type)).toEqual(['text', 'text', 'text'])
    expect((envelope?.content[0] as { text: string }).text).toContain('hologram')
    expect((envelope?.content[2] as { text: string }).text).toContain('?')
  })

  it('截断标记与 originalChars 带回', () => {
    const envelope = decodeAcpToolPresentation({
      acpToolPresentation: {
        version: 1,
        title: 'T',
        status: 'completed',
        content: [{ type: 'text', text: 'headtail', originalChars: 9000, truncated: true }],
      },
    })
    expect(envelope?.content[0]).toEqual({ type: 'text', text: 'headtail', originalChars: 9000, truncated: true })
  })
})

// ---------- acpToolIconKey ----------

describe('acpToolIconKey（ACP ToolKind → 图标键归并）', () => {
  it('词表逐项 + 缺席/未知兜底 other', () => {
    expect(acpToolIconKey('read')).toBe('read')
    expect(acpToolIconKey('edit')).toBe('edit')
    expect(acpToolIconKey('delete')).toBe('edit')
    expect(acpToolIconKey('move')).toBe('edit')
    expect(acpToolIconKey('execute')).toBe('execute')
    expect(acpToolIconKey('search')).toBe('search')
    expect(acpToolIconKey('fetch')).toBe('fetch')
    expect(acpToolIconKey('think')).toBe('think')
    expect(acpToolIconKey('switch_mode')).toBe('other')
    expect(acpToolIconKey('other')).toBe('other')
    expect(acpToolIconKey(undefined)).toBe('other')
    expect(acpToolIconKey('vendor-extension')).toBe('other')
  })
})

// ---------- acpToolRowModel ----------

const ENVELOPE: AcpToolPresentation = {
  version: 1,
  title: 'Edit a.ts',
  kind: 'edit',
  status: 'completed',
  locations: [{ path: '/repo/src/a.ts' }],
  inputSummary: { file_path: '/repo/src/a.ts' },
  content: [
    { type: 'diff', path: '/repo/src/a.ts', operation: '修改', linesAdded: 2, linesRemoved: 1, patch: 'new', originalChars: 3 },
    { type: 'text', text: 'ok', truncated: true, originalChars: 9000 },
  ],
}

describe('acpToolRowModel', () => {
  it('settled + 信封：title/kind 事实、单 location 相对化 summary + filePath、IN 取 inputSummary、diff 卡片 + OUT 文本', () => {
    const model = acpToolRowModel({
      running: false,
      isError: false,
      argsRaw: '{"file_path":"/repo/src/a.ts"}',
      resultText: 'ok',
      envelope: ENVELOPE,
      cwd: '/repo',
    })
    expect(model.state).toBe('ok')
    expect(model.title).toBe('Edit a.ts')
    expect(model.summary).toBe('src/a.ts')
    expect(model.filePath).toBe('/repo/src/a.ts')
    expect(model.inputText).toBe('{"file_path":"/repo/src/a.ts"}')
    expect(model.diffs).toEqual([{ path: '/repo/src/a.ts', newText: 'new', truncated: false }])
    expect(model.outputText).toBe('ok')
    expect(model.truncated).toBe(true)
    expect(model.expandable).toBe(true)
  })

  it('running：无信封（上游 RunningToolCall 不带 meta）→ title 缺席（UI 落本地化通用标题），summary 是 argsRaw 首行有界预览', () => {
    const model = acpToolRowModel({
      running: true,
      isError: false,
      argsRaw: '{"command":"ls"}',
      resultText: undefined,
      envelope: undefined,
      cwd: '/repo',
    })
    expect(model.state).toBe('running')
    expect(model.title).toBeUndefined()
    expect(model.summary).toBe('{"command":"ls"}')
    expect(model.filePath).toBeUndefined()
    expect(model.inputText).toBe('{"command":"ls"}')
    expect(model.outputText).toBeUndefined()
    expect(model.expandable).toBe(true)
  })

  it('failed：state=error；无信封 → OUT 回退 resultText', () => {
    const model = acpToolRowModel({
      running: false,
      isError: true,
      argsRaw: '{}',
      resultText: 'boom',
      envelope: undefined,
      cwd: undefined,
    })
    expect(model.state).toBe('error')
    expect(model.outputText).toBe('boom')
    expect(model.title).toBeUndefined()
  })

  it('多 location：summary 带 +N 计数，filePath 缺席（不是单文件行）', () => {
    const model = acpToolRowModel({
      running: false,
      isError: false,
      argsRaw: undefined,
      resultText: undefined,
      envelope: {
        version: 1,
        title: 'Search',
        status: 'completed',
        locations: [{ path: '/repo/a.ts' }, { path: '/repo/src/b.ts' }],
        content: [],
      },
      cwd: '/repo',
    })
    expect(model.summary).toBe('a.ts +1')
    expect(model.filePath).toBeUndefined()
    // content 空且无 input → 无展开体
    expect(model.expandable).toBe(false)
  })

  it('image/resource/terminal 项汇入 OUT 事实行；image 字节不可得（ref + 元数据行）', () => {
    const model = acpToolRowModel({
      running: false,
      isError: false,
      argsRaw: undefined,
      resultText: undefined,
      envelope: {
        version: 1,
        title: 'T',
        status: 'completed',
        content: [
          { type: 'image', ref: 'sha256:abc', mimeType: 'image/png', size: 8 },
          { type: 'resource', uri: 'file:///x.txt', summary: 'body' },
          { type: 'terminal', terminalId: 'term-1', text: '[terminal 占位] term-1' },
        ],
      },
      cwd: undefined,
    })
    expect(model.outputText).toBe('[Image] sha256:abc (image/png, 8 bytes)\nfile:///x.txt\nbody\n[terminal 占位] term-1')
    expect(model.diffs).toEqual([])
  })
})
