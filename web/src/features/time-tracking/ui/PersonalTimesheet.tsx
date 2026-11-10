import type { TimeEntry } from '@mukuroji/contracts'
import { useId, useState } from 'react'
import type { TimeEntryDraftInput, TimesheetTransitionResult } from '../api/timeEntries'
import {
  buildTimeEntryWeekRows,
  countTimeEntriesByStatus,
  groupTimeEntriesByDay,
  sumTimeEntryMinutesInDays,
} from '../model/timeEntryLifecycle'
import { formatMinutes, type TimeWeekPeriod } from '../model/timePeriod'
import { TimeEntryForm, type TimeEntryWorkItemOption } from './TimeEntryForm'
import { TimeEntryList } from './TimeEntryList'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import {
  describeTimeTrackingFailure,
  interpolate,
  timeEntryStatusKeys,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'

/** Props of the member's weekly timesheet. */
export type PersonalTimesheetProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Local date of today, used as the default for a new entry. */
  today: string
  /** Member's entries of the week. */
  entries: readonly TimeEntry[]
  /** Whether the first read is loading. */
  isLoading?: boolean
  /** Whether the week holds more entries than were read, so the totals are partial. */
  isPartial?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Work Items the member may record time against. */
  workItemOptions: readonly TimeEntryWorkItemOption[]
  /** Whether the offered Work Items are still being resolved. */
  isLoadingWorkItemOptions?: boolean
  /** Work Item titles keyed by identifier. */
  workItemTitles: Readonly<Record<string, string>>
  /** Latest rejection reason keyed by entry identifier. */
  rejectionReasons?: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Reloads the week. */
  onRetry: () => void
  /** Records a manual entry. */
  onCreateEntry: (input: TimeEntryDraftInput) => Promise<unknown>
  /** Edits an entry. */
  onUpdateEntry: (entry: TimeEntry, input: TimeEntryDraftInput) => Promise<unknown>
  /** Submits one entry. */
  onSubmitEntry: (entry: TimeEntry) => Promise<unknown>
  /** Submits every draft and rejected entry of the week. */
  onSubmitWeek: () => Promise<TimesheetTransitionResult>
}

/**
 * The member's week: a Work Item × day table, the entries of each day, and a week-wide submit.
 *
 * @param props - Week, entries, and actions.
 * @returns Timesheet.
 */
