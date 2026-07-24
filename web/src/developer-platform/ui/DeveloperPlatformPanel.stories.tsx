import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  expect,
  fireEvent,
  userEvent,
  waitFor,
  within,
} from 'storybook/test'
import { DeveloperPlatformPanel } from './DeveloperPlatformPanel'
import type { ImportDryRunReport } from '@mukuroji/contracts'
import {
  connectorConflictDeveloperPlatformResourcesFixture,
  deliveryFailureDeveloperPlatformResourcesFixture,
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  developerSyncConflictsFixture,
  emptyDeveloperPlatformResourcesFixture,
  importDryRunErrorDeveloperPlatformResourcesFixture,
  issuedApiKeySecretFixture,
  issuedOAuthClientSecretFixture,
  issuedWebhookSigningSecretFixture,
  multipleConnectorAccountsDeveloperPlatformResourcesFixture,
  needsReauthorizationDeveloperPlatformResourcesFixture,
  readOnlyDeveloperPlatformResourcesFixture,
  successfulImportDryRunReportFixture,
} from '../fixtures'
import type { DryRunDeveloperImportInput } from '../model/transfers'

const staleImportDryRunInputs: DryRunDeveloperImportInput[] = []
let resolveStaleImportDryRun:
  | ((report: ImportDryRunReport) => void)
  | undefined

/** Releases a pending stale import dry-run response, if one exists. */
function releaseStaleImportDryRun() {
  const resolve = resolveStaleImportDryRun

  resolveStaleImportDryRun = undefined
  resolve?.(successfulImportDryRunReportFixture)
}

/** Resets recorded inputs and releases a request left by a prior render. */
function resetStaleImportDryRunScenario() {
  releaseStaleImportDryRun()
  staleImportDryRunInputs.length = 0
}

/**
 * Records an import dry-run and defers its response.
 *
 * @param input - Import input captured when the request starts.
 * @returns A response Promise controlled by the story.
 */
function runStaleImportDryRunScenario(
  input: DryRunDeveloperImportInput,
) {
  staleImportDryRunInputs.push(input)

  return new Promise<ImportDryRunReport>((resolve) => {
    resolveStaleImportDryRun = resolve
  })
}

/**
 * Returns the shared successful import dry-run fixture.
 */
const successfulImportDryRunHandler: (
  input: DryRunDeveloperImportInput,
) => Promise<ImportDryRunReport> = async () =>
  successfulImportDryRunReportFixture

/**
 * DeveloperPlatformPanel の Storybook metadata です。
 */
const meta = {
  title: 'Application/Developer Platform/Management Panel',
  component: DeveloperPlatformPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    importProjectOptions: [
      {
        value: 'project-mukuroji',
        label: 'mukuroji',
        description: 'Product delivery project.',
        teamId: 'team-product',
      },
    ],
    importTeamOptions: [
      {
        value: 'team-product',
        label: 'Product',
        description: 'Product engineering Team.',
      },
    ],
    labels: developerPlatformLabelsFixture,
    resources: developerPlatformResourcesFixture,
    onCommitImport: async () =>
      developerPlatformResourcesFixture.imports[0],
    onConnectConnector: async () => undefined,
    onCreateApiKey: async () => issuedApiKeySecretFixture,
    onCreateOAuthApp: async () => issuedOAuthClientSecretFixture,
    onCreateWebhook: async () => issuedWebhookSigningSecretFixture,
    onDisconnectConnector: async () => undefined,
    onDryRunImport: successfulImportDryRunHandler,
    onExport: async () => undefined,
    onReauthorizeConnector: async () => undefined,
    onReplayDelivery: async () => undefined,
    onResolveSyncConflict: async () => undefined,
    onRetry: async () => undefined,
    onRevokeApiKey: async () => undefined,
    onRevokeOAuthApp: async () => undefined,
    onRevokeWebhook: async () => undefined,
    onRotateApiKey: async () => issuedApiKeySecretFixture,
    onRotateOAuthApp: async () => issuedOAuthClientSecretFixture,
    onRotateWebhook: async () => issuedWebhookSigningSecretFixture,
  },
} satisfies Meta<typeof DeveloperPlatformPanel>

export default meta

/**
 * DeveloperPlatformPanel stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Credential ledger を表示する標準状態です。
 */
export const Default: Story = {}

/**
 * Aggregate resource を取得中の skeleton 状態です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    resources: undefined,
  },
}

/**
 * Developer resource がまだ一件も無い初回利用状態です。
 */
export const Empty: Story = {
  args: {
    resources: emptyDeveloperPlatformResourcesFixture,
  },
}

/**
 * Aggregate resource の取得に失敗した状態です。
 */
