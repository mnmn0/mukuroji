import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  PLANNING_UPDATE_CONTENT_VERSION,
  type PlanningSnapshot,
  type PlanningUpdate,
  type PlanningUpdateCadence,
  type PlanningUpdateTarget,
  type PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import type { AuthSession } from '../src/auth/session'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const planningProjectTarget = {
  type: 'project',
  projectId: 'refero',
  teamId: 'core-team',
} satisfies PlanningUpdateTarget

const configuredCadence = {
  cadence: { count: 1, unit: 'week' },
  escalationHoursAfter: 12,
  escalationMemberKey: 'lead@example.com',
  nextDueAt: '2026-08-14T08:00:00.000Z',
  reminderHoursBefore: 24,
  timeZone: 'Asia/Tokyo',
  updateOwnerMemberKey: 'publisher@example.com',
} satisfies PlanningUpdateCadence

const nextCadence = {
  ...configuredCadence,
  nextDueAt: '2026-08-21T08:00:00.000Z',
} satisfies PlanningUpdateCadence

const publishedUpdate = {
  authorMemberKey: 'publisher@example.com',
  changes: [],
  contentVersion: PLANNING_UPDATE_CONTENT_VERSION,
  contextSnapshot: {
    dependencies: [],
    health: 'on-track',
    milestones: [],
    progress: { linkedWorkItemCount: 2, percent: 60 },
    risk: 'low',
    scope: { projectId: 'refero', teamId: 'core-team' },
  },
  coveredDueAt: configuredCadence.nextDueAt,
  createdAt: '2026-08-10T03:45:00.000Z',
  decisionSummary: 'Keep the current rollout sequence.',
  evidence: [],
  health: 'on-track',
  helpNeeded: 'Review the launch checklist.',
  id: 'planning-update-published',
  nextAction: 'Complete the final release review.',
  origin: 'manual',
  progressSnapshot: { linkedWorkItemCount: 2, percent: 60 },
  risk: 'low',
  riskSummary: 'No blocking risk is confirmed.',
  summary: 'The launch plan is ready for final review.',
  target: planningProjectTarget,
  version: 1,
} satisfies PlanningUpdate

