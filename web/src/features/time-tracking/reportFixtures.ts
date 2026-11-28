import type { ProjectBudgetReport, ProjectExpense, TimeTrackingSummary } from '@mukuroji/contracts'

/** Report period of the report fixtures: the fixture week. */
export const timeReportFixtureRange = { from: '2026-11-09', to: '2026-11-15' } as const

/** Project names referenced by the report fixtures. */
export const timeReportFixtureProjects = [
  { id: 'refero', name: 'Refero' },
  { id: 'atlas', name: 'Atlas' },
] as const

/** Report grouped by member, as a Team manager receives it with costs. */
export const timeReportFixtureManagerSummary: TimeTrackingSummary = {
  from: '2026-11-08T15:00:00.000Z',
  to: '2026-11-15T15:00:00.000Z',
  timeZone: 'Asia/Tokyo',
  groupBy: 'user',
  groups: [
    { key: 'aoi@example.com', label: 'aoi@example.com', minutes: 750, billableMinutes: 600, entryCount: 5, estimateMinutes: 900, actualCostByCurrency: { JPY: 75_000 }, actualCostMinor: 75_000 },
    { key: 'ren@example.com', label: 'ren@example.com', minutes: 420, billableMinutes: 0, entryCount: 3, actualCostByCurrency: { JPY: 35_000 }, actualCostMinor: 35_000 },
  ],
  totalMinutes: 1_170,
  totalBillableMinutes: 600,
  totalEstimateMinutes: 900,
  totalActualCostByCurrency: { JPY: 110_000 },
  totalActualCostMinor: 110_000,
  costsRedacted: false,
  canManageTeam: true,
}

/** The same period as a member without cost access receives it: only their own time. */
export const timeReportFixtureMemberSummary: TimeTrackingSummary = {
  from: timeReportFixtureManagerSummary.from,
  to: timeReportFixtureManagerSummary.to,
  timeZone: 'Asia/Tokyo',
  groupBy: 'user',
  groups: [
    { key: 'aoi@example.com', label: 'aoi@example.com', minutes: 750, billableMinutes: 600, entryCount: 5, estimateMinutes: 900 },
  ],
  totalMinutes: 750,
  totalBillableMinutes: 600,
  totalEstimateMinutes: 900,
  costsRedacted: true,
  canManageTeam: false,
}

