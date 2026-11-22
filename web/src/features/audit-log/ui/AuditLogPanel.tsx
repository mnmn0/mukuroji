import { useId, type FormEvent } from 'react'
import type {
  AuditEventActorView,
  AuditEventResourceView,
  AuditEventView,
  AuditExportView,
} from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import {
  formatAuditActorName,
  formatAuditTime,
  formatAuditValue,
} from '../model/auditEventDisplay'
import {
  formatAuditEventType,
  formatAuditResourceType,
  suggestedAuditEventTypes,
  suggestedAuditTargetTypes,
} from '../model/auditEventTypes'
import {
  changeAuditLogTargetType,
  type AuditLogFilterDraft,
  type AuditLogFilterProblem,
} from '../model/auditLogFilters'
import type { IssuedAuditExportLinks } from '../mutations/useAuditExportActions'
import { AuditExportSection } from './AuditExportSection'

/** Why the event list could not be shown. */
export type AuditLogLoadFailure = 'forbidden' | 'failed'

/** Message keys of each filter problem. */
const filterProblemKeys: Record<AuditLogFilterProblem, MessageKey> = {
  targetIdWithoutType: 'auditLog.filter.problem.targetIdWithoutType',
  tooManyEventTypes: 'auditLog.filter.problem.tooManyEventTypes',
  invalidPeriod: 'auditLog.filter.problem.invalidPeriod',
}

/** Props of the audit log panel. */
export type AuditLogPanelProps = {
  /** Display locale. */
  readonly locale: Locale
  /** IANA time zone used for times and the period filter; undefined uses the browser's. */
  readonly timeZone?: string
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Search form values. */
  readonly draft: AuditLogFilterDraft
  /** Problem that blocks the search, shown below the form. */
  readonly filterProblem?: AuditLogFilterProblem
  /** Whether a search has been run; nothing is read before the first one. */
  readonly hasSearched: boolean
  /** Events read so far. */
  readonly events: readonly AuditEventView[]
  /** Whether the first page is loading. */
  readonly isLoading: boolean
  /** Why the events could not be read. */
  readonly loadFailure?: AuditLogLoadFailure
  /** Whether more pages remain. */
  readonly hasMore: boolean
  /** Whether a further page is loading. */
  readonly isLoadingMore: boolean
  /** Whether the member may search; otherwise only the export section works. */
  readonly canSearch: boolean
  /** Whether the member may export; hides the export section otherwise. */
  readonly canExport: boolean
  /** Recent exports, undefined while loading. */
  readonly exports?: readonly AuditExportView[]
  /** Whether the export list could not be read. */
  readonly exportsFailed: boolean
  /** Whether an export request is in flight. */
  readonly isRequestingExport: boolean
  /** Export whose links are being issued. */
  readonly issuingExportId?: string
  /** Links issued per export ID. */
  readonly exportLinks: Readonly<Record<string, IssuedAuditExportLinks>>
  /** Message of the last failed export action. */
  readonly exportActionError?: string
  /** Changes the search form. */
  readonly onChangeDraft: (draft: AuditLogFilterDraft) => void
  /** Runs the search with the form values. */
  readonly onSearch: () => void
  /** Clears the form and the search. */
  readonly onReset: () => void
  /** Reads the next page. */
  readonly onLoadMore: () => void
  /** Reads the search again after a failure. */
  readonly onRetry: () => void
  /** Searches the events of one actor. */
  readonly onFilterByActor: (actor: AuditEventActorView) => void
  /** Searches the events that changed one target. */
  readonly onFilterByTarget: (target: AuditEventResourceView) => void
  /** Requests an export of the form's filters. */
  readonly onRequestExport: () => void
  /** Reloads the export list. */
  readonly onRetryExports: () => void
  /** Issues download links of one export page. */
  readonly onIssueExportLinks: (exportId: string, fromPart?: number) => void
}

/**
 * Renders the Workspace audit log: search filters, the event list with field changes, and exports.
 *
 * @param props - Search state, events, export state, and callbacks.
 * @returns The audit log settings panel.
 */
