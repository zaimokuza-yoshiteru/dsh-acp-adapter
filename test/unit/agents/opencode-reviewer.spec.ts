import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeReviewer } from '../../../src/host/approval-review/opencode/reviewer.ts'
import {
  isLocalOpenCodeReviewProfile,
  isOpenCodeReviewModel,
  isOpenCodeReviewerAgent,
} from '../../../src/contract/opencode-review.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

it('recognizes only the verified native command, version and explicit model', () => {
  expect(isOpenCodeReviewerAgent({ name: 'OpenCode', version: '2.3.2' })).toBe(true)
  expect(isOpenCodeReviewerAgent({ name: 'OpenCode', version: '1.19.4' })).toBe(false)
  expect(isLocalOpenCodeReviewProfile({ command: '/bin/opencode', args: ['acp'] })).toBe(true)
  expect(isLocalOpenCodeReviewProfile({ command: 'ssh', args: ['host', 'opencode', 'acp'] })).toBe(false)
  expect(isLocalOpenCodeReviewProfile({ command: 'opencode', args: ['acp', '--auto'] })).toBe(false)
  expect(isOpenCodeReviewModel('openrouter/vendor/model')).toBe(true)
  for (const id of ['default', '/broken', 'model/', 'provider//id', 'provider/model#unparsed', 'provider/model\n'])
    expect(isOpenCodeReviewModel(id)).toBe(false)
})

