import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { isReviewEnvironmentKey } from '../subprocess.ts'

const importSources = [
  'agents_standard',
  'cursor',
  'windsurf',
  'claude',
  'copilot',
  'codex',
  'kiro',
  'opencode',
  'zed',
  'cloud',
]
const authKeys = ['WINDSURF_API_KEY', 'DEVIN_API_KEY']

async function privateDirectory(): Promise<string> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Private Devin review profile unavailable')
  const systemTemp = await realpath(tmpdir())
  // Devin also searches the cwd's ancestors. A TMPDIR inside a checkout could load its native hooks.
  for (let dir = systemTemp; ; dir = dirname(dir)) {
    for (const name of ['.git', '.devin']) {
      if (
        await lstat(join(dir, name)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return undefined
        })
      )
        throw new Error('Devin review requires a private directory outside the project')
    }
    if (dirname(dir) === dir) break
  }
  const parent = join(systemTemp, 'dsh-acp-devin-review-' + uid)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const info = await lstat(parent)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error('Devin review directory is not private')
  // Only reclaim our private profiles from dead Host processes. A concurrent desktop owns its own PID.
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const owner = /^(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name)
    if (!entry.isDirectory() || !owner) continue
    const pid = Number(owner[1])
    if (pid < 1 || !Number.isSafeInteger(pid)) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        await rm(join(parent, entry.name), { recursive: true, force: true })
    }
  }
  return mkdtemp(join(parent, process.pid + '-'))
}

export async function openReviewWorkspace(profileEnv: Readonly<Record<string, string>>) {
  const root = await privateDirectory()
  const cwd = join(root, 'workspace')
  const cfg = join(root, 'config')
  const data = join(root, 'data')
  const configPath = join(cfg, 'devin', 'config.json')
  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: cfg,
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    TMPDIR: join(root, 'tmp'),
  }
  const close = () => rm(root, { recursive: true, force: true })
  try {
    await Promise.all(
      [cwd, dirname(configPath), join(data, 'devin'), ...Object.values(env)].map((dir) =>
        mkdir(dir, { recursive: true, mode: 0o700 }),
      ),
    )
    await writeFile(
      configPath,
      JSON.stringify({
        read_config_from: Object.fromEntries(importSources.map((name) => [name, false])),
        subagents_enabled: false,
        permissions: { deny: ['read', 'edit', 'write', 'grep', 'glob', 'exec', 'fetch', 'mcp__*'] },
      }),
      { mode: 0o600, flag: 'wx' },
    )
    for (const [key, value] of Object.entries(profileEnv))
      if (isReviewEnvironmentKey(key) || authKeys.includes(key)) env[key] = value
    if (!authKeys.some((key) => !!env[key])) {
      const sourceData =
        profileEnv.XDG_DATA_HOME || process.env.XDG_DATA_HOME || join(profileEnv.HOME || homedir(), '.local', 'share')
      if (!isAbsolute(sourceData)) throw new Error('Devin login location is not absolute')
      const source = join(sourceData, 'devin', 'credentials.toml')
      const info = await lstat(source)
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size === 0 || info.size > 64 * 1024)
        throw new Error('Devin login unavailable')
      // The CLI reads the same user's installed login. No token is read into JS or copied to a second file.
      await symlink(source, join(data, 'devin', 'credentials.toml'))
    }
    return { root, cwd, configPath, env, close }
  } catch (error) {
    await close()
    throw error
  }
}
