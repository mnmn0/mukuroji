import { expect, test } from 'bun:test'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { listTeamWorkItemEffort, withWorkItemPlannedEffort } from './work-item-effort'

const { createBulkRecoveryIssue } = createApiTestHarness()

test('reads archived Work Items only when asked, so time reports keep their estimates', async () => {
  const item = (id: string): CanonicalWorkItem => {
    const base = createBulkRecoveryIssue()
    return { ...base, id, statusCategory: 'completed', schedule: { ...base.schedule, plannedEffortMinutes: 120 } }
  }
  const reads: (boolean | undefined)[] = []
  const teamIssues = {
    async getTeamIssues(
      _directoryId: string,
      teamId: string,
      options?: { includeArchived?: boolean; consistentRead?: boolean; limitEvaluatedRows?: boolean },
    ) {
      // The DynamoDB client rejects an evaluated-row bounded read that is not consistent.
      expect(options?.limitEvaluatedRows).toBe(true)
      expect(options?.consistentRead).toBe(true)
      reads.push(options?.includeArchived)
      const issues = [item('open'), ...(options?.includeArchived ? [item('archived')] : [])]
      return { teamId, issues, evaluatedCount: issues.length }
    },
  }

  expect((await listTeamWorkItemEffort('workspace', 'team', {}, teamIssues)).map((effort) => effort.workItemId)).toEqual(['open'])
  expect(await listTeamWorkItemEffort('workspace', 'team', { includeArchived: true }, teamIssues)).toEqual([
    expect.objectContaining({ workItemId: 'open', plannedEffortMinutes: 120, remainingEffortMinutes: 0 }),
    expect.objectContaining({ workItemId: 'archived', plannedEffortMinutes: 120, remainingEffortMinutes: 0 }),
  ])
  expect(reads).toEqual([false, true])
})

test('lists the unfinished contributor shares that capacity planning places on members', async () => {
  const base = createBulkRecoveryIssue()
  const open: CanonicalWorkItem = {
    ...base,
    id: 'open',
    statusCategory: 'started',
    schedule: { mode: 'date-range', startDate: '2026-08-03', endDate: '2026-08-07', durationDays: 5, calendarPolicy: base.schedule.calendarPolicy },
    contributorAssignments: [
      { assignmentId: 'a'.repeat(32), memberUserId: 'dev@example.com', plannedEffortMinutes: 240, status: 'in-progress' },
      { assignmentId: 'b'.repeat(32), memberUserId: 'done@example.com', plannedEffortMinutes: 60, status: 'done' },
      { assignmentId: 'c'.repeat(32), jobRoleId: 'qa', plannedEffortMinutes: 60, status: 'planned' },
      { assignmentId: 'd'.repeat(32), memberUserId: 'idle@example.com', status: 'planned' },
    ],
  }
  const finished: CanonicalWorkItem = { ...open, id: 'finished', statusCategory: 'completed' }
  const teamIssues = {
    async getTeamIssues(_directoryId: string, teamId: string) {
      return { teamId, issues: [open, finished], evaluatedCount: 2 }
    },
  }

  expect(await listTeamWorkItemEffort('workspace', 'team', {}, teamIssues)).toEqual([
    expect.objectContaining({
      workItemId: 'open',
      window: { fromDate: '2026-08-03', toDate: '2026-08-07' },
      contributors: [{ assignmentId: 'a'.repeat(32), memberId: 'dev@example.com', plannedEffortMinutes: 240 }],
    }),
    expect.not.objectContaining({ contributors: expect.anything() }),
  ])
})

test('writes an estimate into a stored schedule and keeps its placement', () => {
  const calendarPolicy = { timeZone: 'UTC', workingWeekdays: ['monday' as const], holidays: [] }
  const stored = { mode: 'due-date' as const, dueDate: '2026-09-10', calendarPolicy, plannedEffortMinutes: 120 }
  expect(withWorkItemPlannedEffort(stored, 480)).toEqual({ ...stored, plannedEffortMinutes: 480 })
  expect(withWorkItemPlannedEffort(stored, null)).toEqual({ mode: 'due-date', dueDate: '2026-09-10', calendarPolicy })
})
