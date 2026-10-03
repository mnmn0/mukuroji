import { expect, test, type Page } from '@playwright/test'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { SavedUpdateFeeds, UpdateFeedDigestState } from '@mukuroji/contracts'

/** Installs session and durable mock server state; reloads retain only server-owned read state.
 * @param page - Browser page whose API requests are intercepted.
 * @param guest - Whether the authenticated member is a read-only guest.
 * @param expiresAt - Optional fixed session expiry for deliberately skewed device-clock tests.
 * @returns Controls for simulating revocation and refresh failure.
 */
async function mockFeed(page: Page, guest = false, expiresAt?: number) {
  const saved: SavedUpdateFeeds = { revision: 0, feeds: [] }
  const digest: UpdateFeedDigestState = { revision: 0, preferences: { enabled: false, frequency: 'daily', views: ['for-me'] }, history: [] }
  const inbox = structuredClone(digest)
  const state = { feed: structuredClone(updateFeedFixture), saved, digest, inbox, inboxDenied: false, inboxRequests: 0, digestRequests: 0, digestConflict: false, denied: false, failed: false, forbidden: false, conflict: false }
  await page.addInitScript(({ expiresAt }) => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'feed-test', expiresAt: expiresAt ?? Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  }, { expiresAt })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: guest ? [] : ['mukuroji-system-admins'], isSystemAdmin: !guest, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: guest ? 'guest' : 'owner' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/planning/update-feed**', async (route) => {
    if (state.forbidden) return route.fulfill({ status: 403, json: { code: 'WorkspacePermissionDenied' } })
    if (state.failed) return route.fulfill({ status: 503, json: { message: 'Unavailable' } })
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/digest/inbox')) {
      state.inboxRequests++
      if (state.inboxDenied) return route.fulfill({ status: 403, json: { code: 'WorkspacePermissionDenied' } })
      if (route.request().method() === 'PUT') {
        if (guest) return route.fulfill({ status: 403, json: {} })
        const input = route.request().postDataJSON()
        if (state.digestConflict || input.expectedRevision !== state.inbox.revision) return route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestConflict' } })
        state.inbox = { ...state.inbox, revision: state.inbox.revision + 1, preferences: input.preferences }
      }
      return route.fulfill({ json: state.inbox })
    }
    if (url.pathname.endsWith('/digest')) {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON()
        if (state.digestConflict || input.expectedRevision !== state.digest.revision) return route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestConflict' } })
        state.digest = { ...state.digest, revision: state.digest.revision + 1, preferences: input.preferences }
      }
      return route.fulfill({ json: state.digest })
    }
    if (url.pathname.endsWith('/digest/preview')) {
      state.digestRequests += 1
      if (state.digestConflict) return route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestConflict' } })
      const replay = state.digest.history.length > 0
      const id = state.digest.preferences.frequency === 'weekly' ? 'weekly:2026-09-28' : 'daily:2026-10-03'
      const entries = state.denied ? [] : state.feed.entries.filter((entry) => entry.latestUpdate && entry.readState?.read === false)
      state.digest = { ...state.digest, revision: state.digest.revision + 1, history: [{ id, status: 'completed', attempts: 1, token: 'fixture', leaseUntil: 0, count: entries.length }] }
      return route.fulfill({ json: { id, replay, entries, truncated: false, transport: 'preview' } })
    }
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

