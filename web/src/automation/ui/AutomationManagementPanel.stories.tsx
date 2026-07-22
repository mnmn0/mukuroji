import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationManagementPanel } from './AutomationManagementPanel'
import {
  activeAutomationRuleFixture,
  activeInboundWebhookEndpointFixture,
  deadLetterAutomationExecutionFixture,
  dstRecurringWorkFixture,
  pausedAutomationRuleFixture,
  pausedInboundWebhookEndpointFixture,
  provisioningInboundWebhookEndpointFixture,
  projectAutomationTemplateFixture,
  projectTemplateApplicationFixture,
  revokedInboundWebhookEndpointFixture,
  inboundWebhookSecretResponseFixture,
  workflowAutomationTemplateFixture,
  workflowTemplateApplicationFixture,
  workItemAutomationTemplateFixture,
} from '../fixtures'

/** AutomationManagementPanel の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Management Panel',
  component: AutomationManagementPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    executions: [],
    locale: 'ja',
    recurringWork: [],
    rules: [activeAutomationRuleFixture, pausedAutomationRuleFixture],
    teams: [
      { id: 'core-team', name: 'Core team' },
      { id: 'design-team', name: 'Design team' },
    ],
    templates: [
      workItemAutomationTemplateFixture,
      projectAutomationTemplateFixture,
      workflowAutomationTemplateFixture,
    ],
    webhooks: [
      provisioningInboundWebhookEndpointFixture,
      activeInboundWebhookEndpointFixture,
      pausedInboundWebhookEndpointFixture,
      revokedInboundWebhookEndpointFixture,
    ],
    workflowTargets: [
      {
        expectedRevision: 7,
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
    onApplyTemplate: async (template) => template.kind === 'workflow'
      ? workflowTemplateApplicationFixture
      : projectTemplateApplicationFixture,
    onCreateRecurringWork: async () => undefined,
    onCreateRule: async () => undefined,
    onCreateWebhook: async () => inboundWebhookSecretResponseFixture,
    onCreateTemplate: async () => undefined,
    onDuplicateTemplate: async () => undefined,
    onRefresh: async () => undefined,
    onPauseWebhook: async () => undefined,
    onResumeWebhook: async () => undefined,
    onRevokeWebhook: async () => undefined,
    onRetryExecution: async () => undefined,
    onRotateWebhook: async () => inboundWebhookSecretResponseFixture,
    onToggleRecurringWork: async () => undefined,
    onToggleRule: async () => undefined,
    onToggleTemplate: async () => undefined,
    onUpdateTemplate: async () => undefined,
    onRefreshTemplateApplication: async (applicationId) =>
      applicationId === workflowTemplateApplicationFixture.id
        ? workflowTemplateApplicationFixture
        : projectTemplateApplicationFixture,
  },
} satisfies Meta<typeof AutomationManagementPanel>

export default meta

/** AutomationManagementPanel stories の型です。 */
type Story = StoryObj<typeof meta>

/** Active と paused の rule を並べる標準状態です。 */
export const ActiveAndPausedRules: Story = {}

/** Endpoint URL、lifecycle controls、一回限り secret 発行導線を表示します。 */
export const InboundWebhooks: Story = {
  args: {
    initialTab: 'webhooks',
    locale: 'en',
  },
}

/** Typed Project/Workflow editor と application target を表示します。 */
export const TypedTemplateManagement: Story = {
  args: {
    initialTab: 'templates',
  },
}

/** America/New_York の DST 境界を表示する recurring Work 状態です。 */
export const DaylightSavingSchedule: Story = {
  args: {
    initialTab: 'recurring',
    recurringWork: [dstRecurringWorkFixture],
  },
}

/** Dead-letter の失敗理由と action result、retry を表示する状態です。 */
export const DeadLetterError: Story = {
  args: {
    errorMessage: 'One execution needs an administrator review.',
    executions: [deadLetterAutomationExecutionFixture],
    initialTab: 'runs',
    locale: 'en',
  },
}

/** Mutation controls を表示しない参照専用状態です。 */
export const ReadOnly: Story = {
  args: {
    canViewWebhooks: false,
    readOnly: true,
  },
}

/** Automation API の loading state です。 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
}
