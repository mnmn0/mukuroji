import type { Meta, StoryObj } from '@storybook/react-vite'
import type {
  AiAssistanceGeneration,
  CreateCustomerRequestFromTriageInput,
  CustomerRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import type { AiAssistanceController } from '../../features/ai-assistance/mutations/useAiAssistanceController'
import { aiTriageGenerationFixture } from '../../features/ai-assistance/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  triageConfigurationFixture,
  triageEntryFixtures,
} from '../fixtures'
import {
  countTriageEntryViews,
  createTriageEntryView,
} from '../model/triageView'
import { TriageWorkbench, type TriageWorkbenchProps } from './TriageWorkbench'

const entryViews = triageEntryFixtures.map((entry) =>
  createTriageEntryView(entry, new Date('2026-08-09T01:30:00.000Z'))
)
const eligibleAssigneeIdsByProject = new Map([
  ['launch-readiness', new Set(['member-ada'])],
  ['launch-support', new Set(['member-ada'])],
])
const onAction = fn(async () => triageEntryFixtures[0] ?? Promise.reject(new Error('Missing fixture')))
const onBulkAction = fn(async () => [])
const onSaveConfiguration = fn(async () => triageConfigurationFixture)
const customerOptions = [
  { id: 'acme', name: 'Acme Corporation' },
  { id: 'globex', name: 'Globex Industries' },
]
const onCreateCustomerRequest = fn(async (
  _entryId: string,
  input: CreateCustomerRequestFromTriageInput,
): Promise<CustomerRequest> => ({
  createdAt: '2026-08-09T00:20:00.000Z',
  customerId: input.customerId,
  id: 'customer-request-1',
  importance: input.importance,
  originalMessage: 'Create a shared launch follow-up item.',
  projectLinks: [],
  receivedAt: '2026-08-08T23:40:00.000Z',
  revision: 1,
  schemaVersion: 1,
  source: { canNotify: false, kind: 'form' },
  status: 'requested',
  triageEntryId: 'triage-form-1',
  updatedAt: '2026-08-09T00:20:00.000Z',
  workItemLinks: [],
  workspaceId: 'workspace-demo',
}))
const onRetryCustomerOptions = fn()

const meta = {
  title: 'Application/Triage/Team Workbench',
  component: TriageWorkbench,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)]">
        <Story />
      </main>
    ),
  ],
  args: {
    allowedBulkActions: triageConfigurationFixture.allowedBulkActions,
    canManageConfiguration: true,
    configuration: triageConfigurationFixture,
    counts: countTriageEntryViews(entryViews),
    entries: entryViews,
    filters: { owner: 'all' },
    locale: 'en',
    onAction,
    onBackToQueue: fn(),
    onBulkAction,
    onClearSelection: fn(),
    onEntrySelectionChange: fn(),
    onFiltersChange: fn(),
    onSaveConfiguration,
    onSelectEntry: fn(),
    onViewChange: fn(),
    onVisibleSelectionChange: fn(),
    routeView: 'queue',
    selectedEntry: entryViews[0],
    selectedEntryIds: [],
    t: createTranslator('en'),
    teamId: 'core-team',
    teamName: 'Core team',
    visibleProjectIds: ['launch-readiness', 'launch-support'],
    eligibleAssigneeIdsByProject,
  },
} satisfies Meta<typeof TriageWorkbench>

/** Storybook metadata for the Team triage workbench. */
export default meta

/** Story type for the Team triage workbench. */
type Story = StoryObj<typeof meta>

/** Multi-source queue with unowned and SLA-breached entries. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const firstEntry = canvas.getByTestId('triage-entry-triage-chat-1')
    const nextEntry = canvas.getByTestId('triage-entry-triage-email-1')
    firstEntry.focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(nextEntry).toHaveFocus()

    const acceptButton = canvas.getByRole('button', { name: /Accept/ })
    acceptButton.focus()
    onAction.mockClear()
    await userEvent.keyboard('a')
    await expect(canvas.getByTestId('triage-action-accept')).toBeVisible()
    await expect(onAction).not.toHaveBeenCalled()
  },
}

/** Stable split-pane skeleton while the queue and detail load. */
export const Loading: Story = {
  args: {
    entries: [],
    isDetailLoading: true,
    isQueueLoading: true,
    selectedEntry: undefined,
  },
}

