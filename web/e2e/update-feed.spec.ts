import { expect, test, type Page } from '@playwright/test'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/** Installs session and durable mock server state; reloads retain only server-owned read state.
 * @param page - Browser page whose API requests are intercepted.
 * @returns Controls for simulating revocation and refresh failure.
 */
async function mockFeed(page: Page) {
  const state = { feed: structuredClone(updateFeedFixture), denied: false, failed: false }
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'feed-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: ['mukuroji-system-admins'], isSystemAdmin: true, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'owner' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/planning/update-feed**', async (route) => {
    if (state.failed) return route.fulfill({ status: 503, json: { message: 'Unavailable' } })
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON()
      expect(input).toMatchObject({ target: updateFeedFixture.entries[0]?.target, version: 1 })
      const entry = state.feed.entries[0]
      if (!entry?.readState || entry.readState.revision !== input.expectedRevision) return route.fulfill({ status: 409, json: {} })
      entry.readState = { read: input.read, revision: input.expectedRevision + 1 }
      return route.fulfill({ json: entry.readState })
    }
    const view = new URL(route.request().url()).searchParams.get('view')
    return route.fulfill({ json: { ...state.feed, view, ...(state.denied ? { entries: [], total: 0 } : {}) } })
  })
  return state
}

test('explicit read/unread survives a fresh page and refresh removes revoked content', async ({ page }) => {
  const state = await mockFeed(page)
  await page.goto('/updates')
  await expect(page.getByTestId('update-feed-row')).toHaveCount(3)
  await expect(page.getByText('On track', { exact: true })).toBeVisible()
  await expect(page.getByText('Overdue', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mark as read: Customer onboarding', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Mark as unread:/ })).toHaveCount(2)
  await page.reload()
  await expect(page.getByRole('button', { name: /^Mark as unread:/ })).toHaveCount(2)
  await page.getByRole('button', { name: 'Mark as unread: Customer onboarding', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mark as read: Customer onboarding', exact: true })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'View history & evidence: Customer onboarding', exact: true })).toHaveAttribute('href', '/planning/portfolio?targetType=project&teamId=core-team&projectId=refero')
  state.denied = true
  await page.getByLabel('Feed', { exact: true }).selectOption('recent')
  await expect(page.getByText('No updates in this feed')).toBeVisible()
  await expect(page.getByTestId('update-feed-row')).toHaveCount(0)
})

test('narrow screen wraps reports and failed refresh removes stale rows', async ({ page }) => {
  const state = await mockFeed(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/updates')
  await expect(page.getByTestId('update-feed-row')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/issue241-feed-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '/tmp/issue241-feed-desktop.png', fullPage: true })
  state.failed = true
  await page.getByLabel('Feed', { exact: true }).selectOption('recent')
  await expect(page.getByText('Updates could not be verified. Reload to check current access.')).toBeVisible()
  await expect(page.getByTestId('update-feed-row')).toHaveCount(0)
  state.failed = false
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(page.getByTestId('update-feed-row')).toHaveCount(3)
})
