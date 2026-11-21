import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'

// Catalog discovery may start first. Hold the real ACP handshake until the panel's targeted check joins it.
const gate = process.argv[2] ?? ''
if (!gate) throw new Error('Missing rename probe gate')
await new Promise<void>((resolve) => {
  const watcher = watch(dirname(gate), check)
  function check() {
    if (existsSync(gate)) {
      watcher.close()
      resolve()
    }
  }
  check()
})
await import('../mock-agent/probe-refresh-agent.ts')
