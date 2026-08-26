import { describe, expect, it } from 'vitest'
import { acpMcpFingerprint, acpMcpServersOf, acpMcpSnapshot } from '../../../src/domain/session/mcp.ts'

describe('profile-owned ACP MCP configuration', () => {
  it('normalizes stdio/http/sse and resolves environment references only at dispatch', () => {
    const servers = acpMcpServersOf([
      { type: 'stdio', name: 'local', command: '/usr/local/bin/mcp', args: ['--safe'], env: { TOKEN: { valueFromEnv: 'MCP_TOKEN' } } },
      { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: { Authorization: { valueFromEnv: 'MCP_AUTH' }, Accept: 'application/json' } },
      { type: 'sse', name: 'events', url: 'https://example.test/events', headers: {} },
    ])
    expect(acpMcpSnapshot(servers, { MCP_TOKEN: 'secret', MCP_AUTH: 'Bearer secret' })).toEqual([
      { name: 'local', command: '/usr/local/bin/mcp', args: ['--safe'], env: [{ name: 'TOKEN', value: 'secret' }] },
      { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: [{ name: 'Accept', value: 'application/json' }, { name: 'Authorization', value: 'Bearer secret' }] },
      { type: 'sse', name: 'events', url: 'https://example.test/events', headers: [] },
    ])
  })

  it('rejects unsafe stdio and URL credential forms', () => {
    expect(() => acpMcpServersOf([{ type: 'stdio', name: 'bad', command: 'sh -c evil', args: [], env: {} }])).toThrow(/absolute executable path/)
    expect(() => acpMcpServersOf([{ type: 'http', name: 'bad', url: 'https://user:pass@example.test/mcp', headers: {} }])).toThrow(/credentials/)
  })

  it('fails before session setup when an environment reference is unavailable', () => {
    const servers = acpMcpServersOf([
      { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: { Authorization: { valueFromEnv: 'MCP_AUTH' } } },
    ])
    expect(() => acpMcpSnapshot(servers, {})).toThrow(/requires non-empty environment variable MCP_AUTH/)
  })

  it('fingerprints references by name/presence without including their values', () => {
    const servers = acpMcpServersOf([{ type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: { Authorization: { valueFromEnv: 'MCP_AUTH' } } }])
    const absent = acpMcpFingerprint(servers, {})
    const present = acpMcpFingerprint(servers, { MCP_AUTH: 'secret' })
    expect(absent).not.toBe(present)
    expect(absent).not.toContain('secret')
    expect(present).not.toContain('secret')
  })
})
