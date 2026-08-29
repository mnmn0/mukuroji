import type { SearchEntityType, SearchViewLayout, WorkspaceSearchResult } from '@mukuroji/contracts'
import { useMemo, type ReactNode } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { resolveSearchResultPath } from '../api'
import { getSearchColumns, getSearchGroup, getSearchLayoutMode } from '../model/queryState'
import {
  resolveWorkspaceSearchResultFieldValue,
  sortWorkspaceSearchResults,
} from '../model/sortResults'

/** Props for the permission-aware Search result collection. */
export type SearchResultCollectionProps = {
  /** Permission-aware results returned by the Search API. */
  results: WorkspaceSearchResult[]
  /** Result mode, sorting, grouping, and visible columns. */
  layout: SearchViewLayout
  /** Locale used for labels and dates. */
  locale: Locale
  /** Opens one result path after route-level guards pass. */
  onNavigate: (path: string) => void
  /** Whether result navigation is fenced during an AI operation. */
  isAiOperationPending?: boolean
  /** Configuration-derived display names for workflow status IDs. */
  statusLabels?: Readonly<Record<string, string>>
}

const entityLabelKeys: Record<SearchEntityType, MessageKey> = {
  'work-item': 'search.entity.work-item',
  project: 'search.entity.project',
  team: 'search.entity.team',
  comment: 'search.entity.comment',
  'context-item': 'search.entity.context-item',
  file: 'search.entity.file',
  document: 'search.entity.document',
}
const statusLabelKeys: Record<string, MessageKey> = {
  todo: 'tasks.status.todo',
  'in-progress': 'tasks.status.in-progress',
  review: 'tasks.status.review',
  done: 'tasks.status.done',
}
const contextKindLabelKeys: Record<string, MessageKey> = {
  decision: 'collaboration.decisions.kind.decision',
  action: 'collaboration.decisions.kind.action',
  risk: 'collaboration.decisions.kind.risk',
  context: 'collaboration.decisions.kind.context',
}

/** Localizes a context-item kind while preserving unknown search subtitles. */
function formatSearchSubtitle(
  result: WorkspaceSearchResult,
  translate: (key: MessageKey) => string,
): string | undefined {
  if (!result.subtitle) return result.subtitle
  if (result.entityType !== 'context-item') return result.subtitle
  const key = contextKindLabelKeys[result.subtitle]
  return key ? translate(key) : result.subtitle
}

/**
 * Renders Search results in the selected table, board, calendar, or timeline mode.
 *
 * @param props - Permission-safe result data, layout, and route callbacks.
 * @returns The selected Search result presentation.
 */
export function SearchResultCollection({
  isAiOperationPending = false,
  layout,
  locale,
  onNavigate,
  results,
  statusLabels = {},
}: SearchResultCollectionProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatStatus = (status: string) => formatSearchStatus(status, statusLabels, t)
  const formatSubtitle = (result: WorkspaceSearchResult) => formatSearchSubtitle(result, t)
  const mode = getSearchLayoutMode(layout)
  const sortedResults = useMemo(
    () => sortWorkspaceSearchResults(results, layout),
    [layout, results],
  )

  if (mode === 'board') {
    return <SearchBoard formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} layout={layout} locale={locale} onNavigate={onNavigate} results={sortedResults} t={t} />
  }

  if (mode === 'calendar') {
    return <SearchCalendar formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} locale={locale} onNavigate={onNavigate} results={sortedResults} t={t} />
  }

  if (mode === 'timeline') {
    return <SearchTimeline formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} locale={locale} onNavigate={onNavigate} results={sortedResults} t={t} />
  }

  return <SearchTable formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} layout={layout} locale={locale} onNavigate={onNavigate} results={sortedResults} t={t} />
}

/**
 * Renders Search results in a table and fences result navigation during AI operations.
 *
 * @param props - Formatting callbacks, layout metadata, and permission-safe results.
 * @returns A table view of the current Search results.
 */
