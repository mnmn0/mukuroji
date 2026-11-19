import { expect, test, type Page } from '@playwright/test'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
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
 * @returns Query strings of every `GET /api/work-items` request.
 */
async function mockWorkspace(page: Page) {
  const listQueries: URLSearchParams[] = []
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
  return listQueries
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
  await expect(page).toHaveURL(/project=core-team%3Arefero/)
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
  await expect(page).toHaveURL(/group=assignee/)
})

test('Issue #381: a failed Work Item read shows the load notice instead of an empty list', async ({ page }) => {
  await mockWorkspace(page)
  await page.route((url) => url.pathname === '/api/work-items', (route) =>
    route.fulfill({ status: 500, json: { message: 'Unavailable' } }))

  await page.goto('/work-items')

  await expect(page.getByTestId('cross-project-work-items')).toBeVisible()
  await expect(page.getByTestId('workspace-task-partial-error')).toBeVisible()
  await expect(page.getByTestId('cross-project-work-items-count')).toHaveCount(0)
  await expect(page.getByText('No Work Items match these filters.')).toHaveCount(0)
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