export function AuditLogPanel(props: AuditLogPanelProps) {
  const { draft, onChangeDraft, t } = props
  const formId = useId()
  const eventTypeListId = `${formId}-event-types`
  /**
   * Builds the element ID of one form field.
   *
   * @param name - Form field.
   * @returns ID unique to this panel.
   */
  const field = (name: keyof AuditLogFilterDraft) => `${formId}-${name}`
  /**
   * Replaces one form value. Changing the target type goes through its own handler, which
   * also clears the target ID so a stale ID never outlives its type.
   *
   * @param name - Form field.
   * @param value - New value.
   */
  const update = (name: keyof AuditLogFilterDraft, value: string) => onChangeDraft({ ...draft, [name]: value })
  /**
   * Runs the search instead of submitting the page, when the member may search.
   *
   * @param event - Form submit event.
   */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (props.canSearch) props.onSearch()
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="audit-log-panel">
      <div className="border-b border-[var(--workbench-border)] px-5 py-6 sm:px-7">
        <p className="workbench-eyebrow">{t('auditLog.eyebrow')}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[var(--workbench-text)]">
          {t('auditLog.title')}
        </h2>
        <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('auditLog.description')}
        </p>
      </div>

      <form aria-label={t('auditLog.filter.aria')} className="grid gap-4 px-5 py-5 sm:px-7" onSubmit={submit}>
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={field('actorId')}>
            {t('auditLog.filter.actor')}
            <input
              aria-describedby={`${field('actorId')}-hint`}
              className="workbench-input min-h-10 px-3"
              id={field('actorId')}
              onChange={(event) => update('actorId', event.target.value)}
              value={draft.actorId}
            />
            <span className="text-xs font-medium text-[var(--workbench-muted)]" id={`${field('actorId')}-hint`}>
              {t('auditLog.filter.actorHint')}
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={field('eventTypes')}>
            {t('auditLog.filter.eventType')}
            <input
              aria-describedby={`${field('eventTypes')}-hint`}
              className="workbench-input min-h-10 px-3"
              id={field('eventTypes')}
              list={eventTypeListId}
              onChange={(event) => update('eventTypes', event.target.value)}
              value={draft.eventTypes}
            />
            <datalist id={eventTypeListId}>
              {suggestedAuditEventTypes.map((eventType) => (
                <option key={eventType} value={eventType}>{formatAuditEventType(eventType, props.t)}</option>
              ))}
            </datalist>
            <span className="text-xs font-medium text-[var(--workbench-muted)]" id={`${field('eventTypes')}-hint`}>
              {t('auditLog.filter.eventTypeHint')}
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2 sm:col-span-2 xl:col-span-1">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={field('fromDate')}>
              {t('auditLog.filter.from')}
              <input
                className="workbench-input min-h-10 px-3"
                id={field('fromDate')}
                onChange={(event) => update('fromDate', event.target.value)}
                type="date"
                value={draft.fromDate}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={field('toDate')}>
              {t('auditLog.filter.to')}
              <input
                className="workbench-input min-h-10 px-3"
                id={field('toDate')}
                onChange={(event) => update('toDate', event.target.value)}
                type="date"
                value={draft.toDate}
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={field('targetType')}>
            {t('auditLog.filter.targetType')}
            <select
              className="workbench-input min-h-10 px-3"
              id={field('targetType')}
              onChange={(event) => onChangeDraft(changeAuditLogTargetType(draft, event.target.value))}
              value={draft.targetType}
            >
              <option value="">{t('auditLog.filter.anyTarget')}</option>
              {suggestedAuditTargetTypes.map((targetType) => (
                <option key={targetType} value={targetType}>{formatAuditResourceType(targetType, props.t)}</option>
              ))}
              {draft.targetType && !suggestedAuditTargetTypes.includes(draft.targetType) ? (
                <option value={draft.targetType}>{draft.targetType}</option>
              ) : null}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)] xl:col-span-2" htmlFor={field('targetId')}>
            {t('auditLog.filter.targetId')}
            <input
              className="workbench-input min-h-10 px-3"
              disabled={!draft.targetType}
              id={field('targetId')}
              onChange={(event) => update('targetId', event.target.value)}
              placeholder={t('auditLog.filter.targetIdPlaceholder')}
              value={draft.targetId}
            />
          </label>
        </div>
        {props.filterProblem ? (
          <p className="text-sm font-semibold text-fg-9e3d27" role="alert">{t(filterProblemKeys[props.filterProblem])}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {props.canSearch ? (
            <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" type="submit">{t('auditLog.filter.search')}</button>
          ) : null}
          <button className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50" onClick={props.onReset} type="button">{t('auditLog.filter.reset')}</button>
        </div>
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {t(props.canSearch ? 'auditLog.filter.viewRecorded' : 'auditLog.filter.exportOnly')}
        </p>
      </form>

      {props.canSearch ? (
        <div className="border-t border-[var(--workbench-border)] px-5 py-5 sm:px-7">
          <AuditEventList {...props} />
        </div>
      ) : null}

      {props.canExport ? (
        <AuditExportSection
          exportActionError={props.exportActionError}
          exportLinks={props.exportLinks}
          exports={props.exports}
          exportsFailed={props.exportsFailed}
          isRequestingExport={props.isRequestingExport}
          issuingExportId={props.issuingExportId}
          locale={props.locale}
          onIssueExportLinks={props.onIssueExportLinks}
          onRequestExport={props.onRequestExport}
          onRetryExports={props.onRetryExports}
          t={t}
          timeZone={props.timeZone}
        />
      ) : null}
    </section>
  )
}

