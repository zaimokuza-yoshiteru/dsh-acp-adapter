import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { mcpServersForCapabilities } from '../../../src/runtime/session/session-runtime.ts'

const stdio: acp.McpServer = { name: 'local', command: '/usr/local/bin/mcp', args: [], env: [] }
const http: acp.McpServer = { type: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [] }

describe('ACP M5 session inputs', () => {
  it('keeps trusted definitions unchanged and rejects an unadvertised transport before session RPC', () => {
    expect(mcpServersForCapabilities([stdio], { mcpCapabilities: {} })).toEqual([stdio])
    expect(mcpServersForCapabilities([http], { mcpCapabilities: { http: true } })).toEqual([http])
    expect(() => mcpServersForCapabilities([http], { mcpCapabilities: {} })).toThrow('ACP_MCP_UNSUPPORTED')
  })

  it('does not expose MCP definitions or credential values when no resolver is configured', () => {
    expect(mcpServersForCapabilities([], undefined)).toEqual([])
    expect(JSON.stringify(mcpServersForCapabilities([], undefined))).not.toContain('token')
  })
})
