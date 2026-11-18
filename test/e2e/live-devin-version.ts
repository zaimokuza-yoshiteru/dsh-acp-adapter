import { execFile } from 'node:child_process'
import { scrubbedParentEnv, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/** CLI release identity is independent of ACP initialize's agentInfo.version. No prompt or auth command runs. */
export async function readLiveDevinCliVersion(
  executable: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const env = { ...scrubbedParentEnv() }
  for (const [key, value] of Object.entries(environment))
    if (!SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith('DSH_')) env[key] = value
  const output = await new Promise<string>((resolve, reject) => {
    try {
      execFile(
        executable,
        ['--version'],
        {
          cwd,
          env,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 4_096,
          killSignal: 'SIGKILL',
        },
        (error, stdout) => {
          if (error !== null) reject(new Error('LIVE_DEVIN_CLI_VERSION_QUERY_FAILED'))
          else resolve(stdout)
        },
      )
    } catch {
      reject(new Error('LIVE_DEVIN_CLI_VERSION_QUERY_FAILED'))
    }
  })
  const match = /^(?:Devin(?: CLI)?[ \t]+)?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?: \([0-9a-f]{7,64}\))?$/i.exec(
    output.trim(),
  )
  if (match?.[1] === undefined) throw new Error('LIVE_DEVIN_CLI_VERSION_OUTPUT_INVALID')
  return match[1]
}
