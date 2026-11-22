import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanningEntity } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../fixtures'
import { collectPlanningOwnerCandidates } from '../model/entityEditor'
import { PlanningEntityEditor } from './PlanningEntityEditor'
import { createPlanningLabels } from './labels'

const labels = createPlanningLabels('ja').entityEditor

/**
 * Returns a fixture entity by ID.
 *
 * @param id - Planning entity ID in the shared fixture.
 * @returns The fixture entity.
 */
function fixtureEntity(id: string): PlanningEntity {
  const entity = planningSnapshotFixture.entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Planning fixture ${id} is missing.`)
  return entity
}

const meta = {
  title: 'Application/Planning/EntityEditor',
  component: PlanningEntityEditor,
  args: {
    entity: fixtureEntity('phase-build'),
    labels,
    ownerCandidates: collectPlanningOwnerCandidates(planningSnapshotFixture.entities),
    onSave: () => undefined,
  },
} satisfies Meta<typeof PlanningEntityEditor>

export default meta

type Story = StoryObj<typeof meta>

/** A Phase with a date range and manual progress. */
export const Phase: Story = {}

/** A Milestone, whose baseline and forecast are single days. */
export const Milestone: Story = {
  args: { entity: fixtureEntity('milestone-beta') },
}

/** A Goal the current user can only read. */
export const ReadOnlyGoal: Story = {
  args: { entity: fixtureEntity('goal-activation'), onSave: undefined },
}

/** A Cycle, which also edits its cadence, capacity and carry-over policy. */
export const Cycle: Story = {
  args: { entity: fixtureEntity('cycle-14'), cycleWorkItemCount: 2 },
}
