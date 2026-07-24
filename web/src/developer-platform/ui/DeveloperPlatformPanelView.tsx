import { useState, type FormEvent } from 'react'
import type {
  ApiScope,
  DeveloperPlatformOverview,
  ImportDryRunReport,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  completeDeveloperConnectorCatalog,
  filterDeveloperConnectorCatalog,
  parseConflictMergedValues,
  type ConnectDeveloperConnectorInput,
  type DeveloperConnectorProvider,
  type DeveloperSyncConflictResolution,
  type ResolveDeveloperSyncConflictInput,
} from '../model/connectors'
import {
  type CreateDeveloperApiKeyInput,
  type CreateDeveloperOAuthAppInput,
  type DeveloperOAuthGrantType,
  type IssuedApiKeySecret,
  type IssuedOAuthClientSecret,
  toLocalEndOfDayIso,
} from '../model/credentials'
import {
  formatDeveloperTimestamp,
  interpolate,
} from '../model/displayFormatting'
import {
  filterImportProjectOptions,
  selectLatestImport,
  type DeveloperExportFormat,
  type DeveloperImportFieldMapping,
  type DeveloperImportFormat,
  type DryRunDeveloperImportInput,
} from '../model/transfers'
import {
  type CreateDeveloperWebhookInput,
  type DeveloperWebhookEventType,
  type IssuedWebhookSigningSecret,
} from '../model/webhooks'
import { ConnectorsSection } from './ConnectorsSection'
import { CredentialsSection } from './CredentialsSection'
import { EditorDialog } from './DeveloperPlatformEditorDialog'
import {
  SecretDialog,
  type SecretDialogState,
} from './DeveloperPlatformSecretDialog'
import type {
  DeveloperImportProjectOption,
  DeveloperPlatformLabels,
  DeveloperPlatformOption,
  DeveloperPlatformSection,
  EditorDialogKind,
  SecretDialogKind,
} from './DeveloperPlatformView'
import { ImportExportSection } from './ImportExportSection'
import { WebhooksSection } from './WebhooksSection'

/**
 * Compatibility view-type exports retained for existing panel consumers.
 */
export type {
  DeveloperImportProjectOption,
  DeveloperPlatformLabels,
  DeveloperPlatformOption,
  DeveloperPlatformSection,
  SecretDialogKind,
} from './DeveloperPlatformView'

/**
 * Compatibility connector-catalog export retained for existing panel consumers.
 */
export type { DeveloperConnectorCatalogItem } from '../model/connectors'

/**
 * Aggregate data and action callbacks accepted by the pure Developer Platform panel.
 */
