import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationTemplateApplicationEditor } from './AutomationManagementPanel'
import {
  projectAutomationTemplateFixture,
  projectTemplateApplicationFixture,
  workflowAutomationTemplateFixture,
  workflowTemplateApplicationFixture,
} from './fixtures'

/** Durable template application editor の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Template Application',
  component: AutomationTemplateApplicationEditor,
  parameters: { layout: 'padded' },
  args: {
    initialApplication: projectTemplateApplicationFixture,
    locale: 'en',
    teams: [
      { id: 'core-team', name: 'Core team' },
      { id: 'design-team', name: 'Design team' },
    ],
    template: projectAutomationTemplateFixture,
    workflowTargets: [],
    onApply: async () => projectTemplateApplicationFixture,
    onRefresh: async () => projectTemplateApplicationFixture,
  },
} satisfies Meta<typeof AutomationTemplateApplicationEditor>

export default meta

/** AutomationTemplateApplicationEditor stories の型です。 */
type Story = StoryObj<typeof meta>

/** Immutable version と作成済み Project ID を含む成功 receipt です。 */
export const ProjectSucceeded: Story = {}

/** 継承 Team target と optimistic revision を表示する Workflow receipt です。 */
export const WorkflowSucceeded: Story = {
  args: {
    initialApplication: workflowTemplateApplicationFixture,
    template: workflowAutomationTemplateFixture,
    teams: [],
    workflowTargets: [
      {
        expectedRevision: 9,
        name: 'Workspace',
        scopeId: 'workspace-demo',
        scopeType: 'workspace',
      },
      {
        expectedRevision: 0,
        inheritedFrom: 'workspace',
        name: 'Core team',
        scopeId: 'core-team',
        scopeType: 'team',
      },
    ],
    onApply: async () => workflowTemplateApplicationFixture,
    onRefresh: async () => workflowTemplateApplicationFixture,
  },
}
