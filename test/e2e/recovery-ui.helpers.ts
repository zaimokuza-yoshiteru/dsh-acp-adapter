import { expect } from 'vitest'
import type { Locator, Page } from 'playwright'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeComposerDraft } from '#host-support'

export const loadFailureMarker = (directory: string) => join(directory, 'remote-session-load-failure.once')

/** An ordinary disconnect leaves the composer ready for a fresh input. */
export async function expectAutomaticRecovery(page: Page): Promise<void> {
  const notice = page.getByRole('status').filter({ hasText: 'Sending a new message will try to reconnect' })
  await notice.waitFor()
  expect(await notice.getByRole('button').count()).toBe(0)
  expect(await page.getByRole('dialog').count()).toBe(0)
}

/** Drive the real composer and fail the next load, or exhaust its transport retries. */
export async function failAutomaticRecovery(
  page: Page,
  directory: string,
  reason: 'missing' | 'disconnect' = 'missing',
): Promise<void> {
  await expectAutomaticRecovery(page)
  const marker = loadFailureMarker(directory)
  writeFileSync(marker, reason === 'disconnect' ? Array(6).fill('disconnect').join('\n') : 'missing')
  try {
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_CONTINUE_UNAVAILABLE_SESSION')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: 'Recovery options', exact: true }).waitFor({ timeout: 60_000 })
    expect(await page.getByRole('dialog').count()).toBe(0)
  } finally {
    rmSync(marker, { force: true })
  }
}

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
    const actions = button.parentElement
    const summary = actions?.previousElementSibling
    if (!actions || !summary) throw new Error('Recovery summary or actions missing')
    return actions.getBoundingClientRect().top >= summary.getBoundingClientRect().bottom - 1 ? 'below' : 'beside'
  })
}

export function resetLabelsFit(page: Page, confirmName: string): Promise<boolean> {
  return page
    .getByRole('dialog')
    .getByRole('button', { name: confirmName, exact: true })
    .evaluate((confirm) => {
      const buttons = confirm.parentElement?.querySelectorAll('button')
      if (buttons?.length !== 2) return false
      if (Math.abs(buttons[0]!.getBoundingClientRect().width - buttons[1]!.getBoundingClientRect().width) > 1)
        return false
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
