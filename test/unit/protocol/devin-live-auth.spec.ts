import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyDevinLiveCredentials, devinCredentialsPath } from '../../../scripts/devin-live-auth.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('copies only the authorized file with private permissions and never changes its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devin-live-auth-test-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'isolated')
  await mkdir(source)
  const credentials = join(source, 'credentials.toml')
  const synthetic = 'synthetic-test-credential\n'
  await writeFile(credentials, synthetic)
  await writeFile(join(source, 'history.sqlite'), 'unrelated history')
  await copyDevinLiveCredentials(credentials, target)
  const directory = join(target, 'native-data', 'devin')
  const destination = join(directory, 'credentials.toml')
  expect(await readdir(directory)).toEqual(['credentials.toml'])
  expect(await readFile(destination, 'utf8')).toBe(synthetic)
  expect(await readFile(credentials, 'utf8')).toBe(synthetic)
  if (process.platform !== 'win32') {
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  }
  await expect(copyDevinLiveCredentials(credentials, target)).rejects.toMatchObject({ code: 'EEXIST' })
})

it('uses the documented per-platform location without searching user history', () => {
  expect(devinCredentialsPath('darwin', '/home/user', {})).toBe('/home/user/.local/share/devin/credentials.toml')
  expect(devinCredentialsPath('linux', '/home/user', { XDG_DATA_HOME: '/isolated-data' })).toBe(
    '/isolated-data/devin/credentials.toml',
  )
  expect(() => devinCredentialsPath('win32', '/home/user', {})).toThrow('LIVE_AUTH_APPDATA_REQUIRED')
})

it.skipIf(process.platform === 'win32')('refuses indirect credential sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devin-live-auth-link-'))
  roots.push(root)
  const source = join(root, 'source.toml')
  await writeFile(source, 'synthetic')
  const link = join(root, 'link.toml')
  await symlink(source, link)
  await expect(copyDevinLiveCredentials(link, join(root, 'isolated'))).rejects.toThrow('LIVE_AUTH_FILE_INVALID')
})
