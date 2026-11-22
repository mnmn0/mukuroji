import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
  type RunningTimer,
  type TeamWeeklyReportMemberStatus,
  type TeamWeeklySummaryResponse,
  type TimeEntry,
  type TimeSheet,
  type WeeklyReportResponse,
  type WeeklyReportSubmission,
} from '@mukuroji/contracts'

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
  canManageTeam: true,
}

/**
 * Creates a fixture Work Item owned by the fixture member.
 *
 * @param overrides - Fields that differ from the default open, unscheduled item.
 * @returns Canonical Work Item.
 */
export function createWorkItemFixture(
  overrides: Partial<CanonicalWorkItem> & Pick<CanonicalWorkItem, 'id' | 'title'>,
): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    teamId: 'core-team',
    assignedProjectId: 'refero',
    assigneeUserId: 'aoi@example.com',
    creatorMemberKey: 'aoi@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    dueDate: '',
    schedule: createDefaultUnscheduledWorkItemSchedule(),
    priority: 'medium',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    source: 'dynamodb',
    ...overrides,
  }
}

/** The fixture member's Work Items in the fixture week, one for each weekly report section. */
export const weeklyReportFixtureWorkItems: CanonicalWorkItem[] = [
  createWorkItemFixture({
    id: 'onboarding',
    key: 'CORE-12',
    title: 'Reduce onboarding friction',
    workflowStatusId: 'done',
    statusCategory: 'completed',
    dueDate: '2026-11-12',
    schedule: createDefaultDueDateWorkItemSchedule('2026-11-12'),
    actualStartDate: '2026-11-04',
    actualEndDate: '2026-11-11',
  }),
  createWorkItemFixture({
    id: 'pricing',
    key: 'CORE-15',
    title: 'Update the pricing page',
    workflowStatusId: 'active',
    statusCategory: 'started',
    dueDate: '2026-11-20',
    schedule: createDefaultDueDateWorkItemSchedule('2026-11-20'),
    actualStartDate: '2026-11-10',
  }),
  createWorkItemFixture({
    id: 'invoice',
    key: 'CORE-9',
    title: 'Fix invoice rounding',
    dueDate: '2026-11-06',
    schedule: createDefaultDueDateWorkItemSchedule('2026-11-06'),
  }),
  createWorkItemFixture({
    id: 'survey',
    key: 'CORE-21',
    title: 'Send the customer survey',
    dueDate: '2026-11-18',
    schedule: createDefaultDueDateWorkItemSchedule('2026-11-18'),
  }),
]

/** A submitted weekly report as a manager who cannot view the invoice task reads it. */
export const weeklyReportFixtureSubmission: WeeklyReportSubmission = {
  version: 1,
  submittedAt: '2026-11-13T08:30:00.000Z',
  weekStart: timeTrackingFixtureWeekStart,
  weekEnd: '2026-11-15',
  sections: {
    completed: [{ hidden: false, workItemId: 'onboarding', key: 'CORE-12', title: 'Reduce onboarding friction', plannedEndDate: '2026-11-12', minutes: 150 }],
    started: [{ hidden: false, workItemId: 'pricing', key: 'CORE-15', title: 'Update the pricing page', plannedEndDate: '2026-11-20', minutes: 60 }],
    overdue: [{ hidden: true, minutes: 0 }],
    upcoming: [{ hidden: false, workItemId: 'survey', key: 'CORE-21', title: 'Send the customer survey', plannedEndDate: '2026-11-18', minutes: 0 }],
  },
  time: [
    { hidden: false, workItemId: 'onboarding', key: 'CORE-12', title: 'Reduce onboarding friction', minutes: 150 },
    { hidden: false, workItemId: 'pricing', key: 'CORE-15', title: 'Update the pricing page', minutes: 60 },
    { hidden: true, minutes: 30 },
  ],
  indirectTime: [{ category: 'meeting', minutes: 45 }],
  totalMinutes: 285,
  timeIsPartial: false,
  notes: { issues: 'Waiting for the pricing review.', reflection: 'Onboarding shipped on time.' },
}

/** The member's saved notes and first submission of the fixture week. */
export const weeklyReportFixtureSaved: WeeklyReportResponse = {
  teamId: 'core-team',
  memberKey: 'demo@example.com',
  weekStart: timeTrackingFixtureWeekStart,
  submissionCount: 1,
  draft: { revision: 2, updatedAt: '2026-11-13T08:30:00.000Z', notes: weeklyReportFixtureSubmission.notes },
  submission: weeklyReportFixtureSubmission,
}

/** Submission state of the Team members for the fixture week. */
export const teamWeeklyReportFixtureMembers: TeamWeeklyReportMemberStatus[] = [
  { memberKey: 'demo@example.com', submissionCount: 1, lastSubmittedAt: '2026-11-13T08:30:00.000Z' },
  { memberKey: 'sato@example.com', submissionCount: 0 },
]

/** Weekly summary of the fixture week: one Project with a baseline, one without, and Team-level Work Items. */
export const teamWeeklySummaryFixture: TeamWeeklySummaryResponse = {
  teamId: 'core-team',
  weekStart: timeTrackingFixtureWeekStart,
  weekEnd: '2026-11-15',
  generatedAt: '2026-11-13T03:00:00.000Z',
  totals: { completed: 3, delayed: 1, overdue: 2, milestonesReached: 1 },
  scopes: [
    {
      projectId: 'refero',
      baseline: { revision: 2, capturedAt: '2026-11-01T00:00:00.000Z' },
      completed: {
        count: 2,
        items: [
          { workItemId: 'onboarding', key: 'REF-1', title: 'Onboarding checklist', plannedEndDate: '2026-11-10', actualEndDate: '2026-11-10' },
          { workItemId: 'beta-release', key: 'REF-4', title: 'Beta release', plannedEndDate: '2026-11-12', actualEndDate: '2026-11-12' },
        ],
      },
      delayed: {
        count: 1,
        items: [{ workItemId: 'billing', key: 'REF-2', title: 'Billing export', plannedEndDate: '2026-11-20', baselineEndDate: '2026-11-14', delayDays: 6 }],
      },
      overdue: {
        count: 1,
        items: [{ workItemId: 'review', key: 'REF-3', title: 'Security review', plannedEndDate: '2026-11-11' }],
      },
      milestonesReached: {
        count: 1,
        items: [{ workItemId: 'beta-release', key: 'REF-4', title: 'Beta release', plannedEndDate: '2026-11-12', actualEndDate: '2026-11-12' }],
      },
    },
    {
      projectId: 'mobile',
      baseline: null,
      completed: { count: 0, items: [] },
      delayed: { count: 0, items: [] },
      overdue: { count: 1, items: [{ workItemId: 'push', title: 'Push notifications', plannedEndDate: '2026-11-12' }] },
      milestonesReached: { count: 0, items: [] },
    },
    {
      completed: { count: 1, items: [{ workItemId: 'retro', title: 'Team retrospective', actualEndDate: '2026-11-13' }] },
      delayed: { count: 0, items: [] },
      overdue: { count: 0, items: [] },
      milestonesReached: { count: 0, items: [] },
    },
  ],
}

/** Project names of {@link teamWeeklySummaryFixture}. */
export const teamWeeklySummaryFixtureProjectNames: Readonly<Record<string, string>> = { refero: 'Refero', mobile: 'Mobile app' }