const fixture = `#!/usr/bin/env node
const fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path')
const dir = process.env.HOME,
  mode = process.env.PROBE_TOKEN,
  log = (r) => fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(r) + '\\n')
const base = fs.realpathSync(process.env.OPENCODE_CONFIG_DIR || path.join(dir, '.config/opencode'))
let checked = 0
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (
    req.headers.authorization !==
    'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')
  ) {
    res.writeHead(403).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  log({
    path: url.pathname,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    body: raw ? JSON.parse(raw) : undefined,
  })
  const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o))
  if (url.pathname === '/api/info') send({ version: mode === 'old' ? '1.19.4' : '2.3.2', urls: [origin] })
  else if (url.pathname === '/api/model') send({ location: { directory: base }, data: [{providerID:'local', id:mode==='missing-model' ? 'other':'example', package:mode==='agent-model'?'claude-agent':'@opencode/ai/providers/openai-compatible'}] })
  else if (['/api/mcp', '/api/plugin'].includes(url.pathname)) {
    if (url.searchParams.get('location[directory]') !== base) throw Error('wrong location')
    ++checked
    send({
      location: { directory: mode === 'location' ? '/other' : base },
      data:
        (mode === 'plugin' && url.pathname === '/api/plugin') ||
        (mode === 'mcp' && url.pathname === '/api/mcp') ||
        (mode === 'late' && checked > 2)
          ? [{}]
          : [],
    })
  } else if (mode === 'change-origin') {
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({plugins:['external']}))
    send({data:{text: JSON.stringify({risk:'not_high',reason:'Routine'})}})
  } else if (mode === 'wait') {
  } else
    send({
      data: {
        text: mode === 'invalid' ? 'invalid' : JSON.stringify({ risk: 'not_high', reason: 'Test only' }),
      },
    })
})
let origin
server.listen(0, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port
  console.log(JSON.stringify({ url: origin }))
})
process.stdin.resume()
process.stdin.on('end', () => {
  server.closeAllConnections()
  server.close()
})`

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('OpenCode stateless reviewer', () => {
  let dir: string, reviewer: OpenCodeReviewer
  const request = (mode: string, signal = new AbortController().signal, env: Record<string, string> = {}) =>
    reviewer.review({
      actorCwd: dir,
      profile: {
        command: join(dir, 'opencode'),
        args: ['acp'],
        env: { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), PROBE_TOKEN: mode, ...env },
      },
      task: 'test secret task marker',
      model: 'local/example',
      toolCall: { toolCallId: 'a', name: 'read', rawInput: { path: 'README.md' } },
      locale: 'en',
      signal,
    })
  const records = async () =>
    (await readFile(join(dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'opencode-reviewer-test-')))
    await mkdir(join(dir, '.config/opencode'), { recursive: true })
    await writeFile(join(dir, 'calls'), '')
    await writeFile(join(dir, 'opencode'), fixture, { mode: 0o700 })
    reviewer = new OpenCodeReviewer({ ...(await sharedTestSubprocess()).seam, localExecution: true })
  })
  afterEach(async () => {
    await reviewer.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  it('passes the explicit model and only the risk prompt in an authenticated POST, cleans its private cwd', async () => {
    expect((await request('ok')).risk).toBe('not_high')
    const calls = await records()
    const generate = calls.find((c) => c.body)
    expect(generate.path).toBe('/api/experimental/generate/text')
    expect(Object.keys(generate.body).sort()).toEqual(['model', 'prompt'])
    expect(generate.body.model).toEqual({ providerID: 'local', id: 'example' })
    expect(generate.argv).not.toContainEqual(expect.stringContaining('secret task'))
    expect(existsSync(generate.cwd)).toBe(false)
  })
  it.each(['plugin', 'mcp', 'old', 'location', 'missing-model', 'agent-model', 'invalid', 'late', 'change-origin'])(
    'hands %s off to manual review',
    async (mode) => {
      const code =
        mode === 'invalid' ? 'invalid-response' : mode === 'missing-model' ? 'model-unavailable' : 'unverified-reviewer'
      await expect(request(mode)).rejects.toMatchObject({ code })
      const calls = await records()
      expect(calls.some((c) => c.body)).toBe(['invalid', 'late', 'change-origin'].includes(mode))
      expect(existsSync(calls[0].cwd)).toBe(false)
    },
  )
  it('stops an in-flight HTTP generation on disposal', async () => {
    const result = request('wait')
    void result.catch(() => {})
    await vi.waitFor(async () => {
      expect((await records()).some((c) => c.body)).toBe(true)
    })
    await reviewer.dispose()
    await expect(result).rejects.toThrow()
    expect(existsSync((await records())[0].cwd)).toBe(false)
  })
  it.each(['.opencode/plugins', '.opencode/tools', '.config/opencode/plugins'])(
    'declines declared extension %s before spawning',
    async (subdir) => {
      await mkdir(join(dir, subdir), { recursive: true })
      await writeFile(join(dir, subdir, 'shadow.js'), 'throw new Error("must not load")')
      await expect(request('ok')).rejects.toThrow()
      expect(await records()).toEqual([])
    },
  )
  it('checks configured extensions in parent JSONC and preserves ordinary model settings', async () => {
    await writeFile(
      join(dir, 'opencode.jsonc'),
      '{/* comment */ "providers":{"test":{"package":"@opencode/ai/providers/openai-compatible"}},}',
    )
    expect((await request('ok')).risk).toBe('not_high')
    await writeFile(join(dir, 'opencode.jsonc'), '{"plugins":["custom-tool"],}')
    await expect(request('ok')).rejects.toThrow()
  })
  it('checks the actual global configuration directory used by Generate', async () => {
    const base = join(dir, 'explicit')
    await mkdir(base)
    const env = { OPENCODE_CONFIG_DIR: base }
    expect((await request('ok', undefined, env)).risk).toBe('not_high')
    await writeFile(join(base, 'opencode.json'), JSON.stringify({ mcp: { remote: {} } }))
    await expect(request('ok', undefined, env)).rejects.toThrow()
    expect((await records()).filter((c) => c.body)).toHaveLength(1)
  })

  it('ignores documentation but declines unknown directories and linked tools', async () => {
    const base = join(dir, '.opencode', 'plugins')
    await mkdir(base, { recursive: true })
    for (const name of ['README.md', '.DS_Store']) await writeFile(join(base, name), '')
    expect((await request('ok')).risk).toBe('not_high')
    await symlink(join(base, 'README.md'), join(base, 'other.js'))
    await expect(request('ok')).rejects.toThrow()
    await rm(join(base, 'other.js'))
    await mkdir(join(base, 'package'))
    await expect(request('ok')).rejects.toThrow()
    expect((await records()).filter((c) => c.body)).toHaveLength(1)
  })

  it('checks provider and model transports in both config formats before spawning', async () => {
    const config = join(dir, 'opencode.json')
    const set = async (data: unknown) => writeFile(config, JSON.stringify(data))
    for (const data of [
      { providers: { local: { models: { x: { package: 'file:///tmp/unknown.js' } } } } },
      { provider: { local: { models: { x: { provider: { npm: '@ai-sdk/unknown' } } } } } },
      { providers: { local: { package: '@opencode/ai/providers/fake' } } },
      { providers: { local: { models: { x: { settings: { body: { tools: ['unexpected'] } } } } } } },
    ]) {
      await set(data)
      await expect(request('ok')).rejects.toThrow()
    }
    expect(await records()).toEqual([])
    await set({
      providers: {
        local: {
          package: '@opencode/ai/providers/azure',
          models: { x: { package: '@opencode/ai/providers/azure/responses' } },
        },
      },
    })
    expect((await request('ok')).risk).toBe('not_high')
  })

  it('checks native remote org and well-known config presence without reading credential values', async () => {
    const store = join(dir, 'data', 'opencode')
    await mkdir(store, { recursive: true })
    const env = { XDG_DATA_HOME: join(dir, 'data') }
    const db = new DatabaseSync(join(store, 'opencode.db'))
    try {
      db.exec(
        'CREATE TABLE account_state(active_org_id); CREATE TABLE control_account(active); CREATE TABLE kv(key,value)',
      )
      for (const [table, values] of [
        ['kv', "'wellknown:sources','[{}]'"],
        ['account_state', "'org'"],
        ['control_account', '1'],
      ]) {
        db.exec('INSERT INTO ' + table + ' VALUES(' + values + ')')
        await expect(request('ok', undefined, env)).rejects.toThrow()
        db.exec('DELETE FROM ' + table)
      }
      expect(await records()).toEqual([])
      expect((await request('ok', undefined, env)).risk).toBe('not_high')
    } finally {
      db.close()
    }
  })
  it('refuses effective actor code preloads but allows ordinary Node or desktop controls', async () => {
    for (const loader of [
      { LD_PRELOAD: '/opt/plugin.so' },
      { LD_AUDIT: '/opt/audit.so' },
      { DYLD_INSERT_LIBRARIES: '/opt/plugin.dylib' },
      { NODE_OPTIONS: '--trace-warnings --import=file:///opt/extension.mjs' },
      { NODE_OPTIONS: '-r/opt/bootstrap.cjs' },
    ] as Record<string, string>[]) {
      await expect(request('ok', undefined, loader)).rejects.toThrow()
    }
    vi.stubEnv('NODE_OPTIONS', '--loader=/opt/module.mjs')
    try {
      await expect(request('ok')).rejects.toThrow()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await records()).toEqual([])
    expect(
      (
        await request('ok', undefined, {
          NODE_OPTIONS: '--no-warnings --max-old-space-size=768',
          ELECTRON_RUN_AS_NODE: '1',
        })
      ).risk,
    ).toBe('not_high')
  })
})
