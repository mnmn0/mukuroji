import { useRef, useState } from 'react'
import type {
  CreateCustomerRequestFromTriageInput,
  Customer,
  CustomerRequest,
} from '@mukuroji/contracts'
import type { AiAssistanceController } from '../../features/ai-assistance/mutations/useAiAssistanceController'
import type { MessageKey } from '../../shared/i18n/i18n'
import { ShieldIcon } from '../../shared/ui/icons'
import type {
  TriageActionInput,
  TriageBulkActionInput,
  TriageBulkItemResult,
  TriageBulkOperation,
  TriageConfiguration,
  TriageEntry,
  TriageQueueCounts,
  TriageQueueFilters,
  UpdateTriageConfigurationInput,
} from '../api'
import type { TriageRouteView } from '../model/queryState'
import type { TriageEntryView } from '../model/triageView'
import { TriageBulkToolbar } from './TriageBulkToolbar'
import { TriageEntryDetail } from './TriageEntryDetail'
import { TriageQueue } from './TriageQueue'
import { TriageSettingsPanel } from './TriageSettingsPanel'

/** Props accepted by the complete Team triage workbench, including queue, detail, and mutation state. */
export type TriageWorkbenchProps = {
  /** Active Workspace member bearer token used only for explicit AI generation. */
  readonly accessToken?: string
  /** Whether the dependent AI API deployment has enabled the route-level controls. */
  readonly aiAssistanceEnabled?: boolean
  /** Optional AI controller override for isolated interaction stories. */
  readonly aiAssistanceController?: AiAssistanceController
  /** Reports authenticated AI failures to the owning Team route session guard. */
  readonly onAuthenticatedApiError?: (error: unknown) => void
  /** Team route identifier used for permission-scoped generation references. */
  readonly teamId: string
  /** Permission-safe bulk operation kinds enabled for the Team queue. */
  readonly allowedBulkActions: readonly TriageBulkOperation['action'][]
  /** Team display name shown in the surface label. */
  readonly teamName: string
  /** Project IDs currently visible to the viewer in this Team directory. */
  readonly visibleProjectIds?: readonly string[]
  /** Active non-guest members keyed by their current Team-qualified Project. */
  readonly eligibleAssigneeIdsByProject?: ReadonlyMap<string, ReadonlySet<string>>
  /** Active queue or settings surface. */
  readonly routeView: TriageRouteView
  /** Visible permission-safe queue entries. */
  readonly entries: readonly TriageEntryView[]
  /** Selected entry detail view. */
  readonly selectedEntry?: TriageEntryView
  /** Entry ID explicitly represented in the URL for mobile drill-in. */
  readonly explicitEntryId?: string
  /** Entry IDs selected for bulk operations. */
  readonly selectedEntryIds: readonly string[]
  /** Active URL-backed filters. */
  readonly filters: TriageQueueFilters
  /** Derived queue summary counts. */
  readonly counts: TriageQueueCounts
  /** Whether the queue is loading. */
  readonly isQueueLoading?: boolean
  /** Whether another queue page is loading. */
  readonly isQueueLoadingMore?: boolean
  /** Whether another queue page exists. */
  readonly hasMore?: boolean
  /** Whether the queue is unavailable because of permission. */
  readonly isQueuePermissionDenied?: boolean
  /** Safe queue load error message. */
  readonly queueErrorMessage?: string
  /** Whether selected detail is loading. */
  readonly isDetailLoading?: boolean
  /** Safe detail or action error message. */
  readonly detailErrorMessage?: string
  /** Entry currently running a single-entry action. */
  readonly pendingEntryId?: string
  /** Whether a bulk action is running. */
  readonly isBulkPending?: boolean
  /** Latest per-entry bulk results. */
  readonly bulkResults?: readonly TriageBulkItemResult[]
  /** Loaded Team triage configuration. */
  readonly configuration?: TriageConfiguration
  /** Whether Team configuration is loading. */
  readonly isConfigurationLoading?: boolean
  /** Safe configuration load or save error. */
  readonly configurationErrorMessage?: string
  /** Whether the current principal may update Team triage configuration. */
  readonly canManageConfiguration: boolean
  /** Whether Team configuration is being saved. */
  readonly isSavingConfiguration?: boolean
  /** Whether the latest Team configuration replacement succeeded. */
  readonly didSaveConfiguration?: boolean
  /** Current locale used for dates. */
  readonly locale: 'ja' | 'en'
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Replaces the active queue or settings surface. */
  readonly onViewChange: (view: TriageRouteView) => void
  /** Replaces active URL-backed filters. */
  readonly onFiltersChange: (filters: TriageQueueFilters) => void
  /** Opens one entry detail. */
  readonly onSelectEntry: (entryId: string) => void
  /** Returns from mobile detail to the queue. */
  readonly onBackToQueue: () => void
  /** Adds or removes one entry from bulk selection. */
  readonly onEntrySelectionChange: (entryId: string, selected: boolean) => void
  /** Adds or removes all visible bulk-capable entries. */
  readonly onVisibleSelectionChange: (entryIds: readonly string[], selected: boolean) => void
  /** Clears bulk selection. */
  readonly onClearSelection: () => void
  /** Loads another queue page. */
  readonly onLoadMore?: () => void
  /** Retries queue loading. */
  readonly onRetryQueue?: () => void
  /** Retries selected detail loading. */
  readonly onRetryDetail?: () => void
  /** Retries configuration loading. */
  readonly onRetryConfiguration?: () => void
  /** Applies one explicit entry action. */
  readonly onAction?: (
    entryId: string,
    input: TriageActionInput,
  ) => Promise<TriageEntry>
  /** Saves one accepted Triage Entry as a Customer Request. */
  readonly onCreateCustomerRequest?: (
    entryId: string,
    input: CreateCustomerRequestFromTriageInput,
  ) => Promise<CustomerRequest>
  /** Customers currently visible to the current Workspace member. */
  readonly customerOptions?: readonly Pick<Customer, 'id' | 'name'>[]
  /** Whether the Customer picker is still loading. */
  readonly isCustomerOptionsLoading?: boolean
  /** Whether another Customer picker page is available. */
  readonly hasMoreCustomerOptions?: boolean
  /** Whether another Customer picker page is loading. */
  readonly isLoadingMoreCustomerOptions?: boolean
  /** Safe error message when the Customer picker cannot load its options. */
  readonly customerOptionsErrorMessage?: string
  /** Retries loading Customer picker options. */
  readonly onRetryCustomerOptions?: () => void
  /** Loads exactly one additional Customer picker page. */
  readonly onLoadMoreCustomerOptions?: () => void
  /** Applies one explicit bounded bulk action. */
  readonly onBulkAction?: (
    input: TriageBulkActionInput,
  ) => Promise<readonly TriageBulkItemResult[]>
  /** Persists revision-fenced Team triage configuration. */
  readonly onSaveConfiguration?: (
    input: UpdateTriageConfigurationInput,
  ) => Promise<TriageConfiguration>
}

