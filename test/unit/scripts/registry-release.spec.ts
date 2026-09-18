import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const agent = (id: string, version: string) => ({ id, name: id, description: 'Fixture', version, distribution: { npx: { package: `${id}@${version}` } } })
const baseline = { version: '1', agents: [agent('example', '1.0.0'), agent('removed', '1.0.0')] }
const executables = { entries: Object.fromEntries(baseline.agents.map(item => [item.id, { version: item.version, kind: 'npx', command: item.id, args: [], env: {} }])) }
const candidate = { version: '1', agents: [agent('example', '2.0.0'), agent('added', '1.0.0')] }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'registry-release-'))
  temporary.push(directory)
  const target = join(directory, 'target'), evidence = join(directory, 'evidence')
  mkdirSync(target)
  const reset = () => {
    writeFileSync(join(target, 'registry.json'), JSON.stringify(baseline))
    writeFileSync(join(target, 'executables.json'), JSON.stringify(executables))
  }
  reset()
  const mock = join(directory, 'fetch.mjs')
  const run = (fault = '', upstream = candidate, sha = 'test-commit') => {
    writeFileSync(mock, `
      globalThis.fetch = async url => {
        if (${JSON.stringify(fault)} === 'network') throw new Error('fixture network unavailable')
        if (String(url).includes('cdn.agentclientprotocol.com')) {
          if (${JSON.stringify(fault)} === 'http') return new Response('unavailable', {status:503})
          if (${JSON.stringify(fault)} === 'json') return new Response('{')
          return new Response(${JSON.stringify(JSON.stringify(upstream))})
        }
        if (${JSON.stringify(fault)} === 'package') throw new Error('fixture npm unavailable')
        const bin = ${JSON.stringify(fault)} === 'ambiguous' ? {first:'a.js',second:'b.js'} : {[String(url).split('/').pop()]:'index.js'}
        return new Response(JSON.stringify({versions:{'1.0.0':{bin},'2.0.0':{bin}}}))
      }
    `)
    return spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve('scripts/sync-release-registry.ts'), '--reuse', '--directory', target, '--evidence', evidence], {
      encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') },
    })
  }
  const report = () => JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'))
  return { directory, target, evidence, run, reset, report }
}

