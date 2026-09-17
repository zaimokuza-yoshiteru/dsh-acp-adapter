import { describe, expect, it } from 'vitest'
import { buildCatalogEntries } from '../../../src/client/data/catalog.ts'

describe('snapshot-owned launch defaults', () => {
  it.each(['codex-acp', 'claude-acp', 'devin', 'kimi', 'future-agent'])('uses new snapshot args/env and package command for %s', id => {
    const agent = { id, name: id, version: '2', distribution: { npx: { package: `${id}@2` } } }
    const executable = { kind: 'npx', version: '2', command: 'new-entry', args: ['--new-acp'], env: { NEW_MODE: '1' } }
    const entry = buildCatalogEntries([agent], { [id]: executable })[0]!
    expect(entry).toMatchObject({ command: 'new-entry', args: ['--new-acp'], env: { NEW_MODE: '1' } })
    expect(entry.args).not.toBe(executable.args)
    expect(entry.env).not.toBe(executable.env)
    if (id === 'future-agent') expect(entry.runtime).toBeUndefined()
  })

  it.each([['devin', 'devin'], ['kimi', 'kimi'], ['poolside', '']])('supplements only known installed binary commands for %s', (id, command) => {
    const agent = { id, name: id, version: '2', website: 'https://example.com/install', distribution: { binary: {} } }
    const executable = { kind: 'binary', version: '2', command: '', args: ['acp', '--new-flag'], env: { ACP_MODE: '1' } }
    expect(buildCatalogEntries([agent], { [id]: executable })[0]).toMatchObject({
      command, args: executable.args, env: executable.env, requiresCommand: command === '',
      installHint: 'https://example.com/install',
    })
  })
})