export type DeveloperPlatformPanelProps = {
  /** Developer Platform aggregate resources. */
  resources?: DeveloperPlatformOverview
  /** Connector synchronization conflicts loaded across available pages. */
  syncConflicts?: WorkItemSyncConflict[]
  /** Whether the first synchronization-conflict page is loading. */
  isSyncConflictsLoading?: boolean
  /** Safe message shown when the first conflict page cannot be loaded. */
  syncConflictsErrorMessage?: string
  /** Safe message shown when a later conflict page cannot be loaded. */
  syncConflictsLoadMoreErrorMessage?: string
  /** Whether another synchronization-conflict page is available. */
  syncConflictsHasMore?: boolean
  /** Whether another synchronization-conflict page is loading. */
  isLoadingMoreSyncConflicts?: boolean
  /** Whether aggregate resources are loading. */
  isLoading?: boolean
  /** Safe message shown when aggregate resources cannot be loaded. */
  loadErrorMessage?: string
  /** Localized labels and display options used by the panel. */
  labels: DeveloperPlatformLabels
  /** Section selected when the panel first mounts. */
  initialSection?: DeveloperPlatformSection
  /** Team options available as import destinations. */
  importTeamOptions?: DeveloperPlatformOption[]
  /** Project options available as import destinations. */
  importProjectOptions?: DeveloperImportProjectOption[]
  /** Optional timestamp formatting callback. */
  formatDateTime?: (value: string) => string
  /** Retries aggregate resource loading. */
  onRetry?: () => Promise<void> | void
  /** Creates an API key and returns its one-time secret. */
  onCreateApiKey?: (
    input: CreateDeveloperApiKeyInput,
  ) => Promise<IssuedApiKeySecret>
  /** Rotates an API key and returns its one-time secret. */
  onRotateApiKey?: (apiKeyId: string) => Promise<IssuedApiKeySecret>
  /** Revokes an API key. */
  onRevokeApiKey?: (apiKeyId: string) => Promise<void>
  /** Creates an OAuth application and returns its one-time client secret. */
  onCreateOAuthApp?: (
    input: CreateDeveloperOAuthAppInput,
  ) => Promise<IssuedOAuthClientSecret>
  /** Rotates an OAuth application client secret. */
  onRotateOAuthApp?: (
    oauthAppId: string,
  ) => Promise<IssuedOAuthClientSecret>
  /** Revokes an OAuth application. */
  onRevokeOAuthApp?: (oauthAppId: string) => Promise<void>
  /** Creates a webhook subscription and returns its signing secret. */
  onCreateWebhook?: (
    input: CreateDeveloperWebhookInput,
  ) => Promise<IssuedWebhookSigningSecret>
  /** Rotates a webhook signing secret. */
  onRotateWebhook?: (
    subscriptionId: string,
  ) => Promise<IssuedWebhookSigningSecret>
  /** Revokes a webhook subscription. */
  onRevokeWebhook?: (subscriptionId: string) => Promise<void>
  /** Replays a failed webhook delivery. */
  onReplayDelivery?: (deliveryId: string) => Promise<void>
  /** Starts a connector authorization flow. */
  onConnectConnector?: (
    provider: DeveloperConnectorProvider,
    input: ConnectDeveloperConnectorInput,
  ) => Promise<void>
  /** Restarts authorization for a connector installation. */
  onReauthorizeConnector?: (installationId: string) => Promise<void>
  /** Disconnects a connector installation. */
  onDisconnectConnector?: (installationId: string) => Promise<void>
  /** Resolves a Work Item synchronization conflict. */
  onResolveSyncConflict?: (
    input: ResolveDeveloperSyncConflictInput,
  ) => Promise<void>
  /** Retries synchronization-conflict loading. */
  onRetrySyncConflicts?: () => Promise<void> | void
  /** Loads the next synchronization-conflict page. */
  onLoadMoreSyncConflicts?: () => Promise<void> | void
  /** Runs an import dry-run. */
  onDryRunImport?: (
    input: DryRunDeveloperImportInput,
  ) => Promise<ImportDryRunReport>
  /** Commits a validated import. */
  onCommitImport?: (
    input: DryRunDeveloperImportInput,
  ) => Promise<DeveloperPlatformOverview['imports'][number]>
  /** Starts a Work Item export download. */
  onExport?: (format: DeveloperExportFormat) => Promise<void>
}

/**
 * Renders the API-independent Developer Platform management panel.
 *
 * @param props - Aggregate data, local display options, and action callbacks.
 * @returns The pure panel shell with controlled section and dialog views.
 */
