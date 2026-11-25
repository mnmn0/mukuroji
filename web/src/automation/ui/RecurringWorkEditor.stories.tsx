import type { Meta, StoryObj } from '@storybook/react-vite'
import { RecurringWorkEditor } from './AutomationEditors'
import { workItemAutomationTemplateFixture } from '../fixtures'

/** RecurringWorkEditor の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Recurring Work Editor',
  component: RecurringWorkEditor,
  parameters: { layout: 'padded' },
  args: {
    locale: 'ja',
    onCreate: async () => undefined,
    teams: [{ id: 'core-team', name: 'Core Team' }],
    templates: [workItemAutomationTemplateFixture],
  },
} satisfies Meta<typeof RecurringWorkEditor>

export default meta

/** RecurringWorkEditor stories の型です。 */
type Story = StoryObj<typeof meta>

/** Choose 毎月 to pick a set date, the last day, or the nth business day of the Team calendar. */
export const MonthlyDayChoices: Story = {}

/** English labels for the same editor. */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
