import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'
import {
  assertComposedDump,
  assertTarballEntries,
  parseArgs,
  parseAuthenticatedStartupUrl,
  redactGateOutput,
  waitForAuthenticatedBootstrap,
} from '../../scripts/install-gate.mjs'
import { findMissingRelativeRuntimeImports } from '../../scripts/verify-runtime-closure.mjs'

describe('DSH clean-install gate contracts', () => {
  it('parses an isolated host and tarball without touching user profile state', () => {
    const parsed = parseArgs(['--host-root', '../alpha', '--tgz', './adapter.tgz', '--skip-boot'])
    expect(basename(parsed.hostRoot)).toBe('alpha')
    expect(parsed.tgz).toBeDefined()
    expect(basename(parsed.tgz!)).toBe('adapter.tgz')
    expect(parsed.skipBoot).toBe(true)
  })

  it('requires the stock loop/picker rows and one additive adapter row', () => {
    const dump = [
      '- id: agent-loop\n  name: @deepseek-ai/dsh-agent-loop',
      '- id: ui-model-selection\n  name: @deepseek-ai/dsh-client-ui-model-selection',
      '- id: dsh-acp-adapter\n  name: @zaimokuza/dsh-acp-adapter',
    ].join('\n')
    expect(() => assertComposedDump(dump)).not.toThrow()
    expect(() => assertComposedDump(dump.replace('id: agent-loop', 'id: agent-loop\n  disabled: true'))).toThrow(/stock agent-loop row is disabled/)
    expect(() => assertComposedDump(dump.replace('id: dsh-acp-adapter', 'id: other'))).toThrow(/additive dsh-acp-adapter row/)
  })

  it('rejects legacy and development files from a published tarball', () => {
    const valid = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'LICENSE']
    expect(() => assertTarballEntries(valid)).not.toThrow()
    expect(() => assertTarballEntries([...valid, 'experiments/old/RESULTS.md'])).toThrow(/forbidden development/)
    expect(() => assertTarballEntries([...valid, 'lib/host-compat/agent-loop.js'])).toThrow(/forbidden development/)
  })

  it('catches a missing relative host runtime module in the tarball', () => {
    const files = ['lib/index.js', 'lib/host/composition/index.js', 'lib/host/composition/installed-profile-registry.js']
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
    expect(findMissingRelativeRuntimeImports([...files, 'lib/contract/config-options.js'], (file) => source.get(file) ?? '')).toEqual([])
  })

  it('extracts the authenticated loopback URL without accepting an unauthenticated URL', () => {
    expect(parseAuthenticatedStartupUrl('starting\ndsh web: http://127.0.0.1:3199/?token=launch-secret\n')).toBe('http://127.0.0.1:3199/?token=launch-secret')
    expect(parseAuthenticatedStartupUrl('dsh web: http://127.0.0.1:3199/')).toBeUndefined()
    expect(parseAuthenticatedStartupUrl('dsh web: https://example.test/?token=secret')).toBeUndefined()
  })

  it('redacts bootstrap tokens and cookie-like credentials from diagnostics', () => {
    const safe = redactGateOutput('dsh web: http://127.0.0.1:3199/?token=launch-secret\nCookie: dsh-session=session-secret\nBearer bearer-secret')
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
      if (!parseAuthenticatedStartupUrl(outputs[Math.min(outputIndex - 1, outputs.length - 1)] ?? '')) fetchedBeforeUrl = true
      if (url.includes('?token=')) {
        return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-session=cookie-secret; Path=/' } })
      }
      rootAttempts += 1
      return rootAttempts === 1
        ? new Response(null, { status: 401 })
        : new Response('<__DSH_BOOT__>', { status: 200 })
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
})
