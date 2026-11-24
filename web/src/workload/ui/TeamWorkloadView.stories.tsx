import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { TeamWorkloadView } from './TeamWorkloadView'

const snapshot: WorkloadSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-14',
  granularity: 'day',
  members: [
    createMember('hana', 'Hanako Sato', [
      createCell('2026-08-03', 480, 360, 'under', { tentativeAllocatedMinutes: 120 }),
      createCell('2026-08-04', 480, 480, 'balanced', { pendingTimeOffMinutes: 240 }),
      createCell('2026-08-05', 480, 600, 'over'),
      createCell('2026-08-06', 0, 0, 'unavailable'),
    ]),
    createMember('mike', 'Mike Chen', [
      createCell('2026-08-03', 480, 240, 'under'),
      createCell('2026-08-04', 480, 300, 'under'),
      createCell('2026-08-05', 480, 480, 'balanced'),
      createCell('2026-08-06', 480, 420, 'under'),
    ]),
  ],
  requests: [],
  assignments: [
    createAssignment('assignment-1', 'hana', 'WI-12', 'tentative'),
    createAssignment('assignment-2', 'hana', 'WI-18', 'confirmed'),
  ],
  redactedAssignmentCount: 2,
  redactedRequestCount: 0,
  revision: 4,
  generatedAt: '2026-08-02T00:00:00.000Z',
  viewer: { memberId: 'mike', canManage: true },
}

const meta = {
  title: 'Workload/TeamWorkloadView',
  component: TeamWorkloadView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TeamWorkloadView>

export default meta
/** Story object type for the Team workload view stories. */
type Story = StoryObj<typeof meta>

/** Displays the day-level workload heatmap with mixed utilization states. */
export const DayHeatmap: Story = {
  render: (args) => <TeamWorkloadView {...args} />,
  args: {
    granularity: 'day',
    isLoading: false,
    onGranularityChange: () => undefined,
    onRetry: () => undefined,
    snapshot,
    t: createTranslator('en'),
  },
}

/** Shows tentative and confirmed assignments with the manager's confirm and cancel actions. */
export const AssignmentReview: Story = {
  ...DayHeatmap,
  args: {
    ...DayHeatmap.args,
    onChangeAssignmentStatus: () => undefined,
    onMoveAssignment: () => undefined,
  },
}

/** Displays the empty state shown before a member schedule is configured. */
export const Empty: Story = {
  ...DayHeatmap,
  args: {
    ...DayHeatmap.args,
    snapshot: { ...snapshot, members: [], redactedAssignmentCount: 0 },
  },
}

/**
 * A member who inherits a Workspace calendar in another time zone shows the effective time zone,
 * not the one stored on the profile.
 */
export const InheritedWorkspaceTimeZone: Story = {
  ...DayHeatmap,
  args: {
    ...DayHeatmap.args,
    snapshot: {
      ...snapshot,
      members: snapshot.members.map((member, index) => index === 0
        ? { ...member, calendarSource: 'workspace', effectiveTimeZone: 'America/New_York' }
        : { ...member, calendarSource: 'custom', effectiveTimeZone: member.timeZone }),
    },
  },
}

/**
 * A member under capacity in this Team but over it once another Team's work is added: the cell is
 * marked over, the row carries the cross-Team badge, and the header links to the cross-Team view.
 */
export const OverAcrossTeams: Story = {
  render: (args) => <MemoryRouter><TeamWorkloadView {...args} /></MemoryRouter>,
  args: {
    ...DayHeatmap.args,
    crossTeamPath: '/workload',
    snapshot: {
      ...snapshot,
      members: snapshot.members.map((member, index) => index === 1
        ? {
          ...member,
          workspaceOverloaded: true,
          cells: member.cells.map((cell, cellIndex) => ({
            ...cell,
            workspaceCapacityMinutes: cell.capacityMinutes,
            workspaceAllocatedMinutes: cellIndex === 1 ? cell.allocatedMinutes + 300 : cell.allocatedMinutes,
            workspaceStatus: cellIndex === 1 ? 'over' : cell.status,
          })),
        }
        : member),
    },
  },
}

/** Creates one member row from the supplied daily cells. */
function createMember(memberId: string, displayName: string, cells: WorkloadSnapshot['members'][number]['cells']) {
  return {
    memberId,
    displayName,
    skills: [],
    timeZone: 'Asia/Tokyo',
    schedule: {
      monday: { enabled: true, minutes: 480 },
      tuesday: { enabled: true, minutes: 480 },
      wednesday: { enabled: true, minutes: 480 },
      thursday: { enabled: true, minutes: 480 },
      friday: { enabled: true, minutes: 480 },
      saturday: { enabled: false, minutes: 0 },
      sunday: { enabled: false, minutes: 0 },
    },
    holidays: [],
    profileRevision: 1,
    timeOff: [],
    cells,
    capacityMinutes: cells.reduce((sum, cell) => sum + cell.capacityMinutes, 0),
    allocatedMinutes: cells.reduce((sum, cell) => sum + cell.allocatedMinutes, 0),
    plannedEffortMinutes: cells.reduce((sum, cell) => sum + cell.plannedEffortMinutes, 0),
    actualMinutes: cells.reduce((sum, cell) => sum + cell.actualMinutes, 0),
    remainingEffortMinutes: cells.reduce((sum, cell) => sum + cell.remainingEffortMinutes, 0),
    overloaded: cells.some((cell) => cell.status === 'over'),
  }
}

/** Creates a deterministic sample workload cell for Storybook. */
function createCell(
  date: string,
  capacityMinutes: number,
  allocatedMinutes: number,
  status: 'under' | 'balanced' | 'over' | 'unavailable',
  extra: { pendingTimeOffMinutes?: number; tentativeAllocatedMinutes?: number } = {},
) {
  return {
    fromDate: date,
    toDate: date,
    label: date,
    capacityMinutes,
    pendingTimeOffMinutes: extra.pendingTimeOffMinutes ?? 0,
    allocatedMinutes,
    tentativeAllocatedMinutes: extra.tentativeAllocatedMinutes ?? 0,
    plannedEffortMinutes: allocatedMinutes,
    actualMinutes: 120,
    remainingEffortMinutes: Math.max(0, allocatedMinutes - 120),
    utilizationPercent: capacityMinutes === 0 ? 0 : Math.round((allocatedMinutes / capacityMinutes) * 100),
    varianceMinutes: capacityMinutes - allocatedMinutes,
    status,
  }
}

/** Creates a deterministic sample assignment on the first sample day. */
function createAssignment(
  id: string,
  memberId: string,
  workItemId: string,
  status: 'tentative' | 'confirmed',
): WorkloadSnapshot['assignments'][number] {
  return {
    id,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    memberId,
    workItemId,
    skillIds: [],
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    allocationMinutes: 120,
    plannedEffortMinutes: 120,
    confidential: false,
    status,
    revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}
