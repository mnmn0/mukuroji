import { expect, test, type Page } from '@playwright/test'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { SavedUpdateFeeds } from '@mukuroji/contracts'

/** Installs session and durable mock server state; reloads retain only server-owned read state.
 * @param page - Browser page whose API requests are intercepted.
 * @param guest - Whether the authenticated member is a read-only guest.
 * @returns Controls for simulating revocation and refresh failure.
 */
async function mockFeed(page: Page, guest = false) {
  const saved: SavedUpdateFeeds = { revision: 0, feeds: [] }
  const state = { feed: structuredClone(updateFeedFixture), saved, denied: false, failed: false, forbidden: false, conflict: false }
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'feed-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: guest ? [] : ['mukuroji-system-admins'], isSystemAdmin: !guest, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: guest ? 'guest' : 'owner' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/planning/update-feed**', async (route) => {
    if (state.forbidden) return route.fulfill({ status: 403, json: { code: 'WorkspacePermissionDenied' } })
    if (state.failed) return route.fulfill({ status: 503, json: { message: 'Unavailable' } })
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/saved')) {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON()
        if (state.conflict || input.expectedRevision !== state.saved.revision) return route.fulfill({ status: 409, json: { code: 'SavedUpdateFeedsConflict' } })
        state.saved = { revision: state.saved.revision + 1, feeds: input.feeds }
      }
      return route.fulfill({ json: state.saved })
    }
    if (url.pathname.endsWith('/options')) return route.fulfill({ json: state.denied ? { teams: [], projects: [], portfolios: [], initiatives: [] } : { teams: [{ id: 'core-team', name: 'Core team' }], projects: [{ teamId: 'core-team', projectId: 'refero', name: 'Customer onboarding' }], portfolios: [{ id: 'portfolio', name: 'Customer outcomes' }], initiatives: [{ id: 'reliability', name: 'Reliability' }] } })
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON()
      expect(input).toMatchObject({ target: updateFeedFixture.entries[0]?.target, version: 1 })
      const entry = state.feed.entries[0]
      if (!entry?.readState || entry.readState.revision !== input.expectedRevision) return route.fulfill({ status: 409, json: {} })
      entry.readState = { read: input.read, revision: input.expectedRevision + 1 }
      return route.fulfill({ json: entry.readState })
    }
    const view = new URL(route.request().url()).searchParams.get('view')
    expect(new URL(route.request().url()).searchParams.get('locale')).toBe('en')
    const definition = state.saved.feeds.find((feed) => feed.id === url.searchParams.get('feedId'))
    const entries = state.denied ? [] : state.feed.entries.filter((entry) => !definition || definition.filters.health.length === 0 || definition.filters.health.includes(entry.health))
    return route.fulfill({ json: { ...state.feed, view, entries, total: entries.length } })
  })
  return state
}

