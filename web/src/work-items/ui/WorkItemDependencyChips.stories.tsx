import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkItemDependencySummary } from '../model/workItemDependencies'
import { WorkItemDependencyChips } from './WorkItemDependencyChips'

const t = createTranslator('ja')

const emptySummary = {
  blockedByCount: 0,
  blocksCount: 0,
  conflictCount: 0,
  critical: false,
  endpoint: { teamId: 'core-team', workItemId: 'wireframe' },
  requiredShiftDays: 0,
} satisfies WorkItemDependencySummary

/** Storybook metadata for compact Work Item dependency signals. */
const meta = {
  title: 'Application/Work Items/Schedule Dependency Chips',
  component: WorkItemDependencyChips,
  args: {
    summary: emptySummary,
    t,
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <section className="workbench-panel mx-auto max-w-xl p-5">
          <Story />
        </section>
      </main>
    ),
  ],
} satisfies Meta<typeof WorkItemDependencyChips>

export default meta

/** Story type for one compact dependency signal. */
type Story = StoryObj<typeof meta>

/** Work Item constrained by an unresolved predecessor. */
export const BlockedBy: Story = {
  args: { summary: { ...emptySummary, blockedByCount: 2 } },
}

/** Work Item driving downstream schedules. */
export const Blocks: Story = {
  args: { summary: { ...emptySummary, blocksCount: 3 } },
}

/** Work Item whose current dependency conflict requires a positive shift. */
export const Delayed: Story = {
  args: { summary: { ...emptySummary, requiredShiftDays: 4 } },
}

/** Work Item involved in one unresolved schedule conflict. */
export const Conflict: Story = {
  args: { summary: { ...emptySummary, conflictCount: 1 } },
}

/** Work Item on the authoritative critical path. */
export const CriticalPath: Story = {
  args: { summary: { ...emptySummary, critical: true } },
}
