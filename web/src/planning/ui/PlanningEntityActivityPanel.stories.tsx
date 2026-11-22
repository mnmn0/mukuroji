import type { Meta, StoryObj } from '@storybook/react-vite'
import { planningEntityActivityFixture, planningSnapshotFixture } from '../fixtures'
import { createPlanningLabels } from './labels'
import { PlanningEntityActivityPanel } from './PlanningEntityActivityPanel'
import { PlanningEntityDetailTabs } from './PlanningEntityDetailTabs'

const labels = createPlanningLabels('ja')

/** Entity titles of the fixture snapshot, used to name referenced plans. */
const entityTitles = new Map(planningSnapshotFixture.entities.map((entity) => [entity.id, entity.title]))

/** Member names of the fixture, as the owner picker shows them. */
const memberNames = new Map([
  ['lead@example.com', '佐藤 リード (lead@example.com)'],
  ['owner@example.com', '田中 オーナー (owner@example.com)'],
])

const meta = {
  title: 'Application/Planning/EntityActivityPanel',
  component: PlanningEntityActivityPanel,
  args: {
    events: planningEntityActivityFixture,
    hasError: false,
    hasMore: true,
    isLoading: false,
    labels: labels.entityActivity,
    memberName: (memberKey: string) => memberNames.get(memberKey) ?? memberKey,
    referenceValue: (field: string, value: unknown) =>
      field === 'parentId' && typeof value === 'string' ? entityTitles.get(value) : undefined,
    onLoadMore: () => undefined,
    onRetry: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="max-w-[720px] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlanningEntityActivityPanel>

export default meta

type Story = StoryObj<typeof meta>

/** Moves, field changes, and creation, newest first, with a further page. */
export const Loaded: Story = {}

/** The first page is loading. */
export const Loading: Story = {
  args: { events: [], isLoading: true, hasMore: false },
}

/** The entity has no activity the caller can see. */
export const Empty: Story = {
  args: { events: [], hasMore: false },
}

/** The activity could not be loaded. */
export const LoadError: Story = {
  args: { events: [], hasError: true, hasMore: false },
}

/** The activity tab open under the selected entity. */
export const InDetailTabs: Story = {
  render: (args) => (
    <PlanningEntityDetailTabs
      defaultTab="activity"
      details={<p>編集欄</p>}
      labels={labels.entityDetailTabs}
      renderActivity={() => <PlanningEntityActivityPanel {...args} />}
    />
  ),
}
