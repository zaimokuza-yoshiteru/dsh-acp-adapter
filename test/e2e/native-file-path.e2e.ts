import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

const scaffold = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(process.cwd(), '../reference/deepseek-harness')
const { toolRowModel } = (await import(
  pathToFileURL(resolve(scaffold, 'packages/client/ui-tool/src/client/tool/models/tool-call-model.ts')).href
)) as { toolRowModel: (name: string, block: ToolCallBlock, cwd?: string) => { filePath: string | undefined } }

// The producer's focused unit tests verify which ACP locations may populate path.
// This source-scaffold check verifies the native consumer after cwd changes.
it.each([
  ['/operation/workspace/src/file.ts', '/new/workspace'],
  ['C:\\operation\\workspace\\src\\file.ts', 'C:\\new\\workspace'],
  ['\\\\server\\share\\src\\file.ts', '\\\\server\\other'],
])('keeps the recorded file location %s when the session cwd becomes %s', (recorded, currentCwd) => {
  const argsRaw = '{"file_path":"src/file.ts"}'
  const block: ToolCallBlock = {
    kind: 'tool-result',
    callId: 'acp:owner:prompt:read',
    name: 'read',
    args: PartialArguments.fromText(argsRaw),
    call: { name: 'read', argsRaw },
    seq: 1,
    time: 1,
    callTime: null,
    content: [{ type: 'text', text: '1\tcontent' }],
    isError: false,
    subCalls: [],
    meta: { path: recorded },
  }
  expect(toolRowModel('read', block, currentCwd).filePath).toBe(recorded)
  expect(block.args.text('file_path')).toBe('src/file.ts')
})
