import { chromium, _electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// Run the same product scenarios in a real Electron renderer, with an isolated
// user-data directory. This does not claim coverage of the packaged desktop host.
chromium.launch = async () => {
  if (process.env.DSH_E2E_RETAIN === '1') throw new Error('Electron regression does not support retained browser sessions')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-acp-electron-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)))
  let application
  try {
    application = await _electron.launch({
      executablePath: process.env.DSH_E2E_ELECTRON,
      args: [fileURLToPath(new URL('./electron-main.cjs', import.meta.url)), `--user-data-dir=${directory}`],
      env: { ...env, TZ: 'Asia/Shanghai' }, timeout: 30_000,
    })
    return {
      async newPage({ viewport, locale, timezoneId } = {}) {
        const window = application.waitForEvent('window')
        await application.evaluate(({ BrowserWindow }, partition) => {
          const window = new BrowserWindow({
            width: 1680, height: 1000, show: false,
            webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
          })
          globalThis.dshRegressionWindows.add(window)
          window.once('closed', () => globalThis.dshRegressionWindows.delete(window))
          void window.loadURL('about:blank')
        }, randomUUID())
        const page = await window
        const cdp = await page.context().newCDPSession(page)
        try {
          if (locale) await cdp.send('Emulation.setLocaleOverride', { locale })
          if (timezoneId) await cdp.send('Emulation.setTimezoneOverride', { timezoneId })
        } finally { await cdp.detach() }
        if (viewport) await page.setViewportSize(viewport)
        return page
      },
      contexts: () => [application.context()],
      async close() {
        try { await application.close() } finally { await rm(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    try { await application?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}
