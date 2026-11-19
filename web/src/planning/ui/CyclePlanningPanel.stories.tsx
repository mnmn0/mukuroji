import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  createDefaultDueDateWorkItemSchedule,
  type PlanningSnapshot,
  type PlanningWorkItemSummary,
} from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../fixtures'
import { CyclePlanningPanel } from './CyclePlanningPanel'
import { createPlanningLabels } from './labels'

const labels = createPlanningLabels('ja').cyclePlanning

/**
 * Adds open backlog Work Items, automation, a next Cycle and a carried-over link to the fixture.
 *
 * @returns A snapshot whose active Cycle exercises every part of the panel.
 */
function createCycleSnapshot(): PlanningSnapshot {
  const backlog = Array.from({ length: 22 }, (_, index) => ({
    id: `backlog-${index}`,
    revision: 1,
    teamId: 'core-team',
    title: `バックログ ${index + 1}`,
    projectId: 'refero',
    statusCategory: 'unstarted' as const,
    dueDate: '2026-07-30',
    schedule: createDefaultDueDateWorkItemSchedule('2026-07-30'),
  }))
  return {
    ...planningSnapshotFixture,
    entities: planningSnapshotFixture.entities.map((entity) => entity.id === 'cycle-14'
      ? { ...entity, automation: { createNext: true, rolloverAtEnd: true }, nextCycleId: 'cycle-15' }
      : entity),
    workItemLinks: planningSnapshotFixture.workItemLinks.map((link, index) => index === 0
      ? { ...link, carriedOverFromCycleId: 'cycle-13', carriedOverAt: '2026-07-13T00:00:00.000Z' }
      : link),
    workItems: [...planningSnapshotFixture.workItems, ...backlog],
  }
}

const snapshot = createCycleSnapshot()

const meta = {
  title: 'Application/Planning/CyclePlanningPanel',
  component: CyclePlanningPanel,
  args: {
    snapshot,
    labels,
    canManageEntity: (): boolean => true,
    canLinkEntity: (): boolean => true,
    canUpdateWorkItemLink: (workItem: PlanningWorkItemSummary): boolean => workItem.id !== '',
    onCreateNextCycle: () => undefined,
    onUpdateCycleAutomation: () => undefined,
    onSetCycleWorkItems: () => undefined,
  },
} satisfies Meta<typeof CyclePlanningPanel>

export default meta

type Story = StoryObj<typeof meta>

/** A manager sees the automation, the next Cycle, and bulk add and remove. */
export const Manager: Story = {}

/** A Cycle without a next Cycle offers "Create next cycle". */
export const WithoutNextCycle: Story = {
  args: {
    snapshot: {
      ...snapshot,
      entities: snapshot.entities.map((entity) => {
        if (entity.id !== 'cycle-14') return entity
        const withoutNext = { ...entity, automation: { createNext: false, rolloverAtEnd: false } }
        delete withoutNext.nextCycleId
        return withoutNext
      }),
    },
  },
}

/** A member can change links but not automation, and Work Items they cannot update are locked. */
export const MemberWithLockedItems: Story = {
  args: {
    canManageEntity: () => false,
    // One Work Item in the Cycle and a few in the backlog belong to a Project the member only reads.
    canUpdateWorkItemLink: (workItem) =>
      workItem.title !== 'Instrument activation events' && !workItem.id.endsWith('1'),
    onCreateNextCycle: undefined,
    onUpdateCycleAutomation: undefined,
  },
}

/** A viewer only reads the commitment and the lists. */
export const ReadOnly: Story = {
  args: {
    canManageEntity: () => false,
    canLinkEntity: () => false,
    canUpdateWorkItemLink: () => false,
    onCreateNextCycle: undefined,
    onUpdateCycleAutomation: undefined,
    onSetCycleWorkItems: undefined,
  },
}
