import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webApi from '@deepseek-ai/dsh-web-deepseek-api'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createTeamBridge } from '../../../src/host/teams/bridge.ts'

const apiBase = 'https://deepseek-web.invalid/v1/tools'
const cleanup: Array<() => unknown | Promise<unknown>> = []

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close()
  } finally {
    vi.unstubAllGlobals()
  }
})

/** Keep native MCP traffic local; every provider request is answered without a network call. */
function captureApi() {
  const nativeFetch = globalThis.fetch
  const requests: Array<{ endpoint: string; headers: Headers; body: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return nativeFetch(input, init)
      if (url.origin !== new URL(apiBase).origin || typeof init?.body !== 'string') {
        throw new Error(`Unexpected non-local request: ${url.origin}${url.pathname}`)
      }
      requests.push({ endpoint: url.href, headers: new Headers(init.headers), body: JSON.parse(init.body) })
      const body = url.pathname.endsWith('/search')
        ? {
            results: [
              { url: 'https://source.invalid/article', title: 'Native source', snippet: 'Source excerpt', date: null },
            ],
          }
        : { content: '# Native fetched page' }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }),
  )
  return requests
}

/** Use the Loader's actual volatile-only save path, rather than changing a test-owned selector. */
async function livePlugin(ctx: Context, plugin: Plugin, id: string, config: Record<string, unknown>) {
  ctx.loader.builtins[id] = plugin
  const options = { id, name: `cordis:${id}`, config }
  const entry = ctx.loader.resolve(await ctx.loader.create(options))
  const fiber = entry.fiber!
  await fiber.await()
  return {
    fiber,
    entry,
    async update(patch: Record<string, unknown>) {
      await entry.update({ config: { ...entry.options.config, ...patch } })
      await entry.fiber!.await()
    },
  }
}

