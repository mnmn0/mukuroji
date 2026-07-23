import type {
  ConnectorInstallation,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  formatConflictMergeDraft,
  formatSyncConflictValue,
  isDeveloperSyncConflictResolution,
  type DeveloperConnectorCatalogItem,
  type DeveloperSyncConflictResolution,
} from '../model/connectors'
import { EmptyState, SectionHeader } from './DeveloperPlatformSectionParts'
import { StatusBadge } from './DeveloperPlatformStatus'
import type { DeveloperPlatformLabels } from './DeveloperPlatformView'

const developerSyncConflictResolutionOptions: readonly DeveloperSyncConflictResolution[] = [
  'keep-local',
  'keep-remote',
  'merge',
  'ignore',
]

/**
 * Props for the Developer Platform connector and synchronization-conflict section.
 */
export type ConnectorsSectionProps = {
  /** Operation key for the mutation currently in progress. */
  busyOperation?: string
  /** Whether connector and conflict mutations are available. */
  canManage: boolean
  /** Connector catalog entries that match the current search query. */
  catalog: DeveloperConnectorCatalogItem[]
  /** Validation messages keyed by synchronization-conflict identifier. */
  conflictMergeErrors: Record<string, string | undefined>
  /** Editable JSON merge drafts keyed by conflict and field identifiers. */
  conflictMergedValueDrafts: Record<string, Record<string, string>>
  /** Selected resolution keyed by synchronization-conflict identifier. */
  conflictResolutions: Partial<
    Record<string, DeveloperSyncConflictResolution>
  >
  /** Current connector installations. */
  connectors: ConnectorInstallation[]
  /** Formats an ISO timestamp for display. */
  formatDateTime: (value: string) => string
  /** Whether an additional conflict page is currently loading. */
  isLoadingMoreSyncConflicts?: boolean
  /** Whether the initial conflict page is currently loading. */
  isSyncConflictsLoading?: boolean
  /** Localized labels used by the section. */
  labels: DeveloperPlatformLabels
  /** Current connector catalog search query. */
  query: string
  /** Loaded synchronization conflicts. */
  syncConflicts: WorkItemSyncConflict[]
  /** Error message shown when the initial conflict page cannot be loaded. */
  syncConflictsErrorMessage?: string
  /** Whether another synchronization-conflict page is available. */
  syncConflictsHasMore?: boolean
  /** Error message shown while retaining conflicts from previously loaded pages. */
  syncConflictsLoadMoreErrorMessage?: string
  /** Starts a new connector authorization flow for a catalog entry. */
  onConnect?: (item: DeveloperConnectorCatalogItem) => void
  /** Updates an editable JSON merge draft for one conflict field. */
  onConflictMergedValueChange: (
    conflictId: string,
    field: string,
    value: string,
  ) => void
  /** Updates the selected resolution for a synchronization conflict. */
  onConflictResolutionChange: (
    conflictId: string,
    value: DeveloperSyncConflictResolution,
  ) => void
  /** Disconnects an installed connector account. */
  onDisconnect?: (connector: ConnectorInstallation) => void
  /** Loads the next synchronization-conflict page. */
  onLoadMoreSyncConflicts?: () => Promise<void> | void
  /** Updates the connector catalog search query. */
  onQueryChange: (value: string) => void
  /** Restarts authorization for an installed connector account. */
  onReauthorize?: (connector: ConnectorInstallation) => void
  /** Resolves an open synchronization conflict. */
  onResolveSyncConflict?: (conflict: WorkItemSyncConflict) => void
  /** Retries synchronization-conflict loading. */
  onRetrySyncConflicts?: () => Promise<void> | void
}

/**
 * Renders connector installations and synchronization-conflict resolution controls.
 *
 * @param props - Connector catalog, conflict state, and action callbacks.
 * @returns The pure connector management section.
 */