export function DeveloperPlatformPanel({
  formatDateTime = formatDeveloperTimestamp,
  initialSection = 'credentials',
  importProjectOptions = [],
  importTeamOptions = [],
  isLoading,
  isLoadingMoreSyncConflicts,
  isSyncConflictsLoading,
  labels,
  loadErrorMessage,
  resources,
  syncConflicts = [],
  syncConflictsErrorMessage,
  syncConflictsHasMore,
  syncConflictsLoadMoreErrorMessage,
  onCommitImport,
  onConnectConnector,
  onCreateApiKey,
  onCreateOAuthApp,
  onCreateWebhook,
  onDisconnectConnector,
  onDryRunImport,
  onExport,
  onLoadMoreSyncConflicts,
  onReauthorizeConnector,
  onReplayDelivery,
  onResolveSyncConflict,
  onRetry,
  onRetrySyncConflicts,
  onRevokeApiKey,
  onRevokeOAuthApp,
  onRevokeWebhook,
  onRotateApiKey,
  onRotateOAuthApp,
  onRotateWebhook,
}: DeveloperPlatformPanelProps) {
  const [activeSection, setActiveSection] =
    useState<DeveloperPlatformSection>(initialSection)
  const [editorDialog, setEditorDialog] = useState<EditorDialogKind>()
  const [secretDialog, setSecretDialog] = useState<SecretDialogState>()
  const [secretCopied, setSecretCopied] = useState(false)
  const [secretCopyError, setSecretCopyError] = useState<string>()
  const [secretStored, setSecretStored] = useState(false)
  const [dialogTrigger, setDialogTrigger] =
    useState<HTMLElement | null>(null)
  const [busyOperation, setBusyOperation] = useState<string>()
  const [exportingFormat, setExportingFormat] =
    useState<DeveloperExportFormat>()
  const [operationError, setOperationError] = useState<string>()
  const [apiKeyName, setApiKeyName] = useState('')
  const [apiKeyExpiry, setApiKeyExpiry] = useState('')
  const [apiKeyScopes, setApiKeyScopes] = useState<ApiScope[]>(
    labels.scopeOptions[0] ? [labels.scopeOptions[0].value] : [],
  )
  const [oauthName, setOAuthName] = useState('')
  const [oauthExpiry, setOAuthExpiry] = useState('')
  const [oauthScopes, setOAuthScopes] = useState<ApiScope[]>(
    labels.scopeOptions[0] ? [labels.scopeOptions[0].value] : [],
  )
  const [oauthGrantTypes, setOAuthGrantTypes] = useState<
    DeveloperOAuthGrantType[]
  >(
    labels.grantTypeOptions[0]
      ? [labels.grantTypeOptions[0].value]
      : [],
  )
  const [webhookName, setWebhookName] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookTeamIds, setWebhookTeamIds] = useState<string[]>(
    importTeamOptions[0] ? [importTeamOptions[0].value] : [],
  )
  const [webhookEvents, setWebhookEvents] = useState<
    DeveloperWebhookEventType[]
  >(
    labels.webhookEventOptions[0]
      ? [labels.webhookEventOptions[0].value]
      : [],
  )
  const [webhookScopes, setWebhookScopes] = useState<ApiScope[]>([
    'work-items:read',
  ])
  const [connectorQuery, setConnectorQuery] = useState('')
  const [conflictResolutions, setConflictResolutions] = useState<
    Partial<Record<string, DeveloperSyncConflictResolution>>
  >({})
  const [conflictMergedValueDrafts, setConflictMergedValueDrafts] =
    useState<Record<string, Record<string, string>>>({})
  const [conflictMergeErrors, setConflictMergeErrors] = useState<
    Record<string, string | undefined>
  >({})
  const [importFormat, setImportFormat] =
    useState<DeveloperImportFormat>('csv')
  const [importFile, setImportFile] = useState<File>()
  const [importMappings, setImportMappings] = useState<
    DeveloperImportFieldMapping[]
  >([])
  const [importTeamId, setImportTeamId] = useState(
    importTeamOptions[0]?.value ?? '',
  )
  const [importProjectId, setImportProjectId] = useState(
    importProjectOptions.find(
      (option) => option.teamId === importTeamOptions[0]?.value,
    )?.value ?? '',
  )
  const [previewImportReport, setPreviewImportReport] =
    useState<ImportDryRunReport>()
  const [validatedImportInput, setValidatedImportInput] =
    useState<DryRunDeveloperImportInput>()
  const availableImportProjectOptions = filterImportProjectOptions(
    importProjectOptions,
    importTeamId,
  )

  if (isLoading) {
    return (
      <section
        aria-label={labels.loading}
        className="workbench-panel overflow-hidden"
        role="status"
      >
        <div className="border-b border-[var(--workbench-border)] p-6">
          <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-7 w-72 max-w-full animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-4 w-[560px] max-w-full animate-pulse rounded bg-slate-100" />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] max-[780px]:grid-cols-1">
          <div className="grid content-start gap-2 border-r border-[var(--workbench-border)] p-4 max-[780px]:grid-cols-2 max-[780px]:border-b max-[780px]:border-r-0">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                className="h-10 animate-pulse rounded bg-slate-100"
                key={index}
              />
            ))}
          </div>
          <div className="grid gap-3 p-5">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                className="h-20 animate-pulse rounded-lg bg-slate-100"
                key={index}
              />
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (loadErrorMessage || !resources) {
    return (
      <section className="workbench-panel grid justify-items-start gap-3 p-6">
        <p className="workbench-eyebrow">{labels.eyebrow}</p>
        <h2 className="text-xl font-semibold text-[var(--workbench-text)]">
          {labels.title}
        </h2>
        <p className="text-sm font-semibold text-red-700">
          {loadErrorMessage ?? labels.loadError}
        </p>
        {onRetry ? (
          <button
            className="workbench-button-secondary min-h-10 px-4"
            onClick={() => void onRetry()}
            type="button"
          >
            {labels.retry}
          </button>
        ) : null}
      </section>
    )
  }

  const canManageCredentials =
    resources.capabilities.canManageCredentials
  const canManageWebhooks = resources.capabilities.canManageWebhooks
  const canManageIntegrations =
    resources.capabilities.canManageIntegrations
  const hasAnyMutationCapability = Object.values(
    resources.capabilities,
  ).some(Boolean)
  const latestImport = selectLatestImport(resources.imports)
  const completeConnectorCatalog = completeDeveloperConnectorCatalog(
    labels.connectorCatalog,
    resources.connectors,
    labels.helpText.installedConnector,
  )
  const filteredConnectorCatalog = filterDeveloperConnectorCatalog(
    completeConnectorCatalog,
    resources.connectors,
    connectorQuery,
  )

  /** Runs a panel action while managing shared busy and safe error state. */
  const runAction = async <TResult,>(
    operationKey: string,
    action: () => Promise<TResult>,
  ) => {
    setBusyOperation(operationKey)
    setOperationError(undefined)

    try {
      return await action()
    } catch {
      setOperationError(labels.operationError)
      return undefined
    } finally {
      setBusyOperation(undefined)
    }
  }

  /** Remembers the element that launched the next dialog. */
  const rememberDialogTrigger = () => {
    if (document.activeElement instanceof HTMLElement) {
      setDialogTrigger(document.activeElement)
    }
  }

  /** Restores focus to the element that launched the dialog flow. */
  const restoreDialogTrigger = () => {
    setDialogTrigger(null)
    window.requestAnimationFrame(() => dialogTrigger?.focus())
  }

  /** Opens a credential or webhook editor dialog. */
  const openEditor = (kind: EditorDialogKind) => {
    rememberDialogTrigger()
    setEditorDialog(kind)
  }

  /** Closes the editor and restores focus. */
  const closeEditor = () => {
    setEditorDialog(undefined)
    restoreDialogTrigger()
  }

  /** Transitions from an editor or action to a guarded secret dialog. */
  const openSecret = (
    kind: SecretDialogKind,
    name: string,
    value: string,
  ) => {
    if (!editorDialog) {
      rememberDialogTrigger()
    }
    setEditorDialog(undefined)
    setSecretCopied(false)
    setSecretCopyError(undefined)
    setSecretStored(false)
    setSecretDialog({ kind, name, value })
  }

  /** Submits the controlled API key form. */
  const handleCreateApiKey = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!onCreateApiKey) return

    const result = await runAction('api-key:create', () =>
      onCreateApiKey({
        name: apiKeyName,
        scopes: apiKeyScopes,
        expiresAt: apiKeyExpiry
          ? toLocalEndOfDayIso(apiKeyExpiry)
          : undefined,
      }),
    )

    if (result) {
      setApiKeyName('')
      openSecret('api-key', result.apiKey.name, result.secret)
    }
  }

  /** Submits the controlled OAuth application form. */
  const handleCreateOAuthApp = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!onCreateOAuthApp) return

    const result = await runAction('oauth-app:create', () =>
      onCreateOAuthApp({
        name: oauthName,
        grantTypes: oauthGrantTypes,
        scopes: oauthScopes,
        expiresAt: oauthExpiry
          ? toLocalEndOfDayIso(oauthExpiry)
          : undefined,
      }),
    )

    if (result) {
      setOAuthName('')
      setOAuthExpiry('')
      openSecret(
        'oauth-app',
        result.oauthApp.name,
        result.clientSecret,
      )
    }
  }

  /** Submits the controlled webhook subscription form. */
  const handleCreateWebhook = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!onCreateWebhook) return

    const result = await runAction('webhook:create', () =>
      onCreateWebhook({
        name: webhookName,
        url: webhookUrl,
        teamIds: webhookTeamIds,
        eventTypes: webhookEvents,
        scopes: webhookScopes,
      }),
    )

    if (result) {
      setWebhookName('')
      setWebhookUrl('')
      openSecret(
        'webhook',
        result.subscription.name,
        result.signingSecret,
      )
    }
  }

  /** Reads the selected import file and runs a dry-run. */
  const handleDryRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!importFile || !onDryRunImport) return

    const content = await importFile.text()
    const input = {
      format: importFormat,
      mapping: importMappings,
      source: {
        content,
        fileName: importFile.name,
        mediaType:
          importFormat === 'csv' ? 'text/csv' : 'application/json',
      },
      teamId: importTeamId,
      assignedProjectId: importProjectId || undefined,
    } satisfies DryRunDeveloperImportInput
    const result = await runAction('import:dry-run', () =>
      onDryRunImport(input),
    )

    if (result) {
      setPreviewImportReport(result)
      setValidatedImportInput(input)
    }
  }

  /** Runs an export while tracking its format-specific busy state. */
  const handleExport = async (format: DeveloperExportFormat) => {
    if (!onExport) return

    setExportingFormat(format)
    try {
      await runAction(`export:${format}`, () => onExport(format))
    } finally {
      setExportingFormat((current) =>
        current === format ? undefined : current,
      )
    }
  }

  return (
    <section
      className="workbench-panel overflow-hidden"
      data-testid="developer-platform-panel"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-6 py-5">
        <div className="min-w-0 max-w-[760px]">
          <p className="workbench-eyebrow">{labels.eyebrow}</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
            {labels.title}
          </h2>
          <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {labels.description}
          </p>
        </div>
        {!hasAnyMutationCapability ? (
          <span className="workbench-badge">{labels.readOnly}</span>
        ) : null}
      </header>

      <div className="grid grid-cols-[220px_minmax(0,1fr)] max-[860px]:grid-cols-1">
        <nav
          aria-label={labels.title}
          className="grid content-start gap-1 border-r border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 max-[860px]:grid-cols-2 max-[860px]:border-b max-[860px]:border-r-0 max-[520px]:grid-cols-1"
        >
          {(
            [
              'credentials',
              'webhooks',
              'connectors',
              'imports',
            ] as const
          ).map((section) => (
            <button
              aria-current={
                activeSection === section ? 'page' : undefined
              }
              className={`min-h-10 rounded-md px-3 text-left text-sm font-semibold transition ${
                activeSection === section
                  ? 'bg-white text-[var(--workbench-primary)] shadow-sm'
                  : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
              }`}
              key={section}
              onClick={() => {
                setActiveSection(section)
                setOperationError(undefined)
              }}
              type="button"
            >
              {labels.tabs[section]}
            </button>
          ))}
        </nav>

        <div className="min-w-0 overflow-hidden p-5 max-[600px]:p-3">
          {operationError ? (
            <div
              className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
              role="alert"
            >
              {operationError}
            </div>
          ) : null}

          {activeSection === 'credentials' ? (
            <CredentialsSection
              apiKeys={resources.apiKeys}
              busyOperation={busyOperation}
              canManage={canManageCredentials}
              formatDateTime={formatDateTime}
              labels={labels}
              oauthApps={resources.oauthApps}
              onCreateApiKey={
                onCreateApiKey ? () => openEditor('api-key') : undefined
              }
              onCreateOAuthApp={
                onCreateOAuthApp
                  ? () => openEditor('oauth-app')
                  : undefined
              }
              onRevokeApiKey={
                onRevokeApiKey
                  ? (apiKey) =>
                      void runAction(
                        `api-key:revoke:${apiKey.id}`,
                        () => onRevokeApiKey(apiKey.id),
                      )
                  : undefined
              }
              onRevokeOAuthApp={
                onRevokeOAuthApp
                  ? (oauthApp) =>
                      void runAction(
                        `oauth-app:revoke:${oauthApp.id}`,
                        () => onRevokeOAuthApp(oauthApp.id),
                      )
                  : undefined
              }
              onRotateApiKey={
                onRotateApiKey
                  ? async (apiKey) => {
                      const result = await runAction(
                        `api-key:rotate:${apiKey.id}`,
                        () => onRotateApiKey(apiKey.id),
                      )

                      if (result) {
                        openSecret(
                          'api-key',
                          result.apiKey.name,
                          result.secret,
                        )
                      }
                    }
                  : undefined
              }
              onRotateOAuthApp={
                onRotateOAuthApp
                  ? async (oauthApp) => {
                      const result = await runAction(
                        `oauth-app:rotate:${oauthApp.id}`,
                        () => onRotateOAuthApp(oauthApp.id),
                      )

                      if (result) {
                        openSecret(
                          'oauth-app',
                          result.oauthApp.name,
                          result.clientSecret,
                        )
                      }
                    }
                  : undefined
              }
            />
          ) : null}

          {activeSection === 'webhooks' ? (
            <WebhooksSection
              busyOperation={busyOperation}
              canManage={canManageWebhooks}
              deliveries={resources.webhookDeliveries}
              formatDateTime={formatDateTime}
              labels={labels}
              subscriptions={resources.webhookSubscriptions}
              onCreate={
                onCreateWebhook
                  ? () => openEditor('webhook')
                  : undefined
              }
              onReplay={
                onReplayDelivery
                  ? (delivery) =>
                      void runAction(
                        `delivery:replay:${delivery.id}`,
                        () => onReplayDelivery(delivery.id),
                      )
                  : undefined
              }
              onRevoke={
                onRevokeWebhook
                  ? (subscription) =>
                      void runAction(
                        `webhook:revoke:${subscription.id}`,
                        () => onRevokeWebhook(subscription.id),
                      )
                  : undefined
              }
              onRotate={
                onRotateWebhook
                  ? async (subscription) => {
                      const result = await runAction(
                        `webhook:rotate:${subscription.id}`,
                        () => onRotateWebhook(subscription.id),
                      )

                      if (result) {
                        openSecret(
                          'webhook',
                          result.subscription.name,
                          result.signingSecret,
                        )
                      }
                    }
                  : undefined
              }
            />
          ) : null}

          {activeSection === 'connectors' ? (
            <ConnectorsSection
              busyOperation={busyOperation}
              canManage={canManageIntegrations}
              catalog={filteredConnectorCatalog}
              conflictMergeErrors={conflictMergeErrors}
              conflictMergedValueDrafts={conflictMergedValueDrafts}
              conflictResolutions={conflictResolutions}
              connectors={resources.connectors}
              formatDateTime={formatDateTime}
              isLoadingMoreSyncConflicts={
                isLoadingMoreSyncConflicts
              }
              isSyncConflictsLoading={isSyncConflictsLoading}
              labels={labels}
              query={connectorQuery}
              syncConflicts={syncConflicts}
              syncConflictsErrorMessage={syncConflictsErrorMessage}
              syncConflictsHasMore={syncConflictsHasMore}
              syncConflictsLoadMoreErrorMessage={
                syncConflictsLoadMoreErrorMessage
              }
              onConnect={
                onConnectConnector
                  ? (item) =>
                      void runAction(
                        `connector:connect:${item.provider}`,
                        () =>
                          onConnectConnector(item.provider, {
                            name: item.name,
                            scopes: item.scopes,
                          }),
                      )
                  : undefined
              }
              onDisconnect={
                onDisconnectConnector
                  ? (connector) => {
                      const account =
                        connector.externalAccountName ??
                        connector.externalAccountId ??
                        connector.name
                      if (
                        !window.confirm(
                          interpolate(
                            labels.helpText.disconnectConfirm,
                            { name: account },
                          ),
                        )
                      ) {
                        return
                      }
                      void runAction(
                        `connector:disconnect:${connector.id}`,
                        () => onDisconnectConnector(connector.id),
                      )
                    }
                  : undefined
              }
              onQueryChange={setConnectorQuery}
              onReauthorize={
                onReauthorizeConnector
                  ? (connector) =>
                      void runAction(
                        `connector:reauth:${connector.id}`,
                        () => onReauthorizeConnector(connector.id),
                      )
                  : undefined
              }
              onResolveSyncConflict={
                onResolveSyncConflict
                  ? (conflict) => {
                      const resolution =
                        conflictResolutions[conflict.id]
                      if (!resolution) return

                      let mergedValues:
                        | Record<string, unknown>
                        | undefined

                      if (resolution === 'merge') {
                        try {
                          mergedValues = parseConflictMergedValues(
                            conflict,
                            conflictMergedValueDrafts[conflict.id],
                          )
                          setConflictMergeErrors((current) => ({
                            ...current,
                            [conflict.id]: undefined,
                          }))
                        } catch {
                          setConflictMergeErrors((current) => ({
                            ...current,
                            [conflict.id]: labels.helpText.mergeInvalid,
                          }))
                          return
                        }
                      }

                      if (
                        !window.confirm(
                          interpolate(
                            labels.helpText.conflictResolveConfirm,
                            {
                              resolution:
                                labels.actions[resolution] ?? resolution,
                              workItem: conflict.workItemId,
                            },
                          ),
                        )
                      ) {
                        return
                      }

                      void runAction(
                        `sync-conflict:resolve:${conflict.id}`,
                        () =>
                          onResolveSyncConflict({
                            conflictId: conflict.id,
                            resolution,
                            ...(mergedValues ? { mergedValues } : {}),
                          }),
                      )
                    }
                  : undefined
              }
              onConflictResolutionChange={(conflictId, resolution) =>
                setConflictResolutions((current) => ({
                  ...current,
                  [conflictId]: resolution,
                }))
              }
              onConflictMergedValueChange={(
                conflictId,
                field,
                value,
              ) => {
                setConflictMergedValueDrafts((current) => ({
                  ...current,
                  [conflictId]: {
                    ...current[conflictId],
                    [field]: value,
                  },
                }))
                setConflictMergeErrors((current) => ({
                  ...current,
                  [conflictId]: undefined,
                }))
              }}
              onLoadMoreSyncConflicts={onLoadMoreSyncConflicts}
              onRetrySyncConflicts={onRetrySyncConflicts}
            />
          ) : null}

          {activeSection === 'imports' ? (
            <ImportExportSection
              busyOperation={busyOperation}
              canExport={resources.capabilities.canExport}
              canImport={resources.capabilities.canImport}
              exportingFormat={exportingFormat}
              format={importFormat}
              importFile={importFile}
              importMappings={importMappings}
              importProjectId={importProjectId}
              importProjectOptions={availableImportProjectOptions}
              importTeamId={importTeamId}
              importTeamOptions={importTeamOptions}
              labels={labels}
              latestImport={latestImport}
              previewReport={previewImportReport}
              onCommit={
                onCommitImport &&
                validatedImportInput &&
                previewImportReport?.valid
                  ? () =>
                      void runAction('import:commit', async () => {
                        await onCommitImport(validatedImportInput)
                        setPreviewImportReport(undefined)
                        setValidatedImportInput(undefined)
                      })
                  : undefined
              }
              onExport={onExport ? handleExport : undefined}
              onFileChange={(file) => {
                setImportFile(file)
                setPreviewImportReport(undefined)
                setValidatedImportInput(undefined)
              }}
              onFormatChange={(format) => {
                setImportFormat(format)
                setPreviewImportReport(undefined)
                setValidatedImportInput(undefined)
              }}
              onMappingChange={(mappings) => {
                setImportMappings(mappings)
                setPreviewImportReport(undefined)
                setValidatedImportInput(undefined)
              }}
              onProjectChange={(projectId) => {
                setImportProjectId(projectId)
                setPreviewImportReport(undefined)
                setValidatedImportInput(undefined)
              }}
              onSubmit={onDryRunImport ? handleDryRun : undefined}
              onTeamChange={(teamId) => {
                setImportTeamId(teamId)
                if (
                  !importProjectOptions.some(
                    (option) =>
                      option.teamId === teamId &&
                      option.value === importProjectId,
                  )
                ) {
                  setImportProjectId('')
                }
                setPreviewImportReport(undefined)
                setValidatedImportInput(undefined)
              }}
            />
          ) : null}
        </div>
      </div>

      {editorDialog ? (
        <EditorDialog
          apiKeyExpiry={apiKeyExpiry}
          apiKeyName={apiKeyName}
          apiKeyScopes={apiKeyScopes}
          busyOperation={busyOperation}
          kind={editorDialog}
          labels={labels}
          oauthExpiry={oauthExpiry}
          oauthGrantTypes={oauthGrantTypes}
          oauthName={oauthName}
          oauthScopes={oauthScopes}
          webhookEvents={webhookEvents}
          webhookName={webhookName}
          webhookScopes={webhookScopes}
          webhookTeamIds={webhookTeamIds}
          webhookTeamOptions={importTeamOptions}
          webhookUrl={webhookUrl}
          onApiKeyExpiryChange={setApiKeyExpiry}
          onApiKeyNameChange={setApiKeyName}
          onApiKeyScopesChange={setApiKeyScopes}
          onOAuthExpiryChange={setOAuthExpiry}
          onOAuthGrantTypesChange={setOAuthGrantTypes}
          onOAuthNameChange={setOAuthName}
          onOAuthScopesChange={setOAuthScopes}
          onRequestClose={closeEditor}
          onSubmitApiKey={handleCreateApiKey}
          onSubmitOAuthApp={handleCreateOAuthApp}
          onSubmitWebhook={handleCreateWebhook}
          onWebhookEventsChange={setWebhookEvents}
          onWebhookNameChange={setWebhookName}
          onWebhookScopesChange={setWebhookScopes}
          onWebhookTeamIdsChange={setWebhookTeamIds}
          onWebhookUrlChange={setWebhookUrl}
        />
      ) : null}

      {secretDialog ? (
        <SecretDialog
          copied={secretCopied}
          copyErrorMessage={secretCopyError}
          labels={labels}
          state={secretDialog}
          stored={secretStored}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(secretDialog.value)
              setSecretCopied(true)
              setSecretCopyError(undefined)
            } catch {
              setSecretCopyError(labels.helpText.secretCopyError)
            }
          }}
          onStoredChange={setSecretStored}
          onRequestClose={() => {
            setSecretDialog(undefined)
            setSecretCopied(false)
            setSecretCopyError(undefined)
            setSecretStored(false)
            restoreDialogTrigger()
          }}
        />
      ) : null}
    </section>
  )
}
