import { expect, test } from '@playwright/test'

/**
 * Stories whose rendering is deterministic: no play function, no live data, and no timers.
 */
const visualStoryIds = [
  'application-pages-workspaceroutes--my-tasks-route',
  'application-pages-workspaceroutes--inbox-route',
  'application-pages-workspaceroutes--settings-route',
  'application-pages-reportspage--overview',
  'application-pages-planningpage--timeline',
  'application-pages-loginpage--default',
  'application-notifications-settings--default',
  'application-documents-workspace--library-home',
  'design-system-responsive-disclosure--desktop',
  'design-system-app-update-notice--english',
] as const

/** Themes compared for every story. */
const visualThemes = ['light', 'dark'] as const

/** Fixed clock so relative dates and "today" markers render the same on every run. */
const visualClock = new Date('2026-07-18T02:30:00.000Z')

for (const storyId of visualStoryIds) {
  for (const theme of visualThemes) {
    test(`${storyId} renders unchanged in the ${theme} theme`, async ({ page }) => {
      await page.clock.setFixedTime(visualClock)
      await page.goto(`/iframe.html?id=${storyId}&viewMode=story&globals=theme:${theme}`)
      await expect(page.locator('#storybook-root > *').first()).toBeVisible()
      await page.evaluate(async () => {
        await document.fonts.ready
      })

      await expect(page).toHaveScreenshot(`${storyId}--${theme}.png`)
    })
  }
}
