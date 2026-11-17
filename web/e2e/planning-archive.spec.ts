import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type {
  ArchivedPlanningEntitySummary,
  PlanningRestoreSummary,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import type { AuthSession } from '../src/auth/session'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const authSession = {
  accessToken: 'planning-archive-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

const fixtureGoal = planningSnapshotFixture.entities.find((entity) => entity.type === 'goal')
if (!fixtureGoal) throw new Error('Planning fixture has no Goal.')

const archivedGoal = {
  id: 'goal-archived',
  type: 'goal',
  title: '過去の目標',
  ...(fixtureGoal.parentId === undefined ? {} : { parentId: fixtureGoal.parentId }),
  ...(fixtureGoal.teamId === undefined ? {} : { teamId: fixtureGoal.teamId }),
  ...(fixtureGoal.projectId === undefined ? {} : { projectId: fixtureGoal.projectId }),
  ownerMemberKey: fixtureGoal.ownerMemberKey,
  archivedAt: '2026-08-01T00:00:00.000Z',
} satisfies ArchivedPlanningEntitySummary

const archivedCycle = {
  id: 'cycle-archived',
  type: 'cycle',
  title: '終わった Cycle',
  teamId: 'core-team',
  ownerMemberKey: fixtureGoal.ownerMemberKey,
  archivedAt: '2026-07-01T00:00:00.000Z',
} satisfies ArchivedPlanningEntitySummary

/**
 * Installs authenticated Workspace and Planning API stubs with two pages of archived plans.
 *
 * @param page - Playwright page whose same-origin API calls are intercepted.
 * @returns The restore request bodies, in order.
 */
async function mockPlanningArchivePage(page: Page) {
  let planning: PlanningSnapshot = {
    ...structuredClone(planningSnapshotFixture),
    revision: 30,
  }
  let goalArchived = true
  const restoreRequests: unknown[] = []
  const restoreSummaries: PlanningRestoreSummary[] = [
    {
      restoredLinkCount: 30,
      droppedLinkCount: 1,
      restoredDependencyCount: 2,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 5,
    },
    {
      restoredLinkCount: 5,
      droppedLinkCount: 0,
      restoredDependencyCount: 0,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 0,
    },
  ]

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
    await route.fulfill({ json: planning })
  })
  await page.route('**/api/planning/update-watch**', async (route) => {
    await route.fulfill({
      json: {
        watch: { automatic: false, explicit: false, reasons: [], subscribed: false, watcherCount: 0 },
      },
    })
  })
  await page.route('**/api/planning/updates**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/comments')) {
      await route.fulfill({ json: { comments: [] } })
      return
    }
    if (pathname.endsWith('/reactions')) {
      await route.fulfill({ json: { reactions: [] } })
      return
    }
    await route.fulfill({ json: { updates: [] } })
  })
  await page.route('**/api/planning/archived-entities**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    if (cursor === 'page-2') {
      await route.fulfill({ json: { entities: [archivedCycle] } })
      return
    }
    await route.fulfill({
      json: { entities: goalArchived ? [archivedGoal] : [], nextCursor: 'page-2' },
    })
  })
  await page.route('**/api/planning/entities/*/restore', async (route) => {
    const request = route.request()
    restoreRequests.push({
      body: request.postDataJSON(),
      pathname: new URL(request.url()).pathname,
    })
    goalArchived = false
    planning = {
      ...planning,
      revision: planning.revision + 1,
      entities: planning.entities.some((entity) => entity.id === archivedGoal.id)
        ? planning.entities
        : [...planning.entities, { ...structuredClone(fixtureGoal), id: archivedGoal.id, title: archivedGoal.title }],
    }
    const restore = restoreSummaries.shift()
    await route.fulfill({ json: { planning, restore } })
  })
  return restoreRequests
}

test('Issue #369: lists archived plans, restores one, and restores the references left behind', async ({
  page,
}) => {
  const restoreRequests = await mockPlanningArchivePage(page)
  await page.goto('/planning/roadmap', { waitUntil: 'domcontentloaded' })

  const panel = page.getByTestId('planning-archived-entities')
  await panel.getByText('アーカイブ済みの計画', { exact: true }).click()
  await expect(panel.getByTestId('planning-archived-entity-goal-archived')).toBeVisible()
  await expect(panel.getByTestId('planning-archived-entity-cycle-archived')).toHaveCount(0)

  await panel.getByRole('button', { name: 'さらに読み込む' }).click()
  await expect(panel.getByTestId('planning-archived-entity-cycle-archived')).toBeVisible()

  await panel.getByRole('button', { name: '復元: 過去の目標' }).click()
  const result = panel.getByTestId('planning-restore-result')
  await expect(result).toContainText('「過去の目標」を復元しました。')
  await expect(result).toContainText('Work Item の関連付け 30 件と依存関係 2 件を戻しました。')
  await expect(result).toContainText('5 件はまだ戻っていません。')
  await expect(panel.getByTestId('planning-archived-entity-goal-archived')).toHaveCount(0)

  await panel.getByTestId('planning-restore-continue').click()
  await expect(result).toContainText('Work Item の関連付け 5 件と依存関係 0 件を戻しました。')
  await expect(panel.getByTestId('planning-restore-continue')).toHaveCount(0)

  expect(restoreRequests).toEqual([
    { body: { expectedRevision: 30 }, pathname: '/api/planning/entities/goal-archived/restore' },
    { body: { expectedRevision: 31 }, pathname: '/api/planning/entities/goal-archived/restore' },
  ])
})
