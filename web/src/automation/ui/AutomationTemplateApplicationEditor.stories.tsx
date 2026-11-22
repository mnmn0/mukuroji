import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationTemplateApplicationEditor } from './AutomationManagementPanel'
import {
  projectAutomationTemplateFixture,
  projectPlannedAutomationTemplateFixture,
  projectPlannedTemplatePreviewFixture,
  projectPlannedTemplatePreviewWithErrorsFixture,
  projectTemplateApplicationFixture,
  projectWbsAutomationTemplateFixture,
  projectWbsTemplateApplicationFixture,
  workflowAutomationTemplateFixture,
  workflowTemplateApplicationFixture,
} from '../fixtures'

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

/** WBS 付き template の適用前の form で、開始日の入力と作る Work Item 数を表示します。 */
export const ProjectWithWbs: Story = {
  args: {
    initialApplication: undefined,
    template: projectWbsAutomationTemplateFixture,
    onApply: async () => projectWbsTemplateApplicationFixture,
    onRefresh: async () => projectWbsTemplateApplicationFixture,
  },
}

/** WBS の Work Item 数を含む Project の成功 receipt です。 */
export const ProjectWithWbsSucceeded: Story = {
  args: {
    initialApplication: projectWbsTemplateApplicationFixture,
    template: projectWbsAutomationTemplateFixture,
    onApply: async () => projectWbsTemplateApplicationFixture,
    onRefresh: async () => projectWbsTemplateApplicationFixture,
  },
}

/** Phase / Milestone と依存を持つ template の適用前 preview で、作成内容と日付を表示します。 */
export const ProjectWithPlanningPreview: Story = {
  args: {
    initialApplication: undefined,
    initialPreview: projectPlannedTemplatePreviewFixture,
    template: projectPlannedAutomationTemplateFixture,
    planningParents: {
      parents: [{ id: 'roadmap-2027', title: 'Roadmap 2027', type: 'roadmap' }],
      isLoading: false,
      failed: false,
      onRetry: () => undefined,
    },
    onPreview: async () => projectPlannedTemplatePreviewFixture,
  },
}

/** Preview が検証エラーを返し、適用できない状態です。 */
export const ProjectWithPlanningPreviewErrors: Story = {
  args: {
    initialApplication: undefined,
    initialPreview: projectPlannedTemplatePreviewWithErrorsFixture,
    template: projectPlannedAutomationTemplateFixture,
    planningParents: {
      parents: [{ id: 'roadmap-2027', title: 'Roadmap 2027', type: 'roadmap' }],
      isLoading: false,
      failed: false,
      onRetry: () => undefined,
    },
    onPreview: async () => projectPlannedTemplatePreviewWithErrorsFixture,
  },
}

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
