import type { Page } from 'playwright'

/** Explicitly acknowledge that blank rebind discards the Agent's private context. */
export async function confirmBlankRecovery(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Reset the current Agent context', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm resetting to blank context', exact: true })
    .click()
}
