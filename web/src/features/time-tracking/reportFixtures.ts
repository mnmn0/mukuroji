import type { TimeTrackingSummary } from '@mukuroji/contracts'

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
