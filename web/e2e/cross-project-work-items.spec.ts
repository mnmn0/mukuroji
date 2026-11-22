import { expect, test, type Page } from '@playwright/test'
import type { CanonicalWorkItem, CreateSavedTaskViewInput, SavedTaskView } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { taskViewStorySelectedTask } from '../src/tasks/ui/TaskView.stories.fixtures'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

/**
 * Creates a readable Work Item from the shared fixture.
 *
 * @param overrides - Fields that differ from the fixture.
 * @returns A canonical Work Item returned by the mocked list API.
 */
function createWorkItem(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return { ...taskViewStorySelectedTask, ...overrides }
}

/** Work Items the server returns; it already left out Work Items the member cannot read. */
const workItems: CanonicalWorkItem[] = [
  createWorkItem({ id: 'refero-1', key: 'CORE-1', teamId: 'core-team', assignedProjectId: 'refero', title: 'Refero owned by me', assigneeUserId: 'demo@example.com', assigneeName: 'Demo' }),
  createWorkItem({
    id: 'roadmap-1',
    key: 'CORE-2',
    teamId: 'core-team',
    assignedProjectId: 'product-roadmap',
    title: 'Roadmap with my contribution',
    assigneeUserId: 'sato@example.com',
    assigneeName: 'Sato',
    contributorAssignments: [
      { assignmentId: 'c-1', memberUserId: 'demo@example.com', jobRoleId: 'designer', status: 'planned' },
    ],
  }),
  createWorkItem({ id: 'brand-1', key: 'DES-1', teamId: 'design-team', assignedProjectId: 'brand-refresh', title: 'Brand refresh task', assigneeUserId: 'suzuki@example.com', assigneeName: 'Suzuki' }),
]

/**
 * Installs the session and the permission-filtered Workspace Work Item list API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @param savedViews - Saved task views the server returns; a created view is appended.
 * @returns Query strings of every `GET /api/work-items` request and every created view input.
 */
async function mockWorkspace(page: Page, savedViews: SavedTaskView[] = []) {
  const listQueries: URLSearchParams[] = []
  const createdViews: CreateSavedTaskViewInput[] = []
  await page.route((url) => url.pathname === '/api/task-views', async (route) => {
    if (route.request().method() === 'POST') {
      const input: CreateSavedTaskViewInput = route.request().postDataJSON()
      createdViews.push(input)
      const view: SavedTaskView = {
        schemaVersion: 1,
        id: `view-${createdViews.length}`,
        name: input.name,
        visibility: input.visibility,
        ownerUserId: 'demo@example.com',
        ...(input.teamId ? { teamId: input.teamId } : {}),
        definition: input.definition,
        revision: 1,
        canEdit: true,
        preference: {
          favorite: false,
          pinned: false,
          isDefault: false,
          isPersonalDefault: false,
          isTeamDefault: false,
          isProjectDefault: false,
        },
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      }
      savedViews.push(view)
      return route.fulfill({ status: 201, json: view })
    }
    return route.fulfill({ json: {
      views: savedViews,
      capabilities: {
        canWrite: true,
        canManageSharedViews: false,
        canSetTeamDefault: false,
        canSetProjectDefault: false,
        writableTeamIds: ['core-team'],
        writableProjectScopes: [],
      },
    } })
  })
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'cross-project-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/workspace/access', (route) => route.fulfill({ status: 403, json: { message: 'Forbidden' } }))
  await page.route('**/api/teams/*/work-item-configuration', (route) => {
    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    return route.fulfill({
      json: {
        configuration: {
          ...structuredClone(teamWorkItemConfigurationFixture),
          scopeId: teamId,
          jobRoles: [{ id: 'designer', name: 'Designer' }],
        },
      },
    })
  })
  await page.route((url) => url.pathname === '/api/work-items', (route) => {
    const params = new URL(route.request().url()).searchParams
    listQueries.push(params)
    const teamId = params.get('teamId')
    const projectId = params.get('projectId')
    return route.fulfill({
      json: {
        workItems: workItems.filter((workItem) =>
          (!teamId || workItem.teamId === teamId) &&
          (!projectId || workItem.assignedProjectId === projectId),
        ),
      },
    })
  })
  return Object.assign(listQueries, { createdViews })
}

