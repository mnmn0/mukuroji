import { describe, expect, test } from 'bun:test'
import type { ProjectExpense, ProjectScheduleBaseline, TimeBudget } from '@mukuroji/contracts'
import { createProjectBudgetReport, type ProjectBudgetReportInput } from './project-budget-report'

const budget: TimeBudget = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  scopeType: 'project',
  scopeId: 'project-1',
  amountMinor: 900_000,
  currency: 'JPY',
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const baseline: ProjectScheduleBaseline = {
  revision: 2,
  id: 'baseline-1',
  name: '承認済み計画',
  capturedAt: '2026-01-01T00:00:00.000Z',
  entries: [
    { workItemId: 'a', startDate: '2026-01-05', endDate: '2026-01-09', plannedEffortMinutes: 600 },
    { workItemId: 'b', endDate: '2026-01-12', plannedEffortMinutes: 300 },
    { workItemId: 'c', plannedEffortMinutes: 120 },
    { workItemId: 'd', startDate: '2026-01-05', endDate: '2026-01-06', plannedEffortMinutes: 60 },
    { workItemId: 'e', startDate: '2026-01-05', endDate: '2026-01-06' },
  ],
}

/**
 * Builds report input around the shared baseline and budget.
 *
 * @param overrides - Fields to replace.
 * @returns The input.
 */
function input(overrides: Partial<ProjectBudgetReportInput> = {}): ProjectBudgetReportInput {
  return {
    teamId: 'team-1',
    projectId: 'project-1',
    from: '2026-01-05',
    to: '2026-01-09',
    timeZone: 'Asia/Tokyo',
    interval: 'day',
    today: '2026-01-07',
    budget,
    baseline,
    workItems: new Map([
      ['a', { canceled: false, progressPercent: 50 }],
      ['b', { canceled: false, progressPercent: 0 }],
      ['c', { canceled: false, progressPercent: 100 }],
      ['d', { canceled: true, progressPercent: 0 }],
    ]),
    entries: [
      { localDate: '2026-01-05', durationMinutes: 120, currency: 'JPY', actualCostMinor: 12_000 },
      { localDate: '2026-01-06', durationMinutes: 180, currency: 'JPY' },
      { localDate: '2026-01-06', durationMinutes: 30, currency: 'USD', actualCostMinor: 500 },
      { localDate: '2026-01-08', durationMinutes: 60, currency: 'JPY', actualCostMinor: 6_000 },
      { localDate: '2026-01-04', durationMinutes: 60, currency: 'JPY', actualCostMinor: 6_000 },
    ],
    expenses: [],
    ...overrides,
  }
}

/**
 * Builds an expense of the shared Project.
 *
 * @param overrides - Fields to replace.
 * @returns The expense.
 */
function expense(overrides: Partial<ProjectExpense>): ProjectExpense {
  return {
    id: 'expense-1',
    teamId: 'team-1',
    projectId: 'project-1',
    date: '2026-01-06',
    category: '外注費',
    amountMinor: 50_000,
    currency: 'JPY',
    receiptFileIds: [],
    status: 'approved',
    submittedByMemberId: 'pm-1',
    submittedAt: '2026-01-06T00:00:00.000Z',
    decision: { outcome: 'approved', decidedByMemberId: 'pm-2', decidedAt: '2026-01-06T01:00:00.000Z' },
    revision: 2,
    createdAt: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-06T01:00:00.000Z',
    ...overrides,
  }
}

