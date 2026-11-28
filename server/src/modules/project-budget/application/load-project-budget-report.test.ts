import { describe, expect, test } from 'bun:test'
import type { TimeEntry } from '@mukuroji/contracts'
import {
  loadProjectBudgetReport,
  loadProjectEarnedValue,
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
    listExpenses: async (workspaceId, teamId, projectId) => {
      calls.push(`expenses ${workspaceId}/${teamId}/${projectId}`)
      return []
    },
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
      { issues: [{ id: 'other', statusCategory: 'completed', schedule: {}, assignedProjectId: 'p' }], nextStartAfterIssueId: 'other' },
      { issues: [{ id: 'a', statusCategory: 'completed', schedule: {}, assignedProjectId: 'p' }] },
    ], calls), 100)

    expect(calls).toEqual([
      'budget w/t/p',
      'entries p 2026-01-04T10:00:00.000Z 2026-01-07T14:00:00.000Z',
      'expenses w/t/p',
    ])
    expect(report.asOf).toBe('2026-01-06')
    expect(report.points[0]).toMatchObject({ date: '2026-01-05', actualMinutes: 60 })
    expect(report.earnedValue).toMatchObject({ budgetAtCompletionMinutes: 600, earnedValueMinutes: 600, actualMinutes: 60 })
  })

  test('fails closed when the Team has more Work Items than one report may evaluate', async () => {
    await expect(loadProjectBudgetReport(request, ports([
      { issues: [{ id: 'a', statusCategory: 'completed', schedule: {}, assignedProjectId: 'p' }], evaluatedCount: 3 },
    ]), 2)).rejects.toMatchObject({ status: 413, code: 'WorkItemListLimitExceeded' })
  })

  test('stops when a Work Item page read does not advance', async () => {
    await expect(loadProjectBudgetReport(request, ports([
      { issues: [], nextStartAfterIssueId: 'x' },
      { issues: [], nextStartAfterIssueId: 'x' },
    ]), 100)).rejects.toMatchObject({ status: 503, code: 'WorkItemListReadStalled' })
  })

  test('splits time that crosses local midnight and keeps each part of the cost', async () => {
    const base = ports([{ issues: [{ id: 'a', statusCategory: 'started', schedule: {}, assignedProjectId: 'p' }] }])
    const report = await loadProjectBudgetReport(request, {
      ...base,
      // 14:00Z on 01-05 is 23:00 in Tokyo, so 60 of the 120 minutes fall on each day.
      listEntries: async () => [{ ...entry('2026-01-05T14:00:00.000Z', 120), hourlyRateMinor: 6_000, actualCostMinor: 12_000 }],
    }, 100)

    expect(report.points.map((point) => [point.date, point.actualMinutes, point.actualCostMinor])).toEqual([
      ['2026-01-05', 60, undefined],
      ['2026-01-06', 120, undefined],
    ])
    expect(report.actualMinutes).toBe(120)
    expect(report.actualCostByCurrency).toEqual({ JPY: 12_000 })
  })

  test('earns nothing for a baseline Work Item that now belongs to another Project', async () => {
    const report = await loadProjectBudgetReport(request, ports([
      { issues: [{ id: 'a', statusCategory: 'completed', schedule: {}, assignedProjectId: 'other' }] },
    ]), 100)

    expect(report.earnedValue).toMatchObject({ budgetAtCompletionMinutes: 600, earnedValueMinutes: 0 })
  })
})