test('explains membership, watch and interaction separately from health, submission and attention', async ({ page }) => {
  const state = await mockFeed(page)
  const entry = state.feed.entries[0]
  if (!entry) throw new Error('Missing fixture')
  entry.relevance = 9
  entry.reasons = ['project-member', 'watching', 'recent-interaction']
  entry.attention = { score: 3, reasons: ['recent-comment', 'recent-reaction'] }
  await page.goto('/updates')
  const row = page.getByTestId('update-feed-row').first()
  await expect(row.getByText(/You are a current Project member/)).toBeVisible()
  await expect(row.getByText(/You watch this target/)).toBeVisible()
  await expect(row.getByText(/You interacted within 30 days/)).toBeVisible()
  await expect(row.getByText(/Comment activity within 7 days/)).toBeVisible()
  await expect(row.getByText(/including removed reactions/)).toBeVisible()
  await expect(row.getByText('On track', { exact: true })).toBeVisible()
  await expect(row.getByText('Overdue', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/issue241-relevance-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/issue241-relevance-mobile.png', fullPage: true })
})

test('guests have no mutation controls and permission denial offers no reload loop', async ({ page }) => {
  const state = await mockFeed(page, true)
  await page.goto('/updates')
  await expect(page.getByTestId('update-feed-row')).toHaveCount(3)
  await expect(page.getByText('Guest access is read-only.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Mark as/ })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/issue241-feed-guest.png', fullPage: true })
  state.forbidden = true
  await page.getByLabel('Feed', { exact: true }).selectOption('recent')
  await expect(page.getByText('You do not have permission to view updates. Contact a workspace administrator.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('update-feed-row')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/issue241-feed-denied.png', fullPage: true })
})

test('saved feeds survive reload, edit with CAS, retain conflicts and require explicit deletion', async ({ page }) => {
  const state = await mockFeed(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/updates')
  await page.getByRole('button', { name: 'New feed', exact: true }).click()
  await expect(page.getByLabel('Feed name', { exact: true })).toBeFocused()
  await page.getByLabel('Feed name', { exact: true }).fill('Customer risks')
  await page.getByRole('listbox', { name: 'Reported health', exact: true }).selectOption('at-risk')
  await page.screenshot({ path: '/tmp/issue241-custom-editor-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Save feed', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/issue241-custom-editor-mobile-bottom.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByLabel('Feed name', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/issue241-custom-editor-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(page).toHaveURL(/feedId=/)
  await expect(page.getByTestId('update-feed-row')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Saved feeds', exact: true })).toHaveValue(state.saved.feeds[0]?.id ?? '')
  await expect(page.getByTestId('update-feed-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Edit feed', exact: true }).click()
  await page.getByLabel('Feed name', { exact: true }).fill('My retained draft')
  state.conflict = true
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(page.getByText(/Your draft is retained/)).toBeVisible()
  await expect(page.getByLabel('Feed name', { exact: true })).toHaveValue('My retained draft')
  await expect(page.getByRole('button', { name: 'Save feed', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Saved feeds', exact: true })).toBeFocused()
  state.conflict = false
  await page.getByRole('button', { name: 'Edit feed', exact: true }).click()
  await page.getByLabel('Feed name', { exact: true }).fill('Reviewed risks')
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(page.getByRole('option', { name: 'Reviewed risks', exact: true })).toBeAttached()
  await page.getByRole('button', { name: 'Delete feed', exact: true }).click()
  await expect(page.getByText('Delete the saved feed “Reviewed risks”? Reports and read states will be kept.')).toBeVisible()
  await page.getByRole('button', { name: 'Delete feed', exact: true }).click()
  await expect(page).not.toHaveURL(/feedId=/)
  expect(state.saved).toEqual({ revision: 3, feeds: [] })
})

test('editing saved feeds preserves collection order while creation appends and deletion removes only its target', async ({ page }) => {
  const state = await mockFeed(page)
  state.saved = { revision: 7, feeds: ['first', 'middle', 'last'].map((id) => ({
    id, name: id, view: 'recent',
    filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] },
  })) }
  await page.goto('/updates?feedId=first')
  const selector = page.getByRole('combobox', { name: 'Saved feeds', exact: true })
  for (const id of ['first', 'middle']) {
    await selector.selectOption(id)
    await page.getByRole('button', { name: 'Edit feed', exact: true }).click()
    await page.getByLabel('Feed name', { exact: true }).fill(`${id} renamed`)
    await page.getByRole('button', { name: 'Save feed', exact: true }).click()
    await expect(selector).toBeFocused()
    expect(state.saved.feeds.map((feed) => feed.id)).toEqual(['first', 'middle', 'last'])
    await expect(selector.locator('option')).toHaveText(['Standard feeds', 'first renamed', id === 'middle' ? 'middle renamed' : 'middle', 'last'])
  }
  expect(state.saved.revision).toBe(9)
  await page.reload()
  await expect(selector.locator('option')).toHaveText(['Standard feeds', 'first renamed', 'middle renamed', 'last'])
  await page.getByRole('button', { name: 'New feed', exact: true }).click()
  await page.getByLabel('Feed name', { exact: true }).fill('new appended')
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(selector).toBeFocused()
  expect(state.saved.feeds.map((feed) => feed.name)).toEqual(['first renamed', 'middle renamed', 'last', 'new appended'])
  await selector.selectOption('middle')
  await page.getByRole('button', { name: 'Delete feed', exact: true }).click()
  await expect(page.getByText('Delete the saved feed “middle renamed”? Reports and read states will be kept.')).toBeVisible()
  await page.getByRole('button', { name: 'Delete feed', exact: true }).click()
  await expect(selector).toBeFocused()
  expect(state.saved).toMatchObject({ revision: 11, feeds: [{ id: 'first', name: 'first renamed' }, { id: 'last', name: 'last' }, { name: 'new appended' }] })
  await expect(selector.locator('option')).toHaveText(['Standard feeds', 'first renamed', 'last', 'new appended'])
})

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

test('unavailable saved conditions show only counts and survive edits to other dimensions', async ({ page }) => {
  const state = await mockFeed(page)
  const filters = { teamIds: ['hidden-team-a', 'hidden-team-b'], projects: [{ teamId: 'hidden-team-a', projectId: 'hidden-project' }], portfolioIds: ['hidden-portfolio'], initiativeIds: ['hidden-initiative'], health: [], updateStates: [] }
  state.saved = { revision: 1, feeds: [{ id: 'personal', name: 'My view', view: 'recent', filters }] }
  await page.goto('/updates?feedId=personal')
  await page.getByRole('button', { name: 'Edit feed', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Teams', exact: true })).toHaveAccessibleDescription('Unavailable saved conditions: 2. Changing this field removes them; editing other fields keeps them.')
  for (const name of ['Projects', 'Portfolios', 'Initiative targets']) await expect(page.getByRole('listbox', { name, exact: true })).toHaveAccessibleDescription('Unavailable saved conditions: 1. Changing this field removes them; editing other fields keeps them.')
  const html = await page.content()
  for (const hidden of ['hidden-team-a', 'hidden-team-b', 'hidden-project', 'hidden-portfolio', 'hidden-initiative']) expect(html).not.toContain(hidden)
  await page.getByRole('listbox', { name: 'Reported health', exact: true }).selectOption('at-risk')
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit feed', exact: true })).toBeVisible()
  expect(state.saved.feeds[0]?.filters).toEqual({ ...filters, health: ['at-risk'] })
  await page.getByRole('button', { name: 'Edit feed', exact: true }).click()
  await page.getByRole('listbox', { name: 'Teams', exact: true }).selectOption('core-team')
  await expect(page.getByRole('listbox', { name: 'Teams', exact: true })).not.toHaveAttribute('aria-describedby')
  await page.getByRole('button', { name: 'Save feed', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit feed', exact: true })).toBeVisible()
  expect(state.saved.feeds[0]?.filters).toEqual({ ...filters, teamIds: ['core-team'], health: ['at-risk'] })
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
