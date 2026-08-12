import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  triageConfigurationFixture,
  triageEntryFixtures,
} from '../fixtures'
import {
  countTriageEntryViews,
  createTriageEntryView,
} from '../model/triageView'
import { TriageWorkbench } from './TriageWorkbench'

const entryViews = triageEntryFixtures.map((entry) =>
  createTriageEntryView(entry, new Date('2026-08-09T01:30:00.000Z'))
)
const onAction = fn(async () => triageEntryFixtures[0] ?? Promise.reject(new Error('Missing fixture')))
const onBulkAction = fn(async () => [])
const onSaveConfiguration = fn(async () => triageConfigurationFixture)

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
    teamName: 'Core team',
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
