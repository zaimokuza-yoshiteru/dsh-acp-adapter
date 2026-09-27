import type { Page, Locator } from 'playwright'

export const ACP_PACKAGE = '@zaimokuza/dsh-acp-adapter'

/** Open ACP through the real Plugins inventory and bundle detail page. */
export async function openAcpPluginDetail(page: Page, locale: 'en' | 'zh' = 'en'): Promise<Locator> {
  await page.getByRole('button', { name: locale === 'en' ? 'Plugins' : '插件', exact: true }).click()
  const card = page.locator(`[data-plugin-package="${ACP_PACKAGE}"]`)
  await card.waitFor({ state: 'visible' })
  await card.getByRole('button').first().click()
  const detail = page.locator(`[data-plugin-detail="${ACP_PACKAGE}"]`)
  await detail.waitFor({ state: 'visible' })
  return detail
}

/** Return to the real Plugins inventory while retaining the current session. */
export async function backToPluginList(detail: Locator, locale: 'en' | 'zh' = 'en'): Promise<void> {
  await detail.getByRole('button', { name: locale === 'en' ? 'Back to plugins' : '返回插件列表', exact: true }).click()
}

/** Return to the same visible chat after using the app's Plugins navigation. */
export async function returnToConversation(page: Page, sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
  } else {
    // Panel selection is in-memory and does not create a browser history entry.
    // Reload restores the last selected conversation without starting a session.
    await page.reload()
  }
  await page.locator('[data-composer-input]').first().waitFor({ state: 'visible' })
}
