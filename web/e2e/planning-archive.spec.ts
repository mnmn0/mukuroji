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
 * How the stubbed restore API fails once.
 *
 * - `continuation-fails`: the first "restore the rest" fails before changing anything.
 * - `initial-outcome-unknown`: the first restore commits, then the response is lost as a 503.
 */
type RestoreFailureScenario = 'continuation-fails' | 'initial-outcome-unknown'

/**
 * Installs authenticated Workspace and Planning API stubs with two pages of archived plans.
 *
 * @param page - Playwright page whose same-origin API calls are intercepted.
 * @param scenario - Which restore request fails, and whether it commits first.
 * @returns The restore request bodies, in order.
 */
async function mockPlanningArchivePage(page: Page, scenario: RestoreFailureScenario) {
  let planning: PlanningSnapshot = {
    ...structuredClone(planningSnapshotFixture),
    revision: 30,
  }
  let goalArchived = true
  const restoreRequests: unknown[] = []
  const failingRequest = scenario === 'continuation-fails' ? 2 : 1
  const restoreSummaries: PlanningRestoreSummary[] = [
    ...(scenario === 'continuation-fails' ? [{
      restoredLinkCount: 30,
      droppedLinkCount: 1,
      restoredDependencyCount: 2,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 5,
    }] : []),
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
    const fails = restoreRequests.length === failingRequest
    if (fails && scenario === 'continuation-fails') {
      // The first "restore the rest" fails; the result and its button must stay.
      await route.fulfill({ json: { code: 'PlanningUnavailable', message: 'Unavailable.' }, status: 503 })
      return
    }
    goalArchived = false
    planning = {
      ...planning,
      revision: planning.revision + 1,
      entities: planning.entities.some((entity) => entity.id === archivedGoal.id)
        ? planning.entities
        : [...planning.entities, { ...structuredClone(fixtureGoal), id: archivedGoal.id, title: archivedGoal.title }],
    }
    if (fails) {
      // The restore committed, but the client only sees a server error.
      await route.fulfill({ json: { code: 'PlanningUnavailable', message: 'Unavailable.' }, status: 503 })
      return
    }
    const restore = restoreSummaries.shift()
    await route.fulfill({ json: { planning, restore } })
  })
  return restoreRequests
}

test('Issue #369: lists archived plans, restores one, and retries the references left behind', async ({
  page,
}) => {
  const restoreRequests = await mockPlanningArchivePage(page, 'continuation-fails')
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
  await expect(page.getByText('計画の変更を保存できませんでした。もう一度お試しください。')).toBeVisible()
  await expect(result).toContainText('5 件はまだ戻っていません。')

  await panel.getByTestId('planning-restore-continue').click()
  await expect(result).toContainText('Work Item の関連付け 5 件と依存関係 0 件を戻しました。')
  await expect(panel.getByTestId('planning-restore-continue')).toHaveCount(0)

  expect(restoreRequests).toEqual([
    { body: { expectedRevision: 30 }, pathname: '/api/planning/entities/goal-archived/restore' },
    { body: { expectedRevision: 31 }, pathname: '/api/planning/entities/goal-archived/restore' },
    { body: { expectedRevision: 31 }, pathname: '/api/planning/entities/goal-archived/restore' },
  ])
})

test('Issue #369: keeps a way to finish a restore whose response was lost', async ({ page }) => {
  const restoreRequests = await mockPlanningArchivePage(page, 'initial-outcome-unknown')
  await page.goto('/planning/roadmap', { waitUntil: 'domcontentloaded' })

  const panel = page.getByTestId('planning-archived-entities')
  await panel.getByText('アーカイブ済みの計画', { exact: true }).click()
  await panel.getByRole('button', { name: '復元: 過去の目標' }).click()

  // The goal left the archive although the request failed; only the result can reach it now.
  await expect(page.getByText('計画の変更を保存できませんでした。もう一度お試しください。')).toBeVisible()
  const result = panel.getByTestId('planning-restore-result')
  await expect(result).toContainText('「過去の目標」の復元が完了したか確認できませんでした。')
  await expect(panel.getByTestId('planning-archived-entity-goal-archived')).toHaveCount(0)

  await panel.getByTestId('planning-restore-continue').click()
  await expect(result).toContainText('Work Item の関連付け 5 件と依存関係 0 件を戻しました。')
  await expect(panel.getByTestId('planning-restore-continue')).toHaveCount(0)

  // The snapshot reloaded after the lost response, so the retry carries the committed revision.
  expect(restoreRequests).toEqual([
    { body: { expectedRevision: 30 }, pathname: '/api/planning/entities/goal-archived/restore' },
    { body: { expectedRevision: 31 }, pathname: '/api/planning/entities/goal-archived/restore' },
  ])
})