test('Issue #381: lists Work Items across Projects, filters by contributor, and keeps the view in the URL', async ({ page }) => {
  const listQueries = await mockWorkspace(page)

  await page.goto('/home')
  await page.getByRole('navigation', { name: 'Global navigation' }).getByRole('button', { name: 'Work items', exact: true }).click()
  await expect(page).toHaveURL(/\/work-items$/)

  const list = page.getByTestId('cross-project-work-items')
  const groups = page.getByTestId('cross-project-work-item-group')
  await expect(groups).toHaveCount(3)
  await expect(groups.nth(0)).toHaveAccessibleName('Refero')
  await expect(page.getByTestId('cross-project-work-items-count')).toHaveText('3 Work Items')
  expect(listQueries.at(-1)?.get('open')).toBe('true')

  // Pick two Projects of the same Team: the read narrows to that Team.
  await list.getByText('Projects: All').click()
  // The checkboxes follow the URL, which the router updates after the click.
  await list.getByRole('checkbox', { name: /^Refero/ }).click()
  await expect(list.getByRole('checkbox', { name: /^Refero/ })).toBeChecked()
  await list.getByRole('checkbox', { name: /^プロダクトロードマップ/ }).click()
  await expect(list.getByRole('checkbox', { name: /^プロダクトロードマップ/ })).toBeChecked()
  await expect(groups).toHaveCount(2)
  // The change is a temporary change of the built-in view, kept in the URL.
  await expect(page).toHaveURL(/view\.override=/)
  await expect(page.getByTestId('task-view-dirty-state')).toHaveText('Temporary changes')
  expect(listQueries.at(-1)?.get('teamId')).toBe('core-team')

  await list.getByLabel('Job role').selectOption({ label: 'Designer (コアチーム)' })
  await expect(groups).toHaveCount(1)
  await expect(groups.first().getByRole('button', { name: /Roadmap with my contribution/ })).toBeVisible()
  await expect(groups.first()).toContainText('demo@example.com (Designer)')

  // Reloading the URL restores the same view.
  await page.reload()
  await expect(page.getByTestId('cross-project-work-item-group')).toHaveCount(1)
  await expect(page.getByLabel('Job role')).toHaveValue('core-team:designer')

  await page.getByLabel('Job role').selectOption('')
  await page.getByLabel('I own or contribute').click()
  await expect(page.getByLabel('I own or contribute')).toBeChecked()
  await page.getByLabel('Group by').selectOption('assignee')
  await expect(groups).toHaveCount(2)
  expect(listQueries.at(-1)?.get('involvement')).toBe('mine')
  await page.reload()
  await expect(page.getByLabel('Group by')).toHaveValue('assignee')
})

test('Issue #381: saves the cross-Project view on the server and shares it with a Team', async ({ page }) => {
  const listQueries = await mockWorkspace(page)

  await page.goto('/work-items')
  const list = page.getByTestId('cross-project-work-items')
  const groups = page.getByTestId('cross-project-work-item-group')
  await expect(groups).toHaveCount(3)
  await list.getByText('Projects: All').click()
  await list.getByRole('checkbox', { name: /^Refero/ }).click()
  await expect(list.getByRole('checkbox', { name: /^Refero/ })).toBeChecked()
  await page.getByLabel('I own or contribute').click()
  await expect(page.getByLabel('I own or contribute')).toBeChecked()

  await page.getByRole('button', { name: 'Save as new view' }).click()
  await page.getByLabel('View name').fill('My Refero work')
  await page.getByLabel('Visibility').selectOption('team')
  await page.getByLabel('Team ID').selectOption('core-team')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect.poll(() => listQueries.createdViews.length).toBe(1)
  expect(listQueries.createdViews[0]).toMatchObject({
    name: 'My Refero work',
    visibility: 'team',
    teamId: 'core-team',
    definition: {
      surface: 'work-items',
      scope: { kind: 'workspace' },
      filters: {
        projectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
        involvement: 'mine',
      },
      layout: { mode: 'table', group: { field: 'project', direction: 'asc' } },
    },
  })
  const toolbar = page.getByTestId('task-view-toolbar')
  await expect(toolbar.getByRole('button', { name: 'My Refero work' })).toBeVisible()
  await expect(page.getByTestId('task-view-dirty-state')).not.toHaveText('Temporary changes')
  await expect(groups).toHaveCount(1)
})