for (const outcome of ['success', 'deleted', '503', '401']) test(`pending custom definitions preserve selection and withdrawal before ${outcome}`, async ({ page }) => {
  const state = await mockFeed(page)
  state.saved = { revision: 1, feeds: [{ id: 'private-custom-id', name: 'Current custom source', view: 'recent', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }] }
  state.digest.preferences = { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['private-custom-id'] } }
  state.inbox.preferences = structuredClone(state.digest.preferences)
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/planning/update-feed/saved', async (route) => {
    await gate
    if (outcome === '503' || outcome === '401') return route.fulfill({ status: Number(outcome), json: {} })
    await route.fulfill({ json: outcome === 'deleted' ? { revision: 2, feeds: [] } : state.saved })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Inbox digest settings' }).click()
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const preview = page.getByRole('region', { name: 'Digest preview', exact: true })
  const inbox = page.getByRole('region', { name: 'Inbox digest settings' })
  for (const panel of [preview, inbox]) {
    await expect(panel.getByText('Loading saved feeds…')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Clear custom selection' })).toHaveCount(0)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel).not.toContainText('private-custom-id')
  }
  await expect(preview.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  await inbox.getByRole('checkbox', { name: 'Receive update digests in Inbox' }).uncheck()
  await inbox.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect.poll(() => state.inbox.preferences.enabled).toBe(false)
  expect(state.inbox.preferences.savedFeeds?.ids).toEqual(['private-custom-id'])
  release()
  if (outcome === '401') {
    await expect(preview).toHaveCount(0)
    await expect(inbox).toHaveCount(0)
  } else {
    for (const panel of [preview, inbox]) {
      await expect(panel.getByText('Loading saved feeds…')).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Clear custom selection' })).toBeVisible()
      if (outcome === 'success') await expect(panel.getByLabel('Current custom source', { exact: true })).toBeChecked()
      else await expect(panel).not.toContainText('Current custom source')
    }
    if (outcome === 'success') await expect(preview.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
    else await expect(preview.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  }
  expect(state.digestRequests).toBe(0)
})

for (const failure of ['503', 'abort']) test(`saved lookup ${failure} still permits keyboard consent withdrawal without exposing custom IDs`, async ({ page }) => {
  const state = await mockFeed(page)
  state.inbox.preferences = { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['private-custom-id'] } }
  state.digest.preferences = structuredClone(state.inbox.preferences)
  await page.route('**/api/planning/update-feed/saved', (route) => failure === 'abort' ? route.abort('failed') : route.fulfill({ status: 503, json: { code: 'SavedUpdateFeedsUnavailable' } }))
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Inbox digest settings' })
  await summary.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  const consent = panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' })
  await expect(consent).toBeChecked()
  await expect(panel).not.toContainText('private-custom-id')
  await consent.focus()
  await page.keyboard.press('Space')
  const save = panel.getByRole('button', { name: 'Save Inbox settings' })
  await expect(save).toBeEnabled()
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(consent).not.toBeChecked()
  await expect.poll(() => state.inbox.preferences.enabled).toBe(false)
  expect(state.inbox.preferences.savedFeeds).toEqual({ revision: 1, ids: ['private-custom-id'] })
  expect(state.digestRequests).toBe(0)
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const preview = page.getByRole('region', { name: 'Digest preview', exact: true })
  await expect(preview.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  await expect(preview.getByLabel('Current preview', { exact: true })).toHaveCount(0)
  await expect(preview).not.toContainText('private-custom-id')
})

test('saved lookup permission denial keeps digest controls unavailable', async ({ page }) => {
  await mockFeed(page)
  await page.route('**/api/planning/update-feed/saved', (route) => route.fulfill({ status: 403, json: { code: 'WorkspacePermissionDenied' } }))
  await page.goto('/updates')
  await expect(page.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible()
  await expect(page.locator('summary', { hasText: 'Inbox digest settings' })).toHaveCount(0)
  await expect(page.locator('summary', { hasText: 'Digest preview' })).toHaveCount(0)
})

for (const inbox of [false, true]) test(`${inbox ? 'Inbox' : 'preview'} custom digest selection pins revision and hides deleted selections`, async ({ page }, testInfo) => {
  const state = await mockFeed(page)
  state.saved = { revision: 1, feeds: [{ id: 'private-selection-id', name: 'My portfolio risks', view: 'at-risk', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }] }
  await page.goto('/updates')
  const title = inbox ? 'Inbox digest settings' : 'Digest preview'
  await page.locator('summary', { hasText: title }).click()
  const panel = page.getByRole('region', { name: title, exact: true })
  await panel.getByLabel('My portfolio risks', { exact: true }).check()
  await panel.getByLabel('For me', { exact: true }).uncheck()
  await panel.getByLabel(inbox ? 'Receive update digests in Inbox when delivery becomes available' : 'Enable manual previews').check()
  const save = panel.getByRole('button', { name: inbox ? 'Save Inbox settings' : 'Save preview settings' })
  await save.click()
  await expect(save).toBeDisabled()
  expect((inbox ? state.inbox : state.digest).preferences).toMatchObject({ views: [], savedFeeds: { revision: 1, ids: ['private-selection-id'] } })
  expect(state.digestRequests).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('custom-digest-mobile.png'), fullPage: true })
  state.saved = { revision: 2, feeds: [] }
  await page.reload()
  await page.locator('summary', { hasText: title }).click()
  await expect(panel.getByText('Saved feeds changed or are unavailable. Clear this selection and choose again.')).toBeVisible()
  await expect(panel).not.toContainText('private-selection-id')
  await expect(panel).not.toContainText('My portfolio risks')
  await expect(save).toBeDisabled()
  await panel.getByRole('button', { name: 'Clear custom selection' }).click()
  await panel.getByLabel('Recent', { exact: true }).check()
  await save.click()
  await expect(save).toBeDisabled()
  expect((inbox ? state.inbox : state.digest).preferences.savedFeeds).toBeUndefined()
  expect(state.digestRequests).toBe(0)
})

for (const conflict of [false, true]) test(`Inbox keyboard save restores owned focus with conflict=${conflict}`, async ({ page }) => {
  const state = await mockFeed(page)
  state.inbox.preferences.enabled = true
  state.digestConflict = conflict
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Inbox digest settings' })
  await summary.click()
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' }).uncheck()
  await panel.getByRole('button', { name: 'Save Inbox settings' }).focus()
  await page.keyboard.press('Enter')
  await expect(summary).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Save Inbox settings' })).toBeDisabled()
  if (conflict) await expect(panel.getByRole('alert')).toContainText('Settings changed')
})

test('saved Inbox draft follows a later external preference change without false conflict', async ({ page }) => {
  const state = await mockFeed(page)
  await page.clock.install()
  let reads = 0
  await page.route('**/api/planning/update-feed/digest/inbox', async (route) => { if (route.request().method() === 'GET') reads++; await route.fallback() })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Inbox digest settings' }).click()
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect.poll(() => state.inbox.revision).toBe(1)
  await expect(panel.getByRole('button', { name: 'Save Inbox settings' })).toBeDisabled()
  state.inbox = { ...state.inbox, revision: 2, preferences: { enabled: true, frequency: 'daily', views: ['recent'] } }
  const before = reads
  await page.clock.fastForward(6_001)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('daily')
  await expect(panel.getByLabel('Recent', { exact: true })).toBeChecked()
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('Inbox consent is lazy, off by default, independent from previews and retained after reload', async ({ page }, testInfo) => {
  const state = await mockFeed(page)
  await page.goto('/updates')
  await expect(page.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible()
  expect(state.inboxRequests).toBe(0)
  const disclosure = page.locator('summary', { hasText: 'Inbox digest settings' })
  await disclosure.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  const consent = panel.getByLabel('Receive update digests in Inbox when delivery becomes available')
  await expect(consent).not.toBeChecked()
  await expect(panel.getByText(/Automatic delivery also requires operator activation/)).toBeVisible()
  await consent.check()
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect(panel.getByText('Delivery preference saved. This does not activate automatic delivery.')).toBeVisible()
  expect(state.digest.preferences.enabled).toBe(false)
  expect(state.digestRequests).toBe(0)
  await page.reload()
  await page.locator('summary', { hasText: 'Inbox digest settings' }).click()
  await expect(consent).toBeChecked()
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: testInfo.outputPath('inbox-settings-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('inbox-settings-mobile.png'), fullPage: true })
  await consent.uncheck()
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect(panel.getByText('Inbox digests are off.')).toBeVisible()
})

test('Inbox settings conflict requires reload and permission loss hides consent', async ({ page }) => {
  const state = await mockFeed(page)
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Inbox digest settings' }).click()
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByLabel('Receive update digests in Inbox when delivery becomes available').check()
  state.digestConflict = true
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Save Inbox settings' })).toBeDisabled()
  state.inboxDenied = true
  await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(panel.locator('form')).toHaveCount(0)
  await expect(page.locator('summary', { hasText: 'Inbox digest settings' })).toBeFocused()
  expect(state.inbox.preferences.enabled).toBe(false)
  expect(state.digestRequests).toBe(0)
})

test('Inbox conflict preserves the original consent draft through a real focus refresh until explicit reload', async ({ page }) => {
  const state = await mockFeed(page)
  await page.clock.install()
  let reads = 0
  const writes: number[] = []
  await page.route('**/api/planning/update-feed/digest/inbox', async (route) => {
    if (route.request().method() === 'GET') reads++
    else writes.push(route.request().postDataJSON().expectedRevision)
    await route.fallback()
  })
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Inbox digest settings' })
  await summary.click()
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' }).check()
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByLabel('Recent', { exact: true }).check()
  state.inbox.revision++
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  expect(writes).toEqual([0])
  const initialReads = reads
  await page.clock.fastForward(6_001)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(initialReads)
  await expect(panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' })).toBeChecked()
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
  await expect(panel.getByLabel('Recent', { exact: true })).toBeChecked()
  await expect(panel.getByRole('button', { name: 'Save Inbox settings' })).toBeDisabled()
  await panel.getByRole('button', { name: 'Reload', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' })).not.toBeChecked()
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('daily')
  await expect(summary).toBeFocused()
  expect(writes).toEqual([0])
})

for (const source of ['feed', 'saved']) for (const failure of ['503', 'abort']) test(`healthy Inbox withdrawal survives ${source} ${failure}`, async ({ page }) => {
  const state = await mockFeed(page)
  state.inbox.preferences.enabled = true
  await page.route(source === 'feed' ? '**/api/planning/update-feed?*' : '**/api/planning/update-feed/saved', (route) => failure === 'abort' ? route.abort('failed') : route.fulfill({ status: 503, json: {} }))
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Inbox digest settings' })
  await summary.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' }).focus()
  await page.keyboard.press('Space')
  await panel.getByRole('button', { name: 'Save Inbox settings' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => state.inbox.preferences.enabled).toBe(false)
})

test('Inbox denial never steals focus from an outside disclosure', async ({ page }) => {
  await mockFeed(page)
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  await page.route('**/api/planning/update-feed/digest/inbox', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    waiting = true; await gate; await route.fulfill({ status: 403, json: {} })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Inbox digest settings' }).click()
  const panel = page.getByRole('region', { name: 'Inbox digest settings' })
  await panel.getByRole('checkbox', { name: 'Receive update digests in Inbox' }).check()
  await panel.getByRole('button', { name: 'Save Inbox settings' }).click()
  await expect.poll(() => waiting).toBe(true)
  const outside = page.locator('summary', { hasText: 'Digest preview' })
  await outside.focus()
  release()
  await expect(panel.locator('form')).toHaveCount(0)
  await expect(outside).toBeFocused()
})

for (const action of ['save-off', 'conflict']) test(`keyboard ${action} restores preview summary when no action remains enabled`, async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  if (action === 'save-off') await panel.getByRole('checkbox', { name: 'Enable manual previews' }).uncheck()
  else state.digestConflict = true
  await panel.getByRole('button', { name: action === 'save-off' ? 'Save preview settings' : 'Generate preview' }).focus()
  await page.keyboard.press('Enter')
  await expect(summary).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
})

test('a saved preview draft follows later external settings without a false conflict', async ({ page }) => {
  const state = await mockFeed(page)
  await page.clock.install()
  let reads = 0
  await page.route('**/api/planning/update-feed/digest', async (route) => { if (route.request().method() === 'GET') reads++; await route.fallback() })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByRole('button', { name: 'Save preview settings' }).click()
  await expect.poll(() => state.digest.revision).toBe(1)
  await expect(panel.getByRole('button', { name: 'Save preview settings' })).toBeDisabled()
  state.digest = { ...state.digest, revision: 2, preferences: { enabled: true, frequency: 'daily', views: ['recent'] } }
  const before = reads
  await page.clock.fastForward(6_001)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('daily')
  await expect(panel.getByLabel('Recent', { exact: true })).toBeChecked()
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('preview completion does not reclaim focus moved outside its form', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  await page.route('**/api/planning/update-feed/digest/preview?*', async (route) => { waiting = true; await gate; await route.fulfill({ status: 409, json: {} }) })
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByRole('button', { name: 'Generate preview' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => waiting).toBe(true)
  await summary.focus()
  release()
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(summary).toBeFocused()
})

for (const source of ['feed', 'saved']) test(`${source} outage leaves healthy standard digest controls available`, async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.route(source === 'feed' ? '**/api/planning/update-feed?*' : '**/api/planning/update-feed/saved', (route) => route.fulfill({ status: 503, json: { code: 'Unavailable' } }))
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByLabel('Current preview', { exact: true })).toBeVisible()
  expect(state.digestRequests).toBe(1)
})

test('generation after another session changes preferences reports conflict instead of silent success', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  state.digest.preferences = { enabled: true, frequency: 'weekly', views: ['recent'] }
  state.digest.revision++
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  await expect(panel.getByLabel('Current preview', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  expect(state.digestRequests).toBe(1)
  await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
  expect(state.digestRequests).toBe(1)
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByLabel('Current preview', { exact: true })).toBeVisible()
})

for (const interruption of ['deadline', 'blur', 'close', 'scope']) test(`stalled metadata releases preview on ${interruption} without late resurrection`, async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.clock.install()
  let release = () => {}
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  await page.route('**/api/planning/update-feed/digest', async (route) => {
    if (state.digestRequests > 0) { waiting = true; await blocked; await route.fulfill({ json: state.digest }).catch(() => undefined) }
    else await route.fallback()
  })
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.click()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect.poll(() => waiting).toBe(true)
  if (interruption === 'deadline') await page.clock.fastForward(15_001)
  else if (interruption === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  else if (interruption === 'scope') await page.evaluate(() => { history.pushState(null, '', '/updates?view=recent'); dispatchEvent(new PopStateEvent('popstate')) })
  else await summary.click()
  release()
  if (interruption === 'close') await summary.click()
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  await expect(page.getByLabel('Current preview', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Digest preview', exact: true }).getByRole('alert')).toHaveCount(0)
  expect(state.digestRequests).toBe(1)
})

test('delayed source metadata preserves the open disclosure, dirty draft and owned focus', async ({ page }) => {
  await mockFeed(page)
  let releaseFeed = () => {}
  let releaseSaved = () => {}
  const feedWait = new Promise<void>((resolve) => { releaseFeed = resolve })
  const savedWait = new Promise<void>((resolve) => { releaseSaved = resolve })
  await page.route('**/api/planning/update-feed?*', async (route) => { await feedWait; await route.fallback() })
  await page.route('**/api/planning/update-feed/saved', async (route) => { await savedWait; await route.fallback() })
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await expect(panel).toBeVisible()
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByLabel('Interval', { exact: true }).focus()
  releaseFeed()
  await expect(page.getByRole('link', { name: 'Customer onboarding', exact: true })).toBeVisible()
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Interval', { exact: true })).toBeFocused()
  releaseSaved()
  await expect(page.getByRole('button', { name: 'New feed', exact: true })).toBeEnabled()
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
  await expect(panel.getByLabel('Interval', { exact: true })).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Save preview settings' })).toBeEnabled()
})

for (const frequency of ['daily', 'weekly'] as const) for (const deviceTime of ['2026-10-04T12:00:00Z', '2026-10-20T12:00:00Z']) test(`${frequency} exhaustion recovers after server rollover despite device time ${deviceTime}`, async ({ page }) => {
  const state = await mockFeed(page, false, Date.parse('2100-01-01T00:00:00Z'))
  await page.clock.install({ time: new Date(deviceTime) })
  state.digest.preferences.enabled = true
  state.digest.preferences.frequency = frequency
  state.digest.history = [{ id: `${frequency}:${frequency === 'daily' ? '2026-10-04' : '2026-09-28'}`, status: 'failed', attempts: 3, token: 'last', leaseUntil: 0, count: 0 }]
  let rolledOver = false
  await page.route('**/api/planning/update-feed/digest/preview?*', async (route) => {
    state.digestRequests++
    if (!rolledOver) return route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestAttemptsExhausted' } })
    const id = `${frequency}:2026-10-05`
    state.digest = { ...state.digest, revision: state.digest.revision + 1, history: [...state.digest.history, { id, status: 'completed', attempts: 1, token: 'new', leaseUntil: 0, count: 0 }] }
    await route.fulfill({ json: { id, replay: false, entries: [], transport: 'preview', truncated: false } })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  await expect(panel.getByRole('alert')).toContainText('attempt limit')
  rolledOver = true
  await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  expect(state.digestRequests).toBe(1)
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByLabel('Current preview', { exact: true })).toBeVisible()
  expect(state.digestRequests).toBe(2)
})

test('Planning refresh and view navigation preserve dirty settings and focus without retaining preview content', async ({ page }) => {
  const state = await mockFeed(page)
  await page.clock.install()
  let reads = 0
  await page.route('**/api/planning/update-feed?*', async (route) => { reads++; await route.fallback() })
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await expect(summary.getByText('Preview only · No notifications are sent')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Digest preview', exact: true })).toHaveCount(0)
  await summary.click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  const interval = panel.getByLabel('Interval', { exact: true })
  await interval.selectOption('weekly')
  await interval.focus()
  state.feed.revision++
  state.feed.entries[0]!.title = 'Refreshed planning target'
  const before = reads
  await page.clock.fastForward(6_001)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(page.getByRole('link', { name: 'Refreshed planning target', exact: true })).toBeVisible()
  await expect(interval).toHaveValue('weekly')
  await expect(interval).toBeFocused()
  await page.evaluate(() => { history.pushState(null, '', '/updates?view=recent'); dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page).toHaveURL(/view=recent/)
  await expect(page.getByLabel('Feed', { exact: true })).toHaveValue('recent')
  await expect(interval).toHaveValue('weekly')
  await expect(interval).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Save preview settings' })).toBeEnabled()
})

test('Feed scope invalidation does not swallow a concurrent settings save conflict', async ({ page }) => {
  const state = await mockFeed(page)
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  await page.route('**/api/planning/update-feed/digest', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    waiting = true; await gate; await route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestConflict' } })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByRole('button', { name: 'Save preview settings' }).click()
  await expect.poll(() => waiting).toBe(true)
  state.feed.revision++
  await page.evaluate(() => { history.pushState(null, '', '/updates?view=recent'); dispatchEvent(new PopStateEvent('popstate')) })
  release()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
})

test('save conflict and focus refresh preserve unsaved cadence until explicit reload', async ({ page }) => {
  const state = await mockFeed(page)
  await page.clock.install()
  let reads = 0
  await page.route('**/api/planning/update-feed/digest', async (route) => { if (route.request().method() === 'GET') reads++; await route.fallback() })
  state.digest.preferences.enabled = true
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByLabel('Recent', { exact: true }).check()
  state.digest.revision += 1
  await panel.getByRole('button', { name: 'Save preview settings' }).click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  const previousReads = reads
  await page.clock.fastForward(6_001)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('weekly')
  await expect(panel.getByLabel('Recent', { exact: true })).toBeChecked()
  await panel.getByRole('button', { name: 'Reload', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByLabel('Interval', { exact: true })).toHaveValue('daily')
  await expect(summary).toBeFocused()
})

test('preview expiry restores only focus inside disappearing content', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.clock.install()
  await page.goto('/updates')
  const summary = page.locator('summary', { hasText: 'Digest preview' })
  await summary.click()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await page.getByLabel('Current preview', { exact: true }).getByRole('link').focus()
  await page.clock.fastForward(15_001)
  await expect(summary).toBeFocused()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect(page.getByLabel('Current preview', { exact: true })).toBeVisible()
  await page.getByLabel('Interval', { exact: true }).focus()
  await page.clock.fastForward(15_001)
  await expect(page.getByLabel('Interval', { exact: true })).toBeFocused()
})

for (const failure of ['network', 'forbidden']) test(`completed preview followed by ${failure} metadata failure hides content until fresh recovery`, async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  let failRefresh = true
  await page.route('**/api/planning/update-feed/digest', async (route) => {
    if (route.request().method() === 'GET' && state.digestRequests > 0 && failRefresh) {
      if (failure === 'network') return route.abort('failed')
      return route.fulfill({ status: 403, json: { code: 'WorkspacePermissionDenied' } })
    }
    return route.fallback()
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByText(failure === 'network' ? 'Preview generated, but current settings could not be verified. Reload before generating a fresh preview.' : 'You no longer have access to digest previews.')).toBeVisible()
  await expect(panel.getByLabel('Current preview', { exact: true })).toHaveCount(0)
  expect(state.digestRequests).toBe(1)
  expect(state.digest.history[0]?.status).toBe('completed')
  failRefresh = false
  if (failure === 'network') await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  else {
    await page.reload()
    await page.locator('summary', { hasText: 'Digest preview' }).click()
  }
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  await expect(panel.getByLabel('Current preview', { exact: true })).toHaveCount(0)
  expect(state.digestRequests).toBe(1)
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByLabel('Current preview', { exact: true }).getByRole('link', { name: 'Customer onboarding' })).toBeVisible()
  expect(state.digestRequests).toBe(2)
  expect(state.digest.history[0]?.attempts).toBe(1)
})

test('manual digest settings, preview and bodyless history work at desktop and phone widths', async ({ page }, testInfo) => {
  const state = await mockFeed(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/updates')
  const disclosure = page.locator('summary', { hasText: 'Digest preview' })
  await disclosure.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  await expect(panel.getByText('Preview only · No notifications are sent')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  await panel.getByLabel('Enable manual previews').check()
  await panel.getByLabel('Interval', { exact: true }).selectOption('weekly')
  await panel.getByLabel('Recent', { exact: true }).check()
  await panel.getByRole('button', { name: 'Save preview settings' }).click()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  expect(state.digest.preferences.frequency).toBe('weekly')
  expect(state.digestRequests).toBe(0)
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  const preview = panel.getByLabel('Current preview', { exact: true })
  await expect(preview.getByRole('link', { name: 'Customer onboarding' })).toBeVisible()
  await expect(panel.getByText(/Preview generated/)).toBeVisible()
  await expect(preview.getByRole('link')).toHaveAttribute('href', /targetType=project/)
  await page.screenshot({ path: testInfo.outputPath('digest-ui-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('digest-ui-mobile.png'), fullPage: true })
  await preview.getByRole('link').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('digest-ui-mobile-result.png'), fullPage: true })
  await panel.getByRole('button', { name: 'Generate preview' }).focus()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(preview.getByText(/Refreshed for current access/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeFocused()
  expect(state.digest.history).toHaveLength(1)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(preview).toHaveCount(0)
})

test('digest conflicts require reload and permission loss removes preview content', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  const panel = page.getByRole('region', { name: 'Digest preview', exact: true })
  state.digestConflict = true
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  await expect(panel.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
  expect(state.digestRequests).toBe(1)
  state.digestConflict = false
  await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByLabel('Current preview')).toBeVisible()
  state.forbidden = true
  await panel.getByRole('button', { name: 'Generate preview' }).click()
  await expect(panel.getByText('You no longer have access to digest previews.')).toBeVisible()
  await expect(panel.getByLabel('Current preview')).toHaveCount(0)
  await expect(panel.locator('form')).toHaveCount(0)
})

test('changing saved feeds discards the preview and does not alter digest settings', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  state.saved.feeds.push({ id: 'risk', name: 'My risks', view: 'at-risk', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: ['at-risk'], updateStates: [] } })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect(page.getByLabel('Current preview')).toBeVisible()
  await page.getByRole('combobox', { name: 'Saved feeds', exact: true }).selectOption('risk')
  await expect(page.getByLabel('Current preview')).toHaveCount(0)
  expect(state.digest.preferences.views).toEqual(['for-me'])
  expect(state.digestRequests).toBe(1)
})

test('a late preview response cannot restore content after browser focus changes', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/planning/update-feed/digest/preview*', async (route) => {
    started?.()
    await gate
    return route.fulfill({ json: { id: 'daily:2026-10-03', replay: false, entries: state.feed.entries.slice(0, 1), truncated: false, transport: 'preview' } })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await waiting
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  release?.()
  await expect(page.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
  await expect(page.getByLabel('Current preview')).toHaveCount(0)
})

test('permission denial on conflict refresh takes precedence over the earlier conflict', async ({ page }) => {
  const state = await mockFeed(page)
  state.digest.preferences.enabled = true
  await page.route('**/api/planning/update-feed/digest/preview*', async (route) => {
    state.forbidden = true
    return route.fulfill({ status: 409, json: { code: 'UpdateFeedDigestConflict' } })
  })
  await page.goto('/updates')
  await page.locator('summary', { hasText: 'Digest preview' }).click()
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect(page.getByText('You no longer have access to digest previews.')).toBeVisible()
  await expect(page.getByText(/Settings changed or a preview is running/)).toHaveCount(0)
})

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