export function PersonalTimesheet({
  entries,
  formatters,
  hasLoadError = false,
  isLoading = false,
  isPartial = false,
  onCreateEntry,
  onMoveWeek,
  onRetry,
  onSubmitEntry,
  onSubmitWeek,
  onUpdateEntry,
  rejectionReasons,
  t,
  today,
  week,
  workItemOptions,
  isLoadingWorkItemOptions = false,
  workItemTitles,
}: PersonalTimesheetProps) {
  const id = useId()
  const [isCreating, setIsCreating] = useState(false)
  const [isSubmittingWeek, setIsSubmittingWeek] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const days = groupTimeEntriesByDay(entries, week.days)
  const rows = buildTimeEntryWeekRows(entries, week.days)
  const counts = countTimeEntriesByStatus(entries)
  const submittableCount = counts.draft + counts.rejected
  const weekTotal = sumTimeEntryMinutesInDays(entries, week.days)
  const defaultDate = week.days.includes(today) ? today : week.days[0] ?? today

  /** Submits the whole week and reports entries that still need a retry. */
  const submitWeek = async () => {
    if (isSubmittingWeek) return
    setIsSubmittingWeek(true)
    setMessage(undefined)
    try {
      const result = await onSubmitWeek()
      setMessage(result.partialFailure
        ? { tone: 'error', text: interpolate(t('timeTracking.timesheet.partialFailure'), { done: result.count, failed: result.failedEntryIds.length }) }
        : { tone: 'status', text: interpolate(t('timeTracking.timesheet.submitted'), { count: result.count }) })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setIsSubmittingWeek(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="personal-timesheet">
      <h2 className="sr-only" id={`${id}-title`}>{t('timeTracking.timesheet.title')}</h2>
      <TimeWeekNavigator formatters={formatters} onMove={onMoveWeek} t={t} week={week} />

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.timesheet.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm font-medium text-[var(--workbench-muted)]">
          <span className="font-semibold text-[var(--workbench-text)]">
            {t('timeTracking.timesheet.weekTotal')} {formatMinutes(weekTotal)}
          </span>
          {(['draft', 'rejected', 'submitted', 'approved', 'locked'] as const).map((status) => counts[status] > 0 ? (
            <span key={status}>{t(timeEntryStatusKeys[status])} {counts[status]}</span>
          ) : null)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="workbench-button-secondary min-h-9 px-3"
            disabled={isCreating || workItemOptions.length === 0}
            onClick={() => setIsCreating(true)}
            type="button"
          >
            {t('timeTracking.panel.addEntry')}
          </button>
          <button
            className="workbench-button-primary min-h-9 px-3"
            disabled={submittableCount === 0 || isSubmittingWeek}
            onClick={() => { void submitWeek() }}
            type="button"
          >
            {interpolate(t('timeTracking.timesheet.submitWeek'), { count: submittableCount })}
          </button>
        </div>
      </div>

      {!isLoadingWorkItemOptions && workItemOptions.length === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]" data-testid="timesheet-no-writable-items">
          {t('timeTracking.timesheet.noWritableItems')}
        </p>
      ) : null}

      <div aria-live="polite" role="status">
        {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
      </div>
      {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}

      {isCreating ? (
        <TimeEntryForm
          defaultDate={defaultDate}
          onCancel={() => setIsCreating(false)}
          onSave={async (input) => {
            await onCreateEntry(input)
            setIsCreating(false)
            setMessage({ tone: 'status', text: t('timeTracking.entry.created') })
          }}
          t={t}
          workItemOptions={workItemOptions}
        />
      ) : null}

      {isPartial ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-fg-amber-800" role="alert">
          {t('timeTracking.timesheet.partial')}
        </p>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {!isLoading && !hasLoadError && entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--workbench-border)] px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('timeTracking.timesheet.empty')}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
          <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="timesheet-week-table">
            <caption className="sr-only">{t('timeTracking.timesheet.tableCaption')}</caption>
            <thead>
              <tr className="bg-[var(--workbench-surface-muted)] text-left text-xs font-semibold text-[var(--workbench-muted)]">
                <th className="sticky left-0 bg-[var(--workbench-surface-muted)] px-3 py-2" scope="col">{t('timeTracking.form.workItem')}</th>
                {week.days.map((date) => <th className="px-2 py-2 text-right" key={date} scope="col">{formatters.day(date)}</th>)}
                <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.timesheet.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-t border-[var(--workbench-border)]" key={row.workItemId}>
                  <th className="sticky left-0 max-w-[220px] truncate bg-surface px-3 py-2 text-left font-medium text-[var(--workbench-text)]" scope="row">
                    {workItemTitles[row.workItemId] ?? row.workItemId}
                  </th>
                  {week.days.map((date) => (
                    <td className="px-2 py-2 text-right tabular-nums text-[var(--workbench-text)]" key={date}>
                      {row.minutesByDate[date] ? formatMinutes(row.minutesByDate[date]) : ''}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--workbench-text)]">{formatMinutes(row.totalMinutes)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] font-semibold">
                <th className="sticky left-0 bg-[var(--workbench-surface-muted)] px-3 py-2 text-left" scope="row">{t('timeTracking.timesheet.total')}</th>
                {days.map((day) => (
                  <td className="px-2 py-2 text-right tabular-nums" key={day.date}>{day.totalMinutes ? formatMinutes(day.totalMinutes) : ''}</td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{formatMinutes(weekTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {days.filter((day) => day.entries.length > 0).map((day) => (
        <section aria-label={formatters.day(day.date)} className="grid min-w-0 gap-2" key={day.date}>
          <h3 className="flex items-baseline gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {formatters.day(day.date)}
            <span className="tabular-nums text-[var(--workbench-muted)]">{formatMinutes(day.totalMinutes)}</span>
          </h3>
          <TimeEntryList
            entries={day.entries}
            formatters={formatters}
            onSubmit={onSubmitEntry}
            onUpdate={onUpdateEntry}
            {...(rejectionReasons ? { rejectionReasons } : {})}
            t={t}
            workItemOptions={workItemOptions}
            workItemTitles={workItemTitles}
          />
        </section>
      ))}
    </section>
  )
}
