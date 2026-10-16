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
    deleteNextCreate: false,
    renameBeforeNextPatch: undefined as string | undefined,
    denyItems: false,
    patches: [] as unknown[],
    searches: [] as unknown[],
  }
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'collections-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route((url) => url.pathname === '/api/collections/candidates', (route) => {
    const params = new URL(route.request().url()).searchParams
    state.searches.push({ keyword: params.get('keyword') })
    const keyword = String(params.get('keyword') ?? '').toLowerCase()
    const results = workItems
      .filter((workItem) => workItem.title.toLowerCase().includes(keyword))
      .map((workItem) => ({ id: `team/${workItem.teamId}/issue/${workItem.id}`, entityType: 'work-item', teamId: workItem.teamId, title: workItem.title, url: `/teams/${workItem.teamId}/issues?issueId=${workItem.id}`, highlights: [] }))
    return route.fulfill({ json: { schemaVersion: 1, results } })
  })
  await page.route((url) => url.pathname === '/api/collections' || url.pathname.startsWith('/api/collections/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const segments = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)
    const [collectionId, itemsSegment, teamId, issueId] = segments
    // Candidate search is served by the handler registered before this one.
    if (collectionId === 'candidates' && !itemsSegment) return route.fallback()
    if (!collectionId) {
      if (request.method() === 'POST') {
        state.createKeys.push(request.headers()['idempotency-key'] ?? '')
        if (state.deleteNextCreate) {
          state.deleteNextCreate = false
          return route.fulfill({ status: 409, json: { code: 'CollectionDeleted', message: 'Deleted.' } })
        }
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
      if (state.denyItems) return route.fulfill({ status: 403, json: { code: 'CollectionAccessDenied', message: 'Denied.' } })
      return route.fulfill({ json: { collection: toPublicCollection(collection), items: collection.items } })
    }
    if (request.method() === 'PATCH') {
      const input = request.postDataJSON()
      state.patches.push(input)
      // Simulates another editor renaming the Collection just before this save arrives.
      if (state.renameBeforeNextPatch) {
        collection.name = state.renameBeforeNextPatch
        collection.revision += 1
        state.renameBeforeNextPatch = undefined
      }
      if (input.expectedRevision !== collection.revision) return route.fulfill({ status: 409, json: { code: 'CollectionConflict' } })
      collection.name = input.name
      if (input.description) collection.description = input.description
      else delete collection.description
      collection.revision += 1
      return route.fulfill({ json: toPublicCollection(collection) })
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

  await page.getByLabel('Find Work Items to add').fill('onboarding')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect.poll(() => state.searches).toEqual([{ keyword: 'onboarding' }])
  await page.getByLabel('Add a Work Item').selectOption({ label: 'Reduce onboarding friction (core-team / onboarding)' })
  // An item change bumps the revision but must not discard an open metadata draft.
  await page.getByRole('button', { name: 'Edit name and description' }).click()
  await page.getByRole('textbox', { name: 'Name' }).last().fill('Q4 launch draft')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const items = page.getByTestId('collection-items')
  await expect(items.getByRole('link', { name: 'Reduce onboarding friction' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Name' }).last()).toHaveValue('Q4 launch draft')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(items.getByRole('link', { name: 'Reduce onboarding friction' })).toHaveAttribute('href', '/teams/core-team/issues?issueId=onboarding')
  await expect(page.getByText('No Work Items to add match this search.')).toBeVisible()

  await page.getByRole('button', { name: 'Remove from Collection: Reduce onboarding friction (core-team / onboarding)' }).click()
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
  // The implicit first selection is pinned in the URL so later list changes cannot switch it.
  await expect(page).toHaveURL(/collectionId=c1/u)
  await expect(page.getByRole('button', { name: 'Create' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete Collection' })).toHaveCount(0)
})

test('Issue #238: a create replay of a deleted Collection gets a new key on the next attempt', async ({ page }) => {
  const state = await mockCollections(page)
  state.deleteNextCreate = true
  await page.goto('/collections')
  await page.getByLabel('Name').fill('Q4 launch')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('The Collection created by that request was deleted.')).toBeVisible()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/collectionId=c1/u)
  expect(state.createKeys).toHaveLength(2)
  expect(state.createKeys[1]).not.toBe(state.createKeys[0])
})

test('Issue #238: saving again after a metadata conflict applies the draft', async ({ page }) => {
  const state = await mockCollections(page)
  state.collections.push({ collectionId: 'c1', name: 'Q4 launch', createdBy: 'demo@example.com', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', revision: 1, items: [] })
  await page.goto('/collections?collectionId=c1')
  await page.getByRole('button', { name: 'Edit name and description' }).click()
  await page.getByRole('textbox', { name: 'Name' }).last().fill('Q4 launch plan')
  state.renameBeforeNextPatch = 'Q4 launch (renamed elsewhere)'
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('The Collection changed. The latest version is loaded; try again.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Name' }).last()).toHaveValue('Q4 launch plan')

  // The draft is now based on the reloaded Collection, so the retry succeeds.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Q4 launch plan', level: 2 })).toBeVisible()
  expect(state.patches).toEqual([
    expect.objectContaining({ expectedRevision: 1, name: 'Q4 launch plan' }),
    expect.objectContaining({ expectedRevision: 2, name: 'Q4 launch plan' }),
  ])
})

test('Issue #238: a 403 on refresh hides the previously loaded Work Items', async ({ page }) => {
  const state = await mockCollections(page)
  const entry = (issueId: string, title: string): WorkItemCollectionEntry => ({ teamId: 'core-team', issueId, title, statusCategory: 'started', addedAt: '2026-10-16T00:00:00.000Z' })
  state.collections.push({
    collectionId: 'c1',
    name: 'Q4 launch',
    createdBy: 'demo@example.com',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    revision: 1,
    items: [entry('onboarding', 'Reduce onboarding friction'), entry('pricing', 'Update the pricing page')],
  })
  await page.goto('/collections?collectionId=c1')
  const items = page.getByTestId('collection-items')
  await expect(items.getByRole('link', { name: 'Update the pricing page' })).toBeVisible()

  // The caller loses read access; the refresh after this change returns 403.
  state.denyItems = true
  await page.getByRole('button', { name: 'Remove from Collection: Reduce onboarding friction (core-team / onboarding)' }).click()
  await expect(page.getByText('Work Items could not be loaded.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Update the pricing page' })).toHaveCount(0)
})