/** Queue empty state with no active filters. */
export const Empty: Story = {
  args: {
    counts: { breached: 0, pending: 0, unowned: 0 },
    entries: [],
    selectedEntry: undefined,
  },
}

/** Retryable queue and detail load failures. */
export const LoadError: Story = {
  args: {
    detailErrorMessage: 'The triage details could not be loaded.',
    entries: [],
    onRetryDetail: fn(),
    onRetryQueue: fn(),
    queueErrorMessage: 'The triage queue could not be loaded.',
    selectedEntry: undefined,
  },
}

/** Dedicated Team queue permission boundary. */
export const PermissionDenied: Story = {
  args: { isQueuePermissionDenied: true },
}

/** Source body, requester email, routing, and reply actions removed by metadata-only access. */
export const MetadataOnly: Story = {
  args: {
    explicitEntryId: 'triage-email-1',
    selectedEntry: entryViews[1],
  },
}

/** Editable routing, rotation, SLA, escalation, and retention configuration. */
export const Settings: Story = {
  args: { routeView: 'settings' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onSaveConfiguration.mockClear()
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Snooze' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Save settings' }))
    await expect(onSaveConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      allowedBulkActions: ['assign', 'decline'],
    }))
  },
}

/** Mobile queue drill-in shows one surface at a time. */
export const MobileDetail: Story = {
  args: { explicitEntryId: 'triage-chat-1' },
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

/** Accepted Triage Entry can be retained as a Customer Request with an explicit Customer. */
export const CustomerRequestAssociation: Story = {
  args: {
    customerOptions,
    explicitEntryId: 'triage-form-1',
    onCreateCustomerRequest,
    selectedEntry: entryViews[2],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Customer organization' }),
      'acme',
    )
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Importance signal' }),
      'high',
    )
    await userEvent.click(canvas.getByRole('button', { name: 'Save as Customer Request' }))
    await expect(onCreateCustomerRequest).toHaveBeenCalledWith('triage-form-1', {
      customerId: 'acme',
      expectedRevision: 4,
      importance: 'high',
    })
  },
}

/** Accepted Triage Entry keeps an explicit retry state when Customer options fail to load. */
export const CustomerRequestAssociationError: Story = {
  args: {
    customerOptionsErrorMessage: 'Customers could not be loaded.',
    explicitEntryId: 'triage-form-1',
    onCreateCustomerRequest,
    onRetryCustomerOptions,
    selectedEntry: entryViews[2],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onRetryCustomerOptions.mockClear()
    await expect(canvas.getByRole('alert')).toHaveTextContent('Customers could not be loaded.')
    await userEvent.click(canvas.getByRole('button', { name: 'Reload' }))
    await expect(onRetryCustomerOptions).toHaveBeenCalledTimes(1)
  },
}

const onAiTriageAction = fn(async () => triageEntryFixtures[0] ?? Promise.reject(new Error('Missing fixture')))
const onTeamTriageAiGenerate = fn(async (input: GenerateAiAssistanceRequest) => {
  void input
  return aiTriageGenerationFixture
})

