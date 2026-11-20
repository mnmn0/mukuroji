import type { TimeEntry } from '@mukuroji/contracts'
import { useState } from 'react'
import type { IndirectTimeEntryInput, TimeEntryDraftInput } from '../api/timeEntries'
import { isTimeEntryEditable } from '../model/timeEntryLifecycle'
import { formatMinutes, toLocalDateKey } from '../model/timePeriod'
import { IndirectTimeEntryForm, type IndirectTimeEntryTargets } from './IndirectTimeEntryForm'
import { TimeEntryForm, type TimeEntryWorkItemOption } from './TimeEntryForm'
import {
  describeTimeEntrySubject,
  describeTimeTrackingFailure,
  formatTimeEntryRange,
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
  /** Edits a draft or rejected indirect-work entry; without it such entries are not editable here. */
  onUpdateIndirect?: (entry: TimeEntry, input: IndirectTimeEntryInput) => Promise<unknown>
  /** Projects offered when editing indirect work. */
  indirectTargets?: IndirectTimeEntryTargets
  /** Deletes one draft or rejected entry after the member confirms; omitted when entries cannot be deleted here. */
  onDelete?: (entry: TimeEntry) => Promise<unknown>
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
  indirectTargets,
  onDelete,
  onSubmit,
  onUpdate,
  onUpdateIndirect,
  rejectionReasons = {},
  showDate = false,
  t,
  workItemOptions,
  workItemTitles,
}: TimeEntryListProps) {
  // The entry as it was when editing began; saving sends its revision so a change made elsewhere
  // in the meantime comes back as a revision conflict instead of being overwritten.
  const [editingEntry, setEditingEntry] = useState<TimeEntry>()
  const [pendingEntryId, setPendingEntryId] = useState<string>()
  const [failure, setFailure] = useState<{ entryId: string; message: string }>()
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>()

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

  /**
   * Deletes one entry after the member confirmed it, keeping a failure next to it.
   *
   * @param entry - Entry to delete.
   */
  const deleteEntry = async (entry: TimeEntry) => {
    if (!onDelete || pendingEntryId) return
    setPendingEntryId(entry.id)
    setFailure(undefined)
    try {
      await onDelete(entry)
      setConfirmingDeleteId(undefined)
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
        const isIndirect = entry.workItemId === undefined
        const canEdit = isIndirect ? onUpdateIndirect !== undefined && indirectTargets !== undefined : onUpdate !== undefined
        const label = `${formatters.date(entry.startAt)} ${formatTimeEntryRange(formatters, entry) || formatMinutes(entry.durationMinutes)}`
        if (editingEntry?.id === entry.id && isIndirect && onUpdateIndirect && indirectTargets) {
          return (
            <li className="min-w-0" key={entry.id}>
              <IndirectTimeEntryForm
                defaultDate={toLocalDateKey(editingEntry.startAt)}
                entry={editingEntry}
                onCancel={() => setEditingEntry(undefined)}
                onSave={async (input) => {
                  await onUpdateIndirect(editingEntry, input)
                  setEditingEntry(undefined)
                }}
                t={t}
                targets={indirectTargets}
              />
            </li>
          )
        }
        if (editingEntry?.id === entry.id && !isIndirect && onUpdate) {
          return (
            <li className="min-w-0" key={entry.id}>
              <TimeEntryForm
                defaultDate={toLocalDateKey(editingEntry.startAt)}
                entry={editingEntry}
                {...(workItemOptions ? { workItemOptions } : { fixedWorkItemId: editingEntry.workItemId })}
                onCancel={() => setEditingEntry(undefined)}
                onSave={async (input) => {
                  await onUpdate(editingEntry, input)
                  setEditingEntry(undefined)
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
                {formatTimeEntryRange(formatters, entry)}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[var(--workbench-muted)]">
                {formatMinutes(entry.durationMinutes)}
              </span>
              {entry.billable ? <span className="workbench-badge">{t('timeTracking.entry.billable')}</span> : null}
              {entry.source === 'timer' ? <span className="workbench-badge">{t('timeTracking.entry.timer')}</span> : null}
            </div>
            {workItemTitles || isIndirect ? (
              <p className="truncate text-sm font-medium text-[var(--workbench-text)]">
                {describeTimeEntrySubject(t, entry, workItemTitles ?? {})}
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
            {editable && (canEdit || onSubmit || onDelete) ? (
              <div className="flex flex-wrap gap-2">
                {canEdit ? (
                  <button
                    aria-label={`${t('timeTracking.entry.edit')} ${label}`}
                    className="workbench-button-secondary min-h-8 px-3"
                    disabled={pendingEntryId !== undefined}
                    onClick={() => setEditingEntry(entry)}
                    type="button"
                  >
                    {t('timeTracking.entry.edit')}
                  </button>
                ) : null}
                {onSubmit ? (
                  <button
                    aria-label={`${entry.status === 'rejected' ? t('timeTracking.entry.resubmit') : t('timeTracking.entry.submit')} ${label}`}
                    className="workbench-button-primary min-h-8 px-3"
                    disabled={pendingEntryId !== undefined}
                    onClick={() => { void submitEntry(entry) }}
                    type="button"
                  >
                    {entry.status === 'rejected' ? t('timeTracking.entry.resubmit') : t('timeTracking.entry.submit')}
                  </button>
                ) : null}
                {onDelete && confirmingDeleteId !== entry.id ? (
                  <button
                    aria-label={`${t('timeTracking.entry.delete')} ${label}`}
                    className="workbench-button-secondary min-h-8 px-3"
                    disabled={pendingEntryId !== undefined}
                    onClick={() => setConfirmingDeleteId(entry.id)}
                    type="button"
                  >
                    {t('timeTracking.entry.delete')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {editable && onDelete && confirmingDeleteId === entry.id ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5" data-testid="time-entry-delete-confirm">
                <p className="text-sm font-medium text-fg-red-700">{t('timeTracking.entry.deleteQuestion')}</p>
                <button
                  className="workbench-button-secondary min-h-8 px-3 text-fg-red-700"
                  disabled={pendingEntryId !== undefined}
                  onClick={() => { void deleteEntry(entry) }}
                  type="button"
                >
                  {t('timeTracking.entry.deleteConfirm')}
                </button>
                <button
                  className="workbench-button-secondary min-h-8 px-3"
                  disabled={pendingEntryId !== undefined}
                  onClick={() => setConfirmingDeleteId(undefined)}
                  type="button"
                >
                  {t('timeTracking.entry.deleteCancel')}
                </button>
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
