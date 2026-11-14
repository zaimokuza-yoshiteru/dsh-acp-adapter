import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Official CLI credential location; no configuration or history discovery. */
export function devinCredentialsPath(
  platform: NodeJS.Platform,
  home: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    if (!environment.APPDATA) throw new Error('LIVE_AUTH_APPDATA_REQUIRED')
    return join(environment.APPDATA, 'devin', 'credentials.toml')
  }
  return join(environment.XDG_DATA_HOME || join(home, '.local', 'share'), 'devin', 'credentials.toml')
}

/** Copy only an explicitly authorized credential file into the disposable run's private data root. */
export async function copyDevinLiveCredentials(source: string, isolatedRoot: string): Promise<void> {
  const info = await lstat(source)
  if (!info.isFile() || info.size === 0 || info.size > 64 * 1024) throw new Error('LIVE_AUTH_FILE_INVALID')
  const destination = join(isolatedRoot, 'native-data', 'devin', 'credentials.toml')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o600)
}
