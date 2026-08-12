import { useRef, type KeyboardEvent } from 'react'
import { TRIAGE_BULK_ACTION_LIMIT } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { ClockIcon, ShieldIcon } from '../../shared/ui/icons'
import type {
  TriageEntryState,
  TriageBulkOperation,
  TriageQueueCounts,
  TriageQueueFilters,
  TriageSlaFilter,
  TriageSourceKind,
} from '../api'
import { resolveTriageNavigationIndex } from '../model/keyboard'
import type { TriageEntryView } from '../model/triageView'
import { TriageSourceIcon } from './TriageSourceIcon'

/** Props accepted by the Team triage queue list and filters. */
export type TriageQueueProps = {
  /** Bulk operation kinds enabled by the current Team configuration. */
  readonly allowedBulkActions: readonly TriageBulkOperation['action'][]
  /** Visible permission-filtered queue entries. */
  readonly entries: readonly TriageEntryView[]
  /** URL-backed filters controlling the visible queue. */
  readonly filters: TriageQueueFilters
  /** Whether initial queue data is loading. */
  readonly isLoading?: boolean
  /** Whether another cursor page is loading. */
  readonly isLoadingMore?: boolean
  /** Whether another cursor page exists. */
  readonly hasMore?: boolean
  /** Safe localized load error. */
  readonly errorMessage?: string
  /** Current locale used for dates. */
  readonly locale: 'ja' | 'en'
  /** Derived queue metrics. */
  readonly counts: TriageQueueCounts
  /** Entry selected in the detail pane. */
  readonly selectedEntryId?: string
  /** Entry IDs selected for a bulk operation. */
  readonly selectedEntryIds: readonly string[]
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Replaces active URL-backed filters. */
  readonly onFiltersChange: (filters: TriageQueueFilters) => void
  /** Loads another cursor page. */
  readonly onLoadMore?: () => void
  /** Retries the active queue query. */
  readonly onRetry?: () => void
  /** Opens one entry in the detail pane. */
  readonly onSelectEntry: (entryId: string) => void
  /** Adds or removes one entry from bulk selection. */
  readonly onEntrySelectionChange: (entryId: string, selected: boolean) => void
  /** Adds or removes all visible bulk-capable entries. */
  readonly onVisibleSelectionChange: (entryIds: readonly string[], selected: boolean) => void
}

const entryStates: readonly TriageEntryState[] = [
  'pending',
  'needs-information',
  'snoozed',
  'accepted',
  'duplicate',
  'declined',
]
const sourceKinds: readonly TriageSourceKind[] = [
  'form',
  'chat',
  'email',
  'webhook',
  'manual-handoff',
]
const slaFilters: readonly TriageSlaFilter[] = [
  'breached',
  'due-soon',
  'on-track',
  'paused',
]
const stateLabelKeys: Record<TriageEntryState, MessageKey> = {
  accepted: 'triage.state.accepted',
  declined: 'triage.state.declined',
  duplicate: 'triage.state.duplicate',
  'needs-information': 'triage.state.needsInformation',
  pending: 'triage.state.pending',
  snoozed: 'triage.state.snoozed',
}
const sourceLabelKeys: Record<TriageSourceKind, MessageKey> = {
  chat: 'triage.source.chat',
  email: 'triage.source.email',
  form: 'triage.source.form',
  'manual-handoff': 'triage.source.manualHandoff',
  webhook: 'triage.source.webhook',
}
const slaLabelKeys: Record<TriageSlaFilter, MessageKey> = {
  breached: 'triage.sla.breached',
  'due-soon': 'triage.sla.dueSoon',
  'on-track': 'triage.sla.onTrack',
  paused: 'triage.sla.paused',
}

/**
 * Renders the filterable, keyboard-navigable Team triage queue.
 *
 * @param props - Queue data, filters, selection, and callbacks.
 * @returns Responsive queue controls and entry rows.
 */