const authSession = {
  accessToken: 'planning-update-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

/**
 * Installs authenticated Workspace and Planning API stubs for one Project update stream.
 *
 * @param page - Playwright page whose same-origin API calls are intercepted.
 * @param readOnly - Whether the current viewer and initial cadence are read-only.
 */
async function mockPlanningUpdatePage(page: Page, readOnly = false) {
  const initialTargetSummary: PlanningUpdateTargetSummary = readOnly
    ? {
        cadence: configuredCadence,
        latestVersion: 0,
        target: planningProjectTarget,
        updatedAt: '2026-08-09T00:00:00.000Z',
        updateState: 'missing',
      }
    : {
        latestVersion: 0,
        target: planningProjectTarget,
        updatedAt: '2026-08-09T00:00:00.000Z',
        updateState: 'not-configured',
      }
  const otherTargetSummaries = structuredClone(
    planningSnapshotFixture.updateTargets.filter((summary) =>
      summary.target.type !== 'project' ||
      summary.target.teamId !== planningProjectTarget.teamId ||
      summary.target.projectId !== planningProjectTarget.projectId
    ),
  )
  let planning: PlanningSnapshot = {
    ...structuredClone(planningSnapshotFixture),
    revision: 20,
    updatedAt: '2026-08-09T00:00:00.000Z',
    updateTargets: [initialTargetSummary, ...otherTargetSummaries],
  }
  let history: PlanningUpdate[] = []

  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
    window.localStorage.setItem('mukuroji.locale', 'ja')
  }, authSession)

  await page.route('**/api/auth/me', async (route) => {
    const username = readOnly ? 'viewer@example.com' : 'publisher@example.com'
    await route.fulfill({
      json: {
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: username,
          name: readOnly ? 'Planning Viewer' : 'Planning Publisher',
        },
        groups: readOnly ? [] : ['mukuroji-system-admins'],
        isSystemAdmin: !readOnly,
        username,
        workspaceMemberStatus: 'active',
        workspaceRole: readOnly ? 'guest' : 'owner',
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
        watch: {
          automatic: false,
          explicit: false,
          reasons: [],
          subscribed: false,
          watcherCount: 1,
        },
      },
    })
  })

  await page.route('**/api/planning/updates**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname

    if (pathname === '/api/planning/updates/cadence' && request.method() === 'PUT') {
      const updateTarget = {
        cadence: configuredCadence,
        latestVersion: 0,
        target: planningProjectTarget,
        updatedAt: '2026-08-09T01:00:00.000Z',
        updateState: 'missing',
      } satisfies PlanningUpdateTargetSummary
      planning = {
        ...planning,
        revision: planning.revision + 1,
        updatedAt: updateTarget.updatedAt,
        updateTargets: planning.updateTargets.map((summary) =>
          summary.target.type === 'project' &&
            summary.target.teamId === planningProjectTarget.teamId &&
            summary.target.projectId === planningProjectTarget.projectId
            ? updateTarget
            : summary
        ),
      }
      await route.fulfill({ json: { planning, updateTarget } })
      return
    }

    if (pathname === '/api/planning/updates' && request.method() === 'POST') {
      history = [publishedUpdate]
      const updateTarget = {
        cadence: nextCadence,
        latestUpdate: {
          authorMemberKey: publishedUpdate.authorMemberKey,
          coveredDueAt: publishedUpdate.coveredDueAt,
          createdAt: publishedUpdate.createdAt,
          health: publishedUpdate.health,
          id: publishedUpdate.id,
          progressSnapshot: publishedUpdate.progressSnapshot,
          risk: publishedUpdate.risk,
          summary: publishedUpdate.summary,
          version: publishedUpdate.version,
        },
        latestVersion: publishedUpdate.version,
        target: planningProjectTarget,
        updatedAt: publishedUpdate.createdAt,
        updateState: 'current',
      } satisfies PlanningUpdateTargetSummary
      planning = {
        ...planning,
        revision: planning.revision + 1,
        updatedAt: publishedUpdate.createdAt,
        updateTargets: planning.updateTargets.map((summary) =>
          summary.target.type === 'project' &&
            summary.target.teamId === planningProjectTarget.teamId &&
            summary.target.projectId === planningProjectTarget.projectId
            ? updateTarget
            : summary
        ),
      }
      await route.fulfill({ json: { planning, update: publishedUpdate } })
      return
    }

    if (pathname === '/api/planning/updates' && request.method() === 'GET') {
      await route.fulfill({ json: { updates: history } })
      return
    }

    if (pathname.endsWith('/comments') && request.method() === 'GET') {
      await route.fulfill({ json: { comments: [] } })
      return
    }

    if (pathname.endsWith('/reactions') && request.method() === 'GET') {
      await route.fulfill({ json: { reactions: [] } })
      return
    }

    await route.fulfill({ json: { message: 'Unexpected Planning update request.' }, status: 404 })
  })
}

/**
 * Opens the canonical Team-qualified Project update route after mocks are installed.
 *
 * @param page - Authenticated Playwright page.
 */
async function openPlanningProjectUpdate(page: Page) {
  await page.goto(
    '/planning/timeline?targetType=project&teamId=core-team&projectId=refero',
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.getByTestId('planning-update-detail-pane')).toBeVisible()
}

