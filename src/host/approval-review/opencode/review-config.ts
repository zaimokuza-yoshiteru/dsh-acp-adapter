import { ApprovalReviewError } from '../../../contract/approval-review.ts'
import type { AcpAgentConfig } from '../../../contract/agent-config.ts'
import { constants } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { isReviewEnvironmentKey } from '../subprocess.ts'

const unavailable = () => new ApprovalReviewError('unverified-reviewer')
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

// The native 2.3.2 text transports verified against @opencode/ai's published exports.
// Other packages (including the npm-installed AI SDK bridge) require human approval.
const nativePackages = new Set(
  [
    'amazon-bedrock',
    'anthropic',
    'anthropic-compatible',
    'azure',
    'azure/chat',
    'azure/messages',
    'azure/responses',
    'cerebras',
    'deepseek',
    'google',
    'google-vertex',
    'google-vertex/messages',
    'google-vertex/responses',
    'groq',
    'mistral',
    'openai',
    'openai/chat',
    'openai/responses',
    'openai-compatible',
    'openai-compatible/responses',
    'openai-compatible-responses',
  ].map((name) => '@opencode/ai/providers/' + name),
)

function configObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}

function checkTransport(value: unknown) {
  const entry = configObject(value)
  for (const pkg of [entry.package, entry.npm])
    if (pkg !== undefined && (typeof pkg !== 'string' || !nativePackages.has(pkg))) throw unavailable()
  // Native providers may merge raw request body overrides after constructing the tool-less generation.
  for (const settings of [entry.settings, entry.options]) {
    if (settings === undefined) continue
    const data = configObject(settings)
    if (['body', 'tools', 'functions', 'toolChoice', 'tool_choice', 'messages', 'model'].some((k) => k in data))
      throw unavailable()
  }
  return entry
}

/** The advertised model can select a different implementation than the configured provider.
 * Require an actual native text transport: bundled agent-backed bridges can start a second agent. */
export function verifyOpenCodeReviewModel(value: unknown) {
  const model = checkTransport(value)
  if (typeof model.package !== 'string' || !nativePackages.has(model.package)) throw unavailable()
}

function checkConfig(raw: string) {
  // Match quoted strings first, including escapes, so comment markers and commas inside values are literal.
  const withoutComments = raw.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (token) =>
    token[0] === '"' ? token : ' ',
  )
  const data: unknown = JSON.parse(
    withoutComments.replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g, (token) => (token === ',' ? '' : token)),
  )
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable()
  const config = data as Record<string, unknown>
  for (const key of ['plugins', 'plugin', 'mcp', 'mcpServers']) {
    const value = config[key]
    if (value !== undefined && (!value || typeof value !== 'object' || Object.keys(value).length)) throw unavailable()
  }
  for (const declarations of [config.providers, config.provider]) {
    if (declarations === undefined) continue
    for (const provider of Object.values(configObject(declarations))) {
      const entry = checkTransport(provider)
      if (entry.models === undefined) continue
      for (const model of Object.values(configObject(entry.models))) {
        const m = checkTransport(model)
        if (m.provider !== undefined) checkTransport(m.provider)
      }
    }
  }
}

async function checkFile(file: string) {
  const stat = await lstat(file).catch((error) => {
    if (!absent(error)) throw error
  })
  if (!stat) return
  if (!stat.isFile() || stat.size > 1048576) throw unavailable()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size > 1048576) throw unavailable()
    checkConfig(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

/** Detect local extension entrypoints before starting a private server; the runtime registry also checks managed sources. */
async function assertReviewBase(env: Record<string, string>, location: string) {
  const system = process.platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode'
  if (process.platform === 'darwin') {
    for (const root of ['/Library/Managed Preferences', join('/Library/Managed Preferences', userInfo().username)]) {
      if (
        await lstat(join(root, 'ai.opencode.managed.plist')).catch((error) => {
          if (!absent(error)) throw error
        })
      )
        throw unavailable()
    }
  }
  for (const directory of new Set([system, location, ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])])) {
    await assertNoToolOverrides(directory)
    for (const file of ['config.json', 'opencode.json', 'opencode.jsonc']) await checkFile(join(directory, file))
  }
  if (env.OPENCODE_CONFIG) await checkFile(env.OPENCODE_CONFIG)
  if (env.OPENCODE_CONFIG_CONTENT) checkConfig(env.OPENCODE_CONFIG_CONTENT)
}

