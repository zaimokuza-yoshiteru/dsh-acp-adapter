import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpMcpLease } from '../../runtime/session/mcp-lease.ts'

async function linkEntries(source: string, target: string, except: string): Promise<void> {
  let entries
  try { entries = await readdir(source, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name !== except) await symlink(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? 'junction' : 'file')
  }
}

/** Devin currently discovers model-visible MCP tools from its native config, not ACP session/new.
 * Overlay only that file; links keep normal credentials, settings and permissions in their original homes.
 * The private endpoint is never written into the user's MCP config.
 */
export async function prepareDevinTeamConfig(env: Record<string, string>, lease: AcpMcpLease): Promise<{ env: Record<string, string>; lease: AcpMcpLease }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-team-'))
  try {
    const source = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME
      ?? (process.platform === 'win32' ? env.APPDATA ?? process.env.APPDATA : undefined)
      ?? join(env.HOME ?? process.env.HOME ?? homedir(), '.config')
    const target = join(root, 'devin')
    await mkdir(target)
    await linkEntries(source, root, 'devin')
    await linkEntries(join(source, 'devin'), target, 'mcp_config.json')
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(await readFile(join(source, 'devin', 'mcp_config.json'), 'utf8')) as Record<string, unknown> } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const servers = Object.fromEntries(lease.servers.map(server => {
      if (!('type' in server) || server.type !== 'http') throw new Error('Devin Teams requires the local HTTP bridge')
      return [server.name, { url: server.url, transport: 'http', headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) }]
    }))
    await writeFile(join(target, 'mcp_config.json'), JSON.stringify({ ...config, mcpServers: { ...config.mcpServers as object, ...servers } }), { mode: 0o600 })
    let closing: Promise<void> | undefined
    let removing: Promise<void> | undefined
    const remove = (): Promise<void> => removing ??= rm(root, { recursive: true, force: true })
    lease.signal.throwIfAborted()
    lease.signal.addEventListener('abort', () => { void remove().catch(() => undefined) }, { once: true })
    return {
      env: { ...env, XDG_CONFIG_HOME: root, ...(process.platform === 'win32' ? { APPDATA: root } : {}) },
      lease: {
        signal: lease.signal,
        ...(lease.instructions === undefined ? {} : { instructions: lease.instructions }),
        // Avoid launching a second copy through the ACP path that Devin does not expose to its model.
        servers: [],
        beginPrompt: signal => lease.beginPrompt(signal), endPrompt: () => lease.endPrompt(), permission: request => lease.permission(request),
        elicitation: (request, toolCall) => lease.elicitation?.(request, toolCall),
        presentTool: call => lease.presentTool?.(call) ?? call,
        close() { return closing ??= lease.close().finally(remove) },
      },
    }
  } catch (error) {
    await lease.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
