import type { TimeEntry } from '@mukuroji/contracts'
import { useState } from 'react'
import type { TimeEntryDraftInput } from '../api/timeEntries'
import { isTimeEntryEditable } from '../model/timeEntryLifecycle'
import { formatMinutes, toLocalDateKey } from '../model/timePeriod'
import { TimeEntryForm, type TimeEntryWorkItemOption } from './TimeEntryForm'
import {
  describeTimeTrackingFailure,
  timeEntryStatusBadgeClasses,
  timeEntryStatusKeys,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'

/** Props of a member's own time entry list. */
export type TimeEntryListProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Entries to show, in display order. */
  entries: readonly TimeEntry[]
  /** Work Item titles keyed by identifier; when given, each row names its Work Item. */
  workItemTitles?: Readonly<Record<string, string>>
  /** Work Items offered when editing; omit to keep each entry's Work Item. */
  workItemOptions?: readonly TimeEntryWorkItemOption[]
  /** Latest rejection reason keyed by entry identifier. */
  rejectionReasons?: Readonly<Record<string, string>>
  /** Edits a draft or rejected entry; omitted when the list is read-only. */
  onUpdate?: (entry: TimeEntry, input: TimeEntryDraftInput) => Promise<unknown>
  /** Submits one draft or rejected entry; omitted when the list is read-only. */
  onSubmit?: (entry: TimeEntry) => Promise<unknown>
  /** Whether each row shows its date, for lists that are not grouped by day. */
  showDate?: boolean
}

/**
 * Lists a member's time entries with their state, rejection reason, and edit / submit actions.
 *
 * @param props - Entries and actions.
 * @returns Entry list.
 */
export function TimeEntryList({
  entries,
  formatters,
  onSubmit,
  onUpdate,
  rejectionReasons = {},
  showDate = false,
  t,
  workItemOptions,
  workItemTitles,
}: TimeEntryListProps) {
  const [editingEntryId, setEditingEntryId] = useState<string>()
  const [pendingEntryId, setPendingEntryId] = useState<string>()
  const [failure, setFailure] = useState<{ entryId: string; message: string }>()

  /**
   * Submits one entry and keeps its failure next to it.
   *
   * @param entry - Entry to submit.
   */
  const submitEntry = async (entry: TimeEntry) => {
    if (!onSubmit || pendingEntryId) return
    setPendingEntryId(entry.id)
    setFailure(undefined)
    try {
      await onSubmit(entry)
    } catch (error) {
      setFailure({ entryId: entry.id, message: describeTimeTrackingFailure(t, error) })
    } finally {
      setPendingEntryId(undefined)
    }
  }

  return (
    <ul className="grid min-w-0 gap-2">
      {entries.map((entry) => {
        const editable = isTimeEntryEditable(entry)
        const reason = rejectionReasons[entry.id]
        if (editingEntryId === entry.id && onUpdate) {
          return (
            <li className="min-w-0" key={entry.id}>
              <TimeEntryForm
                defaultDate={toLocalDateKey(entry.startAt)}
                entry={entry}
                {...(workItemOptions ? { workItemOptions } : { fixedWorkItemId: entry.workItemId })}
                onCancel={() => setEditingEntryId(undefined)}
                onSave={async (input) => {
                  await onUpdate(entry, input)
                  setEditingEntryId(undefined)
                }}
                t={t}
              />
            </li>
          )
        }
        return (
          <li
            className="grid min-w-0 gap-1.5 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2"
            data-testid="time-entry-row"
            key={entry.id}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={timeEntryStatusBadgeClasses[entry.status]}>{t(timeEntryStatusKeys[entry.status])}</span>
              <span className="text-sm font-semibold tabular-nums text-[var(--workbench-text)]">
                {showDate ? `${formatters.day(toLocalDateKey(entry.startAt))} ` : ''}
                {formatters.time(entry.startAt)}–{formatters.time(entry.endAt)}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[var(--workbench-muted)]">
                {formatMinutes(entry.durationMinutes)}
              </span>
              {entry.billable ? <span className="workbench-badge">{t('timeTracking.entry.billable')}</span> : null}
              {entry.source === 'timer' ? <span className="workbench-badge">{t('timeTracking.entry.timer')}</span> : null}
            </div>
            {workItemTitles ? (
              <p className="truncate text-sm font-medium text-[var(--workbench-text)]">
                {workItemTitles[entry.workItemId] ?? entry.workItemId}
              </p>
            ) : null}
            {entry.description ? (
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--workbench-muted)]">{entry.description}</p>
            ) : null}
            {/* An unloaded or failed history shows no reason rather than claiming none was recorded. */}
            {entry.status === 'rejected' && reason !== undefined ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-sm font-medium text-fg-red-700">
                {t('timeTracking.entry.rejectionReason')}: {reason || t('timeTracking.entry.rejectionReasonMissing')}
              </p>
            ) : null}
            {editable && (onUpdate || onSubmit) ? (
              <div className="flex flex-wrap gap-2">
                {onUpdate ? (
                  <button
                    aria-label={`${t('timeTracking.entry.edit')} ${formatters.date(entry.startAt)} ${formatters.time(entry.startAt)}`}
                    className="workbench-button-secondary min-h-8 px-3"
                    disabled={pendingEntryId !== undefined}
                    onClick={() => setEditingEntryId(entry.id)}
                    type="button"
                  >
                    {t('timeTracking.entry.edit')}
                  </button>
                ) : null}
                {onSubmit ? (
                  <button
                    aria-label={`${entry.status === 'rejected' ? t('timeTracking.entry.resubmit') : t('timeTracking.entry.submit')} ${formatters.date(entry.startAt)} ${formatters.time(entry.startAt)}`}
                    className="workbench-button-primary min-h-8 px-3"
                    disabled={pendingEntryId !== undefined}
                    onClick={() => { void submitEntry(entry) }}
                    type="button"
                  >
                    {entry.status === 'rejected' ? t('timeTracking.entry.resubmit') : t('timeTracking.entry.submit')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {failure?.entryId === entry.id ? (
              <p className="text-sm font-semibold text-fg-red-700" role="alert">{failure.message}</p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
