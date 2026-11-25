import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkloadTimeOffList } from './WorkloadTimeOffList'

const schedule = {
  monday: { enabled: true, minutes: 480 },
  tuesday: { enabled: true, minutes: 480 },
  wednesday: { enabled: true, minutes: 480 },
  thursday: { enabled: true, minutes: 480 },
  friday: { enabled: true, minutes: 480 },
  saturday: { enabled: false, minutes: 0 },
  sunday: { enabled: false, minutes: 0 },
}

const snapshot: WorkloadSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-14',
  granularity: 'day',
  members: [
    {
      memberId: 'hana',
      displayName: 'Hanako Sato',
      skills: [],
      timeZone: 'Asia/Tokyo',
      schedule,
      holidays: [],
      profileRevision: 3,
      timeOff: [
        { id: 'pto-1', fromDate: '2026-08-05', toDate: '2026-08-06', reason: 'Family trip', status: 'planned', revision: 1 },
        { id: 'pto-2', fromDate: '2026-08-12', toDate: '2026-08-12', minutesPerDay: 240, status: 'approved', reviewedBy: 'mike', revision: 2 },
      ],
      cells: [],
      capacityMinutes: 0,
      allocatedMinutes: 0,
      plannedEffortMinutes: 0,
      actualMinutes: 0,
      remainingEffortMinutes: 0,
      overloaded: false,
    },
  ],
  requests: [],
  assignments: [],
  redactedAssignmentCount: 0,
  redactedRequestCount: 0,
  revision: 4,
  generatedAt: '2026-08-02T00:00:00.000Z',
  viewer: { memberId: 'mike', canManage: true },
}

const meta = {
  title: 'Workload/WorkloadTimeOffList',
  component: WorkloadTimeOffList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof WorkloadTimeOffList>

export default meta
/** Story object type for the time-off review list stories. */
type Story = StoryObj<typeof meta>

/** A Team manager sees approve and reject actions on pending time off. */
export const Manager: Story = {
  args: {
    isSaving: false,
    memberNames: new Map([['hana', 'Hanako Sato'], ['mike', 'Mike Chen']]),
    onReview: () => undefined,
    snapshot,
    t: createTranslator('ja'),
  },
}

/** The member sees their own time off and may withdraw it, without review actions. */
export const Member: Story = {
  args: {
    ...Manager.args,
    snapshot: { ...snapshot, viewer: { memberId: 'hana', canManage: false } },
  },
}
