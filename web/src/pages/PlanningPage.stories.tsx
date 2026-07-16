import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  emptyPlanningSnapshotFixture,
  planningSnapshotFixture,
} from '../planning/fixtures'
import { PlanningScreen } from '../planning/PlanningScreen'
import { createPlanningLabels } from '../planning/labels'

/**
 * PlanningScreen の Storybook meta です。
 */
const meta = {
  title: 'Application/Pages/PlanningPage',
  component: PlanningScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    activeView: 'timeline',
    labels: createPlanningLabels('ja'),
    snapshot: planningSnapshotFixture,
    onArchiveEntity: async () => undefined,
    onAddStatusUpdate: async () => undefined,
    onChangeMilestoneDate: async () => undefined,
    onCreateDependency: async () => undefined,
    onCreateEntity: async () => undefined,
    onDeleteDependency: async () => undefined,
    onDeleteWorkItemLink: async () => undefined,
    onDuplicateEntity: async () => undefined,
    onMoveEntity: async () => undefined,
    onOpenWorkItem: () => undefined,
    onRetry: () => undefined,
    onRolloverCycle: async () => undefined,
    onSaveWorkItemLink: async () => undefined,
    onViewChange: () => undefined,
  },
} satisfies Meta<typeof PlanningScreen>

export default meta

/**
 * PlanningScreen stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Milestone、dependency、cycle rollover を操作できる Timeline です。
 */
export const Timeline: Story = {}

/**
 * Goal から Work Item を辿れる Roadmap です。
 */
export const Roadmap: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'goal-activation',
  },
}

/**
 * 上位計画の roll-up を比較する Portfolio です。
 */
export const Portfolio: Story = {
  args: {
    activeView: 'portfolio',
  },
}

/**
 * Planning entity がまだない empty state です。
 */
export const Empty: Story = {
  args: {
    snapshot: emptyPlanningSnapshotFixture,
  },
}

/**
 * Planning snapshot の初回 loading state です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    snapshot: undefined,
  },
}

/**
 * Planning mutation の競合を表示する state です。
 */
export const Conflict: Story = {
  args: {
    errorMessage: '他のユーザーが計画を更新しました。再読み込みしてください。',
  },
}

/**
 * Entity mutation 権限がない Roadmap です。
 */
export const ReadOnly: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'goal-activation',
    onArchiveEntity: undefined,
    onAddStatusUpdate: undefined,
    onCreateEntity: undefined,
    onDeleteDependency: undefined,
    onDeleteWorkItemLink: undefined,
    onDuplicateEntity: undefined,
    onMoveEntity: undefined,
    onSaveWorkItemLink: undefined,
  },
}

/**
 * English locale の Planning workbench です。
 */
export const English: Story = {
  args: {
    labels: createPlanningLabels('en'),
  },
}