test('Issue #381: opens a shared view with only the Projects the viewer can read', async ({ page }) => {
  // The server already removed the Project the viewer cannot read from the shared definition.
  await mockWorkspace(page, [{
    schemaVersion: 1,
    id: 'shared-view',
    name: 'PM portfolio',
    visibility: 'shared',
    ownerUserId: 'pm@example.com',
    definition: {
      surface: 'work-items',
      scope: { kind: 'workspace' },
      filters: { projectScopes: [{ teamId: 'design-team', projectId: 'brand-refresh' }] },
      layout: {
        mode: 'board',
        group: { field: 'project', direction: 'asc' },
        sort: [],
        columns: [{ field: 'title' }],
        density: 'comfortable',
        displayOptions: { showCompleted: false },
      },
    },
    revision: 1,
    canEdit: false,
    preference: {
      favorite: false,
      pinned: false,
      isDefault: true,
      isPersonalDefault: true,
      isTeamDefault: false,
      isProjectDefault: false,
      defaultSource: 'personal',
    },
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    migrationWarnings: [{ code: 'permission-redacted', section: 'filter', fallback: 'removed' }],
  }])

  await page.goto('/work-items')
  await expect(page.getByTestId('task-view-toolbar').getByRole('button', { name: 'PM portfolio' })).toBeVisible()
  await expect(page.getByTestId('cross-project-work-items-layout-board')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('cross-project-work-item-lane')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Brand refresh task' })).toBeVisible()
})

test('Issue #381: an older link with list parameters opens as a temporary change', async ({ page }) => {
  await mockWorkspace(page)

  await page.goto('/work-items?layout=board&group=assignee')
  await expect(page.getByTestId('cross-project-work-items-layout-board')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Group by')).toHaveValue('assignee')
  await expect(page).toHaveURL(/view\.override=/)
  await expect(page).not.toHaveURL(/layout=board/)
})

test('Issue #381: a failed Work Item read shows the load notice instead of an empty list', async ({ page }) => {
  await mockWorkspace(page)
  let failRead = true
  await page.route((url) => url.pathname === '/api/work-items', (route) =>
    failRead ? route.fulfill({ status: 500, json: { message: 'Unavailable' } }) : route.fallback())

  await page.goto('/work-items')

  await expect(page.getByTestId('cross-project-work-items')).toBeVisible()
  await expect(page.getByTestId('workspace-task-partial-error')).toBeVisible()
  await expect(page.getByTestId('cross-project-work-items-count')).toHaveCount(0)
  await expect(page.getByText('No Work Items match these filters.')).toHaveCount(0)

  failRead = false
  await page.getByTestId('cross-project-work-items-retry').click()
  await expect(page.getByTestId('cross-project-work-item-group')).toHaveCount(3)
  await expect(page.getByTestId('workspace-task-partial-error')).toHaveCount(0)
})

test('Issue #381: a failed Team configuration read shows the configuration notice with retry', async ({ page }) => {
  await mockWorkspace(page)
  await page.route('**/api/teams/design-team/work-item-configuration', (route) =>
    route.fulfill({ status: 500, json: { message: 'Unavailable' } }))

  await page.goto('/work-items')

  await expect(page.getByTestId('cross-project-work-item-group')).toHaveCount(3)
  const notice = page.getByTestId('work-items-configuration-error')
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('button')).toBeVisible()
})

test('Issue #381: shows the same Work Items on a read-only board and Gantt chart', async ({ page }) => {
  await mockWorkspace(page)

  await page.goto('/work-items')
  await expect(page.getByTestId('cross-project-work-item-group')).toHaveCount(3)

  await page.getByTestId('cross-project-work-items-layout-board').click()
  await expect(page.getByTestId('cross-project-work-items-layout-board')).toHaveAttribute('aria-pressed', 'true')
  const lanes = page.getByTestId('cross-project-work-item-lane')
  await expect(lanes).toHaveCount(3)
  const referoLane = lanes.filter({ has: page.getByRole('heading', { name: /^Refero/ }) })
  await expect(referoLane.getByRole('region', { name: /In progress$/ })
    .getByRole('button', { name: 'Refero owned by me' })).toBeVisible()
  // The board only opens Work Items; it has no status selector or drag handle.
  await expect(page.getByTestId('cross-project-work-item-card-status-select')).toHaveCount(0)
  await expect(page.locator('[data-testid="cross-project-work-item-card"][draggable="true"]')).toHaveCount(0)

  await page.getByTestId('cross-project-work-items-layout-gantt').click()
  await expect(page.getByTestId('cross-project-work-items-layout-gantt')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('task-gantt-group-project:core-team:refero')).toBeVisible()
  await expect(page.getByTestId('task-gantt-group-project:design-team:brand-refresh')).toBeVisible()
  await expect(page.getByTestId('task-gantt-bar-refero-1')).not.toHaveAttribute('draggable', 'true')

  // Reloading the URL restores the layout.
  await page.reload()
  await expect(page.getByTestId('cross-project-work-items-layout-gantt')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('task-gantt-bar-refero-1').click()
  await expect(page).toHaveURL(/refero-1/)
})

test('Issue #381: a failed Workspace calendar read in the Gantt chart shows a notice with retry', async ({ page }) => {
  await mockWorkspace(page)
  let calendarReads = 0
  await page.route('**/api/workspace/calendar-settings', (route) => {
    calendarReads += 1
    return route.fulfill({ status: 500, json: { message: 'Unavailable' } })
  })

  await page.goto('/work-items')
  await expect(page.getByTestId('cross-project-work-item-group')).toHaveCount(3)
  expect(calendarReads).toBe(0)

  await page.getByTestId('cross-project-work-items-layout-gantt').click()
  const notice = page.getByTestId('work-items-workspace-calendar-error')
  await expect(notice).toBeVisible()
  // The chart still shows, shading the default calendar.
  await expect(page.getByTestId('task-gantt-bar-refero-1')).toBeVisible()
  const readsBeforeRetry = calendarReads
  await notice.getByRole('button').click()
  await expect.poll(() => calendarReads).toBeGreaterThan(readsBeforeRetry)
})