describe('loadProjectBudgetReport Agent Run cost (ADR 0119)', () => {
  /** JPY 100,000 budget over the report dates. */
  const budget = {
    schemaVersion: 1 as const,
    workspaceId: 'w',
    teamId: 't',
    scopeType: 'project' as const,
    scopeId: 'p',
    amountMinor: 100_000,
    currency: 'JPY',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  /**
   * Builds ports with a budget and a recorder of Agent Run cost reads.
   *
   * @param settings - Workspace agent cost settings.
   * @param reads - Receives each Agent Run cost read.
   * @returns The ports.
   */
  function agentPorts(
    settings: { includeInProjectBudgets: boolean; usdExchangeRates: Record<string, number> } | undefined,
    reads: unknown[],
  ): ProjectBudgetReportPorts {
    return {
      ...ports([{
        issues: [
          { id: 'a', statusCategory: 'started', schedule: {}, assignedProjectId: 'p' },
          { id: 'moved', statusCategory: 'started', schedule: {}, assignedProjectId: 'other' },
        ],
      }]),
      getBudget: async () => budget,
      readAgentCostSettings: async () => settings,
      listAgentRunCosts: async (input) => {
        reads.push({ ...input, workItemIds: [...input.workItemIds] })
        // 2026-01-05T16:00Z is 2026-01-06 in Tokyo; $1.50 at 150 JPY is 225 yen.
        return { runs: [{ finishedAt: '2026-01-05T16:00:00.000Z', costMicroUsd: 1_500_000 }], truncated: false }
      },
    }
  }

  test('adds the converted cost of runs on the Project Work Items to the actual cost and EVM', async () => {
    const reads: unknown[] = []
    const report = await loadProjectBudgetReport(request, agentPorts({ includeInProjectBudgets: true, usdExchangeRates: { JPY: 150 } }, reads), 100)

    expect(reads).toEqual([{
      workspaceId: 'w',
      teamId: 't',
      workItemIds: ['a'],
      since: '2026-01-04T10:00:00.000Z',
      until: '2026-01-07T14:00:00.000Z',
      maxRuns: 1_000,
    }])
    expect(report.agentCost).toEqual({
      status: 'included',
      estimatedCostMicroUsd: 1_500_000,
      amountMinor: 225,
      usdExchangeRate: 150,
      runCount: 1,
      truncated: false,
    })
    // Time cost 6,000 plus 225 of agent cost.
    expect(report.earnedValue?.money?.actualCostMinor).toBe(6_225)
    expect(report.budgetConsumedPercent).toBe(6.2)
    expect(report.points.map((point) => point.actualCostMinor)).toEqual([6_000, 6_225])
  })

  test('reports the cost apart without adding it when the budget currency has no rate', async () => {
    const report = await loadProjectBudgetReport(request, agentPorts({ includeInProjectBudgets: true, usdExchangeRates: {} }, []), 100)

    expect(report.agentCost).toEqual({ status: 'missing-exchange-rate', estimatedCostMicroUsd: 1_500_000, runCount: 1, truncated: false })
    expect(report.earnedValue?.money?.actualCostMinor).toBe(6_000)
  })

  test('reads no Agent Runs when the Workspace does not count them', async () => {
    const reads: unknown[] = []
    const report = await loadProjectBudgetReport(request, agentPorts({ includeInProjectBudgets: false, usdExchangeRates: { JPY: 150 } }, reads), 100)

    expect(reads).toEqual([])
    expect(report.agentCost).toBeUndefined()
    expect(report.earnedValue?.money?.actualCostMinor).toBe(6_000)
  })
})

describe('loadProjectEarnedValue', () => {
  test('counts every minute recorded on the Project through the as-of date without rounding', async () => {
    const calls: string[] = []
    const base = ports([{ issues: [{ id: 'a', statusCategory: 'started', schedule: {}, assignedProjectId: 'p' }] }], calls)
    const figures = await loadProjectEarnedValue(
      { workspaceId: 'w', teamId: 't', projectId: 'p', timeZone: 'Asia/Tokyo', asOf: Date.parse('2026-01-05T12:00:00.000Z') },
      {
        ...base,
        // 60 planned minutes over 2026-01-05..11 plan 60/7 minutes a day, which the report rounds.
        getBaseline: async () => ({
          revision: 1,
          capturedAt: '2026-01-01T00:00:00.000Z',
          entries: [{ workItemId: 'a', startDate: '2026-01-05', endDate: '2026-01-11', plannedEffortMinutes: 60 }],
        }),
      },
      100,
    )

    // Time is read from long before the plan, and expenses are not read for effort figures.
    expect(calls).toEqual([
      'budget w/t/p',
      'entries p 1999-12-31T10:00:00.000Z 2026-01-06T14:00:00.000Z',
    ])
    // A started Work Item earns half of its 60 minutes; planned value stays unrounded.
    expect(figures).toMatchObject({ budgetAtCompletionMinutes: 60, earnedValueMinutes: 30, actualMinutes: 60 })
    expect(figures?.plannedValueMinutes).toBeCloseTo(60 / 7, 10)
  })

  test('reads nothing more for a Project without a baseline that plans effort', async () => {
    const calls: string[] = []
    const base = ports([], calls)
    const figures = await loadProjectEarnedValue(
      { workspaceId: 'w', teamId: 't', projectId: 'p', timeZone: 'UTC', asOf: Date.parse('2026-01-05T12:00:00.000Z') },
      { ...base, getBaseline: async () => null },
      100,
    )

    expect(figures).toBeNull()
    expect(calls).toEqual(['budget w/t/p'])
  })
})