/** Full-visibility flow where AI adoption only prefills the existing Assign form. */
export const AiDraftAdoption: Story = {
  args: {
    accessToken: 'storybook-access-token',
    onAction: onAiTriageAction,
  },
  render: (args) => <AiTriageWorkbenchStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onAiTriageAction.mockClear()
    onTeamTriageAiGenerate.mockClear()

    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await expect(onTeamTriageAiGenerate).toHaveBeenCalledWith({
      locale: 'en',
      source: {
        expectedRevision: 3,
        teamId: 'core-team',
        triageEntryId: 'triage-chat-1',
        type: 'triage-entry',
      },
      task: 'triage',
    })
    await expect(canvas.getByText('Unblock customer Workspace provisioning')).toBeVisible()
    await expect(onAiTriageAction).not.toHaveBeenCalled()

    await userEvent.click(canvas.getByRole('button', { name: 'Use in Accept / Assign form' }))
    await expect(canvas.getByRole('textbox', { name: 'Owner user ID' })).toHaveValue('member-ada')
    await expect(canvas.getByRole('textbox', { name: 'Project ID' })).toHaveValue('launch-readiness')
    await expect(onAiTriageAction).not.toHaveBeenCalled()

    await userEvent.click(canvas.getByRole('button', { name: 'Review and apply' }))
    await expect(onAiTriageAction).toHaveBeenCalledWith(
      'triage-chat-1',
      expect.objectContaining({
        action: 'assign',
        expectedRevision: 3,
        ownerUserId: 'member-ada',
        projectId: 'launch-readiness',
      }),
    )
  },
}

/** Confirms a dirty routing field before recording the AI approval decision. */
export const AiDraftRoutingReplacementConfirmation: Story = {
  args: {
    accessToken: 'storybook-access-token',
    onAction: onAiTriageAction,
  },
  render: (args) => <AiTriageWorkbenchStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: 'Change routing' }))
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Owner user ID' }))
    await userEvent.type(canvas.getByRole('textbox', { name: 'Owner user ID' }), 'member-manual')
    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Use in Accept / Assign form' }))

    await expect(canvas.getByRole('alert')).toHaveTextContent('Keep or replace your manual edits?')
    await userEvent.click(canvas.getByRole('button', { name: 'Keep manual edits' }))
    await expect(canvas.getByRole('textbox', { name: 'Owner user ID' })).toHaveValue('member-manual')
    await expect(canvas.getByRole('button', { name: 'Use in Accept / Assign form' })).toBeVisible()

    await userEvent.click(canvas.getByRole('button', { name: 'Use in Accept / Assign form' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with AI draft' }))
    await expect(canvas.getByRole('textbox', { name: 'Owner user ID' })).toHaveValue('member-ada')
  },
}

/** Phone-width full-visibility detail with the flat AI evidence rail. */
export const AiDraftMobileDetail: Story = {
  args: {
    accessToken: 'storybook-access-token',
    explicitEntryId: 'triage-chat-1',
    onAction: onAiTriageAction,
  },
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
  render: (args) => <AiTriageWorkbenchStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await expect(canvas.getByText('Unblock customer Workspace provisioning')).toBeVisible()
  },
}

/**
 * Supplies a stateful deterministic AI controller for Storybook without issuing Bedrock requests.
 *
 * @param props - Triage workbench story props passed to the rendered surface.
 * @returns A triage workbench wired to the in-memory generation controller.
 */
function AiTriageWorkbenchStory(props: TriageWorkbenchProps) {
  const [generation, setGeneration] = useState<AiAssistanceGeneration>()
  const controller: AiAssistanceController = {
    cancelGeneration: () => undefined,
    decide: async (outcome) => {
      if (!generation) return undefined
      const decidedGeneration: AiAssistanceGeneration = {
        ...generation,
        decision: { decidedAt: '2026-08-25T01:16:00.000Z', outcome },
        revision: generation.revision + 1,
      }
      setGeneration(decidedGeneration)
      return decidedGeneration
    },
    generate: async (input) => {
      const generated = await onTeamTriageAiGenerate(input)
      setGeneration(generated)
      return generated
    },
    generation,
    isDecisionPending: false,
    isFeedbackPending: false,
    isGenerating: false,
    reset: () => setGeneration(undefined),
    sendFeedback: async () => undefined,
  }

  return <TriageWorkbench {...props} aiAssistanceController={controller} />
}