test('Issue #195: configures cadence, publishes manually, and shows the latest immutable update', async ({
  page,
}) => {
  await mockPlanningUpdatePage(page)
  await openPlanningProjectUpdate(page)

  const detail = page.getByTestId('planning-update-detail-pane')
  const cadence = page.getByTestId('planning-update-cadence')
  const composer = page.getByTestId('planning-update-composer')

  await expect(detail.getByTestId('planning-update-freshness')).toHaveText('更新スケジュール未設定')
  await expect(composer.getByRole('button', { name: '更新を公開' })).toBeDisabled()

  await cadence.locator('[name="updateOwnerMemberKey"]').fill('publisher@example.com')
  await cadence.locator('[name="cadenceCount"]').fill('1')
  await cadence.locator('[name="cadenceUnit"]').selectOption('week')
  await cadence.locator('[name="timeZone"]').fill('Asia/Tokyo')
  await cadence.locator('[name="nextDueAt"]').fill(configuredCadence.nextDueAt)
  await cadence.locator('[name="reminderHoursBefore"]').fill('24')
  await cadence.locator('[name="escalationHoursAfter"]').fill('12')
  await cadence.locator('[name="escalationMemberKey"]').fill('lead@example.com')

  const cadenceRequestPromise = page.waitForRequest((request) =>
    request.method() === 'PUT' &&
    new URL(request.url()).pathname === '/api/planning/updates/cadence'
  )
  await cadence.getByRole('button', { name: 'スケジュールを保存' }).click()
  const cadenceRequest = await cadenceRequestPromise

  expect(cadenceRequest.postDataJSON()).toMatchObject({
    cadence: configuredCadence,
    expectedRevision: 20,
    target: planningProjectTarget,
  })
  await expect(detail.getByTestId('planning-update-freshness')).toHaveText('未報告')
  await expect(composer.getByRole('button', { name: '更新を公開' })).toBeEnabled()

  await composer.locator('[name="health"]').selectOption('on-track')
  await composer.locator('[name="risk"]').selectOption('low')
  await composer.locator('[name="summary"]').fill(publishedUpdate.summary)
  await composer.locator('[name="riskSummary"]').fill(publishedUpdate.riskSummary)
  await composer.locator('[name="decisionSummary"]').fill(publishedUpdate.decisionSummary)
  await composer.locator('[name="helpNeeded"]').fill(publishedUpdate.helpNeeded)
  await composer.locator('[name="nextAction"]').fill(publishedUpdate.nextAction)

  const publishRequestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' &&
    new URL(request.url()).pathname === '/api/planning/updates'
  )
  await composer.getByRole('button', { name: '更新を公開' }).click()
  const publishRequest = await publishRequestPromise

  expect(publishRequest.postDataJSON()).toMatchObject({
    decisionSummary: publishedUpdate.decisionSummary,
    evidence: [],
    expectedRevision: 21,
    health: publishedUpdate.health,
    helpNeeded: publishedUpdate.helpNeeded,
    id: expect.stringMatching(/^planning-update-/),
    nextAction: publishedUpdate.nextAction,
    risk: publishedUpdate.risk,
    riskSummary: publishedUpdate.riskSummary,
    summary: publishedUpdate.summary,
    target: planningProjectTarget,
  })

  await expect(detail.getByTestId('planning-update-freshness')).toHaveText('更新済み')
  await expect(detail).toContainText('publisher@example.com · 2026/08/10 12:45')
  await expect(detail).toContainText('次回期限: 2026/08/21 17:00 · Asia/Tokyo')

  const history = page.getByTestId('planning-status-update-history')
  const immutableUpdate = history.locator('article[data-update-version="1"]')
  await expect(immutableUpdate).toBeVisible()
  await expect(immutableUpdate).toContainText(publishedUpdate.summary)
  await expect(immutableUpdate).toContainText('公開済み・変更不可')
})

test('Issue #195: keeps a configured Project update composer read-only without permission', async ({
  page,
}) => {
  await mockPlanningUpdatePage(page, true)
  await openPlanningProjectUpdate(page)

  const detail = page.getByTestId('planning-update-detail-pane')
  const cadence = page.getByTestId('planning-update-cadence')
  const composer = page.getByTestId('planning-update-composer')

  await expect(detail.getByTestId('planning-update-freshness')).toHaveText('未報告')
  await expect(cadence).toContainText('更新スケジュールを変更する権限がありません。')
  await expect(cadence.getByRole('button', { name: 'スケジュールを保存' })).toBeDisabled()
  await expect(composer.locator('[name="summary"]')).toBeDisabled()
  await expect(composer.locator('[name="evidenceType"]')).toBeDisabled()
  await expect(composer.getByRole('button', { name: '更新を公開' })).toBeDisabled()
})