export const ErrorState: Story = {
  args: {
    loadErrorMessage:
      developerPlatformLabelsFixture.loadError,
    resources: undefined,
  },
}

/**
 * Capabilities が全て無効な参照専用状態です。
 */
export const ReadOnly: Story = {
  args: {
    resources: readOnlyDeveloperPlatformResourcesFixture,
  },
}

/**
 * API key 作成 response の one-time secret modal を表示した状態です。
 */
export const SecretIssued: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const createApiKeyButton = canvas.getByRole('button', {
      name: developerPlatformLabelsFixture.actions.createApiKey,
    })

    await userEvent.click(createApiKeyButton)
    const editor = within(
      canvas.getByRole('dialog', {
        name: developerPlatformLabelsFixture.headings['create-api-key'],
      }),
    )
    await userEvent.type(
      editor.getByPlaceholderText(
        developerPlatformLabelsFixture.placeholders.apiKeyName,
      ),
      'Story automation',
    )
    await userEvent.click(
      editor.getByRole('button', {
        name: developerPlatformLabelsFixture.actions['submit-api-key'],
      }),
    )
    await expect(
      canvas.getByRole('dialog', {
        name: developerPlatformLabelsFixture.secretTitles['api-key'],
      }),
    ).toBeVisible()
    await expect(
      canvas.getByRole('checkbox', {
        name: developerPlatformLabelsFixture.secretStoredConfirmation,
      }),
    ).not.toBeChecked()
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.closeDialog,
      }),
    ).toBeDisabled()
    await userEvent.click(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.copySecret,
      }),
    )
    await expect(
      canvas.getByRole('checkbox', {
        name: developerPlatformLabelsFixture.secretStoredConfirmation,
      }),
    ).not.toBeChecked()
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.closeDialog,
      }),
    ).toBeDisabled()
    await userEvent.click(
      canvas.getByRole('checkbox', {
        name: developerPlatformLabelsFixture.secretStoredConfirmation,
      }),
    )
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.closeDialog,
      }),
    ).toBeEnabled()
    await userEvent.click(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.closeDialog,
      }),
    )
    await waitFor(() => {
      expect(
        canvas.queryByRole('dialog', {
          name: developerPlatformLabelsFixture.secretTitles['api-key'],
        }),
      ).not.toBeInTheDocument()
      expect(createApiKeyButton).toHaveFocus()
    })
  },
}

/**
 * API key scope を空にした場合は明示 validation を表示します。
 */
export const CredentialScopeRequired: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.createApiKey,
      }),
    )
    const editor = within(
      canvas.getByRole('dialog', {
        name: developerPlatformLabelsFixture.headings['create-api-key'],
      }),
    )
    const selectedScopeLabel = editor.getByText(
      developerPlatformLabelsFixture.scopeOptions[0]!.label,
    ).closest('label')

    if (!selectedScopeLabel) {
      throw new Error('API key scope option was not rendered.')
    }
    await userEvent.click(
      within(selectedScopeLabel).getByRole('checkbox'),
    )
    await expect(
      editor.getByRole('alert'),
    ).toHaveTextContent(
      developerPlatformLabelsFixture.helpText.selectionRequired,
    )
    await expect(
      editor.getByRole('button', {
        name: developerPlatformLabelsFixture.actions['submit-api-key'],
      }),
    ).toBeDisabled()
  },
}

/**
 * Webhook delivery failure と replay action を表示する状態です。
 */
export const DeliveryFailure: Story = {
  args: {
    initialSection: 'webhooks',
    resources:
      deliveryFailureDeveloperPlatformResourcesFixture,
  },
}

/**
 * Provider authorization が切れ reconnect を求める状態です。
 */
export const NeedsReauthorization: Story = {
  args: {
    initialSection: 'connectors',
    resources:
      needsReauthorizationDeveloperPlatformResourcesFixture,
  },
}

/**
 * 双方向同期の resource mapping conflict を表示する状態です。
 */
export const ConnectorConflict: Story = {
  args: {
    initialSection: 'connectors',
    resources:
      connectorConflictDeveloperPlatformResourcesFixture,
    syncConflicts: developerSyncConflictsFixture,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByText('Ship the public API'),
    ).toBeVisible()
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.resolve,
      }),
    ).toBeDisabled()
    await userEvent.selectOptions(
      canvas.getByRole('combobox', {
        name: developerPlatformLabelsFixture.fields.conflictResolution,
      }),
      'merge',
    )
    await expect(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.resolve,
      }),
    ).toBeEnabled()
    await expect(
      canvas.getByRole('group', {
        name: developerPlatformLabelsFixture.fields.mergedValues,
      }),
    ).toBeVisible()
  },
}

