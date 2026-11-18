import { describe, expect, it } from 'vitest'
import { buildCatalogEntries } from '../../../src/client/data/catalog.ts'

describe('snapshot-owned launch defaults', () => {
  it('marks Qwen adapter coverage independently of registry version and generic runtime identity', () => {
    const entries = buildCatalogEntries(
      [
        { id: 'future-agent', name: 'Future Agent', version: '99' },
        { id: 'qwen-code', name: 'Qwen Code', version: '99' },
      ],
      {
        'qwen-code': { kind: 'npx', version: '100', command: 'qwen', args: ['--acp'], env: {} },
      },
    )
    expect(entries.map((entry) => [entry.id, entry.verification])).toEqual([
      ['qwen-code', 'adapter-tested'],
      ['future-agent', 'unverified'],
    ])
    expect(entries[0]).toMatchObject({ version: '100', command: 'qwen', args: ['--acp'] })
    expect(entries[0]?.runtime).toBeUndefined()
    expect(entries[1]?.runtime).toBeUndefined()
  })

  it.each(['codex-acp', 'claude-acp', 'devin', 'future-agent'])(
    'uses new snapshot args/env and package command for %s',
    (id) => {
      const agent = { id, name: id, version: '2', distribution: { npx: { package: `${id}@2` } } }
      const executable = {
        kind: 'npx',
        version: '2',
        command: 'new-entry',
        args: ['--new-acp'],
        env: { NEW_MODE: '1' },
      }
      const entry = buildCatalogEntries([agent], { [id]: executable })[0]!
      expect(entry).toMatchObject({ command: 'new-entry', args: ['--new-acp'], env: { NEW_MODE: '1' } })
      expect(entry.args).not.toBe(executable.args)
      expect(entry.env).not.toBe(executable.env)
      if (id === 'future-agent') expect(entry.runtime).toBeUndefined()
    },
  )

  it.each([
    ['devin', 'devin'],
    ['claude-acp', 'claude-agent-acp'],
    ['poolside', ''],
  ])('supplements only known installed binary commands for %s', (id, command) => {
    const agent = {
      id,
      name: id,
      version: '2',
      website: 'https://example.com/install',
      repository: 'https://example.com/source',
      distribution: { binary: {} },
    }
    const executable = {
      kind: 'binary',
      version: '2',
      command: '',
      args: ['acp', '--new-flag'],
      env: { ACP_MODE: '1' },
    }
    expect(buildCatalogEntries([agent], { [id]: executable })[0]).toMatchObject({
      command,
      args: executable.args,
      env: executable.env,
      requiresCommand: command === '',
      installHint: 'https://example.com/install',
    })
  })

  it('keeps the installed Claude command and one repository guide when binary archives are added alongside npx', () => {
    const agent = {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.106.0',
      repository: 'https://github.com/agentclientprotocol/claude-agent-acp',
      distribution: {
        npx: { package: '@agentclientprotocol/claude-agent-acp@0.106.0' },
        binary: {
          'linux-x86_64': { archive: 'https://example.com/claude.tar.gz', cmd: './claude-agent-acp' },
          'windows-x86_64': { archive: 'https://example.com/claude.zip', cmd: './claude-agent-acp.exe' },
        },
      },
    }
    const executable = {
      kind: 'binary',
      manualReason: 'host-platform-required',
      version: '0.106.0',
      command: '',
      args: ['--new-acp'],
      env: { ACP_MODE: '1' },
    }
    const entry = buildCatalogEntries([agent], { 'claude-acp': executable })[0]!
    expect(entry).toMatchObject({
      command: 'claude-agent-acp',
      args: ['--new-acp'],
      env: { ACP_MODE: '1' },
      requiresCommand: false,
      installHint: agent.repository,
      runtime: 'claude',
      loginHint: 'claude',
    })
    expect(entry.args).not.toBe(executable.args)
    expect(entry.env).not.toBe(executable.env)
  })

  it('retains platform download guidance when a binary Agent has no website or repository', () => {
    const entry = buildCatalogEntries(
      [
        {
          id: 'future-agent',
          name: 'Future Agent',
          distribution: {
            binary: {
              'linux-x86_64': { archive: 'https://example.com/agent.tar.gz', cmd: './agent' },
              'windows-x86_64': { archive: 'https://example.com/agent.zip', cmd: './agent.exe' },
            },
          },
        },
      ],
      {},
    )[0]!
    expect(entry).toMatchObject({
      command: '',
      requiresCommand: true,
      installHint: 'linux-x86_64: https://example.com/agent.tar.gz\nwindows-x86_64: https://example.com/agent.zip',
    })
  })

  it('excludes both retired Kimi catalog identities without excluding unrelated Agents', () => {
    const entries = buildCatalogEntries(
      [
        { id: 'kimi', name: 'Kimi Legacy' },
        { id: 'kimi-code', name: 'Kimi Code' },
        { id: 'kimchi', name: 'Kimchi' },
        { id: 'claude-acp', name: 'Claude Agent' },
      ],
      {},
    )
    expect(entries.map((entry) => entry.id)).toEqual(['claude-acp', 'kimchi'])
  })
})
