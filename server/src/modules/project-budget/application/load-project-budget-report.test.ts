import { describe, expect, test } from 'bun:test'
import type { TimeEntry } from '@mukuroji/contracts'
import {
  loadProjectBudgetReport,
  type ProjectBudgetReportPorts,
  type ProjectBudgetReportRequest,
  type ProjectBudgetWorkItemPage,
} from './load-project-budget-report'

const request: ProjectBudgetReportRequest = {
  workspaceId: 'w',
  teamId: 't',
  projectId: 'p',
  from: '2026-01-05',
  to: '2026-01-06',
  timeZone: 'Asia/Tokyo',
  interval: 'day',
}

/**
 * Builds a stored time entry of the Project.
 *
 * @param startAt - Start instant.
 * @param durationMinutes - Length in minutes.
 * @returns The entry.
 */
function entry(startAt: string, durationMinutes: number): TimeEntry {
  return {
    schemaVersion: 1,
    workspaceId: 'w',
    teamId: 't',
    id: startAt,
    userId: 'member',
    projectId: 'p',
    workItemId: 'a',
    startAt,
    endAt: new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString(),
    durationMinutes,
    billable: true,
    currency: 'JPY',
    actualCostMinor: durationMinutes * 100,
    source: 'manual',
    status: 'draft',
    revision: 1,
    createdAt: startAt,
    updatedAt: startAt,
  }
}

/**
 * Builds ports around fixed data.
 *
 * @param pages - Work Item pages returned in order.
 * @param calls - Receives each read so a test can check what was asked.
 * @returns The ports.
 */
function ports(pages: ProjectBudgetWorkItemPage[], calls: string[] = []): ProjectBudgetReportPorts {
  let page = 0
  return {
    getBudget: async (workspaceId, teamId, projectId) => {
      calls.push(`budget ${workspaceId}/${teamId}/${projectId}`)
      return undefined
    },
    getBaseline: async () => ({
      revision: 1,
      id: 'baseline',
      name: 'Plan',
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [{ workItemId: 'a', startDate: '2026-01-05', endDate: '2026-01-06', plannedEffortMinutes: 600 }],
    }),
    getProgressMode: async () => 'status-category',
    listEntries: async (input) => {
      calls.push(`entries ${input.projectId} ${input.from} ${input.to}`)
      // 2026-01-04T20:00Z is 2026-01-05 in Tokyo, so it counts on the first day.
      return [entry('2026-01-04T20:00:00.000Z', 60)]
    },
    listWorkItems: async () => {
      const next = pages[page]
      page += 1
      if (!next) throw new Error('No more pages.')
      return next
    },
    now: () => new Date('2026-01-10T00:00:00.000Z'),
  }
}

describe('loadProjectBudgetReport', () => {
  test('reads the Team-scoped data and counts time by its local start date', async () => {
    const calls: string[] = []
    const report = await loadProjectBudgetReport(request, ports([
      { issues: [{ id: 'other', statusCategory: 'completed', schedule: {} }], nextStartAfterIssueId: 'other' },
      { issues: [{ id: 'a', statusCategory: 'completed', schedule: {} }] },
    ], calls), 100)

    expect(calls).toEqual([
      'budget w/t/p',
      'entries p 2026-01-04T10:00:00.000Z 2026-01-07T14:00:00.000Z',
    ])
    expect(report.asOf).toBe('2026-01-06')
    expect(report.points[0]).toMatchObject({ date: '2026-01-05', actualMinutes: 60 })
    expect(report.earnedValue).toMatchObject({ budgetAtCompletionMinutes: 600, earnedValueMinutes: 600, actualMinutes: 60 })
  })

  test('fails closed when the Team has more Work Items than one report may evaluate', async () => {
    await expect(loadProjectBudgetReport(request, ports([
      { issues: [{ id: 'a', statusCategory: 'completed', schedule: {} }], evaluatedCount: 3 },
    ]), 2)).rejects.toMatchObject({ status: 413, code: 'WorkItemListLimitExceeded' })
  })

  test('stops when a Work Item page read does not advance', async () => {
    await expect(loadProjectBudgetReport(request, ports([
      { issues: [], nextStartAfterIssueId: 'x' },
      { issues: [], nextStartAfterIssueId: 'x' },
    ]), 100)).rejects.toMatchObject({ status: 503, code: 'WorkItemListReadStalled' })
  })
})