export function TriageQueue({
  allowedBulkActions,
  counts,
  entries,
  errorMessage,
  filters,
  hasMore = false,
  isLoading = false,
  isLoadingMore = false,
  locale,
  onEntrySelectionChange,
  onFiltersChange,
  onLoadMore,
  onRetry,
  onSelectEntry,
  onVisibleSelectionChange,
  selectedEntryId,
  selectedEntryIds,
  t,
}: TriageQueueProps) {
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const selectedIdSet = new Set(selectedEntryIds)
  const selectableEntries = entries.filter((view) => canBulkAct(view, allowedBulkActions))
  const visibleSelectionCandidates = selectableEntries.slice(0, TRIAGE_BULK_ACTION_LIMIT)
  const allVisibleSelected = visibleSelectionCandidates.length > 0 &&
    visibleSelectionCandidates.every((view) => selectedIdSet.has(view.entry.id))

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const nextIndex = resolveTriageNavigationIndex(index, event.key, entries.length)
    if (nextIndex === undefined) return
    const nextEntry = entries[nextIndex]
    if (!nextEntry) return
    event.preventDefault()
    onSelectEntry(nextEntry.entry.id)
    rowButtons.current.get(nextEntry.entry.id)?.focus()
  }

  return (
    <section
      aria-label={t('triage.queue.aria')}
      className="min-w-0 border-r border-[var(--workbench-border)] bg-white max-[860px]:border-r-0"
      data-testid="triage-queue"
    >
      <div className="border-b border-[var(--workbench-border)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--workbench-text)]">
              {t('triage.queue.title')}
            </h2>
            <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
              {t('triage.queue.visibleCount').replace('{count}', String(entries.length))}
            </p>
          </div>
          <label className="inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            <input
              aria-label={t('triage.bulk.selectVisible')}
              checked={allVisibleSelected}
              className="h-4 w-4 rounded border-[var(--workbench-border-strong)] text-[var(--workbench-primary)]"
              disabled={selectableEntries.length === 0}
              onChange={(event) => {
                const ids = event.target.checked
                  ? selectableEntries
                    .filter((view) => !selectedIdSet.has(view.entry.id))
                    .slice(0, Math.max(0, TRIAGE_BULK_ACTION_LIMIT - selectedIdSet.size))
                    .map((view) => view.entry.id)
                  : selectableEntries.map((view) => view.entry.id)
                onVisibleSelectionChange(ids, event.target.checked)
              }}
              type="checkbox"
            />
            {t('triage.bulk.selectVisible')}
          </label>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2" aria-label={t('triage.metrics.aria')}>
          <QueueMetric label={t('triage.metrics.pending')} value={counts.pending} />
          <QueueMetric label={t('triage.metrics.unowned')} value={counts.unowned} />
          <QueueMetric alert label={t('triage.metrics.breached')} value={counts.breached} />
        </div>

        <div className="mt-4 grid gap-2">
          <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('triage.filter.search')}
            <input
              className="workbench-input min-h-10 px-3 text-sm"
              onChange={(event) => onFiltersChange({
                ...filters,
                query: event.target.value || undefined,
              })}
              placeholder={t('triage.filter.searchPlaceholder')}
              type="search"
              value={filters.query ?? ''}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <FilterSelect
              label={t('triage.filter.state')}
              value={filters.state ?? ''}
              onChange={(value) => onFiltersChange({
                ...filters,
                state: readEntryState(value),
              })}
            >
              <option value="">{t('triage.filter.all')}</option>
              {entryStates.map((state) => (
                <option key={state} value={state}>{t(stateLabelKeys[state])}</option>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t('triage.filter.source')}
              value={filters.source ?? ''}
              onChange={(value) => onFiltersChange({
                ...filters,
                source: readSourceKind(value),
              })}
            >
              <option value="">{t('triage.filter.all')}</option>
              {sourceKinds.map((source) => (
                <option key={source} value={source}>{t(sourceLabelKeys[source])}</option>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t('triage.filter.owner')}
              value={filters.owner ?? 'all'}
              onChange={(value) => onFiltersChange({
                ...filters,
                owner: value === 'mine' || value === 'unowned' ? value : 'all',
              })}
            >
              <option value="all">{t('triage.filter.all')}</option>
              <option value="mine">{t('triage.filter.mine')}</option>
              <option value="unowned">{t('triage.filter.unowned')}</option>
            </FilterSelect>
            <FilterSelect
              label={t('triage.filter.sla')}
              value={filters.sla ?? ''}
              onChange={(value) => onFiltersChange({
                ...filters,
                sla: readSlaFilter(value),
              })}
            >
              <option value="">{t('triage.filter.all')}</option>
              {slaFilters.map((sla) => (
                <option key={sla} value={sla}>{t(slaLabelKeys[sla])}</option>
              ))}
            </FilterSelect>
          </div>
        </div>
      </div>

      {isLoading ? (
        <QueueSkeleton label={t('triage.queue.loading')} />
      ) : errorMessage ? (
        <div className="grid justify-items-start gap-3 p-5" role="alert">
          <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onRetry} type="button">
              {t('triage.queue.retry')}
            </button>
          ) : null}
        </div>
      ) : entries.length === 0 ? (
        <div className="grid min-h-52 place-items-center p-6 text-center">
          <div>
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {hasActiveFilters(filters)
                ? t('triage.queue.filteredEmpty')
                : t('triage.queue.empty')}
            </p>
            {hasActiveFilters(filters) ? (
              <button
                className="mt-3 min-h-10 px-3 text-sm font-semibold text-[var(--workbench-primary)]"
                onClick={() => onFiltersChange({ owner: 'all' })}
                type="button"
              >
                {t('triage.filter.clear')}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--workbench-border)]" data-testid="triage-entry-list">
          {entries.map((view, index) => {
            const entry = view.entry
            const isSelected = entry.id === selectedEntryId
            const isBulkSelectable = canBulkAct(view, allowedBulkActions)
            return (
              <li
                className={isSelected ? 'bg-[#effaf8]' : 'bg-white hover:bg-slate-50'}
                key={entry.id}
              >
                <div className="flex items-start gap-2 px-3 py-3">
                  <label className="grid min-h-10 w-8 flex-none place-items-center">
                    <span className="sr-only">
                      {t('triage.bulk.selectEntry').replace('{title}', view.title ?? entry.id)}
                    </span>
                    <input
                      checked={selectedIdSet.has(entry.id)}
                      className="h-4 w-4 rounded border-[var(--workbench-border-strong)] text-[var(--workbench-primary)]"
                      disabled={!isBulkSelectable ||
                        (!selectedIdSet.has(entry.id) && selectedIdSet.size >= TRIAGE_BULK_ACTION_LIMIT)}
                      onChange={(event) => onEntrySelectionChange(entry.id, event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                  <button
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={t('triage.queue.openEntry').replace('{title}', view.title ?? entry.id)}
                    className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)] focus-visible:ring-offset-2"
                    data-testid={`triage-entry-${entry.id}`}
                    data-triage-entry-id={entry.id}
                    onClick={() => onSelectEntry(entry.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    ref={(element) => {
                      if (element) rowButtons.current.set(entry.id, element)
                      else rowButtons.current.delete(entry.id)
                    }}
                    tabIndex={isSelected || (!selectedEntryId && index === 0) ? 0 : -1}
                    type="button"
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 flex-none place-items-center rounded-md border border-teal-100 bg-teal-50 text-[var(--workbench-primary)]">
                        <TriageSourceIcon className="h-5 w-5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" source={entry.source.kind} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <strong className="line-clamp-2 text-sm text-[var(--workbench-text)]">
                            {view.title ?? t('triage.permission.restrictedTitle')}
                          </strong>
                          <TriageStateBadge state={entry.state} t={t} />
                        </span>
                        <span className="mt-1 block truncate text-xs font-medium text-[var(--workbench-muted)]">
                          {entry.permission.visibility === 'denied'
                            ? t('triage.permission.denied')
                            : `${entry.requester.displayName} · ${view.sourceLabel}`}
                        </span>
                        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
                          <span>{formatDateTime(entry.lastActivityAt, locale)}</span>
                          <span>{entry.ownerUserId ?? t('triage.queue.unowned')}</span>
                          <SlaLabel state={view.slaState} t={t} />
                          {entry.permission.visibility !== 'full' ? (
                            <span className="inline-flex items-center gap-1">
                              <ShieldIcon className="h-3.5 w-3.5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
                              {t(`triage.permission.${entry.permission.visibility}`)}
                            </span>
                          ) : null}
                        </span>
                        {entry.capabilities.canViewInternalContext && view.routingCandidate ? (
                          <span className="mt-2 block truncate text-xs font-medium text-slate-500">
                            {view.routingCandidate.teamId}
                            {view.routingCandidate.projectId ? ` / ${view.routingCandidate.projectId}` : ''}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {hasMore ? (
        <div className="border-t border-[var(--workbench-border)] p-4 text-center">
          <button
            className="workbench-button-secondary min-h-10 px-5"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {isLoadingMore ? t('triage.queue.loadingMore') : t('triage.queue.loadMore')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/** Renders one compact visible-queue metric. */
function QueueMetric({ alert = false, label, value }: {
  alert?: boolean
  label: string
  value: number
}) {
  return (
    <div className={`border-l-2 pl-2 ${alert && value > 0 ? 'border-red-400' : 'border-teal-300'}`}>
      <strong className={`block text-lg ${alert && value > 0 ? 'text-red-700' : 'text-[var(--workbench-text)]'}`}>{value}</strong>
      <span className="block truncate text-[11px] font-semibold text-[var(--workbench-muted)]">{label}</span>
    </div>
  )
}

/** Renders one labeled queue filter control. */
function FilterSelect({ children, label, onChange, value }: {
  children: React.ReactNode
  label: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select
        className="workbench-input min-h-10 min-w-0 px-2 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  )
}

/** Renders stable placeholder rows while the queue loads. */
function QueueSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} className="divide-y divide-[var(--workbench-border)]" role="status">
      {[0, 1, 2, 3].map((index) => (
        <div className="animate-pulse px-4 py-4 motion-reduce:animate-none" key={index}>
          <div className="h-4 w-2/3 rounded bg-slate-200" />
          <div className="mt-3 h-3 w-1/2 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  )
}

/** Renders a localized semantic entry-state badge. */
function TriageStateBadge({ state, t }: {
  state: TriageEntryState
  t: (key: MessageKey) => string
}) {
  const tone = state === 'accepted'
    ? 'workbench-badge-success'
    : state === 'declined' || state === 'duplicate'
      ? 'workbench-badge-danger'
      : state === 'needs-information' || state === 'snoozed'
        ? 'workbench-badge'
        : 'workbench-badge-primary'
  return <span className={`${tone} flex-none`}>{t(stateLabelKeys[state])}</span>
}

/** Renders a localized SLA label with semantic urgency. */
function SlaLabel({ state, t }: {
  state: TriageSlaFilter
  t: (key: MessageKey) => string
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${state === 'breached' ? 'text-red-700' : state === 'due-soon' ? 'text-amber-700' : ''}`}>
      <ClockIcon className="h-3.5 w-3.5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
      {t(slaLabelKeys[state])}
    </span>
  )
}

/** Checks whether at least one enabled bulk action is available for an entry.
 *
 * @param view The permission-projected entry view.
 * @param allowedActions The Team policy returned with the queue page.
 * @returns Whether the entry may be selected for at least one enabled operation.
 */
function canBulkAct(
  view: TriageEntryView,
  allowedActions: readonly TriageBulkOperation['action'][],
) {
  const capabilities = view.entry.capabilities
  return allowedActions.includes('assign') && capabilities.canAssign ||
    allowedActions.includes('decline') && capabilities.canDecline ||
    allowedActions.includes('snooze') && capabilities.canSnooze
}

/** Checks whether any non-default queue filter is active. */
function hasActiveFilters(filters: TriageQueueFilters) {
  return Boolean(
    filters.query || filters.state || filters.source || filters.sla ||
    (filters.owner && filters.owner !== 'all'),
  )
}

/** Narrows a select value to a supported entry state. */
function readEntryState(value: string): TriageEntryState | undefined {
  return entryStates.find((state) => state === value)
}

/** Narrows a select value to a supported source kind. */
function readSourceKind(value: string): TriageSourceKind | undefined {
  return sourceKinds.find((source) => source === value)
}

/** Narrows a select value to a supported SLA filter. */
function readSlaFilter(value: string): TriageSlaFilter | undefined {
  return slaFilters.find((sla) => sla === value)
}

/** Formats an ISO timestamp using the active locale with a safe fallback. */
function formatDateTime(value: string, locale: 'ja' | 'en') {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
