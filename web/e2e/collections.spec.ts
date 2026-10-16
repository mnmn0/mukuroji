import { expect, test, type Page } from '@playwright/test'
import type { WorkItemCollection, WorkItemCollectionEntry } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/** Canonical Work Items the member can read. */
const workItems = [
  { id: 'onboarding', teamId: 'core-team', title: 'Reduce onboarding friction', statusCategory: 'started', assignedProjectId: 'refero' },
  { id: 'pricing', teamId: 'core-team', title: 'Update the pricing page', statusCategory: 'unstarted' },
]

/**
 * Installs the session and an in-memory Collection API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @param canWrite - Whether the server reports that the member may change Collections.
 * @returns Mutable mock server state.
 */
async function mockCollections(page: Page, canWrite = true) {
  const state = {
    collections: [] as (WorkItemCollection & { items: WorkItemCollectionEntry[] })[],
    createKeys: [] as string[],
  }
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'collections-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/work-items', (route) => route.fulfill({ json: { workItems } }))
  await page.route((url) => url.pathname === '/api/collections' || url.pathname.startsWith('/api/collections/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const segments = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)
    const [collectionId, itemsSegment, teamId, issueId] = segments
    if (!collectionId) {
      if (request.method() === 'POST') {
        state.createKeys.push(request.headers()['idempotency-key'] ?? '')
        const input = request.postDataJSON()
        const created = { collectionId: `c${state.collections.length + 1}`, name: input.name, ...(input.description ? { description: input.description } : {}), createdBy: 'demo@example.com', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', revision: 1, items: [] }
        state.collections.push(created)
        return route.fulfill({ status: 201, json: toPublicCollection(created) })
      }
      return route.fulfill({ json: { collections: state.collections.map(toPublicCollection), canWrite } })
    }
    const collection = state.collections.find((candidate) => candidate.collectionId === collectionId)
    if (!collection) return route.fulfill({ status: 404, json: { code: 'CollectionNotFound' } })
    if (itemsSegment === 'items' && teamId && issueId) {
      if (request.method() === 'PUT') {
        const workItem = workItems.find((candidate) => candidate.teamId === teamId && candidate.id === issueId)
        if (!workItem) return route.fulfill({ status: 404, json: { code: 'CollectionWorkItemNotFound' } })
        collection.items.unshift({ teamId, issueId, title: workItem.title, statusCategory: workItem.statusCategory === 'started' ? 'started' : 'unstarted', ...(workItem.assignedProjectId ? { assignedProjectId: workItem.assignedProjectId } : {}), addedAt: '2026-10-16T00:00:00.000Z' })
      } else {
        collection.items = collection.items.filter((item) => item.teamId !== teamId || item.issueId !== issueId)
      }
      collection.revision += 1
      return route.fulfill({ json: toPublicCollection(collection) })
    }
    if (itemsSegment === 'items') {
      return route.fulfill({ json: { collection: toPublicCollection(collection), items: collection.items } })
    }
    if (request.method() === 'DELETE') {
      if (url.searchParams.get('expectedRevision') !== String(collection.revision)) return route.fulfill({ status: 409, json: { code: 'CollectionConflict' } })
      state.collections = state.collections.filter((candidate) => candidate !== collection)
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ status: 405, json: {} })
  })
  return state
}

/**
 * Strips mock-only item state from a Collection.
 *
 * @param collection - Mock Collection with its items.
 * @returns The Collection as the API returns it.
 */
function toPublicCollection(collection: WorkItemCollection): WorkItemCollection {
  return {
    collectionId: collection.collectionId,
    name: collection.name,
    ...(collection.description ? { description: collection.description } : {}),
    createdBy: collection.createdBy,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    revision: collection.revision,
  }
}

test('Issue #238: places a Work Item in a Collection without copying it', async ({ page }) => {
  const state = await mockCollections(page)
  await page.goto('/collections')
  await expect(page.getByRole('heading', { name: 'Collections', level: 2 })).toBeVisible()
  await expect(page.getByText('There are no Collections yet.')).toBeVisible()

  await page.getByLabel('Name').fill('Q4 launch')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/collectionId=c1/u)
  expect(state.createKeys).toHaveLength(1)
  expect(state.createKeys[0]).not.toBe('')

  await page.getByLabel('Add a Work Item').selectOption({ label: 'Reduce onboarding friction (core-team / onboarding)' })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const items = page.getByTestId('collection-items')
  await expect(items.getByRole('link', { name: 'Reduce onboarding friction' })).toHaveAttribute('href', '/teams/core-team/issues?issueId=onboarding')
  await expect(page.getByLabel('Add a Work Item').locator('option', { hasText: 'Reduce onboarding friction' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Remove from Collection: Reduce onboarding friction' }).click()
  await expect(page.getByText('This Collection has no Work Items yet.')).toBeVisible()

  page.once('dialog', (dialog) => { void dialog.accept() })
  await page.getByRole('button', { name: 'Delete Collection' }).click()
  await expect(page.getByText('There are no Collections yet.')).toBeVisible()
  expect(state.collections).toEqual([])
})

test('Issue #238: members without Work Item write permission see Collections read-only', async ({ page }) => {
  const state = await mockCollections(page, false)
  state.collections.push({ collectionId: 'c1', name: 'Q4 launch', createdBy: 'demo@example.com', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', revision: 1, items: [] })
  await page.goto('/collections')
  await expect(page.getByText('You have view-only access, so Collections cannot be changed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete Collection' })).toHaveCount(0)
})
