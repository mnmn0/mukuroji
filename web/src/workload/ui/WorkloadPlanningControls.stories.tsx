import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkloadMemberSummary, WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkloadPlanningControls } from './WorkloadPlanningControls'

const snapshot: WorkloadSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-14',
  granularity: 'day',
  members: [],
  requests: [],
  assignments: [],
  redactedAssignmentCount: 0,
  redactedRequestCount: 0,
  revision: 4,
  generatedAt: '2026-08-02T00:00:00.000Z',
}

const meta = {
  title: 'Workload/WorkloadPlanningControls',
  component: WorkloadPlanningControls,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkloadPlanningControls>

export default meta
/** Story object type for the workload planning controls stories. */
type Story = StoryObj<typeof meta>

/** Displays the profile, absence, request, assignment, and what-if forms. */
export const Default: Story = {
  args: {
    accessToken: 'storybook-access-token',
    members: [
      { id: 'hana', name: 'Hanako Sato', email: 'hana@example.com' },
      { id: 'mike', name: 'Mike Chen', email: 'mike@example.com' },
    ],
    onSaved: () => undefined,
    projects: [
      { id: 'project-1', name: 'Customer onboarding' },
      { id: 'project-2', name: 'Internal platform' },
    ],
    snapshot,
    t: createTranslator('en'),
    teamId: 'team-1',
  },
}

/** Date and numeric inputs stay within the phone form width. */
export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/**
 * Builds a snapshot whose first member has a saved profile, so the profile form opens with it.
 *
 * @param member - Profile fields that differ between the inherited and custom stories.
 * @returns A workload snapshot containing one saved member profile.
 */
function snapshotWithSavedProfile(
  member: Pick<WorkloadMemberSummary, 'calendarSource' | 'timeZone' | 'effectiveTimeZone' | 'holidays'>,
): WorkloadSnapshot {
  return {
    ...snapshot,
    members: [{
      memberId: 'hana',
      displayName: 'Hanako Sato',
      skills: [],
      timeOff: [],
      ...member,
      schedule: {
        monday: { enabled: true, minutes: 360 },
        tuesday: { enabled: true, minutes: 360 },
        wednesday: { enabled: false, minutes: 360 },
        thursday: { enabled: true, minutes: 360 },
        friday: { enabled: true, minutes: 360 },
        saturday: { enabled: true, minutes: 360 },
        sunday: { enabled: true, minutes: 360 },
      },
      profileRevision: 3,
      cells: [],
      capacityMinutes: 0,
      allocatedMinutes: 0,
      plannedEffortMinutes: 0,
      actualMinutes: 0,
      remainingEffortMinutes: 0,
      overloaded: false,
    }],
  }
}

/**
 * A saved profile that inherits the Workspace calendar: the time zone field is hidden, holidays
 * read as personal days off, and Wednesday stays a personal non-working weekday.
 */
export const SavedInheritedProfile: Story = {
  args: {
    ...Default.args,
    snapshot: snapshotWithSavedProfile({
      calendarSource: 'workspace',
      timeZone: 'Asia/Tokyo',
      effectiveTimeZone: 'America/New_York',
      holidays: [{ date: '2026-08-12', label: 'Family event' }],
    }),
  },
}

/** A saved custom profile keeps its own time zone, holidays, and Wednesday off. */
export const SavedCustomProfile: Story = {
  args: {
    ...Default.args,
    snapshot: snapshotWithSavedProfile({
      calendarSource: 'custom',
      timeZone: 'Europe/London',
      effectiveTimeZone: 'Europe/London',
      holidays: [{ date: '2026-08-31', label: 'Summer bank holiday' }],
    }),
  },
}
