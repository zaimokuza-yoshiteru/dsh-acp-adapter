import { request } from 'node:http'
import type { Readable } from 'node:stream'

/** The only permitted destination comes from the just-spawned CLI over its private stdout. */
export function readServerEndpoint(stdout: Readable | undefined, signal: AbortSignal): Promise<string> {
  if (!stdout) return Promise.reject(new Error('Missing OpenCode server output'))
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let text = ''
    const cleanup = () => {
      stdout.off('data', onData)
      stdout.off('end', fail)
      stdout.off('error', fail)
      signal.removeEventListener('abort', fail)
    }
    const fail = () => {
      cleanup()
      reject(new Error('Invalid OpenCode server announcement'))
    }
    const onData = (chunk: Buffer) => {
      if (text.length + chunk.length > 1024) return fail()
      text += chunk.toString('utf8')
      if (!text.includes('\n')) return
      try {
        const { url } = JSON.parse(text.trim()) as { url: unknown }
        if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(url) || !new URL(url).port)
          return fail()
        cleanup()
        stdout.resume()
        resolve(url)
      } catch {
        fail()
      }
    }
    stdout.on('data', onData)
    stdout.once('end', fail)
    stdout.once('error', fail)
    signal.addEventListener('abort', fail, { once: true })
  })
}

/** Direct loopback only. Do not follow redirects, use inherited proxies, log bodies or transport the prompt in argv. */
export function localReviewApi(origin: string, password: string, signal: AbortSignal) {
  const authorization = `Basic ${Buffer.from('opencode:' + password).toString('base64')}`
  return (path: string, body?: unknown, byteLimit = 16384): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const req = request(
        origin + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          agent: false,
          signal,
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.destroy()
            reject(new Error('OpenCode review API rejected the request'))
            return
          }
          const parts: Buffer[] = []
          let size = 0
          res.on('error', reject)
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > byteLimit) res.destroy(new Error('OpenCode result limit exceeded'))
            else parts.push(chunk)
          })
          res.on('end', () => {
            try {
              const result: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
              if (!result || typeof result !== 'object' || Array.isArray(result))
                throw Error('Invalid OpenCode API result')
              resolve(result as Record<string, unknown>)
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      req.once('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}
