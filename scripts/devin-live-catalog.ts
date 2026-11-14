import assert from 'node:assert/strict'

const requiredTools = [
  'subagent',
  'send_message',
  'list_agents',
  'wait_agent',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
]
interface CatalogTool {
  readonly name: string
  readonly schema: {
    readonly [key: string]: unknown
    readonly properties?: Record<string, unknown>
    readonly required?: readonly string[]
  }
}

/** Only native catalog facts; no claim about which tools the external model chose. */
export function assertDevinLiveCatalog(native: readonly CatalogTool[], mcp: readonly CatalogTool[]): void {
  for (const tools of [native, mcp]) {
    for (const name of requiredTools)
      assert.equal(tools.filter((tool) => tool.name === name).length, 1, `LIVE_CATALOG_REQUIRED_${name}`)
    const spawn = tools.find((tool) => tool.name === 'subagent')!.schema
    const send = tools.find((tool) => tool.name === 'send_message')!.schema
    assert.ok(
      spawn.properties?.name && spawn.properties.description && spawn.properties.prompt,
      'LIVE_CATALOG_SUBAGENT_SCHEMA',
    )
    assert.ok(!Object.hasOwn(spawn.properties, 'context'), 'LIVE_CATALOG_OBSOLETE_CONTEXT')
    assert.ok(
      spawn.required?.includes('description') && spawn.required.includes('prompt'),
      'LIVE_CATALOG_SUBAGENT_REQUIRED',
    )
    assert.ok(send.required?.includes('agent') && send.required.includes('message'), 'LIVE_CATALOG_SEND_REQUIRED')
    assert.ok(send.properties?.agent && !Object.hasOwn(send.properties, 'target'), 'LIVE_CATALOG_SEND_SCHEMA')
  }
  assert.deepEqual(
    mcp.map((tool) => tool.name).sort(),
    native.map((tool) => tool.name).sort(),
    'LIVE_CATALOG_BRIDGE_MISMATCH',
  )
  for (const tool of native)
    assert.deepEqual(
      mcp.find((candidate) => candidate.name === tool.name)?.schema,
      tool.schema,
      'LIVE_CATALOG_SCHEMA_MISMATCH',
    )
}