async function harness(baseSelection = false) {
  const requests = captureApi()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const selection = await livePlugin(ctx, WebRuntime, 'web', {
    searchProvider: baseSelection ? 'deepseek-official' : 'deepseek-search-api',
    fetchProvider: baseSelection ? 'http' : 'deepseek-fetch-api',
  })
  let apiKey: string | undefined = 'test-host-api-key'
  const resolveCredential = vi.fn(async (_reference: string) => {
    await Promise.resolve()
    return apiKey === undefined ? undefined : { value: apiKey }
  })
  // These two external credential seams contain only dummy values. The native
  // provider, not this fixture, chooses which seam the initiating Session may use.
  ctx.provide('credentials', { resolve: resolveCredential } as never)
  const resolveAccountToken = vi.fn(async (_endpoint: string) => 'test-native-account-token')
  ctx.provide('deepseekAccount', { resolveToken: resolveAccountToken } as never)
  const provider = await livePlugin(ctx, webApi, 'web-deepseek-api', { baseURL: apiBase })
  await ctx.plugin(toolWeb, {})

  async function connect(id: string, question: string, route = 'acp-test') {
    const session = ctx.sessions.create(SessionId(id))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/context', { provider: route, model: 'test-model' })
    const appendQuestion = (text: string) => {
      session.append(
        'user/message',
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
        { surfaceOp: 'append' },
      )
    }
    appendQuestion(question)
    // No loop or model is mounted. The real registry supplies initiator scope;
    // only the unused driver-facing methods are fixture handles.
    const agent = {
      id: session.id,
      session,
      ctx,
      options: { provider: route, model: 'test-model' },
      status: 'idle',
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    } as unknown as Agent
    await ctx.agents.register(agent)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    const lease = await createTeamBridge(
      ctx,
      id,
      { mcpCapabilities: { http: true } },
      undefined,
      async () => 'auto',
      undefined,
      assembly.tools,
    )
    if (lease === undefined) throw new Error('Expected native web tools on the ACP MCP bridge')
    cleanup.push(() => lease.close())
    const server = lease.servers[0]
    if (server === undefined || !('url' in server)) throw new Error('Expected a local HTTP MCP server')
    const client = new Client({ name: `web-provider-${id}`, version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    lease.beginPrompt(new AbortController().signal)
    return {
      session,
      appendQuestion,
      listedTools: (await client.listTools()).tools.map((tool) => tool.name).sort(),
      search: (query: string) => client.callTool({ name: 'web_search', arguments: { queries: [query] } }),
      fetch: (url: string) => client.callTool({ name: 'web_fetch', arguments: { url } }),
    }
  }

  return {
    ctx,
    requests,
    selection,
    provider,
    resolveCredential,
    resolveAccountToken,
    connect,
    setApiKey(value: string | undefined) {
      apiKey = value
    },
  }
}

describe('published RC.2 web providers through the ACP native-tool bridge', () => {
  it('uses the current native Session human prompt and preserves native web tools and output', async () => {
    const h = await harness()
    const caller = await h.connect('current-question', 'Earlier question')
    caller.appendQuestion('  What changed\n\tin DeepSeek?  ')
    caller.session.append(
      'user/message',
      createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Injected context' }] }),
      { surfaceOp: 'append' },
    )
    expect(caller.listedTools).toEqual(['web_fetch', 'web_search'])
    const result = await caller.search('release changes')
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Source excerpt') }),
      ]),
    )
    expect(h.requests[0]).toMatchObject({
      endpoint: `${apiBase}/search`,
      body: { query: 'release changes', count: 8, need_content: false, ori_question: 'What changed in DeepSeek?' },
    })
    caller.appendQuestion('A follow-up in the same Session')
    expect((await caller.search('follow-up')).isError).not.toBe(true)
    expect(h.requests[1]?.body.ori_question).toBe('A follow-up in the same Session')
    expect(h.ctx.agents.currentInitiator()).toBeUndefined()
  })

  it('isolates concurrent ACP Session initiators and omits a question outside an initiator', async () => {
    const h = await harness()
    const first = await h.connect('first-session', 'Question from first Session')
    const second = await h.connect('second-session', 'Question from second Session')
    const results = await Promise.all([first.search('first-query'), second.search('second-query')])
    expect(results.every((result) => result.isError !== true)).toBe(true)
    expect(new Map(h.requests.map(({ body }) => [body.query, body.ori_question]))).toEqual(
      new Map([
        ['first-query', 'Question from first Session'],
        ['second-query', 'Question from second Session'],
      ]),
    )
    await h.ctx.web.search({ query: 'no-session-query' })
    expect(h.requests.at(-1)?.body).not.toHaveProperty('ori_question')
    expect(h.ctx.agents.currentInitiator()).toBeUndefined()
  })

  it('honors the native question-sharing opt-out on the next ACP search without remounting', async () => {
    const h = await harness()
    const caller = await h.connect('question-opt-out', 'Private human question')
    expect((await caller.search('before')).isError).not.toBe(true)
    expect(h.requests[0]?.body.ori_question).toBe('Private human question')
    await h.provider.update({ sendOriginalQuestion: false })
    expect(Object.is(h.provider.entry.fiber, h.provider.fiber)).toBe(true)
    expect((await caller.search('after')).isError).not.toBe(true)
    expect(h.requests[1]?.body).not.toHaveProperty('ori_question')
  })

  it.each(['acp-test', 'deepseek-account'])(
    'keeps Search and Fetch credential routing owned by the initiating %s Session',
    async (route) => {
      const h = await harness()
      const caller = await h.connect(`credential-${route}`, 'Credential routing question', route)
      expect((await caller.search('credential-query')).isError).not.toBe(true)
      h.setApiKey('test-rotated-host-key')
      const fetched = await caller.fetch('https://requested.invalid/article')
      expect(fetched.isError).not.toBe(true)
      expect(fetched.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('# Native fetched page') }),
        ]),
      )
      expect(h.requests.map(({ endpoint }) => endpoint)).toEqual([`${apiBase}/search`, `${apiBase}/fetch`])
      expect(h.requests[1]?.body).toEqual({ url: 'https://requested.invalid/article' })
      if (route === 'deepseek-account') {
        expect(h.resolveAccountToken.mock.calls.map(([endpoint]) => endpoint)).toEqual([
          `${apiBase}/search`,
          `${apiBase}/fetch`,
        ])
        expect(h.resolveCredential).not.toHaveBeenCalled()
        for (const { headers } of h.requests) {
          expect(headers.get('x-dsh-auth-token')).toBe('test-native-account-token')
          expect(headers.has('authorization')).toBe(false)
        }
      } else {
        expect(h.resolveAccountToken).not.toHaveBeenCalled()
        expect(h.resolveCredential.mock.calls.map(([reference]) => reference)).toEqual([
          'DEEPSEEK_API_KEY',
          'DEEPSEEK_API_KEY',
        ])
        expect(h.requests.map(({ headers }) => headers.get('authorization'))).toEqual([
          'Bearer test-host-api-key',
          'Bearer test-rotated-host-key',
        ])
        expect(h.requests.every(({ headers }) => !headers.has('x-dsh-auth-token'))).toBe(true)
      }
    },
  )

  it('does not borrow a native account token or dispatch when an ACP Session has no API credential', async () => {
    const h = await harness()
    h.setApiKey(undefined)
    const caller = await h.connect('missing-api-credential', 'Missing credential question')
    const search = await caller.search('missing-key')
    const fetched = await caller.fetch('https://requested.invalid/article')
    expect(search.isError).toBe(true)
    expect(fetched.isError).toBe(true)
    expect(h.resolveCredential).toHaveBeenCalledTimes(2)
    expect(h.resolveAccountToken).not.toHaveBeenCalled()
    expect(h.requests).toEqual([])
  })

  it('keeps base-provider selection until a native save, then switches both capabilities without remounting', async () => {
    const h = await harness(true)
    // Only the old backends are scripted; provider selection, the live save,
    // native tools, the ACP bridge, and the new API producer are production code.
    const oldSearch = vi.fn(async () => ({ content: 'Old search backend', sources: [], truncated: false }))
    const oldFetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: { kind: 'text' as const, content: 'Old fetch backend' },
      truncated: false,
    }))
    h.ctx.web.registerSearchProvider({ id: 'deepseek-official', available: () => true, search: oldSearch })
    h.ctx.web.registerFetchProvider({ id: 'http', available: () => true, fetch: oldFetch })
    const caller = await h.connect('provider-selection', 'Selection question')
    const search = () => caller.search('selected-query')
    const fetchPage = () => caller.fetch('https://requested.invalid/article')
    for (const result of await Promise.all([search(), fetchPage()])) expect(result.isError).not.toBe(true)
    expect(oldSearch).toHaveBeenCalledOnce()
    expect(oldFetch).toHaveBeenCalledOnce()
    expect(h.requests).toEqual([])
    expect(h.resolveCredential).not.toHaveBeenCalled()

    const webOwner = h.selection.fiber.uid
    const liveConfig = h.selection.fiber.config
    await h.selection.update({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    expect(Object.is(h.selection.entry.fiber, h.selection.fiber)).toBe(true)
    expect(h.selection.entry.fiber?.uid).toBe(webOwner)
    expect(Object.is(h.selection.entry.fiber?.config, liveConfig)).toBe(true)
    for (const result of await Promise.all([search(), fetchPage()])) expect(result.isError).not.toBe(true)
    expect(h.requests.map(({ endpoint }) => endpoint).sort()).toEqual([`${apiBase}/fetch`, `${apiBase}/search`])
    expect(oldSearch).toHaveBeenCalledOnce()
    expect(oldFetch).toHaveBeenCalledOnce()

    await h.selection.update({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    for (const result of await Promise.all([search(), fetchPage()])) expect(result.isError).not.toBe(true)
    expect(oldSearch).toHaveBeenCalledTimes(2)
    expect(oldFetch).toHaveBeenCalledTimes(2)
    expect(h.requests).toHaveLength(2)
    expect(h.selection.entry.fiber?.uid).toBe(webOwner)
    expect(Object.is(h.selection.entry.fiber?.config, liveConfig)).toBe(true)
    expect(caller.listedTools).toEqual(['web_fetch', 'web_search'])
  })
})
