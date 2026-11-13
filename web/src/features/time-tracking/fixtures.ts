import type { RunningTimer, TimeEntry, TimeEstimate, TimeSheet } from '@mukuroji/contracts'

/** Monday of the fixture week. */
export const timeTrackingFixtureWeekStart = '2026-11-09'

/** Current time used by fixtures: Tuesday of the fixture week. */
export const timeTrackingFixtureNow = new Date('2026-11-10T03:30:00.000Z')

/** Work Items referenced by the fixtures. */
export const timeTrackingFixtureWorkItems = [
  { id: 'onboarding', title: 'Reduce onboarding friction' },
  { id: 'pricing', title: 'Update the pricing page' },
] as const

/** Member names referenced by the fixtures. */
export const timeTrackingFixtureMemberNames: Readonly<Record<string, string>> = {
  'aoi@example.com': 'Aoi Tanaka',
  'ren@example.com': 'Ren Sato',
}

/**
 * Creates a fixture entry.
 *
 * @param overrides - Fields that differ from the default draft.
 * @returns Entry.
 */
export function createTimeEntryFixture(overrides: Partial<TimeEntry> & Pick<TimeEntry, 'id'>): TimeEntry {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-demo',
    teamId: 'core-team',
    projectId: 'refero',
    workItemId: 'onboarding',
    userId: 'aoi@example.com',
    startAt: '2026-11-09T00:00:00.000Z',
    endAt: '2026-11-09T01:30:00.000Z',
    durationMinutes: 90,
    billable: false,
    currency: 'USD',
    status: 'draft',
    source: 'manual',
    revision: 1,
    createdAt: '2026-11-09T01:30:00.000Z',
    updatedAt: '2026-11-09T01:30:00.000Z',
    ...overrides,
  }
}

/** A member's week with every lifecycle state. */
export const timeTrackingFixtureEntries: TimeEntry[] = [
  createTimeEntryFixture({ id: 'entry-draft', description: 'Interview notes' }),
  createTimeEntryFixture({
    id: 'entry-rejected',
    workItemId: 'pricing',
    startAt: '2026-11-10T00:00:00.000Z',
    endAt: '2026-11-10T02:00:00.000Z',
    durationMinutes: 120,
    status: 'rejected',
    billable: true,
    revision: 3,
  }),
  createTimeEntryFixture({
    id: 'entry-submitted',
    startAt: '2026-11-10T04:00:00.000Z',
    endAt: '2026-11-10T05:00:00.000Z',
    durationMinutes: 60,
    status: 'submitted',
    source: 'timer',
    revision: 2,
  }),
  createTimeEntryFixture({
    id: 'entry-approved',
    startAt: '2026-11-11T00:00:00.000Z',
    endAt: '2026-11-11T00:45:00.000Z',
    durationMinutes: 45,
    status: 'approved',
    revision: 3,
  }),
]

/** Team entries seen by a manager in the approval queue. */
export const timeTrackingFixtureTeamEntries: TimeEntry[] = [
  ...timeTrackingFixtureEntries,
  createTimeEntryFixture({
    id: 'entry-ren-submitted',
    userId: 'ren@example.com',
    workItemId: 'pricing',
    startAt: '2026-11-09T05:00:00.000Z',
    endAt: '2026-11-09T08:00:00.000Z',
    durationMinutes: 180,
    status: 'submitted',
    revision: 2,
    hourlyRateMinor: 9000,
    actualCostMinor: 27000,
  }),
  createTimeEntryFixture({
    id: 'entry-ren-locked',
    userId: 'ren@example.com',
    startAt: '2026-11-12T00:00:00.000Z',
    endAt: '2026-11-12T01:00:00.000Z',
    durationMinutes: 60,
    status: 'locked',
    revision: 4,
  }),
]

/** Rejection reasons of the fixture week. */
export const timeTrackingFixtureRejectionReasons: Readonly<Record<string, string>> = {
  'entry-rejected': 'Split the pricing work from the onboarding interview.',
}

/** A timer running on the onboarding Work Item. */
export const timeTrackingFixtureTimer: RunningTimer = {
  schemaVersion: 1,
  id: 'timer-1',
  workspaceId: 'workspace-demo',
  teamId: 'core-team',
  projectId: 'refero',
  workItemId: 'onboarding',
  userId: 'aoi@example.com',
  startedAt: '2026-11-10T02:45:00.000Z',
  billable: false,
  revision: 1,
  updatedAt: '2026-11-10T02:45:00.000Z',
}

/** Estimate of the onboarding Work Item. */
export const timeTrackingFixtureEstimate: TimeEstimate = {
  schemaVersion: 1,
  workspaceId: 'workspace-demo',
  teamId: 'core-team',
  workItemId: 'onboarding',
  estimateMinutes: 480,
  revision: 2,
  updatedBy: 'aoi@example.com',
  updatedAt: '2026-11-08T00:00:00.000Z',
}

/** Team totals of the fixture week as a manager sees them. */
export const timeTrackingFixtureTeamTimesheet: TimeSheet = {
  from: '2026-11-08T15:00:00.000Z',
  to: '2026-11-15T15:00:00.000Z',
  timeZone: 'Asia/Tokyo',
  days: [
    { key: '2026-11-09', label: '2026-11-09', minutes: 270, billableMinutes: 0, entryCount: 2 },
    { key: '2026-11-10', label: '2026-11-10', minutes: 180, billableMinutes: 120, entryCount: 2 },
    { key: '2026-11-11', label: '2026-11-11', minutes: 45, billableMinutes: 0, entryCount: 1 },
    { key: '2026-11-12', label: '2026-11-12', minutes: 60, billableMinutes: 0, entryCount: 1 },
  ],
  weeks: [{ key: '2026-11-09', label: '2026-11-09', minutes: 555, billableMinutes: 120, entryCount: 6 }],
  costsRedacted: false,
}