/**
 * 同一 provider のすべての account と切断後の新規 OAuth 導線を表示します。
 */
export const MultipleConnectorAccounts: Story = {
  args: {
    initialSection: 'connectors',
    resources: multipleConnectorAccountsDeveloperPlatformResourcesFixture,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('mnmn0')).toBeVisible()
    await expect(canvas.getByText('mnmn0-archive')).toBeVisible()
    await expect(canvas.getByText('mukuroji-gitlab')).toBeVisible()
    await expect(canvas.getByRole('button', {
      name: developerPlatformLabelsFixture.actions.connectAgain,
    })).toBeEnabled()
  },
}

/**
 * Sync conflict の次 page を取得できる状態です。
 */
export const ConflictHasMore: Story = {
  args: {
    initialSection: 'connectors',
    resources: connectorConflictDeveloperPlatformResourcesFixture,
    syncConflicts: developerSyncConflictsFixture,
    syncConflictsHasMore: true,
    onLoadMoreSyncConflicts: async () => undefined,
  },
}

/**
 * 取得済み conflict を保持しながら追加 page の retry を案内します。
 */
export const ConflictPaginationError: Story = {
  args: {
    initialSection: 'connectors',
    resources: connectorConflictDeveloperPlatformResourcesFixture,
    syncConflicts: developerSyncConflictsFixture,
    syncConflictsHasMore: true,
    syncConflictsLoadMoreErrorMessage:
      developerPlatformLabelsFixture.helpText.syncConflictsLoadMoreError,
    onLoadMoreSyncConflicts: async () => undefined,
    onRetrySyncConflicts: async () => undefined,
  },
}

/**
 * Import dry-run の row-level error report を表示する状態です。
 */
export const ImportDryRunError: Story = {
  args: {
    initialSection: 'imports',
    resources:
      importDryRunErrorDeveloperPlatformResourcesFixture,
  },
}

/**
 * A stale dry-run response cannot restore validation after import input changes.
 */
export const StaleImportDryRunIgnored: Story = {
  args: {
    initialSection: 'imports',
    resources: {
      ...developerPlatformResourcesFixture,
      imports: [],
    },
    onDryRunImport: runStaleImportDryRunScenario,
  },
  beforeEach: () => {
    resetStaleImportDryRunScenario()
    return releaseStaleImportDryRun
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(
      canvas.getByRole('button', {
        name: developerPlatformLabelsFixture.actions.addMapping,
      }),
    )
    await userEvent.type(
      canvas.getByRole('textbox', {
        name: developerPlatformLabelsFixture.fields.sourceField,
      }),
      'Title',
    )
    await userEvent.selectOptions(
      canvas.getByRole('combobox', {
        name: developerPlatformLabelsFixture.fields.targetField,
      }),
      'title',
    )
    await userEvent.upload(
      canvas.getByLabelText(
        developerPlatformLabelsFixture.fields.importFile,
      ),
      new File(['Title\nShip the stable API'], 'work-items.csv', {
        type: 'text/csv',
      }),
    )
    const dryRunButton = canvas.getByRole('button', {
      name: developerPlatformLabelsFixture.actions.dryRun,
    })
    const importForm = dryRunButton.closest('form')

    if (!importForm) {
      throw new Error('Import form was not rendered.')
    }
    fireEvent.submit(importForm)
    await waitFor(() => {
      expect(staleImportDryRunInputs).toHaveLength(1)
      expect(dryRunButton).toBeDisabled()
    })

    const jsonFormatLabel = canvas.getByText(
      developerPlatformLabelsFixture.headings['source-json'],
    )
    const jsonFormatButton = jsonFormatLabel.closest('button')

    if (!jsonFormatButton) {
      throw new Error('JSON import format button was not rendered.')
    }
    await userEvent.click(jsonFormatButton)
    releaseStaleImportDryRun()

    await waitFor(() => {
      expect(dryRunButton).toBeEnabled()
      expect(
        canvas.queryByRole('button', {
          name: developerPlatformLabelsFixture.actions.commitImport,
        }),
      ).not.toBeInTheDocument()
    })
  },
}

/**
 * Export failure を panel 共通 error として処理し、再試行可能に戻します。
 */
export const ExportFailure: Story = {
  args: {
    initialSection: 'imports',
    onExport: async () => {
      throw new Error('Export failed.')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const exportButton = canvas.getByRole('button', {
      name: developerPlatformLabelsFixture.actions['export-csv'],
    })

    await userEvent.click(exportButton)
    await expect(
      canvas.getByRole('alert'),
    ).toHaveTextContent(developerPlatformLabelsFixture.operationError)
    await expect(exportButton).toBeEnabled()
  },
}