/**
 * Renders the result of the search, or the state that stands in for it.
 *
 * @param props - Panel props.
 * @returns Event list or its empty, loading, or failure state.
 */
function AuditEventList(props: AuditLogPanelProps) {
  const { t } = props
  if (!props.hasSearched) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('auditLog.list.notSearched')}</p>
  }
  if (props.isLoading) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('auditLog.list.loading')}</p>
  }
  if (props.loadFailure) {
    return (
      <div className="grid justify-items-start gap-3" role="alert">
        <p className="text-sm font-semibold text-fg-9e3d27">
          {t(props.loadFailure === 'forbidden' ? 'auditLog.list.forbidden' : 'auditLog.list.failed')}
        </p>
        {props.loadFailure === 'failed' ? (
          <button className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50" onClick={props.onRetry} type="button">{t('auditLog.list.retry')}</button>
        ) : null}
      </div>
    )
  }
  if (props.events.length === 0 && !props.hasMore) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('auditLog.list.empty')}</p>
  }
  if (props.events.length === 0) {
    // The server filters after reading a page, so a page can hold no match while older ones do.
    return (
      <div className="grid justify-items-start gap-3">
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('auditLog.list.noMatchYet')}</p>
        <LoadMoreButton {...props} />
      </div>
    )
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium text-[var(--workbench-muted)]">
        {t('auditLog.list.count').replace('{count}', String(props.events.length))}
      </p>
      <ol className="grid gap-2" aria-label={t('auditLog.list.aria')}>
        {props.events.map((event) => (
          <AuditEventRow
            event={event}
            key={event.eventId}
            locale={props.locale}
            onFilterByActor={props.onFilterByActor}
            onFilterByTarget={props.onFilterByTarget}
            t={t}
            timeZone={props.timeZone}
          />
        ))}
      </ol>
      {props.hasMore ? (
        <LoadMoreButton {...props} />
      ) : (
        <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('auditLog.list.end')}</p>
      )}
    </div>
  )
}

/**
 * Renders the button that reads the next, older page.
 *
 * @param props - Panel props.
 * @returns Load more button.
 */
function LoadMoreButton({ isLoadingMore, onLoadMore, t }: AuditLogPanelProps) {
  return (
    <button
      className="workbench-button-secondary min-h-10 justify-self-start px-4 disabled:opacity-50"
      disabled={isLoadingMore}
      onClick={onLoadMore}
      type="button"
    >
      {t(isLoadingMore ? 'auditLog.list.loadingMore' : 'auditLog.list.loadMore')}
    </button>
  )
}

/** Props of one event row. */
type AuditEventRowProps = {
  /** Event to show. */
  readonly event: AuditEventView
  /** Display locale. */
  readonly locale: Locale
  /** IANA time zone; undefined uses the browser's. */
  readonly timeZone?: string
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Searches the events of one actor. */
  readonly onFilterByActor: (actor: AuditEventActorView) => void
  /** Searches the events that changed one target. */
  readonly onFilterByTarget: (target: AuditEventResourceView) => void
}

/**
 * Renders one event with its actor and target, and its details on demand.
 *
 * @param props - Event, display settings, and filter callbacks.
 * @returns List item of the event.
 */
