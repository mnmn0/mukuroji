import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import {
  connectorConflictDeveloperPlatformResourcesFixture,
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  developerSyncConflictsFixture,
  multipleConnectorAccountsDeveloperPlatformResourcesFixture,
  needsReauthorizationDeveloperPlatformResourcesFixture,
} from '../fixtures'
import {
  completeDeveloperConnectorCatalog,
  filterDeveloperConnectorCatalog,
  type DeveloperConnectorCatalogItem,
} from '../model/connectors'
import { formatDeveloperTimestamp } from '../model/displayFormatting'
import {
  ConnectorsSection,
  type ConnectorsSectionProps,
} from './ConnectorsSection'

/**
 * Builds a complete connector catalog for a story's installation set.
 *
 * @param connectors - Connector installations rendered by the story.
 * @returns Localized catalog entries including installed-only providers.
 */
function createConnectorCatalog(
  connectors: ConnectorsSectionProps['connectors'],
): DeveloperConnectorCatalogItem[] {
  return completeDeveloperConnectorCatalog(
    developerPlatformLabelsFixture.connectorCatalog,
    connectors,
    developerPlatformLabelsFixture.helpText.installedConnector,
  )
}

/**
 * Provides controlled search and conflict-editing state for isolated stories.
 *
 * @param props - Initial connector section props and story callbacks.
 * @returns The connector section with interactive local story state.
 */
function ConnectorsSectionStoryHarness(props: ConnectorsSectionProps) {
  const [query, setQuery] = useState(props.query)
  const [conflictResolutions, setConflictResolutions] = useState(
    props.conflictResolutions,
  )
  const [conflictMergedValueDrafts, setConflictMergedValueDrafts] = useState(
    props.conflictMergedValueDrafts,
  )
  const catalog = filterDeveloperConnectorCatalog(
    props.catalog,
    props.connectors,
    query,
  )

  return (
    <ConnectorsSection
      {...props}
      catalog={catalog}
      conflictMergedValueDrafts={conflictMergedValueDrafts}
      conflictResolutions={conflictResolutions}
      query={query}
      onConflictMergedValueChange={(conflictId, field, value) => {
        setConflictMergedValueDrafts((currentDrafts) => ({
          ...currentDrafts,
          [conflictId]: {
            ...currentDrafts[conflictId],
            [field]: value,
          },
        }))
        props.onConflictMergedValueChange(conflictId, field, value)
      }}
      onConflictResolutionChange={(conflictId, value) => {
        setConflictResolutions((currentResolutions) => ({
          ...currentResolutions,
          [conflictId]: value,
        }))
        props.onConflictResolutionChange(conflictId, value)
      }}
      onQueryChange={(value) => {
        setQuery(value)
        props.onQueryChange(value)
      }}
    />
  )
}

/**
 * Storybook metadata for the standalone Developer Platform connectors section.
 */
const meta = {
  title: 'Application/Developer Platform/Connectors Section',
  component: ConnectorsSection,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <section className="workbench-panel p-5">
          <Story />
        </section>
      </main>
    ),
  ],
  render: (args) => <ConnectorsSectionStoryHarness {...args} />,
  args: {
    canManage:
      developerPlatformResourcesFixture.capabilities.canManageIntegrations,
    catalog: createConnectorCatalog(
      developerPlatformResourcesFixture.connectors,
    ),
    conflictMergeErrors: {},
    conflictMergedValueDrafts: {},
    conflictResolutions: {},
    connectors: developerPlatformResourcesFixture.connectors,
    formatDateTime: formatDeveloperTimestamp,
    labels: developerPlatformLabelsFixture,
    query: '',
    syncConflicts: [],
    onConnect: fn(),
    onConflictMergedValueChange: fn(),
    onConflictResolutionChange: fn(),
    onDisconnect: fn(),
    onQueryChange: fn(),
    onReauthorize: fn(),
    onResolveSyncConflict: fn(),
    onRetrySyncConflicts: fn(),
  },
} satisfies Meta<typeof ConnectorsSection>

export default meta

/**
 * Story type for the standalone connectors section.
 */
type Story = StoryObj<typeof meta>

/**
 * Displays an expired provider authorization with its recovery action.
 */
