import { expect, test, type Page } from '@playwright/test'
import type { AuthSession } from '../src/auth/session'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const authSession = {
  accessToken: 'planning-cross-project-timeline-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

/**
 * Signs in a Workspace owner and stubs the APIs the Planning screen reads.
 *
 * @param page - Playwright page to prepare.
 */
async function preparePlanningPage(page: Page) {
  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
    window.localStorage.setItem('mukuroji.locale', 'ja')
  }, authSession)
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: 'planner@example.com',
          name: 'Planner',
        },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        username: 'planner@example.com',
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })
  await page.route('**/api/teams/projects**', async (route) => {
    await route.fulfill({ json: { teams: projectDirectoryFixtures } })
  })
  await page.route('**/api/projects/quick-access', async (route) => {
    await route.fulfill({ json: { items: [], revision: 0 } })
  })
  await page.route('**/api/notifications/unread-count', async (route) => {
    await route.fulfill({ json: { unreadCount: 0 } })
  })
  await page.route('**/api/planning', async (route) => {
    await route.fulfill({ json: planningSnapshotFixture })
  })
  await page.route('**/api/planning/archived-entities**', async (route) => {
    await route.fulfill({ json: { entities: [] } })
  })
}

test('Issue #388: opens the Project overview and Gantt chart from the cross-Project timeline', async ({ page }) => {
  await preparePlanningPage(page)
  // The fixture plans fall in August 2026, so today must be inside them for the today line.
  await page.clock.setFixedTime(new Date('2026-08-20T09:00:00'))
  await page.goto('/planning', { waitUntil: 'domcontentloaded' })

  const chart = page.getByTestId('planning-cross-project-timeline')
  await expect(chart.getByTestId('cross-project-timeline-group-project:core-team/refero')).toContainText('Refero')
  await expect(chart.getByTestId('cross-project-timeline-today')).toHaveCount(1)

  await chart.getByRole('button', { name: 'Refero の Project のガントを開く' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/projects/refero/issues' &&
    url.searchParams.get('teamId') === 'core-team' &&
    url.searchParams.get('view.override') === JSON.stringify({ layout: { mode: 'gantt' } }))

  await page.goBack()
  await page.getByTestId('planning-cross-project-timeline')
    .getByRole('button', { name: 'Refero の Project 概要を開く' })
    .click()
  await expect(page).toHaveURL((url) => url.pathname === '/projects/refero/overview' &&
    url.searchParams.get('teamId') === 'core-team')
})

test('Issue #388: prints only the cross-Project timeline laid out to the paper width', async ({ page }) => {
  await preparePlanningPage(page)
  await page.goto('/planning', { waitUntil: 'domcontentloaded' })
  const chart = page.getByTestId('planning-cross-project-timeline')
  await expect(chart.getByTestId('cross-project-timeline-bar-milestone-beta')).toBeVisible()

  // Keep the print layout until the test reads it; the real dialog would restore it on close.
  await page.evaluate(() => {
    window.print = () => undefined
  })
  await chart.getByTestId('cross-project-timeline-print-a3').click()
  await expect(page.locator('html')).toHaveAttribute('data-print-target', 'planning-timeline')
  await expect(chart).toHaveAttribute('data-print-paper', 'a3')

  await page.emulateMedia({ media: 'print' })
  await expect(chart).toBeVisible()
  await expect(chart.getByTestId('cross-project-timeline-print-a3')).toBeHidden()
  await expect(page.getByTestId('planning-timeline').locator('table')).toBeHidden()
  const gridWidth = await chart.locator('[data-print-overflow] > div').evaluate((element) =>
    element.getBoundingClientRect().width)
  expect(gridWidth).toBe(1_526)
})
