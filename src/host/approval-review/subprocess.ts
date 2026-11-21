import type { SubprocessSeam } from '../../runtime/process/subprocess.ts'

export function isReviewEnvironmentKey(key: string): boolean {
  return /^(?:PATH|LANG|LANGUAGE|LC_\w+|TZ|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)
}

/** Host subprocess merges a scrubbed parent environment. Remove inherited CLI, loader and config overrides too. */
export function privateReviewSubprocess(host: SubprocessSeam): SubprocessSeam {
  return {
    resolveExecutable: host.resolveExecutable.bind(host),
    spawn(spec) {
      const removed: Record<string, undefined> = {}
      for (const key of Object.keys(process.env)) if (!isReviewEnvironmentKey(key)) removed[key] = undefined
      return host.spawn({ ...spec, env: { ...removed, ...spec.env } })
    },
  }
}
