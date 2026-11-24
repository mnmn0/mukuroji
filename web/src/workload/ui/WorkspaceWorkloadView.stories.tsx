import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkspaceWorkloadCell, WorkspaceWorkloadSnapshot } from '@mukuroji/contracts'
import { fn } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceWorkloadView } from './WorkspaceWorkloadView'

/** Two Teams: one member is over only when both Teams count, and part of the load is hidden. */
const snapshot: WorkspaceWorkloadSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-05',
  granularity: 'day',
  teams: [{ teamId: 'team-core', name: 'Core' }, { teamId: 'team-mobile', name: 'Mobile' }],
  members: [
    {
      memberId: 'hana',
      displayName: 'Hanako Sato',
      teamIds: ['team-core', 'team-mobile'],
      capacityMinutes: 1440,
      allocatedMinutes: 1560,
      overloaded: true,
      cells: [
        createCell('2026-08-03', 480, 600, 'over', [['team-core', 300], ['team-mobile', 180]], 120),
        createCell('2026-08-04', 480, 480, 'balanced', [['team-core', 240], ['team-mobile', 240]], 0),
        createCell('2026-08-05', 480, 480, 'balanced', [['team-core', 480]], 0),
      ],
    },
    {
      memberId: 'mike',
      displayName: 'Mike Chen',
      teamIds: ['team-core'],
      capacityMinutes: 960,
      allocatedMinutes: 540,
      overloaded: false,
      cells: [
        createCell('2026-08-03', 480, 300, 'under', [['team-core', 300]], 0),
        createCell('2026-08-04', 480, 240, 'under', [['team-core', 240]], 0),
        createCell('2026-08-05', 0, 0, 'unavailable', [], 0),
      ],
    },
  ],
  generatedAt: '2026-08-02T00:00:00.000Z',
}

/**
 * Builds one day of the fixture heatmap.
 *
 * @param date - Local date of the cell.
 * @param capacityMinutes - Capacity of the day.
 * @param allocatedMinutes - Allocation across every Team.
 * @param status - Status of the day.
 * @param teams - Visible minutes per Team.
 * @param hiddenAllocatedMinutes - Allocation the viewer may not break down.
 * @returns The cell.
 */
function createCell(
  date: string,
  capacityMinutes: number,
  allocatedMinutes: number,
  status: WorkspaceWorkloadCell['status'],
  teams: ReadonlyArray<readonly [string, number]>,
  hiddenAllocatedMinutes: number,
): WorkspaceWorkloadCell {
  return {
    fromDate: date,
    toDate: date,
    label: date,
    capacityMinutes,
    allocatedMinutes,
    utilizationPercent: capacityMinutes === 0 ? 0 : Math.round(allocatedMinutes / capacityMinutes * 100),
    varianceMinutes: capacityMinutes - allocatedMinutes,
    status,
    teams: teams.map(([teamId, minutes]) => ({ teamId, allocatedMinutes: minutes })),
    projects: teams.map(([teamId, minutes]) => ({ teamId, allocatedMinutes: minutes })),
    hiddenAllocatedMinutes,
  }
}

/** Metadata of the workload across Teams stories. */
const meta = {
  title: 'Workload/WorkspaceWorkloadView',
  component: WorkspaceWorkloadView,
  parameters: { layout: 'fullscreen' },
  args: {
    failed: false,
    granularity: 'day',
    isLoading: false,
    onGranularityChange: fn(),
    onRetry: fn(),
    snapshot,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof WorkspaceWorkloadView>

export default meta
/** Story object type for the workload across Teams stories. */
type Story = StoryObj<typeof meta>

/** Daily totals across Teams with each visible Team's share and the hidden remainder. */
export const DayHeatmap: Story = {}

/** While the workload loads. */
export const Loading: Story = { args: { isLoading: true, snapshot: undefined } }

/** A failed load with the retry action. */
export const LoadError: Story = { args: { failed: true, snapshot: undefined } }

/** No member the viewer may see has a profile. */
export const Empty: Story = { args: { snapshot: { ...snapshot, members: [] } } }
