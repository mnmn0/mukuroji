import { expect, test } from '@playwright/test'
import {
  createDefaultDueDateWorkItemSchedule,
  type PlanningEntityPatch,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import type { AuthSession } from '../src/auth/session'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const authSession = {
  accessToken: 'planning-cycle-settings-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

/** One PATCH the stubbed Planning API received. */
type EntityUpdateRequest = {
  /** Request path, which names the entity. */
  pathname: string
  /** Request body. */
  body: unknown
}

/**
 * Reads the patch out of an entity update body so the stub can apply it.
 *
 * @param body - Parsed request body.
 * @returns The patch, or an empty patch when the body has none.
 */
function readPatch(body: unknown): PlanningEntityPatch {
  if (typeof body !== 'object' || body === null || !('patch' in body)) return {}
  const { patch } = body
  if (typeof patch !== 'object' || patch === null) return {}
  const result: PlanningEntityPatch = {}
  if ('capacity' in patch && typeof patch.capacity === 'number') result.capacity = patch.capacity
  if ('carryOverPolicy' in patch && (patch.carryOverPolicy === 'move-incomplete' || patch.carryOverPolicy === 'keep-incomplete')) {
    result.carryOverPolicy = patch.carryOverPolicy
  }
  if (
    'cadence' in patch &&
    typeof patch.cadence === 'object' &&
    patch.cadence !== null &&
    'unit' in patch.cadence &&
    'count' in patch.cadence &&
    (patch.cadence.unit === 'week' || patch.cadence.unit === 'month') &&
    typeof patch.cadence.count === 'number'
  ) {
    result.cadence = { unit: patch.cadence.unit, count: patch.cadence.count }
  }
  return result
}

test('Issue #385: edits a Cycle cadence, capacity and carry-over policy from the Planning screen', async ({ page }) => {
  let planning: PlanningSnapshot = {
    ...structuredClone(planningSnapshotFixture),
    revision: 40,
    // The Cycle is full, so the backlog Work Item cannot go in until the capacity is raised.
    entities: planningSnapshotFixture.entities.map((entity) => entity.id === 'cycle-14'
      ? { ...structuredClone(entity), capacity: 2 }
      : structuredClone(entity)),
    workItems: [
      ...structuredClone(planningSnapshotFixture.workItems),
      {
        id: 'backlog-1',
        revision: 1,
        teamId: 'core-team',
        title: 'バックログの Work Item',
        projectId: 'refero',
        statusCategory: 'unstarted',
        dueDate: '2026-07-30',
        schedule: createDefaultDueDateWorkItemSchedule('2026-07-30'),
      },
    ],
  }
  const updates: EntityUpdateRequest[] = []

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
  await page.route('**/api/planning/archived-entities**', async (route) => {
    await route.fulfill({ json: { entities: [] } })
  })
  await page.route('**/api/planning/entities/cycle-14', async (route) => {
    const request = route.request()
    const body: unknown = request.postDataJSON()
    updates.push({ pathname: new URL(request.url()).pathname, body })
    const patch = readPatch(body)
    planning = {
      ...planning,
      revision: planning.revision + 1,
      entities: planning.entities.map((entity) => entity.id === 'cycle-14' ? { ...entity, ...patch } : entity),
    }
    await route.fulfill({ json: planning })
  })

  await page.goto('/planning', { waitUntil: 'domcontentloaded' })
  const cyclePanel = page.getByTestId('cycle-planning')
  await expect(cyclePanel.getByTestId('cycle-planning-summary')).toContainText('コミット 2 件 / 容量 2 件')
  await expect(cyclePanel.getByTestId('cycle-planning-capacity-full')).toBeVisible()

  await page.getByTestId('timeline-entity-cycle-14').getByRole('button').first().click()
  const editor = page.getByTestId('planning-entity-editor')
  const settings = editor.getByTestId('planning-entity-editor-cycle')
  await expect(settings).toContainText('今 2 件。これ未満にはできません。')

  await settings.getByLabel('キャパシティ（Work Item 件数）').fill('1')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByTestId('planning-entity-editor-message'))
    .toHaveText('キャパシティは今入っている Work Item の件数以上にしてください。')
  expect(updates).toEqual([])

  await settings.getByLabel('キャパシティ（Work Item 件数）').fill('30')
  await settings.getByLabel('1 Cycle の長さ').fill('1')
  await settings.getByLabel('長さの単位').selectOption('month')
  await settings.getByLabel('繰り越し方針').selectOption('keep-incomplete')
  await editor.getByRole('button', { name: '保存', exact: true }).click()

  await expect(cyclePanel.getByTestId('cycle-planning-summary')).toContainText('コミット 2 件 / 容量 30 件')
  await expect(cyclePanel.getByTestId('cycle-planning-capacity-full')).toHaveCount(0)
  expect(updates).toEqual([{
    pathname: '/api/planning/entities/cycle-14',
    body: {
      expectedRevision: 40,
      patch: {
        cadence: { unit: 'month', count: 1 },
        capacity: 30,
        carryOverPolicy: 'keep-incomplete',
      },
    },
  }])
  await expect(settings.getByLabel('キャパシティ（Work Item 件数）')).toHaveValue('30')
})
