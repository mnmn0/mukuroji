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
    { workItemId: 'open', plannedEffortMinutes: 120, remainingEffortMinutes: 0 },
    { workItemId: 'archived', plannedEffortMinutes: 120, remainingEffortMinutes: 0 },
  ])
  expect(reads).toEqual([false, true])
})

test('writes an estimate into a stored schedule and keeps its placement', () => {
  const calendarPolicy = { timeZone: 'UTC', workingWeekdays: ['monday' as const], holidays: [] }
  const stored = { mode: 'due-date' as const, dueDate: '2026-09-10', calendarPolicy, plannedEffortMinutes: 120 }
  expect(withWorkItemPlannedEffort(stored, 480)).toEqual({ ...stored, plannedEffortMinutes: 480 })
  expect(withWorkItemPlannedEffort(stored, null)).toEqual({ mode: 'due-date', dueDate: '2026-09-10', calendarPolicy })
})
