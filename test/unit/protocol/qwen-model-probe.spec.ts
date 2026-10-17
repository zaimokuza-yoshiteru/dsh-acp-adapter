import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const fixture = fileURLToPath(new URL('../../fixtures/qwen-ui-agent.mjs', import.meta.url))
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Qwen model-directory discovery', () => {
  it.each(['qwen-code', 'generic-acp'])(
    'only automatically probes per-model configuration for %s',
    async (agentName) => {
      const directory = mkdtempSync(join(tmpdir(), 'qwen-model-probe-'))
      directories.push(directory)
      const log = join(directory, 'wire.jsonl')
      const result = await AcpClientConnection.probe(
        {
          argv: [process.execPath, fixture],
          cwd: directory,
          env: { QWEN_UI_LOG: log, QWEN_UI_AGENT_NAME: agentName },
          subprocess: (await sharedTestSubprocess()).seam,
        },
        { cwd: directory, timeoutMs: 5_000, eofGraceMs: 100, termGraceMs: 300 },
      )
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; value?: string })
      expect(events.filter((entry) => entry.method === 'session/prompt')).toEqual([])
      const selected = events
        .filter((entry) => entry.method === 'session/set_config_option')
        .map((entry) => entry.value)
      if (agentName !== 'qwen-code') {
        expect(result.modelConfigOptions).toBeUndefined()
        expect(selected).toEqual([])
        return
      }
      expect(selected).toEqual(['qwen-levels', 'qwen-basic'])
      const efforts = (model: string) =>
        result.modelConfigOptions?.[model]?.find((option) => option.id === 'reasoning_effort')
      const values = (model: string) => {
        const option = efforts(model)
        return option?.type === 'select'
          ? option.options
              .flatMap((entry) => ('options' in entry ? entry.options : [entry]))
              .map((entry) => entry.value)
          : []
      }
      expect(values('qwen-toggle')).toEqual(['none', 'high'])
      expect(values('qwen-levels')).toEqual(['none', 'low', 'medium', 'xhigh'])
      expect(efforts('qwen-basic')).toBeUndefined()
      expect(result.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('qwen-toggle')
    },
  )
})