async function assertNoToolOverrides(directory: string) {
  for (const name of ['plugin', 'plugins', 'tool', 'tools']) {
    const files = await readdir(join(directory, name), { withFileTypes: true }).catch((error) => {
      if (!absent(error)) throw error
      return []
    })
    if (files.some((file) => !file.isFile() || /\.(?:js|ts)$/.test(file.name))) throw unavailable()
  }
}

/** V2.3.2 can load location-specific remote config via Console and registered well-known endpoints.
 * Keep these deployments manual. Read only presence facts, never credential values or conversation data. */
async function assertNoRemoteConfig(env: Record<string, string>) {
  const file = join(env.XDG_DATA_HOME || join(env.HOME!, '.local', 'share'), 'opencode', 'opencode.db')
  const st = await lstat(file).catch((e) => {
    if (!absent(e)) throw e
  })
  if (!st) return
  if (!st.isFile()) throw unavailable()
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const query = `SELECT 1 FROM account_state WHERE active_org_id IS NOT NULL
      UNION ALL SELECT 1 FROM control_account WHERE active = 1
      UNION ALL SELECT 1 FROM kv WHERE key = 'wellknown:sources' AND value != '[]' LIMIT 1`
    if (db.prepare(query).get()) throw unavailable()
  } finally {
    db.close()
  }
}

/** Check before the business connection starts and again around each grant: a project plugin may shadow a native name. */
export async function verifyOpenCodeActorOrigin(profile: Pick<AcpAgentConfig, 'env'>, actorCwd: string): Promise<void> {
  if (!isAbsolute(actorCwd)) throw unavailable()
  // The host scrubs its runner bootstrap separately; its actual ACP child inherits these loader controls.
  const actorEnv = { ...process.env, ...profile.env }
  if (
    ['LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES'].some((key) => actorEnv[key]?.trim()) ||
    /(?:^|\s)["']?(?:--(?:require|import|(?:experimental-)?loader)(?=[=\s"']|$)|-r(?!-))/.test(
      actorEnv.NODE_OPTIONS ?? '',
    )
  )
    throw unavailable()
  const { env, location } = reviewEnvironment(profile.env)
  await assertReviewBase(env, location)
  await assertNoRemoteConfig(env)
  let directory = await realpath(actorCwd)
  // 2.3.2 discovers direct config files and .opencode directories all the way to the filesystem root.
  while (true) {
    const scoped = join(directory, '.opencode')
    for (const file of ['opencode.json', 'opencode.jsonc']) {
      await checkFile(join(directory, file))
      await checkFile(join(scoped, file))
    }
    await assertNoToolOverrides(scoped)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

/** Preserve the CLI's own base settings, account, and organization policies. Only the review cwd is new. */
export function reviewEnvironment(config: Record<string, string>) {
  const source = { ...process.env, ...config }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (
      isReviewEnvironmentKey(key) ||
      /^(?:HOME|XDG_(?:DATA|CONFIG|CACHE|STATE|RUNTIME)_HOME|XDG_RUNTIME_DIR|OPENCODE_CONFIG(?:_DIR|_CONTENT)?)$/i.test(
        key,
      )
    )
      env[key] = value
    // Like the business ACP process, forward only credentials specified in this profile.
    else if (Object.hasOwn(config, key) && /^(?:[A-Z0-9_]+_(?:KEY|TOKEN)|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/.test(key))
      env[key] = value
    else if (key === 'OPENCODE_CONFIG_PROJECT_DISABLE' && /^(?:0|1|true|false)$/.test(value)) continue
    else if (/^OPENCODE_(?:TEST_MANAGED|CONFIG|DB|DATABASE|AUTH|CONTROL|POLICY|SERVER)/.test(key)) throw unavailable()
  }
  env.HOME ??= homedir()
  const configRoot = env.XDG_CONFIG_HOME || join(env.HOME, '.config')
  if (
    !isAbsolute(configRoot) ||
    [
      'HOME',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_DIR',
    ].some((k) => env[k] && !isAbsolute(env[k]!))
  )
    throw unavailable()
  env.OPENCODE_CONFIG_PROJECT_DISABLE = '1'
  return { env, location: env.OPENCODE_CONFIG_DIR || join(configRoot, 'opencode') }
}