export function ConnectorsSection({
  busyOperation,
  canManage,
  catalog,
  conflictMergeErrors,
  conflictMergedValueDrafts,
  conflictResolutions,
  connectors,
  formatDateTime,
  isLoadingMoreSyncConflicts,
  isSyncConflictsLoading,
  labels,
  query,
  syncConflicts,
  syncConflictsErrorMessage,
  syncConflictsHasMore,
  syncConflictsLoadMoreErrorMessage,
  onConnect,
  onConflictMergedValueChange,
  onConflictResolutionChange,
  onDisconnect,
  onLoadMoreSyncConflicts,
  onQueryChange,
  onReauthorize,
  onResolveSyncConflict,
  onRetrySyncConflicts,
}: ConnectorsSectionProps) {
  return (
    <div className="grid min-w-0 gap-8">
      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.syncConflicts}
          title={labels.headings.syncConflicts}
        />

        {isSyncConflictsLoading ? (
          <div
            aria-label={labels.helpText.syncConflictsLoading}
            className="mt-4 grid gap-3"
            role="status"
          >
            <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
          </div>
        ) : syncConflictsErrorMessage ? (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
            role="alert"
          >
            <p className="text-sm font-semibold text-red-800">
              {syncConflictsErrorMessage}
            </p>
            {onRetrySyncConflicts ? (
              <button
                className="workbench-button-secondary min-h-9 px-3"
                onClick={() => void onRetrySyncConflicts()}
                type="button"
              >
                {labels.retry}
              </button>
            ) : null}
          </div>
        ) : syncConflicts.length ? (
          <div className="mt-4 grid gap-3">
            {syncConflicts.map((conflict) => {
              const resolution = conflictResolutions[conflict.id]
              const isOpen = conflict.status === 'open'

              return (
                <article
                  className={`rounded-lg border p-4 ${
                    isOpen
                      ? 'border-amber-300 bg-amber-50/50'
                      : 'border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)]'
                  }`}
                  key={conflict.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--workbench-text)]">
                        {labels.fields.workItem}:{' '}
                        <span className="font-mono">
                          {conflict.workItemId}
                        </span>
                      </p>
                      <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                        {labels.fields.detectedAt}:{' '}
                        {formatDateTime(conflict.detectedAt)}
                      </p>
                    </div>
                    <StatusBadge labels={labels} status={conflict.status} />
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-[var(--workbench-border)] pt-4 text-xs max-[640px]:grid-cols-1">
                    <div>
                      <dt className="font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.externalLink}
                      </dt>
                      <dd className="mt-1 break-all font-mono text-[var(--workbench-text)]">
                        {conflict.externalLinkId}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.revisions}
                      </dt>
                      <dd className="mt-1 text-[var(--workbench-text)]">
                        {labels.fields.localRevision}{' '}
                        <span className="font-mono">
                          {conflict.localRevision}
                        </span>
                        {' · '}
                        {labels.fields.externalRevision}{' '}
                        <span className="font-mono">
                          {conflict.externalRevision}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 grid gap-2">
                    {conflict.fields.map((field) => (
                      <div
                        className="rounded-md border border-[var(--workbench-border)] bg-white p-3"
                        key={field.field}
                      >
                        <p className="font-mono text-xs font-semibold text-[var(--workbench-text)]">
                          {field.field}
                        </p>
                        <dl className="mt-2 grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
                          <div>
                            <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
                              {labels.fields.localValue}
                            </dt>
                            <dd className="mt-1 break-words whitespace-pre-wrap text-sm text-[var(--workbench-text)]">
                              {formatSyncConflictValue(
                                field.localValue,
                                labels.helpText.notAvailable,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
                              {labels.fields.externalValue}
                            </dt>
                            <dd className="mt-1 break-words whitespace-pre-wrap text-sm text-[var(--workbench-text)]">
                              {formatSyncConflictValue(
                                field.externalValue,
                                labels.helpText.notAvailable,
                              )}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>

                  {isOpen && resolution === 'merge' ? (
                    <fieldset className="mt-4 grid gap-3 rounded-lg border border-[#99d7cf] bg-[#f4fbfa] p-3">
                      <legend className="px-1 text-xs font-semibold text-[#116b63]">
                        {labels.fields.mergedValues}
                      </legend>
                      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                        {labels.helpText.mergedValues}
                      </p>
                      {conflict.fields.map((field) => (
                        <label
                          className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]"
                          key={field.field}
                        >
                          <span className="font-mono">{field.field}</span>
                          <textarea
                            className="workbench-input min-h-20 px-3 py-2 font-mono text-xs"
                            spellCheck={false}
                            value={
                              conflictMergedValueDrafts[conflict.id]?.[
                                field.field
                              ] ?? formatConflictMergeDraft(field.localValue)
                            }
                            onChange={(event) =>
                              onConflictMergedValueChange(
                                conflict.id,
                                field.field,
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      ))}
                      {conflictMergeErrors[conflict.id] ? (
                        <p className="text-xs font-semibold text-red-700" role="alert">
                          {conflictMergeErrors[conflict.id]}
                        </p>
                      ) : null}
                    </fieldset>
                  ) : null}

                  {isOpen && canManage && onResolveSyncConflict ? (
                    <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] pt-4">
                      <label className="grid min-w-[220px] flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.conflictResolution}
                        <select
                          className="workbench-input min-h-9 px-3"
                          value={resolution ?? ''}
                          onChange={(event) => {
                            const nextResolution = event.target.value

                            if (
                              isDeveloperSyncConflictResolution(nextResolution)
                            ) {
                              onConflictResolutionChange(
                                conflict.id,
                                nextResolution,
                              )
                            }
                          }}
                        >
                          <option disabled value="">
                            {labels.actions.chooseResolution}
                          </option>
                          {developerSyncConflictResolutionOptions.map((option) => (
                            <option key={option} value={option}>
                              {labels.actions[option]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="workbench-button-primary min-h-9 px-3"
                        disabled={
                          !resolution ||
                          busyOperation?.endsWith(conflict.id)
                        }
                        onClick={() => onResolveSyncConflict(conflict)}
                        type="button"
                      >
                        {labels.actions.resolve}
                      </button>
                    </div>
                  ) : null}
                </article>
              )
            })}
            {syncConflictsLoadMoreErrorMessage ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
                role="alert"
              >
                <p className="text-sm font-semibold text-red-800">
                  {syncConflictsLoadMoreErrorMessage}
                </p>
                {onRetrySyncConflicts ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    onClick={() => void onRetrySyncConflicts()}
                    type="button"
                  >
                    {labels.retry}
                  </button>
                ) : null}
              </div>
            ) : null}
            {syncConflictsHasMore && onLoadMoreSyncConflicts ? (
              <button
                className="workbench-button-secondary min-h-10 w-full px-4 disabled:opacity-50"
                disabled={isLoadingMoreSyncConflicts}
                onClick={() => void onLoadMoreSyncConflicts()}
                type="button"
              >
                {isLoadingMoreSyncConflicts
                  ? labels.actions.loadingMore
                  : labels.actions.loadMore}
              </button>
            ) : null}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.syncConflictsEmpty}
            title={labels.headings.syncConflictsEmpty}
          />
        )}
      </section>

      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.connectors}
          title={labels.headings.connectors}
        />
        <label className="mt-4 grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {labels.fields.resourceSearch}
          <input
            className="workbench-input min-h-10 px-3 normal-case tracking-normal"
            placeholder={labels.placeholders.resourceSearch}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>

        {catalog.length ? (
          <div className="mt-4 grid grid-cols-2 gap-4 max-[1180px]:grid-cols-1">
            {catalog.map((item) => {
              const providerConnectors = connectors.filter(
                (installation) => installation.provider === item.provider,
              )
              const needsAttention = providerConnectors.some(
                (connector) =>
                  connector.status === 'needs-reauth' ||
                  connector.status === 'degraded' ||
                  connector.status === 'conflict',
              )

              return (
                <article
                  className={`rounded-lg border p-4 ${
                    needsAttention
                      ? 'border-amber-300 bg-amber-50/50'
                      : 'border-[var(--workbench-border)]'
                  }`}
                  key={item.provider}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="workbench-badge">
                        {item.categoryLabel}
                      </span>
                      <h4 className="mt-3 font-semibold text-[var(--workbench-text)]">
                        {item.name}
                      </h4>
                      <p className="mt-1 text-sm font-medium leading-5 text-[var(--workbench-muted)]">
                        {item.description}
                      </p>
                    </div>
                    <span className="workbench-badge">
                      {labels.helpText.connectorCount.replace(
                        '{count}',
                        String(providerConnectors.length),
                      )}
                    </span>
                  </div>

                  {providerConnectors.length ? (
                    <div className="mt-4 grid gap-3 border-t border-[var(--workbench-border)] pt-4">
                      {providerConnectors.map((connector) => {
                        const needsRecovery =
                          connector.status === 'needs-reauth' ||
                          connector.status === 'degraded'
                        const hasConflict = connector.status === 'conflict'
                        const isDisconnected =
                          connector.status === 'disconnected'

                        return (
                          <div
                            className="rounded-md border border-[var(--workbench-border)] bg-white p-3"
                            data-testid={`connector-installation-${connector.id}`}
                            key={connector.id}
                          >
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">
                                  {connector.externalAccountName ??
                                    connector.externalAccountId ??
                                    connector.name}
                                </p>
                                <p className="mt-1 truncate text-xs font-medium text-[var(--workbench-muted)]">
                                  {connector.name}
                                </p>
                              </div>
                              <StatusBadge
                                labels={labels}
                                status={connector.status}
                              />
                            </div>
                            <p className="mt-3 text-xs font-medium text-[var(--workbench-muted)]">
                              {labels.tableHeaders.lastSync}:{' '}
                              {connector.lastSyncAt
                                ? formatDateTime(connector.lastSyncAt)
                                : labels.helpText.never}
                            </p>
                            {connector.lastError ? (
                              <p className="mt-2 text-xs font-semibold text-amber-800">
                                {connector.lastError.detail ??
                                  connector.lastError.title}
                              </p>
                            ) : null}
                            {hasConflict ? (
                              <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                                {labels.helpText.connectorConflict}
                              </p>
                            ) : null}
                            {canManage ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {isDisconnected && onReauthorize ? (
                                  <button
                                    className="workbench-button-primary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onReauthorize(connector)}
                                    type="button"
                                  >
                                    {labels.actions.connectAgain}
                                  </button>
                                ) : null}
                                {!isDisconnected &&
                                needsRecovery &&
                                onReauthorize ? (
                                  <button
                                    className="workbench-button-primary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onReauthorize(connector)}
                                    type="button"
                                  >
                                    {labels.actions.reauthorize}
                                  </button>
                                ) : null}
                                {!isDisconnected && onDisconnect ? (
                                  <button
                                    className="workbench-button-secondary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onDisconnect(connector)}
                                    type="button"
                                  >
                                    {labels.actions.disconnect}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="mt-4 border-t border-[var(--workbench-border)] pt-4 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                      {labels.helpText.noConnectorAccounts}
                    </p>
                  )}

                  {canManage && onConnect ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className={
                          providerConnectors.length
                            ? 'workbench-button-secondary min-h-9 px-3'
                            : 'workbench-button-primary min-h-9 px-3'
                        }
                        disabled={busyOperation?.endsWith(item.provider)}
                        onClick={() => onConnect(item)}
                        type="button"
                      >
                        {providerConnectors.length
                          ? labels.actions.addAccount
                          : labels.actions.connect}
                      </button>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.connectorSearchEmpty}
            title={labels.headings.connectorSearchEmpty}
          />
        )}
      </section>
    </div>
  )
}
