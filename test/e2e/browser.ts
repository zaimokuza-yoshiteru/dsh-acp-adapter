import { chromium, _electron } from 'playwright'
import type { Browser, ElectronApplication, LaunchOptions } from 'playwright'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export type TestBrowser = Pick<Browser, 'newPage' | 'contexts' | 'close'>
export async function newEnglishPage(browser: TestBrowser, height = 1000) {
  return browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
}
// Run the same product scenarios in a real Electron renderer, with an isolated
// user-data directory. This does not claim coverage of the packaged desktop host.
export async function launchBrowser(options?: LaunchOptions): Promise<TestBrowser> {
  if (!process.env.DSH_E2E_ELECTRON) return chromium.launch(options)
  if (process.env.DSH_E2E_RETAIN === '1') throw new Error('Electron regression does not support retained browser sessions')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-acp-electron-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)))
  let application: ElectronApplication | undefined
  try {
    const running = await _electron.launch({
      executablePath: process.env.DSH_E2E_ELECTRON,
      args: [fileURLToPath(new URL('./electron-main.cjs', import.meta.url)), `--user-data-dir=${directory}`],
      env: { ...env, TZ: 'Asia/Shanghai' }, timeout: 30_000,
    })
    application = running
    return {
      async newPage({ viewport, locale, timezoneId } = {}) {
        const window = running.waitForEvent('window')
        await running.evaluate(({ BrowserWindow }, partition) => {
          const window = new BrowserWindow({
            width: 1680, height: 1000, show: false,
            webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
          })
          const windows = (globalThis as typeof globalThis & { dshRegressionWindows: Set<InstanceType<typeof BrowserWindow>> }).dshRegressionWindows
          windows.add(window)
          window.once('closed', () => windows.delete(window))
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
      contexts: () => [running.context()],
      async close() {
        try { await running.close() } finally { await rm(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    try { await application?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}