describe('optional Registry refresh for releases', () => {
  it('selects a complete new snapshot and describes additions, removals and updates', () => {
    const f = fixture(), result = f.run()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(f.target, 'registry.json'), 'utf8'))).toEqual(candidate)
    expect(f.report()).toMatchObject({ status: 'updated', agentCount: 2, changes: { added: ['added'], removed: ['removed'], updated: [{ id: 'example', from: '1.0.0', to: '2.0.0', executableChanged: false }] } })
    for (const name of ['registry.json', 'executables.json']) expect(readFileSync(join(f.target, name))).toEqual(readFileSync(join(f.evidence, name)))
    expect(readFileSync(join(f.directory, 'summary'), 'utf8')).toContain('Added: 1; removed: 1; updated: 1')
  })

  it('reports launch changes separately from version-only updates', () => {
    const f = fixture()
    const upstream = { ...candidate, agents: candidate.agents.map(item => ({ ...item, distribution: { npx: { ...item.distribution.npx, args: ['--acp'] } } })) }
    expect(f.run('', upstream).status).toBe(0)
    expect(f.report().changes.updated[0]).toMatchObject({ id: 'example', executableChanged: true })
  })

  it('reports an unchanged catalog without a fallback alert', () => {
    const f = fixture()
    expect(f.run('', baseline).status).toBe(0)
    expect(f.report()).toMatchObject({ status: 'unchanged', changes: { added: [], removed: [], updated: [] } })
    expect(f.report().error).toBeUndefined()
  })

  it.each(['network', 'http', 'json', 'package', 'ambiguous', 'invalid'])('keeps both old files byte-for-byte and succeeds on %s failure', fault => {
    const f = fixture()
    const before = ['registry.json', 'executables.json'].map(name => readFileSync(join(f.target, name)))
    const upstream = fault === 'invalid' ? { ...candidate, agents: [...candidate.agents, candidate.agents[0]!] } : candidate
    const result = f.run(fault, upstream)
    expect(result.status, result.stderr).toBe(0)
    expect(f.report()).toMatchObject({ status: 'fallback', changes: { added: [], removed: [], updated: [] } })
    expect(f.report().error).toBeTruthy()
    expect(['registry.json', 'executables.json'].map(name => readFileSync(join(f.target, name)))).toEqual(before)
    expect(readFileSync(join(f.directory, 'output'), 'utf8')).toContain('status=fallback')
  })

  it('still fails when the committed fallback itself is invalid', () => {
    const f = fixture()
    writeFileSync(join(f.target, 'executables.json'), '{}')
    const result = f.run('network')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('executables.entries must be an object')
  })

  it.each(['', 'network'])('reuses the first selected snapshot on workflow retry (%s)', fault => {
    const f = fixture()
    expect(f.run(fault).status).toBe(0)
    const original = f.report()
    f.reset() // actions/checkout restores the same tagged source before a rerun.
    expect(f.run(fault ? '' : 'network').status).toBe(0)
    expect(f.report()).toEqual(original)
    expect(JSON.parse(readFileSync(join(f.target, 'registry.json'), 'utf8'))).toEqual(fault ? baseline : candidate)
  })

  it.each(['tampered', 'other-commit'])('rejects a %s checkpoint instead of silently changing release inputs', fault => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    f.reset()
    if (fault === 'tampered') writeFileSync(join(f.evidence, 'registry.json'), `${JSON.stringify(candidate)}\n `)
    expect(f.run('', candidate, fault === 'other-commit' ? 'different' : 'test-commit').status).not.toBe(0)
  })
})

const notify = createRequire(import.meta.url)(resolve('scripts/report-registry-sync.cjs'))
describe('non-blocking Registry issue notification', () => {
  const context = { repo: { owner: 'owner', repo: 'repo' }, serverUrl: 'https://github.com', runId: 42 }
  function notification(existing: unknown[] = []) {
    const f = fixture()
    mkdirSync(f.evidence)
    writeFileSync(join(f.evidence, 'report.json'), JSON.stringify({ status: 'fallback' }))
    writeFileSync(join(f.evidence, 'summary.md'), 'Registry HTTP 503; retained old snapshot')
    const result = { data: { html_url: 'https://github.com/owner/repo/issues/1' } }
    const issues = { listForRepo: vi.fn(), create: vi.fn().mockResolvedValue(result), update: vi.fn().mockResolvedValue(result) }
    const github = { paginate: vi.fn().mockResolvedValue(existing), rest: { issues } }
    const core = { notice: vi.fn(), warning: vi.fn(), summary: { addRaw: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue(undefined) } }
    return { f, issues, github, core }
  }
  it('opens a tracking issue with the workflow link on the first failure', async () => {
    const n = notification()
    await notify({ github: n.github, context, core: n.core }, n.f.evidence)
    expect(n.issues.create).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('https://github.com/owner/repo/actions/runs/42') }))
    expect(n.core.warning).not.toHaveBeenCalled()
  })
  it('updates an existing open bot issue without creating a duplicate', async () => {
    const n = notification([{ number: 7, body: '<!-- dsh-acp-registry-sync-fallback -->' }])
    await notify({ github: n.github, context, core: n.core }, n.f.evidence)
    expect(n.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7 }))
    expect(n.issues.create).not.toHaveBeenCalled()
  })
  it('does not fail the release when GitHub issue permissions are unavailable', async () => {
    const n = notification()
    n.issues.create.mockRejectedValue(new Error('HTTP 403'))
    await expect(notify({ github: n.github, context, core: n.core }, n.f.evidence)).resolves.toBeUndefined()
    expect(n.core.warning).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'))
  })
})
