import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Devin 3000.14.30821 resolves governance plugins during session/new. Even with personal
 * imports disabled, a required plugin can change the reviewer's rules or register hooks/MCP.
 * Absence of a cache is not evidence of an empty result (including when authentication fails).
 */
export async function assertEmptyReviewRegistry(workspaceRoot: string): Promise<void> {
  const registry = join(workspaceRoot, 'data', 'devin', 'cli', 'plugins_cache')
  if ((await realpath(registry)) !== registry) throw new Error('Untrusted Devin plugin registry')
  const entries = await readdir(registry, { withFileTypes: true })
  const files: Record<string, RegExp> = {
    'installed.json': /^\s*\{\s*"requirements"\s*:\s*\[\s*\]\s*\}\s*$/,
    'resolved.json': /^\s*\{\s*"resolutions"\s*:\s*\[\s*\]\s*\}\s*$/,
  }
  if (entries.some((e) => !e.isFile() || (!Object.hasOwn(files, e.name) && e.name !== 'store.lock')))
    throw new Error('Unknown Devin plugin registry layout')
  for (const [name, empty] of Object.entries(files)) {
    const fd = await open(join(registry, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const s = await fd.stat()
      if (
        !s.isFile() ||
        s.uid !== process.getuid?.() ||
        s.nlink !== 1 ||
        s.size < 2 ||
        s.size > 512 ||
        (s.mode & 0o022) !== 0
      )
        throw new Error('Untrusted Devin plugin registry file')
      const bytes = Buffer.alloc(513)
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== s.size || !empty.test(bytes.toString('utf8', 0, bytesRead)))
        throw new Error('Devin reviewer extensions are active or unverified')
    } finally {
      await fd.close()
    }
  }
}