export const NeedsReauthorization: Story = {
  args: {
    catalog: createConnectorCatalog(
      needsReauthorizationDeveloperPlatformResourcesFixture.connectors,
    ),
    connectors:
      needsReauthorizationDeveloperPlatformResourcesFixture.connectors,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByText(
        developerPlatformLabelsFixture.statusLabels['needs-reauth'],
      ),
    ).toBeVisible()
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.reauthorize,
      }),
    ).toBeEnabled()
  },
}

/**
 * Displays every installation for providers with multiple connector accounts.
 */
export const MultipleConnectorAccounts: Story = {
  args: {
    catalog: createConnectorCatalog(
      multipleConnectorAccountsDeveloperPlatformResourcesFixture.connectors,
    ),
    connectors:
      multipleConnectorAccountsDeveloperPlatformResourcesFixture.connectors,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('mnmn0')).toBeVisible()
    await expect(canvas.getByText('mnmn0-archive')).toBeVisible()
    await expect(canvas.getByText('mukuroji-gitlab')).toBeVisible()
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.connectAgain,
      }),
    ).toBeEnabled()
  },
}

/**
 * Displays a synchronization conflict and exercises merge resolution controls.
 */
export const ConnectorConflict: Story = {
  args: {
    catalog: createConnectorCatalog(
      connectorConflictDeveloperPlatformResourcesFixture.connectors,
    ),
    connectors: connectorConflictDeveloperPlatformResourcesFixture.connectors,
    syncConflicts: developerSyncConflictsFixture,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const resolveButton = canvas.getByRole('button', {
      name: developerPlatformLabelsFixture.actions.resolve,
    })

    await expect(canvas.getByText('Ship the public API')).toBeVisible()
    await expect(resolveButton).toBeDisabled()
    await userEvent.selectOptions(
      canvas.getByRole('combobox', {
        name: developerPlatformLabelsFixture.fields.conflictResolution,
      }),
      'merge',
    )
    await expect(resolveButton).toBeEnabled()
    await expect(
      canvas.getByRole('group', {
        name: developerPlatformLabelsFixture.fields.mergedValues,
      }),
    ).toBeVisible()
  },
}

/**
 * Displays loaded synchronization conflicts with another page available.
 */
export const ConflictHasMore: Story = {
  args: {
    catalog: createConnectorCatalog(
      connectorConflictDeveloperPlatformResourcesFixture.connectors,
    ),
    connectors: connectorConflictDeveloperPlatformResourcesFixture.connectors,
    syncConflicts: developerSyncConflictsFixture,
    syncConflictsHasMore: true,
    onLoadMoreSyncConflicts: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.loadMore,
      }),
    ).toBeEnabled()
  },
}

/**
 * Retains loaded conflicts while presenting a retryable pagination error.
 */
export const ConflictPaginationError: Story = {
  args: {
    catalog: createConnectorCatalog(
      connectorConflictDeveloperPlatformResourcesFixture.connectors,
    ),
    connectors: connectorConflictDeveloperPlatformResourcesFixture.connectors,
    syncConflicts: developerSyncConflictsFixture,
    syncConflictsHasMore: true,
    syncConflictsLoadMoreErrorMessage:
      developerPlatformLabelsFixture.helpText.syncConflictsLoadMoreError,
    onLoadMoreSyncConflicts: fn(),
    onRetrySyncConflicts: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Ship the public API')).toBeVisible()
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      developerPlatformLabelsFixture.helpText.syncConflictsLoadMoreError,
    )
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.loadMore,
      }),
    ).toBeEnabled()
  },
}

/**
 * Displays the skeleton shown while the first conflict page is loading.
 */
export const InitialLoading: Story = {
  args: {
    isSyncConflictsLoading: true,
    syncConflicts: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByRole('status', {
        name: developerPlatformLabelsFixture.helpText.syncConflictsLoading,
      }),
    ).toBeVisible()
  },
}

/**
 * Displays a retry action when the first conflict page cannot be loaded.
 */
export const InitialError: Story = {
  args: {
    syncConflicts: [],
    syncConflictsErrorMessage:
      developerPlatformLabelsFixture.helpText.syncConflictsError,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('alert')).toHaveTextContent(
      developerPlatformLabelsFixture.helpText.syncConflictsError,
    )
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.retry,
      }),
    ).toBeEnabled()
  },
}
