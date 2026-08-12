import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskActionFeedback } from './TaskActionFeedback'

const t = createTranslator('ja')

/** Storybook metadata for the shared task action feedback banner. */
const meta = {
  title: 'Application/Projects/Task Action Feedback',
  component: TaskActionFeedback,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] py-6">
        <Story />
      </main>
    ),
  ],
  args: {
    dismissLabel: t('tasks.action.dismiss'),
    onDismiss: fn(),
  },
} satisfies Meta<typeof TaskActionFeedback>

export default meta

/** Story type for the shared task action feedback banner. */
type Story = StoryObj<typeof meta>

/** Displays a successful action without an undo affordance. */
export const Success: Story = {
  args: {
    kind: 'success',
    message: t('tasks.action.saved'),
  },
}

/** Displays a successful action with an undo affordance. */
export const SuccessWithUndo: Story = {
  args: {
    kind: 'success',
    message: t('tasks.action.saved'),
    onUndo: fn(),
    undoLabel: t('tasks.action.undo'),
  },
}

/** Displays an error without an undo affordance. */
export const Error: Story = {
  args: {
    kind: 'error',
    message: t('tasks.action.updateError'),
  },
}

/** Displays an error with an undo affordance. */
export const ErrorWithUndo: Story = {
  args: {
    kind: 'error',
    message: t('tasks.action.conflict'),
    onUndo: fn(),
    undoLabel: t('tasks.action.undo'),
  },
}
