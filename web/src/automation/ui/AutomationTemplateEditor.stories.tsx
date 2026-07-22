import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationTemplateEditor } from './AutomationEditors'

/** Typed AutomationTemplateEditor の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Template Editor',
  component: AutomationTemplateEditor,
  parameters: { layout: 'padded' },
  args: {
    initialKind: 'project',
    locale: 'en',
    onCreate: async () => undefined,
  },
} satisfies Meta<typeof AutomationTemplateEditor>

export default meta

/** AutomationTemplateEditor stories の型です。 */
type Story = StoryObj<typeof meta>

/** Localized names と tone を typed fields で入力する Project template です。 */
export const ProjectTemplate: Story = {}

/** Status rail と transition matrix を直接編集する Workflow template です。 */
export const WorkflowTemplate: Story = {
  args: {
    initialKind: 'workflow',
    locale: 'ja',
  },
}
