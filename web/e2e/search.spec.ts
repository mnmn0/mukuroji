import { expect, test, type Page } from '@playwright/test'
import {
  SAVED_VIEW_SCHEMA_VERSION,
  SEARCH_SCHEMA_VERSION,
  type CreateSavedWorkspaceViewInput,
  type SavedWorkspaceView,
  type UpdateSavedWorkspaceViewInput,
  type WorkspaceSearchFilters,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const authSession = {
  accessToken: 'test-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
}

const firstSearchResult = {
  assigneeUserId: 'demo@example.com',
  dueDate: '2026-07-20',
  entityType: 'work-item',
  highlights: [{
    field: 'title',
    fragments: [
      { matched: false, text: 'Workspace ' },
      { matched: true, text: 'launch' },
      { matched: false, text: ' review' },
    ],
  }],
  id: 'launch-review',
  projectId: 'refero',
  status: 'review',
  subtitle: 'Refero · Demo User',
  teamId: 'core-team',
  title: 'Workspace launch review',
  updatedAt: '2026-07-12T08:00:00.000Z',
  url: '/projects/refero/issues?teamId=core-team&issueId=launch-review',
} satisfies WorkspaceSearchResult

const secondSearchResult = {
  creatorUserId: 'sato@example.com',
  entityType: 'comment',
  highlights: [{
    field: 'body',
    fragments: [
      { matched: false, text: 'Ready for ' },
      { matched: true, text: 'launch' },
    ],
  }],
  id: 'comment-2',
  parentId: 'team/core-team/issue/launch-review',
  projectId: 'refero',
  teamId: 'core-team',
  title: 'Launch approval comment',
  body: 'Ready for launch',
  updatedAt: '2026-07-12T09:00:00.000Z',
  url: '/projects/refero/issues?teamId=core-team&issueId=launch-review#comment-comment-2',
} satisfies WorkspaceSearchResult

/**
 * SearchPage が使う認証・directory・search・saved view API を差し替えます。
 */
async function mockAuthenticatedSearchPage(page: Page) {
  const searchRequests: WorkspaceSearchFilters[] = []
  const savedViewMutations: Array<CreateSavedWorkspaceViewInput | UpdateSavedWorkspaceViewInput> = []
  const savedViews: SavedWorkspaceView[] = []

  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
  }, authSession)

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        attributes: { email: 'demo@example.com', name: 'Demo User' },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        username: 'demo@example.com',
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })

  await page.route('**/api/teams/projects**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')
    await route.fulfill({ json: { teams: projectDirectoryFixtures } })
  })

  await page.route(/.*\/api\/search(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url())
    const encodedFilters = url.searchParams.get('filters')
    const filters = encodedFilters ? JSON.parse(encodedFilters) as WorkspaceSearchFilters : {}
    searchRequests.push(filters)
    const cursor = url.searchParams.get('cursor')

    await route.fulfill({
      json: {
        schemaVersion: SEARCH_SCHEMA_VERSION,
        results: cursor ? [secondSearchResult] : [firstSearchResult],
        ...(cursor ? {} : { nextCursor: 'search/page-2' }),
      },
    })
  })

  await page.route(/.*\/api\/saved-views(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const viewId = url.pathname.split('/').at(-1)

    if (request.method() === 'GET') {
      await route.fulfill({ json: { views: savedViews } })
      return
    }

    if (request.method() === 'POST') {
      const input = request.postDataJSON() as CreateSavedWorkspaceViewInput
      savedViewMutations.push(input)
      const view = createSavedView('saved-launch-view', input)
      savedViews.push(view)
      await route.fulfill({ status: 201, json: { view } })
      return
    }

    if (request.method() === 'PATCH') {
      const input = request.postDataJSON() as UpdateSavedWorkspaceViewInput
      savedViewMutations.push(input)
      const view = savedViews.find((candidate) => candidate.id === viewId)
      if (!view) {
        await route.fulfill({ status: 404, json: { message: 'missing' } })
        return
      }
      Object.assign(view, {
        favorite: input.favorite ?? view.favorite,
        isDefault: input.isDefault ?? view.isDefault,
        pinned: input.pinned ?? view.pinned,
        updatedAt: '2026-07-12T10:00:00.000Z',
      })
      await route.fulfill({ json: { view } })
      return
    }

    await route.fulfill({ status: 204 })
  })

  return { savedViewMutations, searchRequests }
}

test('Workspace searchはURL state、highlight、cursor pageを復元する', async ({ page }) => {
  const state = await mockAuthenticatedSearchPage(page)
  await page.goto('/search?v=1&q=launch&type=work-item&status=review&layout=board&group=status&columns=title,status')

  await expect(page.getByRole('heading', { name: 'Workspace を横断検索' })).toBeVisible()
  await expect(page.getByTestId('workspace-search-input')).toHaveValue('launch')
  await expect(page.getByRole('button', { name: 'ボード', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('search-results-board')).toContainText('Workspace launch review')
  await expect(page.getByTestId('search-results-board').locator('mark')).toHaveText('launch')
  await expect.poll(() => state.searchRequests.some((filters) =>
    filters.keyword === 'launch' && filters.entityTypes?.includes('work-item') && filters.statuses?.includes('review'),
  )).toBe(true)

  await page.getByRole('button', { name: '続きを読み込む' }).click()
  await expect(page.getByTestId('search-results-board')).toContainText('Launch approval comment')
  await expect.poll(() => state.searchRequests.length).toBeGreaterThanOrEqual(2)
})

test('Saved viewを作成しfavorite preferenceを更新できる', async ({ page }) => {
  const state = await mockAuthenticatedSearchPage(page)
  await page.goto('/search?v=1&q=launch')

  await page.getByRole('button', { name: '現在の表示を保存' }).click()
  const form = page.getByTestId('saved-view-form')
  await form.getByLabel('View 名').fill('Launch review')
  await form.getByLabel('説明').fill('ローンチ確認用')
  await form.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByTestId('saved-view-list')).toContainText('Launch review')
  await expect(page).toHaveURL(/view=saved-launch-view/)
  await page.getByRole('button', { name: 'お気に入り', exact: true }).click()
  await expect.poll(() => state.savedViewMutations.some((input) => 'favorite' in input && input.favorite === true)).toBe(true)
  expect(state.savedViewMutations[0]).toEqual(expect.objectContaining({
    name: 'Launch review',
    visibility: 'personal',
  }))
})

function createSavedView(
  id: string,
  input: CreateSavedWorkspaceViewInput,
): SavedWorkspaceView {
  return {
    canEdit: true,
    createdAt: '2026-07-12T09:00:00.000Z',
    favorite: input.favorite ?? false,
    filters: input.filters,
    id,
    isDefault: input.isDefault ?? false,
    layout: input.layout,
    name: input.name,
    ownerUserId: 'demo@example.com',
    pinned: input.pinned ?? false,
    revision: 1,
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    updatedAt: '2026-07-12T09:00:00.000Z',
    visibility: input.visibility,
  }
}