describe('createProjectBudgetReport', () => {
  test('adds approved expenses in the budget currency to the actual cost and reports the rest apart', () => {
    const report = createProjectBudgetReport(input({
      expenses: [
        expense({ id: 'approved' }),
        expense({ id: 'usd', currency: 'USD', amountMinor: 1_000 }),
        expense({ id: 'pending', status: 'submitted', amountMinor: 7_000, revision: 1 }),
        expense({ id: 'rejected', status: 'rejected', amountMinor: 9_000, decision: { outcome: 'rejected', decidedByMemberId: 'pm-2', decidedAt: '2026-01-06T01:00:00.000Z' } }),
        expense({ id: 'later', date: '2026-01-08', amountMinor: 3_000 }),
        expense({ id: 'earlier', date: '2026-01-04', amountMinor: 4_000 }),
      ],
    }))

    expect(report.actualCostByCurrency).toEqual({ JPY: 12_000, USD: 500 })
    expect(report.approvedExpenseByCurrency).toEqual({ JPY: 50_000, USD: 1_000 })
    expect(report.pendingExpenseByCurrency).toEqual({ JPY: 7_000 })
    expect(report.budgetConsumedPercent).toBe(6.9)
    expect(report.earnedValue?.money?.actualCostMinor).toBe(62_000)
    expect(report.points.map((point) => point.actualCostMinor)).toEqual([12_000, 62_000, 62_000, undefined, undefined])
  })

  test('counts no expense before the report starts', () => {
    const report = createProjectBudgetReport(input({ today: '2026-01-01', expenses: [expense({ date: '2026-01-05' })] }))

    expect(report.approvedExpenseByCurrency).toEqual({})
    expect(report.pendingExpenseByCurrency).toEqual({})
  })

  test('calculates earned value in minutes and in the budget currency', () => {
    const report = createProjectBudgetReport(input())

    expect(report.asOf).toBe('2026-01-07')
    expect(report.baseline).toEqual({
      id: 'baseline-1',
      name: '承認済み計画',
      capturedAt: '2026-01-01T00:00:00.000Z',
      entryCount: 5,
      unscheduledEffortMinutes: 120,
      canceledEffortMinutes: 60,
    })
    expect(report.actualMinutes).toBe(330)
    expect(report.uncostedMinutes).toBe(180)
    expect(report.actualCostByCurrency).toEqual({ JPY: 12_000, USD: 500 })
    expect(report.budgetConsumedPercent).toBe(1.3)
    expect(report.effortConsumedPercent).toBe(32.4)
    expect(report.earnedValue).toEqual({
      budgetAtCompletionMinutes: 1020,
      plannedValueMinutes: 360,
      earnedValueMinutes: 420,
      actualMinutes: 330,
      scheduleVarianceMinutes: 60,
      costVarianceMinutes: 90,
      schedulePerformanceIndex: 1.167,
      costPerformanceIndex: 1.273,
      estimateAtCompletionMinutes: 801,
      estimateToCompleteMinutes: 471,
      varianceAtCompletionMinutes: 219,
      money: {
        currency: 'JPY',
        budgetAtCompletionMinor: 900_000,
        plannedValueMinor: 317_647,
        earnedValueMinor: 370_588,
        actualCostMinor: 12_000,
        scheduleVarianceMinor: 52_941,
        costVarianceMinor: 358_588,
        costPerformanceIndex: 30.882,
        estimateAtCompletionMinor: 29_143,
        estimateToCompleteMinor: 17_143,
        varianceAtCompletionMinor: 870_857,
      },
    })
  })

  test('builds a cumulative daily series without actuals after the as-of date', () => {
    const report = createProjectBudgetReport(input())

    expect(report.points).toEqual([
      { date: '2026-01-05', endDate: '2026-01-05', plannedValueMinutes: 120, plannedValueMinor: 105_882, actualMinutes: 120, actualCostMinor: 12_000 },
      { date: '2026-01-06', endDate: '2026-01-06', plannedValueMinutes: 240, plannedValueMinor: 211_765, actualMinutes: 330, actualCostMinor: 12_000 },
      { date: '2026-01-07', endDate: '2026-01-07', plannedValueMinutes: 360, plannedValueMinor: 317_647, actualMinutes: 330, actualCostMinor: 12_000 },
      { date: '2026-01-08', endDate: '2026-01-08', plannedValueMinutes: 480, plannedValueMinor: 423_529 },
      { date: '2026-01-09', endDate: '2026-01-09', plannedValueMinutes: 600, plannedValueMinor: 529_412 },
    ])
  })

  test('groups points into Monday-based weeks clipped to the range', () => {
    const report = createProjectBudgetReport(input({ from: '2026-01-01', to: '2026-01-14', interval: 'week', today: '2026-01-20' }))

    expect(report.asOf).toBe('2026-01-14')
    expect(report.points.map((point) => [point.date, point.endDate, point.plannedValueMinutes, point.actualMinutes])).toEqual([
      ['2026-01-01', '2026-01-04', 0, 60],
      ['2026-01-05', '2026-01-11', 600, 450],
      ['2026-01-12', '2026-01-14', 900, 450],
    ])
  })

  test('omits money without a budget and earned value without a baseline', () => {
    const withoutBudget = createProjectBudgetReport(input({ budget: null }))
    expect(withoutBudget.earnedValue?.money).toBeUndefined()
    expect(withoutBudget.budgetConsumedPercent).toBeUndefined()
    expect(withoutBudget.points[0]).toEqual({ date: '2026-01-05', endDate: '2026-01-05', plannedValueMinutes: 120, actualMinutes: 120 })

    const withoutBaseline = createProjectBudgetReport(input({ baseline: null }))
    expect(withoutBaseline.baseline).toBeNull()
    expect(withoutBaseline.earnedValue).toBeNull()
    expect(withoutBaseline.effortConsumedPercent).toBeUndefined()
    expect(withoutBaseline.budgetConsumedPercent).toBe(1.3)
  })

  test('leaves out indices whose divisor is zero and reports nothing before the start', () => {
    const report = createProjectBudgetReport(input({ today: '2026-01-01', entries: [] }))

    expect(report.asOf).toBe('2026-01-05')
    expect(report.actualMinutes).toBe(0)
    expect(report.points.every((point) => point.actualMinutes === undefined)).toBe(true)
    expect(report.earnedValue?.costPerformanceIndex).toBeUndefined()
    expect(report.earnedValue?.estimateAtCompletionMinutes).toBeUndefined()
    expect(report.earnedValue?.money?.costPerformanceIndex).toBeUndefined()
  })

  test('reports a CPI of 0 when time is logged but nothing is earned, without estimates', () => {
    const report = createProjectBudgetReport(input({ workItems: new Map() }))

    expect(report.earnedValue?.earnedValueMinutes).toBe(0)
    expect(report.earnedValue?.costPerformanceIndex).toBe(0)
    expect(report.earnedValue?.estimateAtCompletionMinutes).toBeUndefined()
    expect(report.earnedValue?.estimateToCompleteMinutes).toBeUndefined()
    expect(report.earnedValue?.money?.costPerformanceIndex).toBe(0)
    expect(report.earnedValue?.money?.estimateAtCompletionMinor).toBeUndefined()
  })

  test('ends the series on the last valid date without stepping past it', () => {
    const report = createProjectBudgetReport(input({ from: '9999-12-30', to: '9999-12-31', today: '2026-01-07' }))

    expect(report.points.map((point) => point.date)).toEqual(['9999-12-30', '9999-12-31'])
  })

  test('ends a weekly series on the last valid date without stepping past it', () => {
    const report = createProjectBudgetReport(input({ from: '9999-12-30', to: '9999-12-31', today: '2026-01-07', interval: 'week' }))

    expect(report.points.map((point) => point.date)).toEqual(['9999-12-30'])
  })
})