/**
 * Renders the complete responsive Team triage queue, detail, bulk, and settings surface.
 *
 * @param props - Queue, detail, settings, permission, and mutation state.
 * @returns Team triage workbench inside the shared Workspace shell.
 */
export function TriageWorkbench({
  accessToken,
  aiAssistanceEnabled = true,
  allowedBulkActions,
  aiAssistanceController,
  bulkResults = [],
  canManageConfiguration,
  configuration,
  configurationErrorMessage,
  counts,
  detailErrorMessage,
  didSaveConfiguration = false,
  entries,
  explicitEntryId,
  filters,
  hasMore = false,
  hasMoreCustomerOptions = false,
  isBulkPending = false,
  isCustomerOptionsLoading = false,
  isLoadingMoreCustomerOptions = false,
  customerOptionsErrorMessage,
  isConfigurationLoading = false,
  isDetailLoading = false,
  isQueueLoading = false,
  isQueueLoadingMore = false,
  isQueuePermissionDenied = false,
  isSavingConfiguration = false,
  locale,
  onAuthenticatedApiError,
  onAction,
  onBackToQueue,
  onBulkAction,
  onCreateCustomerRequest,
  onClearSelection,
  onEntrySelectionChange,
  onFiltersChange,
  onLoadMore,
  onRetryConfiguration,
  onRetryDetail,
  onRetryQueue,
  onRetryCustomerOptions,
  onLoadMoreCustomerOptions,
  onSaveConfiguration,
  onSelectEntry,
  onViewChange,
  onVisibleSelectionChange,
  pendingEntryId,
  queueErrorMessage,
  routeView,
  selectedEntry,
  selectedEntryIds,
  t,
  teamId,
  teamName,
  customerOptions,
  eligibleAssigneeIdsByProject,
  visibleProjectIds,
}: TriageWorkbenchProps) {
  const queueRegion = useRef<HTMLDivElement>(null)
  const [isAiOperationPending, setIsAiOperationPending] = useState(false)
  const isAiOperationPendingRef = useRef(false)
  const selectedIds = new Set(selectedEntryIds)
  const selectedBulkEntries = entries.filter((view) => selectedIds.has(view.entry.id))

  /** Keeps the triage source fence synchronized before React renders. */
  const reportAiOperationPending = (pending: boolean) => {
    isAiOperationPendingRef.current = pending
    setIsAiOperationPending(pending)
  }

  /** Ignores entry changes while an AI operation is awaiting its response. */
  const selectEntry = (entryId: string) => {
    if (isAiOperationPendingRef.current) return
    onSelectEntry(entryId)
  }

  /** Keeps the active triage detail mounted while an AI operation is pending. */
  const backToQueue = () => {
    if (isAiOperationPendingRef.current) return
    onBackToQueue()
  }

  /** Keeps the active triage source mounted while an AI operation is pending. */
  const changeView = (view: TriageRouteView) => {
    if (isAiOperationPendingRef.current) return
    onViewChange(view)
  }

  /** Returns keyboard navigation to the mutated row or the next visible row. */
  const restoreQueueFocus = (entryId: string) => {
    const isMobile = typeof window !== 'undefined' &&
      window.matchMedia?.('(max-width: 860px)').matches === true
    if (isMobile) backToQueue()
    /** Focuses a visible queue row after route and cache updates render. */
    const focusEntry = () => {
      const region = queueRegion.current
      if (!region) return
      const rows = region.querySelectorAll<HTMLButtonElement>('[data-triage-entry-id]')
      const target = Array.from(rows).find((row) => row.dataset.triageEntryId === entryId) ??
        rows.item(0)
      if (target) target.focus()
      else region.focus()
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusEntry)
    } else {
      focusEntry()
    }
  }

  return (
    <div className="grid gap-4 px-[clamp(16px,3vw,34px)] py-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--workbench-border)] pb-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{teamName}</p>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{t('triage.surface.description')}</p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label={t('triage.tabs.aria')}>
          <ViewTab active={routeView === 'queue'} disabled={isAiOperationPending} label={t('triage.tab.queue')} onClick={() => changeView('queue')} />
          <ViewTab active={routeView === 'settings'} disabled={isAiOperationPending} label={t('triage.tab.settings')} onClick={() => changeView('settings')} />
        </div>
      </div>

      <section className="workbench-panel min-h-[620px] overflow-hidden" data-testid="triage-workbench">
        {routeView === 'settings' ? (
          <TriageSettingsPanel
            canManage={canManageConfiguration}
            configuration={configuration}
            errorMessage={configurationErrorMessage}
            didSave={didSaveConfiguration}
            isLoading={isConfigurationLoading}
            isSaving={isSavingConfiguration}
            key={configuration ? `${configuration.teamId}:${configuration.revision}` : 'triage-settings'}
            onRetry={onRetryConfiguration}
            onSave={onSaveConfiguration}
            t={t}
          />
        ) : isQueuePermissionDenied ? (
          <PermissionDeniedState message={t('triage.queue.permissionDenied')} t={t} />
        ) : (
          <>
            {selectedBulkEntries.length > 0 && onBulkAction ? (
              <TriageBulkToolbar
                allowedActions={allowedBulkActions}
                entries={selectedBulkEntries}
                errorMessage={detailErrorMessage}
                isAiOperationPending={isAiOperationPending}
                isPending={isBulkPending}
                onApply={onBulkAction}
                onClear={onClearSelection}
                results={bulkResults}
                t={t}
              />
            ) : null}
            <div className="grid min-h-[620px] grid-cols-[minmax(320px,390px)_minmax(0,1fr)] max-[860px]:grid-cols-1">
              <div
                className={explicitEntryId ? 'max-[860px]:hidden' : ''}
                ref={queueRegion}
                tabIndex={-1}
              >
                <TriageQueue
                  allowedBulkActions={allowedBulkActions}
                  counts={counts}
                  entries={entries}
                  errorMessage={queueErrorMessage}
                  filters={filters}
                  hasMore={hasMore}
                  isAiOperationPending={isAiOperationPending}
                  isLoading={isQueueLoading}
                  isLoadingMore={isQueueLoadingMore}
                  locale={locale}
                  onEntrySelectionChange={onEntrySelectionChange}
                  onFiltersChange={onFiltersChange}
                  onLoadMore={onLoadMore}
                  onRetry={onRetryQueue}
                  onSelectEntry={selectEntry}
                  onVisibleSelectionChange={onVisibleSelectionChange}
                  selectedEntryId={selectedEntry?.entry.id}
                  selectedEntryIds={selectedEntryIds}
                  t={t}
                />
              </div>
              <div className={explicitEntryId ? '' : 'max-[860px]:hidden'}>
                <TriageEntryDetail
                  accessToken={accessToken}
                  aiAssistanceController={aiAssistanceController}
                  aiAssistanceEnabled={aiAssistanceEnabled}
                  onAuthenticatedApiError={onAuthenticatedApiError}
                  isAiOperationPending={isAiOperationPending}
                  onOperationPendingChange={reportAiOperationPending}
                  errorMessage={detailErrorMessage}
                  isLoading={isDetailLoading}
                  isPending={pendingEntryId === selectedEntry?.entry.id}
                  key={`${teamId}:${selectedEntry?.entry.id ?? 'triage-detail'}`}
                  locale={locale}
                  onAction={onAction}
                  onActionComplete={restoreQueueFocus}
                  onBack={backToQueue}
                  onCreateCustomerRequest={onCreateCustomerRequest}
                  customerOptions={customerOptions}
                  customerOptionsErrorMessage={customerOptionsErrorMessage}
                  hasMoreCustomerOptions={hasMoreCustomerOptions}
                  isCustomerOptionsLoading={isCustomerOptionsLoading}
                  isLoadingMoreCustomerOptions={isLoadingMoreCustomerOptions}
                  onLoadMoreCustomerOptions={onLoadMoreCustomerOptions}
                  onRetry={onRetryDetail}
                  onRetryCustomerOptions={onRetryCustomerOptions}
                  t={t}
                  teamId={teamId}
                  eligibleAssigneeIdsByProject={eligibleAssigneeIdsByProject}
                  visibleProjectIds={visibleProjectIds}
                  view={selectedEntry}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/** Props for one accessible workbench surface tab. */
type ViewTabProps = {
  /** Whether this tab is currently selected. */
  active: boolean
  /** Whether this tab is temporarily unavailable. */
  disabled?: boolean
  /** Visible and accessible tab label. */
  label: string
  /** Activates the tab's route transition. */
  onClick: () => void
}

/**
 * Renders one accessible workbench surface tab.
 *
 * @param props - Selection, disabled state, label, and activation callback.
 * @returns A semantic tab button for the Team triage workbench.
 */
function ViewTab({ active, disabled = false, label, onClick }: ViewTabProps) {
  return (
    <button
      aria-selected={active}
      className={`min-h-10 border-b-2 px-4 text-sm font-semibold ${active
        ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
        : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'} disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  )
}

/** Renders the dedicated Team queue permission boundary. */
function PermissionDeniedState({ message, t }: {
  message: string
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid min-h-[520px] place-items-center p-8 text-center" data-testid="triage-permission-denied">
      <div className="max-w-md">
        <ShieldIcon className="mx-auto h-9 w-9 fill-none stroke-[var(--workbench-primary)] stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--workbench-text)]">{t('triage.permission.deniedTitle')}</h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{message}</p>
      </div>
    </div>
  )
}
