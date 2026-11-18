import { expect, it } from 'vitest'
import { assertDevinLiveCatalog } from '../../../scripts/devin-live-catalog.ts'
import { classifyDevinCliTool } from '../../../scripts/devin-live-cli-tool.ts'

const tools: Array<Parameters<typeof assertDevinLiveCatalog>[0][number]> = [
  {
    name: 'subagent',
    schema: {
      type: 'object',
      properties: { name: {}, description: {}, prompt: {} },
      required: ['description', 'prompt'],
    },
  },
  {
    name: 'send_message',
    schema: { type: 'object', properties: { agent: {}, message: {} }, required: ['agent', 'message'] },
  },
  ...['list_agents', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'].map(
    (name) => ({ name, schema: { type: 'object', properties: {} } }),
  ),
]
it('requires the admitted native directory and full bridge schemas before a paid run can start', () => {
  expect(() => assertDevinLiveCatalog(tools, structuredClone(tools))).not.toThrow()
  expect(() =>
    assertDevinLiveCatalog(
      tools.filter((tool) => tool.name !== 'subagent'),
      tools,
    ),
  ).toThrow('LIVE_CATALOG_REQUIRED_subagent')
  expect(() =>
    assertDevinLiveCatalog(
      tools,
      tools.filter((tool) => tool.name !== 'send_message'),
    ),
  ).toThrow('LIVE_CATALOG_REQUIRED_send_message')
  const stale = structuredClone(tools)
  stale[1] = {
    name: 'send_message',
    schema: { type: 'object', properties: { target: {}, message: {} }, required: ['target', 'message'] },
  }
  expect(() => assertDevinLiveCatalog(tools, stale)).toThrow('LIVE_CATALOG_SEND_REQUIRED')
})
it('distinguishes exact DSH calls from discovery and private delegation without printing identifiers', () => {
  expect(classifyDevinCliTool('mcp__dsh__subagent', undefined, undefined)).toBe('dsh-subagent')
  expect(classifyDevinCliTool('call_mcp_tool', 'send_message', 'dsh')).toBe('dsh-send-message')
  expect(classifyDevinCliTool('call_mcp_tool', 'subagent', 'other')).toBe('mcp-dispatch')
  expect(classifyDevinCliTool('subagent', undefined, undefined)).toBe('native-subagent')
  expect(classifyDevinCliTool('list_mcp_tools', 'private-query', 'private-server')).toBe('mcp-discovery')
  expect(classifyDevinCliTool('private-tool-name', 'private-query', 'private-server')).toBe('other')
})
