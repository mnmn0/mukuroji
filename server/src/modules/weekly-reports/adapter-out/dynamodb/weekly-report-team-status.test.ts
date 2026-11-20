import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryWeeklyReportStore } from './weekly-report-store'
import { readTeamWeeklyReportStatusUseCase } from '../../application/weekly-report-use-cases'

/** Team shared by every test. */
const team = { workspaceId: 'w', teamId: 't' }

/**
 * Stores one submitted version of a member's week.
 *
 * @param store - Store to write to.
 * @param memberKey - Author.
 * @param weekStart - Stored week start.
 */
async function submitWeek(store: InMemoryWeeklyReportStore, memberKey: string, weekStart: string) {
  const at = '2026-11-20T09:00:00.000Z'
  await store.submit({
    ...team,
    memberKey,
    now: at,
    callerAuthorization: [{ ConditionCheck: { TableName: 'access', Key: {}, ConditionExpression: 'attribute_exists(k)' } }],
    auditContext: createMutationAuditContext({
      workspaceId: 'w',
      actor: { id: memberKey, kind: 'user', displayName: 'Author' },
      idempotencyKey: `${memberKey}-${weekStart}`,
      request: { method: 'POST', path: '/seed', body: {} },
      source: { kind: 'api' },
    }),
    previous: null,
    next: { weekStart, revision: 1, updatedAt: at, notes: { issues: '', reflection: '' }, submissionCount: 1, lastSubmittedAt: at },
    submission: {
      version: 1,
      submittedAt: at,
      weekStart,
      weekEnd: weekStart,
      sections: { completed: [], started: [], overdue: [], upcoming: [] },
      time: [],
      items: [],
      totalMinutes: 0,
      timeIsPartial: false,
      notes: { issues: '', reflection: '' },
    },
  })
}

test('reports a week submitted under an earlier Workspace week start with its stored start', async () => {
  const store = new InMemoryWeeklyReportStore()
  // Submitted while weeks started on Monday; the Workspace now starts weeks on Sunday.
  await submitWeek(store, 'old@example.com', '2026-11-16')
  await submitWeek(store, 'now@example.com', '2026-11-15')
  // Weeks a full week away share no day with the requested week and are ignored.
  await submitWeek(store, 'far@example.com', '2026-11-22')

  const status = await readTeamWeeklyReportStatusUseCase(
    store,
    team,
    [{ memberKey: 'far@example.com' }, { memberKey: 'now@example.com' }, { memberKey: 'old@example.com' }],
    '2026-11-15',
  )

  expect(status.members).toEqual([
    { memberKey: 'far@example.com', submissionCount: 0 },
    { memberKey: 'now@example.com', submissionCount: 1, lastSubmittedAt: '2026-11-20T09:00:00.000Z' },
    { memberKey: 'old@example.com', submissionCount: 1, lastSubmittedAt: '2026-11-20T09:00:00.000Z', weekStart: '2026-11-16' },
  ])
})

test('prefers the overlapping week whose start is nearest', async () => {
  const store = new InMemoryWeeklyReportStore()
  await submitWeek(store, 'm@example.com', '2026-11-10')
  await submitWeek(store, 'm@example.com', '2026-11-17')

  const status = await readTeamWeeklyReportStatusUseCase(store, team, [{ memberKey: 'm@example.com' }], '2026-11-15')

  expect(status.members[0]?.weekStart).toBe('2026-11-17')
})