function SearchTable({
  formatStatus,
  formatSubtitle,
  isAiOperationPending,
  layout,
  locale,
  onNavigate,
  results,
  t,
}: {
  formatStatus: (status: string) => string
  formatSubtitle: (result: WorkspaceSearchResult) => string | undefined
  /** Whether result navigation is fenced while an AI operation is pending. */
  isAiOperationPending: boolean
  layout: SearchViewLayout
  locale: Locale
  onNavigate: (path: string) => void
  results: WorkspaceSearchResult[]
  t: (key: MessageKey) => string
}) {
  const columns = getSearchColumns(layout).filter((column) => column !== 'title')

  return (
    <section className="workbench-table overflow-hidden" data-testid="search-results-table">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-5 py-3" scope="col">{t('issues.column.title')}</th>
              {columns.map((column) => (
                <th className="px-4 py-3" key={column} scope="col">{formatColumnLabel(column, t)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const path = resolveSearchResultPath(result)

              return (
                <tr className="border-b border-[var(--workbench-border)] last:border-b-0" key={createResultKey(result)}>
                  <td className="min-w-[300px] p-0">
                    <button
                      className="w-full px-5 py-4 text-left transition hover:bg-[var(--workbench-surface-muted)] focus-visible:bg-[var(--workbench-surface-muted)] disabled:cursor-default"
                      data-testid={`search-result-${result.entityType}-${result.id}`}
                      disabled={isAiOperationPending || !path}
                      onClick={() => path && onNavigate(path)}
                      type="button"
                    >
                      <span className="block text-sm font-semibold text-[var(--workbench-text)]">
                        <HighlightedField field="title" result={result} fallback={result.title} />
                      </span>
                      {result.subtitle || result.body ? (
                        <span className="mt-1 line-clamp-2 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                          <HighlightedField field="body" result={result} fallback={formatSubtitle(result) ?? result.body ?? ''} />
                        </span>
                      ) : null}
                    </button>
                  </td>
                  {columns.map((column) => (
                    <td className="px-4 py-4 text-sm font-medium text-[var(--workbench-muted)]" key={column}>
                      {renderColumnValue(result, column, locale, formatStatus, t)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Renders grouped Search results as board cards with an AI-operation navigation fence.
 *
 * @param props - Formatting callbacks, grouping layout, and permission-safe results.
 * @returns A board view of the current Search results.
 */
function SearchBoard({
  formatStatus,
  formatSubtitle,
  isAiOperationPending,
  layout,
  locale,
  onNavigate,
  results,
  t,
}: {
  formatStatus: (status: string) => string
  formatSubtitle: (result: WorkspaceSearchResult) => string | undefined
  /** Whether result navigation is fenced while an AI operation is pending. */
  isAiOperationPending: boolean
  layout: SearchViewLayout
  locale: Locale
  onNavigate: (path: string) => void
  results: WorkspaceSearchResult[]
  t: (key: MessageKey) => string
}) {
  const groupBy = getSearchGroup(layout) || 'status'
  const groups = groupResults(results, groupBy)

  return (
    <section
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-4"
      data-testid="search-results-board"
    >
      {groups.map((group) => (
        <article className="workbench-panel min-h-[300px] overflow-hidden" key={group.id}>
          <header className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--workbench-text)]">
              {groupBy === 'dueDate'
                ? formatSearchDate(group.label, locale)
                : groupBy === 'status'
                  ? formatStatus(group.label)
                  : group.label}
            </h2>
            <span className="workbench-badge">{group.results.length}</span>
          </header>
          <div className="grid gap-2 p-3">
            {group.results.map((result) => (
              <SearchResultCard formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} key={createResultKey(result)} locale={locale} onNavigate={onNavigate} result={result} t={t} />
            ))}
          </div>
        </article>
      ))}
    </section>
  )
}

/**
 * Renders date-grouped Search results as calendar cards with an AI-operation navigation fence.
 *
 * @param props - Formatting callbacks, locale, and permission-safe results.
 * @returns A calendar view of the current Search results.
 */
function SearchCalendar({
  formatStatus,
  formatSubtitle,
  isAiOperationPending,
  locale,
  onNavigate,
  results,
  t,
}: {
  formatStatus: (status: string) => string
  formatSubtitle: (result: WorkspaceSearchResult) => string | undefined
  /** Whether result navigation is fenced while an AI operation is pending. */
  isAiOperationPending: boolean
  locale: Locale
  onNavigate: (path: string) => void
  results: WorkspaceSearchResult[]
  t: (key: MessageKey) => string
}) {
  const groups = groupResults(results, 'dueDate')

  return (
    <section
      className="workbench-table grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] overflow-hidden"
      data-testid="search-results-calendar"
    >
      {groups.map((group) => (
        <article className="min-h-[220px] border-b border-r border-[var(--workbench-border)] p-3" key={group.id}>
          <h2 className="text-sm font-semibold text-[var(--workbench-text)]">
            {formatSearchDate(group.label, locale)}
          </h2>
          <div className="mt-3 grid gap-2">
            {group.results.map((result) => (
              <SearchResultCard compact formatStatus={formatStatus} formatSubtitle={formatSubtitle} isAiOperationPending={isAiOperationPending} key={createResultKey(result)} locale={locale} onNavigate={onNavigate} result={result} t={t} />
            ))}
          </div>
        </article>
      ))}
    </section>
  )
}

/**
 * Renders Search results along a timeline and fences navigation during AI operations.
 *
 * @param props - Formatting callbacks, locale, and permission-safe results.
 * @returns A timeline view of the current Search results.
 */
function SearchTimeline({
  formatStatus,
  formatSubtitle,
  isAiOperationPending,
  locale,
  onNavigate,
  results,
  t,
}: {
  formatStatus: (status: string) => string
  formatSubtitle: (result: WorkspaceSearchResult) => string | undefined
  /** Whether result navigation is fenced while an AI operation is pending. */
  isAiOperationPending: boolean
  locale: Locale
  onNavigate: (path: string) => void
  results: WorkspaceSearchResult[]
  t: (key: MessageKey) => string
}) {
  return (
    <section className="workbench-panel overflow-hidden" data-testid="search-results-timeline">
      <div className="divide-y divide-[var(--workbench-border)]">
        {results.map((result) => {
          const path = resolveSearchResultPath(result)

          return (
            <button
              className="grid w-full grid-cols-[120px_16px_minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 text-left transition hover:bg-[var(--workbench-surface-muted)] disabled:cursor-default max-[680px]:grid-cols-[16px_minmax(0,1fr)]"
              disabled={isAiOperationPending || !path}
              key={createResultKey(result)}
              onClick={() => path && onNavigate(path)}
              type="button"
            >
              <time className="text-xs font-semibold text-[var(--workbench-muted)] max-[680px]:hidden">
                {formatSearchDate(resolveResultDate(result), locale)}
              </time>
              <span className="h-3 w-3 rounded-full border-2 border-white bg-[var(--workbench-primary)] ring-2 ring-[#99d7cf]" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">
                  <HighlightedField field="title" result={result} fallback={result.title} />
                </span>
                <span className="mt-1 block truncate text-xs font-medium text-[var(--workbench-muted)]">
                  {t(entityLabelKeys[result.entityType])} {formatSubtitle(result) ? `· ${formatSubtitle(result)}` : ''}
                </span>
                {result.body ? (
                  <span className="mt-1 line-clamp-1 block text-xs font-medium text-[var(--workbench-muted)]">
                    <HighlightedField field="body" result={result} fallback={result.body} />
                  </span>
                ) : null}
              </span>
              <span className="workbench-badge max-[680px]:col-start-2">
                {result.status ? formatStatus(result.status) : t(entityLabelKeys[result.entityType])}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Renders one Search result card whose navigation is disabled during AI operations.
 *
 * @param props - Result data, formatting callbacks, and navigation state.
 * @returns A button-like Search result card.
 */
function SearchResultCard({
  compact = false,
  formatStatus,
  formatSubtitle,
  isAiOperationPending,
  locale,
  onNavigate,
  result,
  t,
}: {
  compact?: boolean
  formatStatus: (status: string) => string
  formatSubtitle: (result: WorkspaceSearchResult) => string | undefined
  /** Whether result navigation is fenced while an AI operation is pending. */
  isAiOperationPending: boolean
  locale: Locale
  onNavigate: (path: string) => void
  result: WorkspaceSearchResult
  t: (key: MessageKey) => string
}) {
  const path = resolveSearchResultPath(result)

  return (
    <button
      className={`rounded-lg border border-[var(--workbench-border)] bg-white text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:cursor-default ${compact ? 'p-3' : 'p-4'}`}
      disabled={isAiOperationPending || !path}
      onClick={() => path && onNavigate(path)}
      type="button"
    >
      <span className="block text-sm font-semibold leading-5 text-[var(--workbench-text)]">
        <HighlightedField field="title" result={result} fallback={result.title} />
      </span>
      <span className="mt-2 block text-xs font-medium text-[var(--workbench-muted)]">
        {t(entityLabelKeys[result.entityType])}{formatSubtitle(result) ? ` · ${formatSubtitle(result)}` : ''}
      </span>
      {result.body ? (
        <span className="mt-2 line-clamp-2 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          <HighlightedField field="body" result={result} fallback={result.body} />
        </span>
      ) : null}
      {result.status || result.dueDate ? (
        <span className="mt-3 flex flex-wrap gap-2">
          {result.status ? <span className="workbench-badge">{formatStatus(result.status)}</span> : null}
          {result.dueDate ? (
            <span className="text-xs font-semibold text-[var(--workbench-muted)]">
              {formatSearchDate(result.dueDate, locale)}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}

function HighlightedField({
  fallback,
  field,
  result,
}: {
  fallback: string
  field: 'body' | 'title'
  result: WorkspaceSearchResult
}) {
  const highlight = result.highlights.find((candidate) => candidate.field === field)

  if (!highlight || highlight.fragments.length === 0) {
    return fallback
  }

  return highlight.fragments.map((fragment, index): ReactNode => fragment.matched ? (
    <mark className="rounded-sm bg-amber-200/70 px-0.5 text-inherit" key={`${fragment.text}-${index}`}>
      {fragment.text}
    </mark>
  ) : <span key={`${fragment.text}-${index}`}>{fragment.text}</span>)
}

function groupResults(results: WorkspaceSearchResult[], field: string) {
  const groups = new Map<string, WorkspaceSearchResult[]>()

  for (const result of results) {
    const value = formatResultFieldValue(
      resolveWorkspaceSearchResultFieldValue(result, field),
    ) ?? '—'
    groups.set(value, [...(groups.get(value) ?? []), result])
  }

  return Array.from(groups, ([label, groupedResults]) => ({
    id: label,
    label,
    results: groupedResults,
  }))
}

function resolveResultDate(result: WorkspaceSearchResult) {
  return result.dueDate ?? result.updatedAt ?? result.createdAt ?? ''
}

function createResultKey(result: WorkspaceSearchResult) {
  return `${result.entityType}:${result.teamId ?? ''}:${result.id}`
}

function formatColumnLabel(column: string, t: (key: MessageKey) => string) {
  const labels: Record<string, string> = {
    type: t('search.filters.types'),
    status: t('tasks.column.status'),
    assignee: t('tasks.column.assignee'),
    creator: t('search.filters.creator'),
    project: t('issues.column.project'),
    team: t('workspace.column.team'),
    dueDate: t('tasks.column.dueDate'),
    updatedAt: t('search.columns.updatedAt'),
  }

  return labels[column] ?? (column.startsWith('custom:') ? column.slice('custom:'.length) : column)
}

function renderColumnValue(
  result: WorkspaceSearchResult,
  column: string,
  locale: Locale,
  formatStatus: (status: string) => string,
  t: (key: MessageKey) => string,
) {
  if (column === 'type') {
    return <span className="workbench-badge">{t(entityLabelKeys[result.entityType])}</span>
  }

  if (column === 'status') {
    return result.status
      ? <span className="workbench-badge">{formatStatus(result.status)}</span>
      : '—'
  }

  const value = resolveWorkspaceSearchResultFieldValue(result, column)
  const formattedValue = formatResultFieldValue(value)

  if (formattedValue === undefined) return '—'
  return column === 'dueDate' || column === 'updatedAt'
    ? formatSearchDate(formattedValue, locale)
    : formattedValue
}

function formatResultFieldValue(value: unknown) {
  if (typeof value === 'string') return value || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.length > 0 ? value.join(', ') : undefined
  }
  return undefined
}

function formatSearchDate(value: string, locale: Locale) {
  if (!value || value === '—') {
    return '—'
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = dateOnlyMatch
    ? new Date(Date.UTC(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3])))
    : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    day: 'numeric',
    month: dateOnlyMatch && locale === 'ja' ? '2-digit' : 'short',
    timeZone: 'UTC',
    year: 'numeric',
    ...(!dateOnlyMatch ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}

function formatSearchStatus(
  status: string,
  statusLabels: Readonly<Record<string, string>>,
  t: (key: MessageKey) => string,
) {
  const configuredLabel = statusLabels[status]
  if (configuredLabel) {
    return configuredLabel
  }
  const key = statusLabelKeys[status]
  return key ? t(key) : status
}
