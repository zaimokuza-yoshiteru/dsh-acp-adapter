import { chromium, _electron } from 'playwright'
import type { Browser, ElectronApplication, LaunchOptions, Page } from 'playwright'

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export type TestDownload = { path(): Promise<string | null> }
export type TestBrowser = Pick<Browser, 'newPage' | 'contexts' | 'close'>
export type DownloadTestBrowser = TestBrowser & {
  downloadFromClick(page: Page, click: () => Promise<unknown>): Promise<TestDownload>
}
export async function newEnglishPage(browser: TestBrowser, height = 1000) {
  return browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
}
// Run the same product scenarios in a real Electron renderer, with an isolated
// user-data directory. This does not claim coverage of the packaged desktop host.
export async function launchBrowser(options?: LaunchOptions): Promise<DownloadTestBrowser> {
  if (!process.env.DSH_E2E_ELECTRON) {
    const browser = await chromium.launch(options)
    return {
      newPage: (options) => browser.newPage(options),
      contexts: () => browser.contexts(),
      close: () => browser.close(),
      async downloadFromClick(page, click) {
        const downloadPromise = page.waitForEvent('download')
        await click()
        return await downloadPromise
      },
    }
  }
  if (process.env.DSH_E2E_RETAIN === '1')
    throw new Error('Electron regression does not support retained browser sessions')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-acp-electron-'))
  const downloadDirectory = join(directory, 'downloads')
  await mkdir(downloadDirectory, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)),
  )
  let application: ElectronApplication | undefined
  try {
    const running = await _electron.launch({
      executablePath: process.env.DSH_E2E_ELECTRON,
      args: [fileURLToPath(new URL('./electron-main.cjs', import.meta.url)), `--user-data-dir=${directory}`],
      env: { ...env, TZ: 'Asia/Shanghai' },
      timeout: 30_000,
    })
    application = running
    const pagePartitions = new WeakMap<Page, string>()
    return {
      async newPage({ viewport, locale, timezoneId } = {}) {
        const window = running.waitForEvent('window')
        const partition = randomUUID()
        await running.evaluate(({ BrowserWindow }, partition) => {
          const window = new BrowserWindow({
            width: 1680,
            height: 1000,
            show: false,
            webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
          })
          const windows = (
            globalThis as typeof globalThis & { dshRegressionWindows: Set<InstanceType<typeof BrowserWindow>> }
          ).dshRegressionWindows
          windows.add(window)
          window.once('closed', () => windows.delete(window))
          void window.loadURL('about:blank')
        }, partition)
        const page = await window
        pagePartitions.set(page, partition)
        const cdp = await page.context().newCDPSession(page)
        try {
          if (locale) await cdp.send('Emulation.setLocaleOverride', { locale })
          if (timezoneId) await cdp.send('Emulation.setTimezoneOverride', { timezoneId })
        } finally {
          await cdp.detach()
        }
        if (viewport) await page.setViewportSize(viewport)
        return page
      },
      contexts: () => [running.context()],
      async downloadFromClick(page, click) {
        const partition = pagePartitions.get(page)
        if (!partition) throw new Error('Electron download page has no isolated session')
        const token = randomUUID()
        const outputPath = join(downloadDirectory, `${randomUUID()}.json`)
        await running.evaluate(
          ({ session }, input) => {
            const downloadSession = session.fromPartition(input.partition)
            const root = globalThis as typeof globalThis & {
              dshRegressionDownloads?: Map<string, { state: string; path: string | null; cancel: () => void }>
            }
            const downloads = (root.dshRegressionDownloads ??= new Map())
            const record = { state: 'armed', path: null as string | null, cancel: () => {} }
            let currentItem:
              | {
                  setSavePath(path: string): void
                  once(event: string, listener: (_event: unknown, state: string) => void): void
                  getSavePath(): string
                  cancel(): void
                }
              | undefined
            let timer: ReturnType<typeof setTimeout>
            const cleanup = () => {
              clearTimeout(timer)
              downloadSession.removeListener('will-download', onDownload)
            }
            const onDownload = (_event: unknown, item: NonNullable<typeof currentItem>) => {
              currentItem = item
              record.state = 'downloading'
              try {
                item.setSavePath(input.outputPath)
              } catch {
                record.state = 'save-failed'
                try {
                  item.cancel()
                } catch {
                  // The explicit save-failed status remains the useful test result.
                }
                cleanup()
                return
              }
              item.once('done', (_doneEvent, state) => {
                record.state = state
                record.path = state === 'completed' ? item.getSavePath() : null
                cleanup()
              })
            }
            record.cancel = () => {
              try {
                currentItem?.cancel()
              } catch {
                // Teardown continues even when Electron has already disposed the item.
              }
              if (record.state === 'armed' || record.state === 'downloading') record.state = 'timed-out'
              cleanup()
            }
            downloads.set(input.token, record)
            timer = setTimeout(record.cancel, input.timeoutMs)
            downloadSession.once('will-download', onDownload)
          },
          { partition, token, outputPath, timeoutMs: 10_000 },
        )

        try {
          await click()
          const deadline = Date.now() + 10_000
          let result = { state: 'armed', path: null as string | null }
          while ((result.state === 'armed' || result.state === 'downloading') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            result = await running.evaluate((_electron, id) => {
              const root = globalThis as typeof globalThis & {
                dshRegressionDownloads?: Map<string, { state: string; path: string | null }>
              }
              const record = root.dshRegressionDownloads?.get(id)
              return record ? { state: record.state, path: record.path } : { state: 'missing', path: null }
            }, token)
          }
          if (result.state !== 'completed' || result.path !== outputPath)
            throw new Error(`Electron native download failed (${result.state})`)
          return { path: async () => result.path }
        } finally {
          await running.evaluate((_electron, id) => {
            const root = globalThis as typeof globalThis & {
              dshRegressionDownloads?: Map<string, { cancel: () => void }>
            }
            const record = root.dshRegressionDownloads?.get(id)
            record?.cancel()
            root.dshRegressionDownloads?.delete(id)
          }, token)
        }
      },
      async close() {
        try {
          await running.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try {
      await application?.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
}