/** Project-grouped report carrying the Team budget, for the budget panel. */
export const timeReportFixtureBudgetSummary: TimeTrackingSummary = {
  ...timeReportFixtureManagerSummary,
  groupBy: 'project',
  groups: [
    { key: 'atlas', label: 'atlas', minutes: 420, billableMinutes: 0, entryCount: 3, actualCostByCurrency: { JPY: 35_000 }, actualCostMinor: 35_000 },
    { key: 'refero', label: 'refero', minutes: 750, billableMinutes: 600, entryCount: 5, actualCostByCurrency: { JPY: 75_000 }, actualCostMinor: 75_000 },
  ],
  budget: {
    schemaVersion: 1,
    workspaceId: 'workspace-demo',
    teamId: 'core-team',
    scopeType: 'team',
    scopeId: 'core-team',
    amountMinor: 500_000,
    currency: 'JPY',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-30',
    revision: 2,
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
}

/**
 * Team budget report of November whose period has its own budget, next to the scope's other
 * budget per period.
 */
export const timeReportFixturePeriodBudgetSummary: TimeTrackingSummary = {
  ...timeReportFixtureBudgetSummary,
  budget: {
    schemaVersion: 1,
    workspaceId: 'workspace-demo',
    teamId: 'core-team',
    scopeType: 'team',
    scopeId: 'core-team',
    amountMinor: 300_000,
    currency: 'JPY',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-30',
    periodBudget: true,
    revision: 1,
    updatedAt: '2026-11-02T00:00:00.000Z',
  },
  budgetPeriods: [
    {
      schemaVersion: 1,
      workspaceId: 'workspace-demo',
      teamId: 'core-team',
      scopeType: 'team',
      scopeId: 'core-team',
      amountMinor: 300_000,
      currency: 'JPY',
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
      periodBudget: true,
      revision: 1,
      updatedAt: '2026-11-02T00:00:00.000Z',
    },
    {
      schemaVersion: 1,
      workspaceId: 'workspace-demo',
      teamId: 'core-team',
      scopeType: 'team',
      scopeId: 'core-team',
      amountMinor: 450_000,
      currency: 'JPY',
      periodFrom: '2026-12-01',
      periodTo: '2026-12-31',
      periodBudget: true,
      revision: 3,
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  ],
}

/** Project budget report of Atlas: a JPY budget, an active baseline, and a slipping schedule. */
export const projectBudgetReportFixture: ProjectBudgetReport = {
  teamId: 'core-team',
  projectId: 'atlas',
  from: '2026-11-02',
  to: '2026-11-29',
  timeZone: 'Asia/Tokyo',
  interval: 'day',
  asOf: '2026-11-18',
  budget: {
    schemaVersion: 1,
    workspaceId: 'workspace-demo',
    teamId: 'core-team',
    scopeType: 'project',
    scopeId: 'atlas',
    amountMinor: 1_200_000,
    currency: 'JPY',
    periodFrom: '2026-11-02',
    periodTo: '2026-11-29',
    revision: 2,
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  baseline: {
    id: 'baseline-1',
    name: '承認済み計画',
    capturedAt: '2026-11-01T00:00:00.000Z',
    entryCount: 8,
    unscheduledEffortMinutes: 240,
    canceledEffortMinutes: 0,
  },
  actualMinutes: 4_800,
  uncostedMinutes: 120,
  actualCostByCurrency: { JPY: 468_000 },
  approvedExpenseByCurrency: {},
  pendingExpenseByCurrency: {},
  budgetConsumedPercent: 39,
  effortConsumedPercent: 40,
  earnedValue: {
    budgetAtCompletionMinutes: 12_000,
    plannedValueMinutes: 6_000,
    earnedValueMinutes: 4_320,
    actualMinutes: 4_800,
    scheduleVarianceMinutes: -1_680,
    costVarianceMinutes: -480,
    schedulePerformanceIndex: 0.72,
    costPerformanceIndex: 0.9,
    estimateAtCompletionMinutes: 13_333,
    estimateToCompleteMinutes: 8_533,
    varianceAtCompletionMinutes: -1_333,
    money: {
      currency: 'JPY',
      budgetAtCompletionMinor: 1_200_000,
      plannedValueMinor: 600_000,
      earnedValueMinor: 432_000,
      actualCostMinor: 468_000,
      scheduleVarianceMinor: -168_000,
      costVarianceMinor: -36_000,
      costPerformanceIndex: 0.923,
      estimateAtCompletionMinor: 1_300_000,
      estimateToCompleteMinor: 832_000,
      varianceAtCompletionMinor: -100_000,
    },
  },
  points: Array.from({ length: 28 }, (_, index) => {
    const date = `2026-11-${String(index + 2).padStart(2, '0')}`
    const planned = Math.round((12_000 - 240) * Math.min(1, (index + 1) / 26))
    return {
      date,
      endDate: date,
      plannedValueMinutes: planned,
      plannedValueMinor: Math.round(planned * 100),
      ...(date <= '2026-11-18' ? { actualMinutes: Math.round(4_800 * (index + 1) / 17), actualCostMinor: Math.round(468_000 * (index + 1) / 17) } : {}),
    }
  }),
}

/** Expenses of the Atlas Project used by stories: approved, waiting on another manager, and rejected. */
export const projectExpensesFixture: ProjectExpense[] = [
  {
    id: 'expense-3',
    teamId: 'core-team',
    projectId: 'atlas',
    date: '2026-11-20',
    category: 'ライセンス',
    amountMinor: 24_000,
    currency: 'JPY',
    description: 'デザインツール 3 席',
    receiptFileIds: ['file-3'],
    status: 'submitted',
    submittedByMemberId: 'aoi@example.com',
    submittedAt: '2026-11-20T01:00:00.000Z',
    revision: 1,
    createdAt: '2026-11-20T01:00:00.000Z',
    updatedAt: '2026-11-20T01:00:00.000Z',
  },
  {
    id: 'expense-2',
    teamId: 'core-team',
    projectId: 'atlas',
    date: '2026-11-12',
    category: '外注費',
    amountMinor: 300_000,
    currency: 'JPY',
    receiptFileIds: ['file-1', 'file-2'],
    status: 'approved',
    submittedByMemberId: 'ren@example.com',
    submittedAt: '2026-11-12T01:00:00.000Z',
    decision: { outcome: 'approved', decidedByMemberId: 'aoi@example.com', decidedAt: '2026-11-13T01:00:00.000Z' },
    revision: 2,
    createdAt: '2026-11-12T01:00:00.000Z',
    updatedAt: '2026-11-13T01:00:00.000Z',
  },
  {
    id: 'expense-1',
    teamId: 'core-team',
    projectId: 'atlas',
    date: '2026-11-05',
    category: '交通費',
    amountMinor: 8_400,
    currency: 'JPY',
    receiptFileIds: [],
    status: 'rejected',
    submittedByMemberId: 'ren@example.com',
    submittedAt: '2026-11-05T01:00:00.000Z',
    decision: { outcome: 'rejected', decidedByMemberId: 'aoi@example.com', decidedAt: '2026-11-06T01:00:00.000Z', note: '証憑を添付してください' },
    revision: 2,
    createdAt: '2026-11-05T01:00:00.000Z',
    updatedAt: '2026-11-06T01:00:00.000Z',
  },
]

/** The same period grouped by investment category (ADR 0116), with unclassified time. */
export const timeReportFixtureInvestmentSummary: TimeTrackingSummary = {
  ...timeReportFixtureManagerSummary,
  groupBy: 'investment',
  groups: [
    { key: 'new-development', label: 'new-development', minutes: 600, billableMinutes: 600, entryCount: 4, actualCostByCurrency: { JPY: 60_000 }, actualCostMinor: 60_000 },
    { key: 'operations', label: 'operations', minutes: 480, billableMinutes: 0, entryCount: 3, actualCostByCurrency: { JPY: 40_000 }, actualCostMinor: 40_000 },
    { key: 'unclassified', label: 'Unclassified', minutes: 90, billableMinutes: 0, entryCount: 1, actualCostByCurrency: { JPY: 10_000 }, actualCostMinor: 10_000 },
  ],
}
