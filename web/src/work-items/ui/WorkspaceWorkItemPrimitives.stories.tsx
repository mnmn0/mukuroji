import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CanonicalWorkItem } from '../../tasks/api'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../fixtures'
import {
  CompactTaskCard,
  PriorityPill,
  StatusPill,
  TaskListRow,
} from './WorkspaceWorkItemPrimitives'

const t = createTranslator('ja')
const storyTask = {
  ...referoTaskFixtures[0],
  workflowStatusId: 'active',
} satisfies CanonicalWorkItem

const workflowStatuses = teamWorkItemConfigurationFixture.workflow.statuses

const meta = {
  args: {
    configuration: teamWorkItemConfigurationFixture,
    onOpenTask: () => undefined,
    t,
    task: storyTask,
  },
  component: TaskListRow,
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-white">
          <Story />
        </div>
      </main>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
  title: 'Application/Work Items/Workspace Primitives',
} satisfies Meta<typeof TaskListRow>

/** Storybook metadata for Workspace Work Item display primitives. */
export default meta

/** Story type for Workspace Work Item display primitives. */
type Story = StoryObj<typeof meta>

/** Standard actionable Work Item row with resolved status and assignee labels. */
export const TaskListRowDefault: Story = {}

/** Work Item row without an open action, rendered in its disabled state. */
export const TaskListRowDisabled: Story = {
  args: {
    onOpenTask: undefined,
  },
}

/** Standard compact Work Item card with status movement controls. */
export const CompactTaskCardDefault: Story = {
  render: () => (
    <div className="p-5">
      <CompactTaskCard
        configuration={teamWorkItemConfigurationFixture}
        draggable
        onOpenTask={() => undefined}
        onStatusChange={() => undefined}
        t={t}
        task={storyTask}
        workflowStatuses={workflowStatuses}
      />
    </div>
  ),
}

/** Compact Work Item card while a native drag interaction is active. */
export const CompactTaskCardDragging: Story = {
  render: () => (
    <div className="p-5">
      <CompactTaskCard
        configuration={teamWorkItemConfigurationFixture}
        draggable
        isDragging
        onOpenTask={() => undefined}
        onStatusChange={() => undefined}
        t={t}
        task={storyTask}
        workflowStatuses={workflowStatuses}
      />
    </div>
  ),
}

/** Compact Work Item card while its workflow status update is pending. */
export const CompactTaskCardUpdating: Story = {
  render: () => (
    <div className="p-5">
      <CompactTaskCard
        configuration={teamWorkItemConfigurationFixture}
        draggable
        isMoving
        onOpenTask={() => undefined}
        onStatusChange={() => undefined}
        t={t}
        task={storyTask}
        workflowStatuses={workflowStatuses}
      />
    </div>
  ),
}

/** Standard workflow status pill resolved from the Team configuration. */
export const StatusPillDefault: Story = {
  render: () => (
    <div className="p-5">
      <StatusPill
        configuration={teamWorkItemConfigurationFixture}
        task={storyTask}
      />
    </div>
  ),
}

/** Standard priority pills for each canonical Work Item priority. */
export const PriorityPillDefault: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-5">
      <PriorityPill priority="high" t={t} />
      <PriorityPill priority="medium" t={t} />
      <PriorityPill priority="low" t={t} />
    </div>
  ),
}

/** Work Item primitives when configuration loading has not resolved a status label. */
export const ConfigurationUnavailable: Story = {
  args: {
    configuration: undefined,
  },
  render: (args) => (
    <div className="grid gap-5 p-5">
      <TaskListRow {...args} />
      <div className="max-w-sm">
        <CompactTaskCard
          onOpenTask={() => undefined}
          t={t}
          task={storyTask}
        />
      </div>
      <StatusPill task={storyTask} />
    </div>
  ),
}
