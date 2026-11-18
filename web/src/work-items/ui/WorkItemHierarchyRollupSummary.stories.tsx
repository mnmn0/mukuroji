import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkItemHierarchyRollupSummary } from './WorkItemHierarchyRollupSummary'

/** Metadata of the hierarchy roll-up summary stories. */
const meta = {
  title: 'Application/Work Items/Hierarchy Roll-up Summary',
  component: WorkItemHierarchyRollupSummary,
  decorators: [(Story) => <div className="w-96 bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    labels: {
      summary: '子 Work Item の集計',
      closed: '完了 {closed}/{total}',
      estimate: '見積 {hours} 時間',
      span: '{start} 〜 {end}',
    },
    rollup: {
      childCount: 3,
      descendantCount: 5,
      statusCategoryCounts: { backlog: 0, unstarted: 1, started: 1, completed: 3, canceled: 0 },
      openDescendantCount: 2,
      plannedEffortMinutes: 1_440,
      estimatedDescendantCount: 4,
      remainingEffortMinutes: 360,
      startDate: '2026-12-01',
      endDate: '2026-12-20',
    },
  },
} satisfies Meta<typeof WorkItemHierarchyRollupSummary>

export default meta
/** Typed roll-up summary story. */
type Story = StoryObj<typeof meta>

/** Parent with estimated, scheduled descendants. */
export const Scheduled: Story = {}

/** Parent whose descendants have no estimate or dates. */
export const Unscheduled: Story = {
  args: {
    rollup: {
      childCount: 2,
      descendantCount: 2,
      statusCategoryCounts: { backlog: 2, unstarted: 0, started: 0, completed: 0, canceled: 0 },
      openDescendantCount: 2,
      plannedEffortMinutes: 0,
      estimatedDescendantCount: 0,
      remainingEffortMinutes: 0,
    },
  },
}
