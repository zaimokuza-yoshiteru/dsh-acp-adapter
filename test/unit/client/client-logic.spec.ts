// Client settings logic: draft parsing and validation, catalog identity,
// panel settings, health response decoding, bound sessions, and error text.

import { describe, expect, it } from 'vitest'
import {
  ACP_AGENT_ID_PATTERN,
  ACP_ENV_KEY_PATTERN,
  ACP_SETTINGS_NS,
  agentLoginHint,
  decodeBoundSessions,
  decodeHealthResponse,
  draftFromAgent,
  draftFromCatalogEntry,
  dropMaskedEnvKey,
  effectiveRuntimeOf,
  emptyDraft,
  errorMessageOf,
  formatArgsText,
  formatEnvText,
  healthRowOf,
  panelSettingsOf,
  parseArgsText,
  parseEnvText,
  sortedAgentIds,
  validateAgentDraft,
  type AcpAgentConfig,
  type AcpProviderHealth,
  type AgentDraft,
} from '../../../src/client/data/logic.ts'
import registrySnapshot from '../../../assets/registry/registry.json' with { type: 'json' }
import { ACP_CATALOG_ENTRIES, catalogEntryOf } from '../../../src/client/data/catalog.ts'

const devinConfig: AcpAgentConfig = {
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  env: {},
  loginHint: 'devin auth login',
}

const fooConfig: AcpAgentConfig = {
  name: 'Foo Agent',
  command: 'foo-cli',
  args: ['serve', '--acp'],
  env: { FOO_HOME: '/opt/foo' },
}

/** 九键齐备的能力事实夹具（okRow 与 decode 专项用例的缺键/错型变体共用）。 */
function fullCaps() {
  return {
    loadSession: true,
    sessionList: true,
    sessionClose: false,
    sessionDelete: true,
    promptImage: true,
    promptAudio: false,
    promptEmbeddedContext: true,
    mcpHttp: false,
    mcpSse: false,
  }
}

/** 清理事实夹具（okRow 用；decode 专项另造三态变体）。 */
const okCleanup = { close: 'not-advertised' as const, delete: 'done' as const, message: null }

/** 端到端能力矩阵夹具（okRow 与各 ok probe 字面量共用；两行覆盖 supported/unsupported + note）。 */
const okMatrix = [
  { id: 'loadSession', advertised: true, adapterPath: 'resume-staging', hostSeam: null, status: 'supported' as const },
  {
    id: 'promptImage',
    advertised: true,
    adapterPath: 'durable-attachment-to-inline-image',
    hostSeam: 'attachments',
    status: 'supported' as const,
  },
]

const okRow = {
  id: 'devin',
  name: 'Devin',
  command: 'devin',
  args: ['acp'],
  loginHint: 'devin auth login',
  executable: true,
  version: '1.2.3',
  state: 'ready',
  probe: {
    status: 'ok',
    at: 1_700_000_000_000,
    modelCount: 2,
    authMethods: [{ id: 'oauth', name: 'OAuth 登录' }],
    agentInfo: { name: 'devin-acp', version: '1.2.3' },
    capabilities: fullCaps(),
    cleanup: okCleanup,
    capabilityHash: '0123456789abcdef',
    protocolVersion: 1,
    versionCompatibility: 'current',
    matrix: okMatrix,
  },
} satisfies AcpProviderHealth

const neverRow: AcpProviderHealth = {
  id: 'foo',
  name: 'Foo Agent',
  command: 'foo-cli',
  args: ['serve', '--acp'],
  loginHint: null,
  executable: false,
  version: null,
  state: 'saved-unverified',
  probe: { status: 'never', at: null },
}

const authErrorRow: AcpProviderHealth = {
  id: 'bar',
  name: 'Bar',
  command: 'bar-cli',
  args: [],
  loginHint: 'bar login',
  executable: true,
  version: null,
  state: 'auth-required',
  probe: {
    status: 'error',
    at: 1_700_000_000_001,
    failureKind: 'auth_required',
    message: 'sign in first',
    phase: 'session',
  },
}

function validDraft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    id: 'devin',
    name: 'Devin',
    command: 'devin',
    argsText: 'acp',
    envText: 'A=1',
    loginHint: 'devin auth login',
    ...overrides,
  }
}

