import type { Page, Locator } from 'playwright'

/** The native root catalog remains the only member-navigation entry. */
export async function openNativeMembers(page: Page): Promise<Locator> {
  const trigger = page.locator('[data-subagent-action] button[aria-haspopup="dialog"]').first()
  await trigger.waitFor()
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  const catalog = page.locator('[data-subagent-panel]:visible')
  await catalog.waitFor()
  return catalog
}

export async function closeNativeMembers(page: Page): Promise<void> {
  const trigger = page.locator('[data-subagent-action] button[aria-haspopup="dialog"]').first()
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) === 'true') await trigger.click()
  await page.locator('[data-subagent-panel]:visible').waitFor({ state: 'hidden' })
}

export function memberSettingsDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.locator('[data-acp-team-panel]') })
}

/** Open the footer contribution; its native Modal outlives the catalog dropdown. */
export async function openMemberSettings(page: Page): Promise<Locator> {
  const dialog = memberSettingsDialog(page)
  if (await dialog.isVisible()) return dialog
  await openNativeMembers(page)
  await page.locator('[data-acp-team-management]').getByRole('button').click()
  await dialog.waitFor()
  return dialog
}

export async function closeMemberSettings(page: Page): Promise<void> {
  const dialog = memberSettingsDialog(page)
  await dialog
    .getByRole('button', { name: /^(?:Close|关闭)$/, exact: true })
    .last()
    .click()
  await dialog.waitFor({ state: 'hidden' })
}

/** Use the native row's sidebar action, preserving the current main conversation. */
export async function openNativeMemberAside(page: Page, name: string): Promise<void> {
  if (await memberSettingsDialog(page).isVisible()) await closeMemberSettings(page)
  const catalog = await openNativeMembers(page)
  const row = catalog.getByRole('treeitem').filter({ hasText: name }).first()
  await row.getByRole('button', { name: /sidebar|侧栏|侧边栏/i }).click()
  await page.locator('[data-sidebar-chat]').waitFor()
}
