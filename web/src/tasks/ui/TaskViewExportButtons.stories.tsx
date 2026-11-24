import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskViewExportButtons } from './TaskViewExportButtons'

/**
 * Storybook metadata for the export buttons of a task view.
 */
const meta = {
  title: 'Application/Tasks/View Export Buttons',
  component: TaskViewExportButtons,
  parameters: {
    layout: 'padded',
  },
  args: {
    createTable: () => ({
      columns: ['Title', 'Status'],
      rows: [['Design review', 'In progress']],
    }),
    fileBaseName: 'mukuroji',
    testId: 'task-view-export',
    t: createTranslator('ja'),
  },
} satisfies Meta<typeof TaskViewExportButtons>

export default meta

/** Story type for the task-view export buttons. */
type Story = StoryObj<typeof meta>

/** Displays the CSV and Excel export buttons. */
export const Default: Story = {}