describe('settings identifiers and catalog defaults', () => {
  it('uses the registered settings namespace', () => {
    expect(ACP_SETTINGS_NS).toBe('dsh-acp-adapter')
  })

  it('ACP_AGENT_ID_PATTERN：小写字母开头 + 小写字母/数字/连字符', () => {
    for (const ok of ['a', 'devin', 'a1', 'a-b', 'z-9-x']) {
      expect(ACP_AGENT_ID_PATTERN.test(ok), ok).toBe(true)
    }
    for (const bad of ['', 'A', 'Devin', '1a', '-a', 'a_b', 'a b', 'a.b', 'a/b']) {
      expect(ACP_AGENT_ID_PATTERN.test(bad), bad).toBe(false)
    }
  })

  it('ACP_ENV_KEY_PATTERN 是 POSIX 标识符字母表', () => {
    for (const ok of ['A', '_', '_1', 'DEEPSEEK_API_KEY', 'a9_Z']) {
      expect(ACP_ENV_KEY_PATTERN.test(ok), ok).toBe(true)
    }
    for (const bad of ['', '1A', 'A-B', 'A B', 'A.B']) {
      expect(ACP_ENV_KEY_PATTERN.test(bad), bad).toBe(false)
    }
  })

  it('lists verified Agents first and builds valid drafts from the bundled registry', () => {
    expect(ACP_CATALOG_ENTRIES.slice(0, 6).map((entry) => entry.id)).toEqual([
      'devin',
      'codebuddy-code',
      'codex-acp',
      'claude-acp',
      'antigravity-acp',
      'qwen-code',
    ])
    expect(ACP_CATALOG_ENTRIES.slice(0, 6).every((entry) => entry.verification === 'adapter-tested')).toBe(true)
    expect(ACP_CATALOG_ENTRIES.slice(6).every((entry) => entry.verification === 'unverified')).toBe(true)
    const testedIds = ACP_CATALOG_ENTRIES.slice(0, 6).map((entry) => entry.id)
    const otherIds = registrySnapshot.agents
      .map((agent) => agent.id)
      .filter((id) => id !== 'kimi' && id !== 'kimi-code' && !testedIds.includes(id))
    expect(ACP_CATALOG_ENTRIES.slice(6).map((entry) => entry.id)).toEqual(otherIds)
    for (const entry of ACP_CATALOG_ENTRIES) {
      expect(ACP_AGENT_ID_PATTERN.test(entry.id), entry.id).toBe(true)
      const draft = draftFromCatalogEntry(entry.id)
      expect(draft, entry.id).toBeDefined()
      if (draft === undefined) continue
      if (entry.requiresCommand) {
        expect(draft.command).toBe('')
        expect(validateAgentDraft(draft, {}, undefined).config).toBeUndefined()
        continue
      }
      const { config } = validateAgentDraft(draft, {}, undefined)
      expect(config, entry.id).toBeDefined()
      expect(config, entry.id).toMatchObject({ name: expect.any(String), command: expect.any(String) })
    }
  })

  it('seeds distribution args/env only for new profiles and leaves platform commands manual', () => {
    expect(draftFromCatalogEntry('minion-code')?.argsText).toBe('acp')
    expect(draftFromCatalogEntry('fast-agent')).toMatchObject({ argsText: '-x', envText: 'FAST_AGENT_MODEL=codexplan' })
    expect(draftFromCatalogEntry('vtcode')).toMatchObject({
      command: '',
      argsText: 'acp',
      envText: 'VT_ACP_ENABLED=1\nVT_ACP_ZED_ENABLED=1',
    })
    expect(catalogEntryOf('poolside')).toMatchObject({ command: '', requiresCommand: true })
    expect(catalogEntryOf('vtcode')?.installHint).toMatch(/^https:/)
    const custom = {
      name: 'My fast agent',
      command: '/opt/my-agent',
      args: ['--custom'],
      env: { FAST_AGENT_MODEL: 'my-model' },
    }
    const edited = draftFromAgent('fast-agent', custom)
    expect(edited).toMatchObject({
      command: '/opt/my-agent',
      argsText: '--custom',
      envText: 'FAST_AGENT_MODEL=my-model',
    })
    expect(validateAgentDraft(edited, { 'fast-agent': custom }, 'fast-agent').config).toEqual({
      ...custom,
      catalogId: 'fast-agent',
    })
  })

  it('round-trips a retired stored binding without silently turning it into generic ACP', () => {
    const stored: AcpAgentConfig = { name: 'Retired', command: 'old-cli', args: [], env: {}, runtime: 'kimi' }
    const draft = draftFromAgent('retired', stored)
    expect(validateAgentDraft(draft, { retired: stored }, 'retired').config).toEqual(stored)
  })

  it.each(['kimi', 'kimi-code', 'no-such-entry'])('does not create a draft for %s', (id) => {
    expect(draftFromCatalogEntry(id)).toBeUndefined()
  })

  it('uses bare catalog commands and keeps Anthropic credential names out of launch arguments', () => {
    const forbidden = /[\s|&;<>()$`"'\\]/
    for (const entry of ACP_CATALOG_ENTRIES) {
      expect(forbidden.test(entry.command), `${entry.id}: ${entry.command}`).toBe(false)
      expect(entry.command.startsWith('npx') || entry.command.startsWith('uvx'), entry.id).toBe(false)
      expect(JSON.stringify(entry.args), entry.id).not.toContain('ANTHROPIC_AUTH_TOKEN')
      expect(JSON.stringify(entry.args), entry.id).not.toContain('ANTHROPIC_API_KEY')
    }
  })
})

describe('parseArgsText / formatArgsText', () => {
  it('逐行 trim、空行丢弃、行内空白保留', () => {
    expect(parseArgsText('')).toEqual([])
    expect(parseArgsText('\n  \n\t\n')).toEqual([])
    expect(parseArgsText('acp')).toEqual(['acp'])
    expect(parseArgsText('  acp  \n\t--verbose\t')).toEqual(['acp', '--verbose'])
    expect(parseArgsText('acp\n\n\n--verbose')).toEqual(['acp', '--verbose'])
    expect(parseArgsText('--config a  b')).toEqual(['--config a  b'])
    expect(parseArgsText('a\r\nb')).toEqual(['a', 'b'])
  })

  it('formatArgsText 一行一个参数；与 parse 往返/归一', () => {
    expect(formatArgsText([])).toBe('')
    expect(formatArgsText(['acp'])).toBe('acp')
    expect(formatArgsText(['acp', '--verbose'])).toBe('acp\n--verbose')
    expect(parseArgsText(formatArgsText(['acp', '--config a  b']))).toEqual(['acp', '--config a  b'])
    // parse 后再 format 是归一化：前导/尾随空白与空行消失
    expect(formatArgsText(parseArgsText('  acp \n\n --verbose '))).toBe('acp\n--verbose')
  })
})

describe('parseEnvText / formatEnvText', () => {
  it('逐行 KEY=VALUE：首个 = 切分、key trim、行 trim 后值原样、空行忽略', () => {
    expect(parseEnvText('')).toEqual({ ok: true, env: {} })
    expect(parseEnvText('\n  \n')).toEqual({ ok: true, env: {} })
    expect(parseEnvText('A=1\nB=2')).toEqual({ ok: true, env: { A: '1', B: '2' } })
    expect(parseEnvText('_=1')).toEqual({ ok: true, env: { _: '1' } })
    // 值内的 = 保留（首个 = 切分）
    expect(parseEnvText('A=a=b=c')).toEqual({ ok: true, env: { A: 'a=b=c' } })
    // 无 = 行：key 为整行，值空串
    expect(parseEnvText('A')).toEqual({ ok: true, env: { A: '' } })
    expect(parseEnvText('A=')).toEqual({ ok: true, env: { A: '' } })
    // 行整体 trim；key 另行 trim；= 之后的值原样（含前导空白）
    expect(parseEnvText('  A=1  ')).toEqual({ ok: true, env: { A: '1' } })
    expect(parseEnvText('A= 1')).toEqual({ ok: true, env: { A: ' 1' } })
    expect(parseEnvText(' A = 1 ')).toEqual({ ok: true, env: { A: ' 1' } })
    expect(parseEnvText('A=1\n\n\nB=2')).toEqual({ ok: true, env: { A: '1', B: '2' } })
  })

  it('key 非法 → key 失败（行号 1-based 且计入空行）', () => {
    expect(parseEnvText('1A=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } })
    expect(parseEnvText('A-B=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } })
    expect(parseEnvText('=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } })
    expect(parseEnvText('A B=x')).toEqual({ ok: false, failure: { line: 1, reason: 'key' } })
    expect(parseEnvText('A=1\n\n1B=x')).toEqual({ ok: false, failure: { line: 3, reason: 'key' } })
  })

  it('重复 key → duplicate 失败（key trim 后判重，且先于值校验）', () => {
    expect(parseEnvText('A=1\nA=2')).toEqual({ ok: false, failure: { line: 2, reason: 'duplicate' } })
    expect(parseEnvText('A=1\n A =2')).toEqual({ ok: false, failure: { line: 2, reason: 'duplicate' } })
  })

  it('：$credential: 形状的值一律按字面值入 env（引用语法已随宿主侧删除）', () => {
    expect(parseEnvText('A=$credential:DEEPSEEK_API_KEY')).toEqual({
      ok: true,
      env: { A: '$credential:DEEPSEEK_API_KEY' },
    })
    // 空名 / 数字开头 / 连字符 / 含空格 也都不再特殊——没有 credential 失败分支了
    expect(parseEnvText('A=$credential:')).toEqual({ ok: true, env: { A: '$credential:' } })
    expect(parseEnvText('A=$credential:1BAD')).toEqual({ ok: true, env: { A: '$credential:1BAD' } })
    expect(parseEnvText('A=$credential:BAD-NAME')).toEqual({ ok: true, env: { A: '$credential:BAD-NAME' } })
    expect(parseEnvText('A=$credential:OK extra')).toEqual({ ok: true, env: { A: '$credential:OK extra' } })
  })

  it('formatEnvText 与 parse 往返（含 = 值、空值与 $ 前缀字面值）', () => {
    expect(formatEnvText({})).toBe('')
    expect(formatEnvText({ A: '1', B: '2' })).toBe('A=1\nB=2')
    expect(formatEnvText({ A: 'a=b', B: '$credential:KEY' })).toBe('A=a=b\nB=$credential:KEY')
    const env = { A: '1', B: 'a=b', C: '$credential:DEEPSEEK_API_KEY', D: '' }
    expect(parseEnvText(formatEnvText(env))).toEqual({ ok: true, env })
  })
})

describe('validateAgentDraft', () => {
  it('全合法 → 仅出 config：name/command/loginHint 保留，args/env 解析', () => {
    expect(validateAgentDraft(validDraft(), {}, undefined)).toEqual({
      config: {
        name: 'Devin',
        command: 'devin',
        args: ['acp'],
        env: { A: '1' },
        loginHint: 'devin auth login',
      },
    })
  })

  it('字段 trim 后入 config；loginHint 空白则不出现在 config', () => {
    const result = validateAgentDraft(
      validDraft({ id: '  devin  ', name: ' Devin ', command: ' devin ', argsText: '', envText: '', loginHint: '   ' }),
      {},
      undefined,
    )
    expect(result).toEqual({ config: { name: 'Devin', command: 'devin', args: [], env: {} } })
  })

  it('id 三分支：必填 / 模式 / 唯一（trim 先于一切检查）', () => {
    expect(validateAgentDraft(validDraft({ id: '' }), {}, undefined).id).toEqual({ key: 'errorIdRequired' })
    expect(validateAgentDraft(validDraft({ id: '   ' }), {}, undefined).id).toEqual({ key: 'errorIdRequired' })
    for (const bad of ['Devin', '1devin', '-devin', 'de_vin', 'de vin']) {
      expect(validateAgentDraft(validDraft({ id: bad }), {}, undefined).id, bad).toEqual({ key: 'errorIdInvalid' })
    }
    expect(validateAgentDraft(validDraft({ id: ' devin ' }), { devin: devinConfig }, undefined).id).toEqual({
      key: 'errorIdTaken',
    })
    expect(validateAgentDraft(validDraft(), { devin: devinConfig, foo: fooConfig }, undefined).id).toEqual({
      key: 'errorIdTaken',
    })
  })

  it('编辑豁免：editingId 与自身 id 相同不撞 taken；改成别人的 id 仍撞', () => {
    expect(validateAgentDraft(validDraft(), { devin: devinConfig }, 'devin').id).toBeUndefined()
    expect(validateAgentDraft(validDraft(), { devin: devinConfig, foo: fooConfig }, 'foo').id).toEqual({
      key: 'errorIdTaken',
    })
    // editingId 缺席（新增流程）不豁免
    expect(validateAgentDraft(validDraft(), { devin: devinConfig }, undefined).id).toEqual({ key: 'errorIdTaken' })
  })

  it(' singleton：草稿生效 runtime 撞存量 profile → runtime 错误点名已有 profile，config 缺席', () => {
    // 显式 runtime 相撞（草稿带模板播种的 runtime）
    const seeded = { ...validDraft({ id: 'devin2' }), runtime: 'devin' as const }
    const conflict = validateAgentDraft(
      seeded,
      { devin: { ...devinConfig, runtime: 'devin', catalogId: 'devin' } },
      undefined,
    )
    expect(conflict.runtime).toEqual({
      key: 'errorRuntimeTaken',
      params: { runtime: 'devin', id: 'devin', name: 'Devin' },
    })
    expect(conflict.config).toBeUndefined()
    // id 回退相撞：草稿无 runtime 但 id 恰为内置 id，存量条目也无 runtime 按 id 回退
    const claudeConfig: AcpAgentConfig = { name: 'C', command: 'claude', args: [], env: {} }
    const fallback = validateAgentDraft(validDraft(), { claude: claudeConfig }, undefined)
    // validDraft 的 id=devin 与存量 claude 不撞 → 无 runtime 错误
    expect(fallback.runtime).toBeUndefined()
    const fallbackHit = validateAgentDraft(validDraft({ id: 'claude' }), { claude: claudeConfig }, undefined)
    expect(fallbackHit.runtime).toEqual({
      key: 'errorRuntimeTaken',
      params: { runtime: 'claude', id: 'claude', name: 'C' },
    })
  })

  it(' singleton 豁免：编辑自身不撞；generic profile（无 runtime 且非内置 id）永不受约束', () => {
    const boundDevin = { ...devinConfig, runtime: 'devin' as const }
    const editSelf = { ...validDraft(), runtime: 'devin' as const }
    expect(validateAgentDraft(editSelf, { devin: boundDevin }, 'devin').runtime).toBeUndefined()
    // generic 草稿对 generic 存量：双方都无 runtime 身份，多实例合法
    const generic = validDraft({ id: 'foo' })
    expect(validateAgentDraft(generic, { foo: fooConfig }, 'foo').config).not.toBeUndefined()
    expect(validateAgentDraft(generic, { bar: fooConfig }, undefined).config).not.toBeUndefined()
  })

  it('effectiveRuntimeOf：显式 runtime 优先，内置 id 回退，generic 归 undefined（与 host 共用规则）', () => {
    expect(effectiveRuntimeOf('foo', { runtime: 'codex' })).toBe('codex')
    expect(effectiveRuntimeOf('kimi', {})).toBeUndefined()
    expect(effectiveRuntimeOf('custom', { runtime: 'kimi' })).toBeUndefined()
    expect(effectiveRuntimeOf('antigravity', {})).toBeUndefined()
    expect(effectiveRuntimeOf('antigravity-acp', {})).toBeUndefined()
    expect(effectiveRuntimeOf('antigravity-acp', { runtime: 'antigravity' })).toBe('antigravity')
    expect(effectiveRuntimeOf('foo', {})).toBeUndefined()
  })

  it('name / command 必填（空白视同空）', () => {
    expect(validateAgentDraft(validDraft({ name: '' }), {}, undefined).name).toEqual({ key: 'errorNameRequired' })
    expect(validateAgentDraft(validDraft({ name: '  ' }), {}, undefined).name).toEqual({ key: 'errorNameRequired' })
    expect(validateAgentDraft(validDraft({ command: '' }), {}, undefined).command).toEqual({
      key: 'errorCommandRequired',
    })
    expect(validateAgentDraft(validDraft({ command: '\t' }), {}, undefined).command).toEqual({
      key: 'errorCommandRequired',
    })
  })

  it.each([
    String.raw`C:\Program Files\Agent Tools\agent.exe`,
    String.raw`\\server\Agent Tools\agent.exe`,
    '/Users/Test User/Agent Tools/agent',
  ])('preserves executable paths in edited and saved drafts: %s', (command) => {
    const original = { name: 'Custom Agent', command, args: ['acp'], env: {} }
    const draft = draftFromAgent('custom', original)
    expect(draft.command).toBe(command)
    expect(validateAgentDraft(draft, { custom: original }, 'custom').config).toEqual(original)
  })

  it('env 两分支映射：key/duplicate → locale key + 行号 params（credential 分支已删）', () => {
    expect(validateAgentDraft(validDraft({ envText: '1A=x' }), {}, undefined).env).toEqual({
      key: 'errorEnvKey',
      params: { line: 1 },
    })
    expect(validateAgentDraft(validDraft({ envText: 'A=1\nA=2' }), {}, undefined).env).toEqual({
      key: 'errorEnvDuplicate',
      params: { line: 2 },
    })
  })

  it('任一错误存在即无 config；多字段错误并发报告', () => {
    expect(validateAgentDraft(validDraft({ envText: '1A=x' }), {}, undefined).config).toBeUndefined()
    const all = validateAgentDraft(
      { id: '', name: '', command: '', argsText: '', envText: 'A=1\nA=2', loginHint: '' },
      {},
      undefined,
    )
    expect(all).toEqual({
      id: { key: 'errorIdRequired' },
      name: { key: 'errorNameRequired' },
      command: { key: 'errorCommandRequired' },
      env: { key: 'errorEnvDuplicate', params: { line: 2 } },
    })
  })

  it('成功 config 的 args/env 来自 argsText/envText 的解析结果', () => {
    const result = validateAgentDraft(
      validDraft({ argsText: 'acp\n--verbose', envText: 'A=1\nB=$credential:KEY', loginHint: '' }),
      {},
      undefined,
    )
    expect(result.config).toEqual({
      name: 'Devin',
      command: 'devin',
      args: ['acp', '--verbose'],
      env: { A: '1', B: '$credential:KEY' },
    })
  })
})

describe('草稿种子：emptyDraft / draftFromCatalogEntry / draftFromAgent', () => {
  it('preserves a saved Claude command, arguments and environment instead of reseeding catalog defaults', () => {
    const config: AcpAgentConfig = {
      name: 'Company Claude',
      catalogId: 'claude-acp',
      runtime: 'claude',
      command: '/opt/company/claude-wrapper',
      args: ['--profile', 'work profile'],
      env: { CLAUDE_CONFIG_DIR: '/opt/company/config' },
      loginHint: 'company-login',
    }
    const draft = draftFromAgent('company-claude', config)
    expect(draft).toMatchObject({
      command: config.command,
      argsText: '--profile\nwork profile',
      envText: 'CLAUDE_CONFIG_DIR=/opt/company/config',
      loginHint: 'company-login',
    })
    expect(validateAgentDraft(draft, { 'company-claude': config }, 'company-claude').config).toEqual(config)
  })

  it('derives display-only login guidance without changing saved custom hints or runtime identity', () => {
    expect(agentLoginHint('custom-codex', { catalogId: 'codex-acp' })).toBe('codex login')
    expect(agentLoginHint('claude', {})).toBe('claude')
    expect(agentLoginHint('custom', { runtime: 'codebuddy', loginHint: 'company-login' })).toBe('company-login')
    expect(agentLoginHint('unknown', {})).toBeUndefined()
    const config = { ...fooConfig, loginHint: 'company-login' }
    expect(validateAgentDraft(draftFromAgent('foo', config), { foo: config }, 'foo').config).toEqual(config)
  })
  it('emptyDraft 全空串', () => {
    expect(emptyDraft()).toEqual({ id: '', name: '', command: '', argsText: '', envText: '', loginHint: '' })
  })

  it.each([
    ['devin', 'devin', 'devin', ['acp'], 'devin auth login'],
    ['claude-acp', 'claude', 'claude-agent-acp', [], 'claude'],
    ['codex-acp', 'codex', 'codex-acp', [], 'codex login'],
    ['codebuddy-code', 'codebuddy', 'codebuddy-code', ['--acp'], 'codebuddy'],
  ] as const)(
    'preserves %s launch settings from the catalog through saving the draft',
    (id, runtime, command, args, loginHint) => {
      const draft = draftFromCatalogEntry(id)!
      const name = registrySnapshot.agents.find((agent) => agent.id === id)!.name
      expect(draft).toEqual({
        id,
        name,
        command,
        argsText: args.join('\n'),
        envText: '',
        loginHint,
        runtime,
        catalogId: id,
      })
      expect(validateAgentDraft(draft, {}, undefined).config).toEqual({
        name,
        command,
        args,
        env: {},
        loginHint,
        runtime,
        catalogId: id,
      })
    },
  )

  it('draftFromCatalogEntry 普通条目：sidecar 预填 command/args、无 runtime、无 loginHint', () => {
    const entry = ACP_CATALOG_ENTRIES.find((candidate) => candidate.runtime === undefined)
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const draft = draftFromCatalogEntry(entry.id)
    expect(draft).toEqual({
      id: entry.id,
      catalogId: entry.id,
      name: entry.name,
      command: entry.command,
      argsText: entry.args.join('\n'),
      envText: '',
      loginHint: '',
    })
    expect('runtime' in (draft ?? {})).toBe(false)
  })

  it('does not suggest CLI login for Antigravity ACP accounts', () => {
    expect(catalogEntryOf('antigravity-acp')).toMatchObject({
      id: 'antigravity-acp',
      runtime: 'antigravity',
      verification: 'adapter-tested',
    })
    const draft = draftFromCatalogEntry('antigravity-acp')
    expect(draft?.runtime).toBe('antigravity')
    expect(draft?.loginHint).toBe('')
  })

  it('draftFromAgent：args/env 渲染成逐行文本，loginHint 缺席补空串', () => {
    expect(draftFromAgent('foo', fooConfig)).toEqual({
      id: 'foo',
      name: 'Foo Agent',
      command: 'foo-cli',
      argsText: 'serve\n--acp',
      envText: 'FOO_HOME=/opt/foo',
      loginHint: '',
    })
    expect(draftFromAgent('devin', devinConfig).loginHint).toBe('devin auth login')
  })

  it('draftFromAgent 与 validateAgentDraft 往返：存出的 config 原样回得来', () => {
    for (const [id, config] of [
      ['devin', devinConfig],
      ['foo', fooConfig],
    ] as const) {
      expect(validateAgentDraft(draftFromAgent(id, config), { [id]: config }, id)).toEqual({ config })
    }
  })

  it('边界：runtime 绑定随草稿过站——编辑器不暴露，保存不静默解除', () => {
    const bound: AcpAgentConfig = { ...fooConfig, runtime: 'claude' }
    const draft = draftFromAgent('foo', bound)
    expect(draft.runtime).toBe('claude')
    expect(validateAgentDraft(draft, { foo: bound }, 'foo')).toEqual({ config: bound })
    // 无绑定的 config 不带 runtime 字段（保持「无绑定 = 字段缺席」单一形态）
    expect('runtime' in draftFromAgent('foo', fooConfig)).toBe(false)
  })
})

describe(' env 密钥掩码（draftFromAgent / validateAgentDraft / dropMaskedEnvKey）', () => {
  const secretConfig: AcpAgentConfig = {
    name: 'Secretive',
    command: 'secretive-cli',
    args: [],
    env: { DEVIN_API_KEY: 'sk-live-9f8e7d', ANTHROPIC_TOKEN: 'tok-abc', FOO_HOME: '/opt/foo' },
  }

  it('draftFromAgent：疑似 secret 的键不进 envText（值不回显），原值进 maskedEnv 过站', () => {
    const draft = draftFromAgent('secretive', secretConfig)
    expect(draft.envText).toBe('FOO_HOME=/opt/foo')
    expect(draft.maskedEnv).toEqual({ DEVIN_API_KEY: 'sk-live-9f8e7d', ANTHROPIC_TOKEN: 'tok-abc' })
    // 文本框（用户可见面）序列化后不含任何疑似键的值
    expect(draft.envText).not.toContain('sk-live-9f8e7d')
    expect(draft.envText).not.toContain('DEVIN_API_KEY')
    // 无疑似键的 config 不带 maskedEnv 字段（单一形态：无掩码 = 字段不在）
    expect('maskedEnv' in draftFromAgent('foo', fooConfig)).toBe(false)
  })

  it('validateAgentDraft：掩码键原样合回 config.env；同名显式重填优先（轮换值）', () => {
    const draft = draftFromAgent('secretive', secretConfig)
    // 不动文本框：掩码值原样保留
    expect(validateAgentDraft(draft, { secretive: secretConfig }, 'secretive').config?.env).toEqual(secretConfig.env)
    // 同名重填 = 轮换；新增疑似键经文本框显式录入也照存（用户亲手输入即所见即所存）
    const rotated: AgentDraft = { ...draft, envText: `${draft.envText}\nDEVIN_API_KEY=sk-rotated-123` }
    expect(validateAgentDraft(rotated, { secretive: secretConfig }, 'secretive').config?.env).toEqual({
      DEVIN_API_KEY: 'sk-rotated-123',
      ANTHROPIC_TOKEN: 'tok-abc',
      FOO_HOME: '/opt/foo',
    })
  })

  it('dropMaskedEnvKey：移除指定键；删空后 maskedEnv 字段整体缺席；未知键原样返回', () => {
    const draft = draftFromAgent('secretive', secretConfig)
    const dropped = dropMaskedEnvKey(draft, 'DEVIN_API_KEY')
    expect(dropped.maskedEnv).toEqual({ ANTHROPIC_TOKEN: 'tok-abc' })
    // 保存后该键即从 config.env 消失（UI 移除行 = 删除该键）
    expect(validateAgentDraft(dropped, { secretive: secretConfig }, 'secretive').config?.env).toEqual({
      ANTHROPIC_TOKEN: 'tok-abc',
      FOO_HOME: '/opt/foo',
    })
    const emptied = dropMaskedEnvKey(dropMaskedEnvKey(draft, 'DEVIN_API_KEY'), 'ANTHROPIC_TOKEN')
    expect('maskedEnv' in emptied).toBe(false)
    const untouched = dropMaskedEnvKey(draft, 'NO_SUCH_KEY')
    expect(untouched).toBe(draft)
  })
})

describe('agents map projection', () => {
  it('sortedAgentIds 按 localeCompare 序返回全部 id', () => {
    expect(sortedAgentIds({})).toEqual([])
    expect(sortedAgentIds({ devin: devinConfig })).toEqual(['devin'])
    expect(sortedAgentIds({ gamma: devinConfig, alpha: devinConfig, beta: devinConfig })).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
  })
})

describe('panelSettingsOf', () => {
  it('ready → ready，agents/writable/revision 透传；value 缺席时 agents 归零', () => {
    expect(
      panelSettingsOf({ status: 'ready', value: { agents: { devin: devinConfig } }, revision: 3, writable: true }),
    ).toEqual({
      status: 'ready',
      writable: true,
      agents: { devin: devinConfig },
      toolApprovalDefault: 'auto',
      revision: 3,
    })
    expect(
      panelSettingsOf({
        status: 'ready',
        value: { agents: {}, toolApprovalDefault: 'ask' },
        revision: 4,
        writable: true,
      }).toolApprovalDefault,
    ).toBe('ask')
    expect(panelSettingsOf({ status: 'ready', value: undefined, revision: 3, writable: false }).agents).toEqual({})
  })

  it('unavailable → unavailable；loading 按 revision 分 loading/invalid', () => {
    expect(panelSettingsOf({ status: 'unavailable', value: undefined, revision: undefined, writable: false })).toEqual({
      status: 'unavailable',
      writable: false,
      agents: {},
      toolApprovalDefault: 'auto',
      revision: undefined,
    })
    expect(panelSettingsOf({ status: 'loading', value: undefined, revision: undefined, writable: true }).status).toBe(
      'loading',
    )
    // decode miss：scope 停在 loading 但 revision 证明读到过 → invalid
    expect(panelSettingsOf({ status: 'loading', value: undefined, revision: 7, writable: false })).toEqual({
      status: 'invalid',
      writable: false,
      agents: {},
      toolApprovalDefault: 'auto',
      revision: 7,
    })
  })
})

describe('decodeHealthResponse', () => {
  it('preserves the typed retirement diagnostic without inventing a failed probe', () => {
    const retired = { ...neverRow, state: 'unavailable', unavailableReason: 'agent-retired' }
    expect(decodeHealthResponse({ providers: [retired] })).toEqual([retired])
    expect(decodeHealthResponse({ providers: [{ ...retired, unavailableReason: 'arbitrary-text' }] })).toBeUndefined()
  })

  it('合法响应：三种 probe 分支逐字段解出；未知顶层/行键剥离', () => {
    const body = { providers: [okRow, neverRow, authErrorRow] }
    expect(decodeHealthResponse(body)).toEqual([okRow, neverRow, authErrorRow])
    expect(decodeHealthResponse({ providers: [] })).toEqual([])
    expect(decodeHealthResponse({ providers: [{ ...okRow, extra: 1 }], extra: true })).toEqual([okRow])
  })

  it.each([
    { modelCount: 0, authMethods: null },
    { modelCount: 0, authMethods: [] },
    { modelCount: 1, authMethods: [{ id: 'oauth', name: 'OAuth', description: null }] },
  ])('decodes optional authentication details $authMethods', (auth) => {
    const row = {
      ...okRow,
      probe: {
        ...okRow.probe,
        ...auth,
        agentInfo: null,
        capabilities: null,
        cleanup: null,
        capabilityHash: null,
        protocolVersion: null,
        versionCompatibility: null,
      },
    }
    expect(decodeHealthResponse({ providers: [row] })).toEqual([row])
  })

  it('readiness 两键：null 词表与三态合法值解出；词表外/畸形整行拒', () => {
    const probe = okRow.probe
    // 合法：versionCompatibility 三态 + null；protocolVersion number|null
    for (const versionCompatibility of ['current', 'different', 'unknown', null] as const) {
      const row = { ...okRow, probe: { ...probe, protocolVersion: 1, versionCompatibility } }
      expect(decodeHealthResponse({ providers: [row] }), String(versionCompatibility)).toEqual([row])
    }
    const nullPair = { ...okRow, probe: { ...probe, protocolVersion: null, versionCompatibility: null } }
    expect(decodeHealthResponse({ providers: [nullPair] })).toEqual([nullPair])
    // 词表外/畸形：strict codec 边界整行拒绝
    for (const patch of [{ protocolVersion: '1' }, { versionCompatibility: 'pinned' }, { versionCompatibility: 42 }]) {
      const row = { ...okRow, probe: { ...probe, ...patch } }
      expect(decodeHealthResponse({ providers: [row] }), JSON.stringify(patch)).toBeUndefined()
    }
  })

  it('matrix：空数组/note 缺席/未知行 id 均合法解出（向前兼容 host 新增行）', () => {
    const empty = { ...okRow, probe: { ...okRow.probe, matrix: [] } }
    expect(decodeHealthResponse({ providers: [empty] })).toEqual([empty])
    const noNote = {
      ...okRow,
      probe: {
        ...okRow.probe,
        matrix: [{ id: 'futureRow', advertised: null, adapterPath: 'x', hostSeam: null, status: 'degraded' }],
      },
    }
    expect(decodeHealthResponse({ providers: [noNote] })).toEqual([noNote])
  })

  it('畸形整体拒绝：body 非 object / providers 非数组', () => {
    for (const bad of [null, 'x', 42, [], {}]) {
      expect(decodeHealthResponse(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(decodeHealthResponse({ providers: {} })).toBeUndefined()
    expect(decodeHealthResponse({ providers: 'rows' })).toBeUndefined()
  })

  it('行字段违规逐一拒绝（且传染整个响应）', () => {
    const badRows: Array<[string, unknown]> = [
      ['行非 object', 'devin'],
      ['id 非 string', { ...okRow, id: 1 }],
      ['name 非 string', { ...okRow, name: null }],
      ['command 非 string', { ...okRow, command: undefined }],
      ['args 非数组', { ...okRow, args: 'acp' }],
      ['args 元素非 string', { ...okRow, args: ['acp', 1] }],
      ['loginHint 缺席（宿主恒发 string|null）', { ...okRow, loginHint: undefined }],
      ['loginHint 数字', { ...okRow, loginHint: 42 }],
      ['executable 非 boolean', { ...okRow, executable: 'yes' }],
      ['version 缺席', { ...okRow, version: undefined }],
      ['version 数字', { ...okRow, version: 1 }],
      // state 为五态词表强制字段
      ['state 缺席', { ...okRow, state: undefined }],
      ['state 未知值', { ...okRow, state: 'half-ready' }],
      ['state 非 string', { ...okRow, state: 1 }],
    ]
    for (const [label, row] of badRows) {
      expect(decodeHealthResponse({ providers: [row] }), label).toBeUndefined()
      // 传染：好行与坏行并存同样整体拒绝
      expect(decodeHealthResponse({ providers: [neverRow, row] }), `${label}（传染）`).toBeUndefined()
    }
  })

  it(' state 词表：五态全部合法解出（行其余字段不动）', () => {
    for (const state of ['saved-unverified', 'ready', 'auth-required', 'unavailable', 'incompatible'] as const) {
      const row = { ...okRow, state }
      expect(decodeHealthResponse({ providers: [row] }), state).toEqual([row])
    }
  })

  it('rejects successful probes missing required fields', () => {
    for (const key of [
      'at',
      'agentInfo',
      'capabilities',
      'cleanup',
      'capabilityHash',
      'matrix',
      'protocolVersion',
      'versionCompatibility',
    ] as const) {
      const { [key]: _removed, ...probe } = okRow.probe
      expect(decodeHealthResponse({ providers: [{ ...okRow, probe }] }), key).toBeUndefined()
    }
  })

  it('rejects malformed probe data', () => {
    const okBase = okRow.probe
    const { id: _id, ...matrixWithoutId } = okMatrix[0]!
    const errBase = { status: 'error', at: 1, failureKind: 'timeout', message: 'boom', phase: null }
    const badProbes: Array<[string, unknown]> = [
      ['probe 非 object', 'ok'],
      ['probe status 未知', { status: 'pending', at: 1 }],
      ['never 的 at 非 null', { status: 'never', at: 1 }],
      ['never 缺 at', { status: 'never' }],
      ['ok 的 modelCount 非 number', { ...okBase, modelCount: '2' }],
      ['ok 的 authMethods 非 null/数组', { ...okBase, authMethods: 'oauth' }],
      ['authMethods 元素缺 name', { ...okBase, authMethods: [{ id: 'oauth' }] }],
      ['authMethods 元素 id 非 string', { ...okBase, authMethods: [{ id: 1, name: 'OAuth' }] }],
      ['agentInfo 缺 version', { ...okBase, agentInfo: { name: 'devin-acp' } }],
      ['agentInfo name 非 string', { ...okBase, agentInfo: { name: 1, version: '1' } }],
      ['capabilities 缺键', { ...okBase, capabilities: { loadSession: true } }],
      ['capabilities 值非 boolean', { ...okBase, capabilities: { ...fullCaps(), promptImage: 'yes' } }],
      // cleanup/capabilityHash 为宿主恒发键（null 词表或合法事实）
      ['cleanup 步骤词表外', { ...okBase, cleanup: { close: 'maybe', delete: 'done', message: null } }],
      ['cleanup 缺 delete', { ...okBase, cleanup: { close: 'done', message: null } }],
      ['cleanup message 非 string/null', { ...okBase, cleanup: { close: 'done', delete: 'failed', message: 7 } }],
      ['capabilityHash 非 string/null', { ...okBase, capabilityHash: 16 }],
      // matrix 为 probe-ok 宿主恒发键（逐行严检，畸形整包拒）
      ['matrix 非数组', { ...okBase, matrix: {} }],
      ['matrix 行非 object', { ...okBase, matrix: ['loadSession'] }],
      ['matrix 行缺 id', { ...okBase, matrix: [matrixWithoutId] }],
      ['matrix advertised 非 boolean/null', { ...okBase, matrix: [{ ...okMatrix[0], advertised: 'yes' }] }],
      ['matrix hostSeam 非 string/null', { ...okBase, matrix: [{ ...okMatrix[0], hostSeam: 1 }] }],
      ['matrix status 词表外', { ...okBase, matrix: [{ ...okMatrix[0], status: 'half' }] }],
      ['matrix note 非 string', { ...okBase, matrix: [{ ...okMatrix[0], note: 10 }] }],
      ['error 缺 failureKind', { ...errBase, failureKind: undefined }],
      ['error 的 message 非 string', { ...errBase, message: 42 }],
      ['error 的 at 非 number', { ...errBase, at: 'now' }],
      [
        'error 缺 phase（宿主恒发 phase|null 词表）',
        { status: 'error', at: 1, failureKind: 'timeout', message: 'boom' },
      ],
      ['error phase 非法值', { ...errBase, phase: 'prompt' }],
    ]
    for (const [label, probe] of badProbes) {
      expect(decodeHealthResponse({ providers: [{ ...okRow, probe }] }), label).toBeUndefined()
    }
  })
})

describe('decodeBoundSessions', () => {
  it('合法应答原样往返（count=0 也是合法计数）', () => {
    expect(decodeBoundSessions({ agentId: 'devin', count: 3 })).toEqual({ agentId: 'devin', count: 3 })
    expect(decodeBoundSessions({ agentId: 'custom', count: 0 })).toEqual({ agentId: 'custom', count: 0 })
  })

  it('畸形/错型整体拒绝为 undefined（绝不拿解码失败冒充 0）', () => {
    const bads: Array<[string, unknown]> = [
      ['整体非 object', 'nope'],
      ['整体为数组', []],
      ['整体为 null', null],
      ['agentId 缺席', { count: 1 }],
      ['agentId 非法 id', { agentId: 'Devin Agent', count: 1 }],
      ['agentId 非 string', { agentId: 42, count: 1 }],
      ['count 缺席', { agentId: 'devin' }],
      ['count 非 number', { agentId: 'devin', count: '3' }],
      ['count 非整数', { agentId: 'devin', count: 1.5 }],
      ['count 负数', { agentId: 'devin', count: -1 }],
    ]
    for (const [label, body] of bads) {
      expect(decodeBoundSessions(body), label).toBeUndefined()
    }
  })
})

describe('healthRowOf', () => {
  it('按 id 匹配；未覆盖或空列表时返回 undefined', () => {
    const rows = [okRow, neverRow, authErrorRow]
    expect(healthRowOf(rows, 'devin')).toBe(okRow)
    expect(healthRowOf(rows, 'foo')).toBe(neverRow)
    expect(healthRowOf(rows, 'ghost')).toBeUndefined()
    expect(healthRowOf([], 'devin')).toBeUndefined()
  })
})

describe('错误文本整形：errorMessageOf', () => {
  it('errorMessageOf：Error 取 message，其余 String()', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom')
    expect(errorMessageOf(new TypeError('bad'))).toBe('bad')
    expect(errorMessageOf('plain')).toBe('plain')
    expect(errorMessageOf(42)).toBe('42')
    expect(errorMessageOf(null)).toBe('null')
    expect(errorMessageOf(undefined)).toBe('undefined')
    expect(errorMessageOf({ a: 1 })).toBe('[object Object]')
  })
})

describe('catalog identity survives profile customization', () => {
  it('preserves generic catalog identity through changing ID and editing', () => {
    const draft = draftFromCatalogEntry('fast-agent')!
    const config = validateAgentDraft({ ...draft, id: 'my-fast', name: 'My fast' }, {}, undefined).config!
    expect(config.catalogId).toBe('fast-agent')
    expect(config.runtime).toBeUndefined()
    expect(validateAgentDraft(draftFromAgent('my-fast', config), { 'my-fast': config }, 'my-fast').config).toEqual(
      config,
    )
  })
  it('keeps unknown catalog IDs without granting a runtime', () => {
    const config: AcpAgentConfig = { name: 'Custom', command: 'custom', args: [], env: {}, catalogId: 'future-agent' }
    expect(draftFromAgent('my-custom', config).catalogId).toBe('future-agent')
    expect(effectiveRuntimeOf('my-custom', config)).toBeUndefined()
    const copiedKnownCatalog: AcpAgentConfig = {
      name: 'Custom CodeBuddy Wrapper',
      command: 'custom',
      args: [],
      env: {},
      catalogId: 'codebuddy-code',
    }
    expect(effectiveRuntimeOf('my-custom', copiedKnownCatalog)).toBeUndefined()
  })
})