function AuditEventRow({ event, locale, onFilterByActor, onFilterByTarget, t, timeZone }: AuditEventRowProps) {
  const actorName = formatAuditActorName(event.actor)
  return (
    <li className="rounded-lg border border-[var(--workbench-border)] bg-surface" data-testid="audit-event-row">
      <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4">
        <time className="text-sm font-semibold tabular-nums text-[var(--workbench-muted)]" dateTime={event.occurredAt}>
          {formatAuditTime(event.occurredAt, locale, timeZone)}
        </time>
        <div className="grid min-w-0 gap-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold text-[var(--workbench-text)]">
            <span>{formatAuditEventType(event.eventType, t)}</span>
            <code className="break-all text-xs font-medium text-[var(--workbench-muted)]">{event.eventType}</code>
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--workbench-muted)]">
            <span>
              {t('auditLog.event.actor')}{' '}
              <button
                className="font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                onClick={() => onFilterByActor(event.actor)}
                title={t('auditLog.event.filterByActor')}
                type="button"
              >
                {actorName}
              </button>
              {event.actor.kind !== 'user' ? ` (${event.actor.kind})` : ''}
            </span>
            <span className="min-w-0 break-all">
              {t('auditLog.event.target')}{' '}
              <button
                className="font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                onClick={() => onFilterByTarget(event.target)}
                title={t('auditLog.event.filterByTarget')}
                type="button"
              >
                {formatAuditResourceType(event.target.type, t)}
              </button>{' '}
              <code className="text-xs">{event.target.id}</code>
            </span>
          </p>
          {event.summary ? <p className="text-sm text-[var(--workbench-text)]">{event.summary}</p> : null}
        </div>
      </div>
      <details className="border-t border-[var(--workbench-border)] px-4 py-2">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-primary-text)]">
          {event.changes.length > 0
            ? t('auditLog.event.changesCount').replace('{count}', String(event.changes.length))
            : t('auditLog.event.details')}
        </summary>
        <div className="grid gap-3 py-3">
          {event.changes.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="text-xs font-semibold text-[var(--workbench-muted)]">
                  <tr>
                    <th className="py-1 pr-3" scope="col">{t('auditLog.event.field')}</th>
                    <th className="py-1 pr-3" scope="col">{t('auditLog.event.before')}</th>
                    <th className="py-1" scope="col">{t('auditLog.event.after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {event.changes.map((change) => (
                    <tr className="border-t border-[var(--workbench-border)] align-top" key={change.field}>
                      <th className="py-1.5 pr-3 font-mono text-xs font-medium" scope="row">{change.field}</th>
                      <td className="break-all py-1.5 pr-3">
                        <AuditChangeValue present={Object.hasOwn(change, 'before')} redacted={change.redacted} t={t} value={change.before} />
                      </td>
                      <td className="break-all py-1.5">
                        <AuditChangeValue present={Object.hasOwn(change, 'after')} redacted={change.redacted} t={t} value={change.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-[var(--workbench-muted)]">{t('auditLog.event.noChanges')}</p>
          )}
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('auditLog.event.entity')}</dt>
            <dd className="break-all font-mono">{event.entity.type} / {event.entity.id}</dd>
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('auditLog.event.actorId')}</dt>
            <dd className="break-all font-mono">{event.actor.id}</dd>
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('auditLog.event.source')}</dt>
            <dd className="break-all font-mono">{event.source}</dd>
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('auditLog.event.correlationId')}</dt>
            <dd className="break-all font-mono">{event.correlationId}</dd>
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('auditLog.event.eventId')}</dt>
            <dd className="break-all font-mono">{event.eventId}</dd>
          </dl>
        </div>
      </details>
    </li>
  )
}

/** Props of one side of a field change. */
type AuditChangeValueProps = {
  /** Whether the side was recorded; a missing side means the field was created or removed. */
  readonly present: boolean
  /** Whether the value was replaced because it is sensitive. */
  readonly redacted?: boolean
  /** Recorded value. */
  readonly value: AuditEventView['changes'][number]['before']
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
}

/**
 * Renders one side of a field change.
 *
 * @param props - Recorded value and how to read it.
 * @returns The value, or a note that it is hidden or absent.
 */
function AuditChangeValue({ present, redacted, t, value }: AuditChangeValueProps) {
  if (redacted) return <span className="italic text-[var(--workbench-muted)]">{t('auditLog.event.redacted')}</span>
  if (!present || value === undefined) return <span className="text-[var(--workbench-muted)]">{t('auditLog.event.absent')}</span>
  return <span className="whitespace-pre-wrap">{formatAuditValue(value)}</span>
}
