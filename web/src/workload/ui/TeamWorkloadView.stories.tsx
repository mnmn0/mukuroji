import type { Meta, StoryObj } from '@storybook/react-vite'
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
      createCell('2026-08-03', 480, 360, 'under'),
      createCell('2026-08-04', 480, 480, 'balanced'),
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
  assignments: [],
  redactedAssignmentCount: 2,
  redactedRequestCount: 0,
  revision: 4,
  generatedAt: '2026-08-02T00:00:00.000Z',
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

/** Displays the empty state shown before a member schedule is configured. */
export const Empty: Story = {
  ...DayHeatmap,
  args: {
    ...DayHeatmap.args,
    snapshot: { ...snapshot, members: [], redactedAssignmentCount: 0 },
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
) {
  return {
    fromDate: date,
    toDate: date,
    label: date,
    capacityMinutes,
    allocatedMinutes,
    plannedEffortMinutes: allocatedMinutes,
    actualMinutes: 120,
    remainingEffortMinutes: Math.max(0, allocatedMinutes - 120),
    utilizationPercent: capacityMinutes === 0 ? 0 : Math.round((allocatedMinutes / capacityMinutes) * 100),
    varianceMinutes: capacityMinutes - allocatedMinutes,
    status,
  }
}
