import type { Locator } from 'playwright'
import { expect } from 'vitest'

/** Native placement may overlap the anchor; the menu and pinned action must remain usable. */
export async function expectCatalogMenuFits(menu: Locator): Promise<void> {
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const viewport = window.visualViewport
        const left = viewport?.offsetLeft ?? 0
        const top = viewport?.offsetTop ?? 0
        const right = left + (viewport?.width ?? innerWidth)
        const bottom = top + (viewport?.height ?? innerHeight)
        const failures: string[] = []
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.left < left + 11 ||
          rect.top < top + 11 ||
          rect.right > right - 11 ||
          rect.bottom > bottom - 11
        )
          failures.push(`Menu outside visible viewport: ${JSON.stringify(rect.toJSON())}`)
        const items = [...element.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        const footer = items.at(-1)
        if (footer === undefined) return [...failures, 'Missing pinned manual entry']
        const target = footer.getBoundingClientRect()
        if (
          target.width <= 0 ||
          target.height <= 0 ||
          target.left < rect.left ||
          target.right > rect.right ||
          target.top < rect.top ||
          target.bottom > rect.bottom
        )
          failures.push('Pinned manual entry is clipped')
        const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2)
        if (hit === null || !footer.contains(hit)) failures.push('Pinned manual entry hit target is intercepted')
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
          failures.push('Page overflows horizontally')
        return failures
      }),
    )
    .toEqual([])
}
