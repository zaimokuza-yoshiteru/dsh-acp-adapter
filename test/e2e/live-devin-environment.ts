import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyDevinLiveCredentials, devinCredentialsPath } from '../../scripts/devin-live-auth.ts'

/** The CLI's user-scoped MCP registration must stay inside this disposable environment. */
export async function prepareLiveDevinEnvironment<T extends Readonly<Record<string, string>>>(
  authMode: string | undefined,
  forwarded: T,
  source = { platform: process.platform, home: homedir(), environment: process.env },
) {
  if (authMode !== undefined && authMode !== 'existing') throw new Error('LIVE_AUTH_MODE_INVALID')
  if (authMode !== 'existing' && !forwarded.WINDSURF_API_KEY) throw new Error('LIVE_CONFIG_TOKEN_REQUIRED')
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-devin-auth-'))
  const dispose = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  try {
    if (authMode === 'existing')
      await copyDevinLiveCredentials(devinCredentialsPath(source.platform, source.home, source.environment), root)
    const env = {
      ...forwarded,
      HOME: join(root, 'native-home'),
      USERPROFILE: join(root, 'native-home'),
      APPDATA: join(root, 'native-data'),
      LOCALAPPDATA: join(root, 'native-cache'),
      XDG_CONFIG_HOME: join(root, 'native-config'),
      XDG_DATA_HOME: join(root, 'native-data'),
      XDG_CACHE_HOME: join(root, 'native-cache'),
    }
    const assertIsolatedDshRegistration = async (cwd: string) => {
      const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
        let text: string
        try {
          text = await readFile(path, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw new Error('LIVE_DEVIN_MANUAL_CONFIG_UNREADABLE')
        }
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch {
          throw new Error('LIVE_DEVIN_MANUAL_CONFIG_INVALID')
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw new Error('LIVE_DEVIN_MANUAL_CONFIG_INVALID')
        return value as Record<string, unknown>
      }
      const configRoot = source.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME
      const configuration = await read(join(configRoot, 'devin', 'mcp_config.json'))
      const servers = configuration?.mcpServers
      if (
        servers === null ||
        typeof servers !== 'object' ||
        Array.isArray(servers) ||
        Object.keys(servers).join(',') !== 'dsh'
      )
        throw new Error('LIVE_DEVIN_MANUAL_CONFIG_NOT_ISOLATED')
      const dsh = (servers as { dsh: unknown }).dsh
      const launcher = join(env.HOME, '.dsh', 'acp', 'mcp', 'dsh-mcp-launcher.mjs')
      if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh))
        throw new Error('LIVE_DEVIN_MANUAL_CONFIG_WRONG_SERVER')
      const entry = dsh as Record<string, unknown>
      if (
        entry.command !== process.execPath ||
        JSON.stringify(entry.args) !== JSON.stringify([launcher]) ||
        entry.url !== undefined ||
        entry.disabled === true ||
        JSON.stringify(entry.env) !== JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' })
      )
        throw new Error('LIVE_DEVIN_MANUAL_CONFIG_WRONG_SERVER')
      for (const name of ['mcp_config.json', 'mcp_config.local.json'])
        if ((await read(join(cwd, '.devin', name))) !== undefined) throw new Error('LIVE_DEVIN_MANUAL_PROJECT_OVERRIDE')
      for (const path of [
        join(configRoot, 'devin', 'config.json'),
        join(cwd, '.devin', 'config.json'),
        join(cwd, '.devin', 'config.local.json'),
      ]) {
        const config = await read(path)
        if (config?.mcpServers !== undefined || config?.read_config_from !== undefined)
          throw new Error('LIVE_DEVIN_MANUAL_CONFIG_IMPORT')
      }
    }
    return { env, dispose, assertIsolatedDshRegistration }
  } catch (error) {
    await dispose()
    throw error
  }
}
