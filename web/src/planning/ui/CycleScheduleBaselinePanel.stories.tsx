import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CycleScheduleBaselineResponse, PlanningSnapshot } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../fixtures'
import { CycleScheduleBaselinePanel } from './CycleScheduleBaselinePanel'
import { createPlanningLabels } from './labels'

const labels = createPlanningLabels('ja').cycleBaseline

/** Snapshot whose Cycle lost one Work Item and gained another since the baseline. */
const snapshot: PlanningSnapshot = {
  ...planningSnapshotFixture,
  workItemLinks: [
    ...planningSnapshotFixture.workItemLinks.filter((link) => link.workItemId !== 'journey-events'),
    { teamId: 'core-team', workItemId: 'late-add', projectId: 'refero', cycleId: 'cycle-14', goalIds: [], createdAt: '2026-07-14T00:00:00.000Z' },
  ],
  workItems: [
    ...planningSnapshotFixture.workItems,
    { ...planningSnapshotFixture.workItems[0]!, id: 'late-add', title: '途中で追加した作業' },
  ],
}

const cycle = snapshot.entities.find((entity) => entity.type === 'cycle') ?? snapshot.entities[0]!

/** Two saved baselines; the newest is shown. */
const response: CycleScheduleBaselineResponse = {
  cycleId: cycle.id,
  revision: 2,
  baseline: {
    id: 'cb-2',
    name: 'Sprint 開始時',
    capturedAt: '2026-07-12T00:00:00.000Z',
    entryCount: 3,
    entries: [
      { teamId: 'core-team', workItemId: 'journey-copy', endDate: '2026-07-19' },
      { teamId: 'core-team', workItemId: 'journey-events', endDate: '2026-07-25' },
    ],
  },
  savedBaselines: [
    { id: 'cb-2', name: 'Sprint 開始時', capturedAt: '2026-07-12T00:00:00.000Z', entryCount: 3 },
    { id: 'cb-1', capturedAt: '2026-07-10T09:00:00.000Z', entryCount: 2 },
  ],
}

const meta = {
  title: 'Application/Planning/CycleScheduleBaselinePanel',
  component: CycleScheduleBaselinePanel,
  args: {
    canCapture: true,
    captureFailed: false,
    cycle,
    hasError: false,
    isCapturing: false,
    isLoading: false,
    labels,
    response,
    snapshot,
    onCapture: async () => true,
    onRetry: () => undefined,
    onSelect: () => undefined,
  },
} satisfies Meta<typeof CycleScheduleBaselinePanel>

export default meta

/** Story variants for the Cycle schedule baseline panel. */
type Story = StoryObj<typeof meta>

/** A Cycle manager sees the comparison and can save another baseline. */
export const Manager: Story = {}

/** A viewer only reads the comparison. */
export const Viewer: Story = { args: { canCapture: false } }

/** No baseline has been saved yet. */
export const Empty: Story = {
  args: { response: { cycleId: cycle.id, revision: 0, baseline: null, savedBaselines: [] } },
}

/** The baseline could not be loaded. */
export const LoadError: Story = { args: { response: undefined, hasError: true } }
