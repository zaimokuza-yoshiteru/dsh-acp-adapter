import type { Locator, Page } from 'playwright'

/** Explicitly acknowledge that blank rebind discards the Agent's private context. */
export async function confirmBlankRecovery(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Reset the current Agent context', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm resetting to blank context', exact: true })
    .click()
}

export function recoveryButtonRow(trigger: Locator): Promise<'beside' | 'below'> {
  return trigger.evaluate((button) => {
    const summary = button.previousElementSibling
    if (!summary) throw new Error('Recovery summary missing')
    return button.getBoundingClientRect().top >= summary.getBoundingClientRect().bottom - 1 ? 'below' : 'beside'
  })
}

export function resetLabelsFit(page: Page, confirmName: string): Promise<boolean> {
  return page
    .getByRole('dialog')
    .getByRole('button', { name: confirmName, exact: true })
    .evaluate((confirm) => {
      const buttons = confirm.parentElement?.querySelectorAll('button')
      if (buttons?.length !== 2) return false
      return Array.from(buttons).every((button) => {
        const range = document.createRange()
        range.selectNodeContents(button)
        const text = range.getBoundingClientRect()
        const bounds = button.getBoundingClientRect()
        return (
          text.width > 0 &&
          text.left >= bounds.left - 1 &&
          text.right <= bounds.right + 1 &&
          text.top >= bounds.top - 1 &&
          text.bottom <= bounds.bottom + 1
        )
      })
    })
}
