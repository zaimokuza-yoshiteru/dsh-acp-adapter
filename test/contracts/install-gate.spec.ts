import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  assertComposedDump,
  assertAcpConfigSentinel,
  assertTarballEntries,
  bootAndCheck,
  ownInstallHost,
  parseArgs,
  parseAuthenticatedStartupUrl,
  redactGateOutput,
  waitForAuthenticatedBootstrap,
} from '../../scripts/install-gate.ts'
import { DSH_SOURCE_TAG } from '../../scripts/dsh-target.ts'
import { findMissingRelativeRuntimeImports } from '../../scripts/verify-runtime-closure.ts'

describe('DSH clean-install gate contracts', () => {
  it('parses an isolated host and tarball without touching user profile state', () => {
    const parsed = parseArgs(['--host-root', '../alpha', '--tgz', './adapter.tgz', '--skip-boot'])
    expect(basename(parsed.hostRoot)).toBe('alpha')
    expect(parsed.tgz).toBeDefined()
    expect(basename(parsed.tgz!)).toBe('adapter.tgz')
    expect(parsed.spec).toBeUndefined()
    expect(parsed.updateSpec).toBeUndefined()
    expect(parsed.skipBoot).toBe(true)
  })

  it('accepts source specs and an optional explicit update spec without changing the tarball default', () => {
    expect(parseArgs(['--spec', '@zaimokuza/dsh-acp-adapter@0.2.0-rc.2.3'])).toMatchObject({
      tgz: undefined,
      spec: '@zaimokuza/dsh-acp-adapter@0.2.0-rc.2.3',
      updateSpec: undefined,
    })
    expect(
      parseArgs([
        '--spec',
        '@zaimokuza/dsh-acp-adapter@0.2.0-rc.2.2',
        '--update-spec',
        '@zaimokuza/dsh-acp-adapter@next',
      ]),
    ).toMatchObject({
      spec: '@zaimokuza/dsh-acp-adapter@0.2.0-rc.2.2',
      updateSpec: '@zaimokuza/dsh-acp-adapter@next',
    })
    expect(() => parseArgs(['--tgz', './adapter.tgz', '--spec', 'plugin'])).toThrow(/mutually exclusive/)
    expect(() => parseArgs(['--update-spec', '@zaimokuza/dsh-acp-adapter@next'])).toThrow(/requires --spec/)
  })

  it('requires the stock loop/picker rows and one additive adapter row', () => {
    const dump = [
      '- id: agent-loop\n  name: @deepseek-ai/dsh-agent-loop',
      '- id: ui-model-selection\n  name: @deepseek-ai/dsh-client-ui-model-selection',
      '- id: dsh-acp-adapter\n  name: @zaimokuza/dsh-acp-adapter',
    ].join('\n')
    expect(() => assertComposedDump(dump)).not.toThrow()
    expect(() => assertComposedDump(dump.replace('id: agent-loop', 'id: agent-loop\n  disabled: true'))).toThrow(
      /stock agent-loop row is disabled/,
    )
    expect(() => assertComposedDump(dump.replace('id: dsh-acp-adapter', 'id: other'))).toThrow(
      /additive dsh-acp-adapter row/,
    )
  })

  it('checks an explicit ACP setting in the composed profile', () => {
    const dump = [
      '- id: agent-loop\n  name: @deepseek-ai/dsh-agent-loop',
      '- id: ui-model-selection\n  name: @deepseek-ai/dsh-client-ui-model-selection',
      "- id: dsh-acp-adapter\n  name: '@zaimokuza/dsh-acp-adapter'\n  config:\n    toolApprovalDefault: ask",
    ].join('\n')
    expect(() => assertAcpConfigSentinel(dump)).not.toThrow()
    expect(() =>
      assertAcpConfigSentinel(dump.replace('toolApprovalDefault: ask', 'toolApprovalDefault: auto')),
    ).toThrow(/sentinel was not preserved/)
  })

  it('rejects legacy and development files from a published tarball', () => {
    const valid = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'LICENSE']
    expect(() => assertTarballEntries(valid)).not.toThrow()
    expect(() => assertTarballEntries([...valid, 'experiments/old/RESULTS.md'])).toThrow(/forbidden development/)
    expect(() => assertTarballEntries([...valid, 'lib/host-compat/agent-loop.js'])).toThrow(/forbidden development/)
  })

  it('catches a missing relative host runtime module in the tarball', () => {
    const files = [
      'lib/index.js',
      'lib/host/composition/index.js',
      'lib/host/composition/installed-profile-registry.js',
    ]
    const source = new Map([
      ['lib/index.js', 'export * from "./host/composition/index.js"'],
      ['lib/host/composition/index.js', 'import "./installed-profile-registry.js"'],
      ['lib/host/composition/installed-profile-registry.js', 'import "../../contract/config-options.js"'],
    ])
    expect(findMissingRelativeRuntimeImports(files, (file) => source.get(file) ?? '')).toEqual([
      {
        file: 'lib/host/composition/installed-profile-registry.js',
        specifier: '../../contract/config-options.js',
        resolved: 'lib/contract/config-options.js',
      },
    ])
    expect(
      findMissingRelativeRuntimeImports([...files, 'lib/contract/config-options.js'], (file) => source.get(file) ?? ''),
    ).toEqual([])
  })

  it('extracts the authenticated loopback URL without accepting an unauthenticated URL', () => {
    expect(parseAuthenticatedStartupUrl('starting\ndsh web: http://127.0.0.1:3199/?token=launch-secret\n')).toBe(
      'http://127.0.0.1:3199/?token=launch-secret',
    )
    expect(parseAuthenticatedStartupUrl('dsh web: http://127.0.0.1:3199/')).toBeUndefined()
    expect(parseAuthenticatedStartupUrl('dsh web: https://example.test/?token=secret')).toBeUndefined()
  })

  it('redacts bootstrap tokens and cookie-like credentials from diagnostics', () => {
    const safe = redactGateOutput(
      'dsh web: http://127.0.0.1:3199/?token=launch-secret\nCookie: dsh-session=session-secret\nBearer bearer-secret',
    )
    expect(safe).not.toContain('launch-secret')
    expect(safe).not.toContain('session-secret')
    expect(safe).not.toContain('bearer-secret')
    expect(safe).toContain('token=<redacted>')
  })

  it('waits for the startup URL and retries a transient authenticated 401', async () => {
    const outputs = ['starting', 'dsh web: http://127.0.0.1:3199/?token=launch-secret']
    let outputIndex = 0
    let rootAttempts = 0
    let fetchedBeforeUrl = false
    const requests: string[] = []
    const fetchImpl = async (input: URL | RequestInfo | Request, _init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (!parseAuthenticatedStartupUrl(outputs[Math.min(outputIndex - 1, outputs.length - 1)] ?? ''))
        fetchedBeforeUrl = true
      if (url.includes('?token=')) {
        return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-session=cookie-secret; Path=/' } })
      }
      rootAttempts += 1
      return rootAttempts === 1 ? new Response(null, { status: 401 }) : new Response('<__DSH_BOOT__>', { status: 200 })
    }
    const result = await waitForAuthenticatedBootstrap({
      readOutput: () => outputs[Math.min(outputIndex++, outputs.length - 1)] ?? '',
      fetchImpl,
      isAlive: () => true,
      timeoutMs: 100,
      intervalMs: 0,
    })
    expect(result.status).toBe(200)
    expect(requests).toHaveLength(4)
    expect(fetchedBeforeUrl).toBe(false)
  })

  it('boots concurrent hosts on their own ephemeral ports and closes both before returning', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-install-host-contract-'))
    try {
      mkdirSync(join(fixture, 'lib'))
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_SOURCE_TAG.slice(5) }),
      )
      writeFileSync(
        join(fixture, 'lib', 'bin.js'),
        `const { createServer } = require('node:http')
if (process.argv[process.argv.indexOf('--port') + 1] !== '0') process.exit(2)
const server = createServer((req, res) => {
  if (req.url.startsWith('/?token=')) {
    res.writeHead(303, { 'set-cookie': 'fixture=session; Path=/', location: '/' }).end()
  } else if (req.headers.cookie === 'fixture=session') {
    res.end('<__DSH_BOOT__>')
  } else res.writeHead(401).end()
})
server.listen(0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture-secret')
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`,
      )
      const results = await Promise.all([bootAndCheck(fixture, fixture), bootAndCheck(fixture, fixture)])
      const ports = results.map((result) => {
        expect(result.status).toBe(200)
        expect(result.output).not.toContain('fixture-secret')
        return Number(/127\.0\.0\.1:(\d+)/u.exec(result.output)?.[1])
      })
      expect(ports.every((port) => port > 0)).toBe(true)
      expect(new Set(ports).size).toBe(2)
      for (const port of ports) {
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'forces a host that ignores SIGTERM and waits for its close event',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const host = ownInstallHost(child, 25)
      let observedClose = false
      child.once('close', () => {
        observedClose = true
      })
      try {
        await once(child.stdout!, 'data')
        expect(host.isAlive()).toBe(true)
        await host.close()
        expect(observedClose).toBe(true)
        expect(child.signalCode).toBe('SIGKILL')
        expect(host.isAlive()).toBe(false)
        expect(() => process.kill(child.pid!, 0)).toThrow()
        await host.close()
      } finally {
        await host.close()
      }
    },
  )

  it('owns a failed spawn without leaving an unhandled error or a pending close', async () => {
    const child = spawn(join(tmpdir(), 'missing-dsh-install-host', 'node'), [], { stdio: 'ignore' })
    const host = ownInstallHost(child, 25)
    await host.close()
    expect(host.isAlive()).toBe(false)
  })
})
