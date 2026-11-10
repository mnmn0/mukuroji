import type { TimeEntry, TimeSheet } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { TimeEntryTransitionAction, TimesheetTransitionResult } from '../api/timeEntries'
import { groupTimeEntriesByMember, sortTimeEntries, type TimeApprovalGroup } from '../model/timeEntryLifecycle'
import { formatMinutes, toLocalDateKey, type TimeWeekPeriod } from '../model/timePeriod'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import {
  describeTimeTrackingFailure,
  interpolate,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'

/** Props of the manager's approval queue. */
export type TimeApprovalQueueProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Every member's entries of the week visible to the manager. */
  entries: readonly TimeEntry[]
  /** Team totals of the week, when loaded. */
  teamTimesheet?: TimeSheet
  /** Whether the member manages the Team; undefined while it is being checked. */
  canManage: boolean | undefined
  /** Whether the first read is loading. */
  isLoading?: boolean
  /** Whether the week holds more entries than were read, so week-wide actions would touch unseen entries. */
  isPartial?: boolean
  /** Whether a read failed. */
  hasLoadError?: boolean
  /** Member display names keyed by member key. */
  memberNames: Readonly<Record<string, string>>
  /** Work Item titles keyed by identifier. */
  workItemTitles: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Reloads the week. */
  onRetry: () => void
  /** Applies one action to one entry. */
  onTransitionEntry: (entry: TimeEntry, action: Exclude<TimeEntryTransitionAction, 'submit'>, reason?: string) => Promise<unknown>
  /** Applies one action to every eligible entry of the week. */
  onTransitionWeek: (action: 'approve' | 'lock') => Promise<TimesheetTransitionResult>
}

/**
 * Manager queue: submitted entries grouped by member with approve / reject, and approved entries
 * with lock, plus week-wide approve and lock that report entries needing a retry.
 *
 * @param props - Week, entries, and actions.
 * @returns Approval queue.
 */
export function TimeApprovalQueue({
  canManage,
  entries,
  formatters,
  hasLoadError = false,
  isLoading = false,
  isPartial = false,
  memberNames,
  onMoveWeek,
  onRetry,
  onTransitionEntry,
  onTransitionWeek,
  t,
  teamTimesheet,
  week,
  workItemTitles,
}: TimeApprovalQueueProps) {
  const id = useId()
  const [pendingKey, setPendingKey] = useState<string>()
  const [rejectingEntryId, setRejectingEntryId] = useState<string>()
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const submitted = groupTimeEntriesByMember(entries, 'submitted')
  const approved = sortTimeEntries(entries.filter((entry) => entry.status === 'approved'))
  const lockedCount = entries.filter((entry) => entry.status === 'locked').length
  const submittedCount = submitted.reduce((total, group) => total + group.entries.length, 0)
  const dayTotals = new Map((teamTimesheet?.days ?? []).map((day) => [day.key, day.minutes]))

  /**
   * Runs one queue action, announcing its outcome.
   *
   * @param key - Pending action identity.
   * @param operation - Operation to run.
   * @param successText - Text announced after success.
   * @returns Whether the action succeeded.
   */
  const runAction = async (key: string, operation: () => Promise<unknown>, successText: string) => {
    if (pendingKey) return false
    setPendingKey(key)
    setMessage(undefined)
    try {
      await operation()
      setMessage({ tone: 'status', text: successText })
      return true
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
      return false
    } finally {
      setPendingKey(undefined)
    }
  }

  /**
   * Applies a week-wide action and reports the entries left for a retry.
   *
   * @param action - Approve or lock.
   */
  const transitionWeek = async (action: 'approve' | 'lock') => {
    if (pendingKey) return
    setPendingKey(`week:${action}`)
    setMessage(undefined)
    try {
      const result = await onTransitionWeek(action)
      setMessage(result.partialFailure
        ? { tone: 'error', text: interpolate(t('timeTracking.timesheet.partialFailure'), { done: result.count, failed: result.failedEntryIds.length }) }
        : { tone: 'status', text: interpolate(t(action === 'approve' ? 'timeTracking.approval.approvedCount' : 'timeTracking.approval.lockedCount'), { count: result.count }) })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setPendingKey(undefined)
    }
  }

  /**
   * Rejects an entry with the typed reason.
   *
   * @param event - Reason form submission.
   * @param entry - Entry being rejected.
   */
  const submitRejection = async (event: FormEvent<HTMLFormElement>, entry: TimeEntry) => {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('reason')
    const reason = typeof value === 'string' ? value.trim() : ''
    if (!reason) {
      setMessage({ tone: 'error', text: t('timeTracking.approval.reasonRequired') })
      return
    }
    if (await runAction(`reject:${entry.id}`, () => onTransitionEntry(entry, 'reject', reason), t('timeTracking.approval.rejected'))) {
      setRejectingEntryId(undefined)
    }
  }

  /**
   * Names a member by display name, falling back to the member key.
   *
   * @param userId - Member key.
   * @returns Display name.
   */
  const memberName = (userId: string) => memberNames[userId] ?? userId

  /**
   * Describes an entry for row text and accessible button names.
   *
   * @param entry - Entry to describe.
   * @returns Date, time range, and Work Item.
   */
  const describeEntry = (entry: TimeEntry) =>
    `${formatters.day(toLocalDateKey(entry.startAt))} ${formatters.time(entry.startAt)}–${formatters.time(entry.endAt)} ${workItemTitles[entry.workItemId] ?? entry.workItemId}`

  /**
   * Renders one member group of submitted entries.
   *
   * @param group - Member and entries.
   * @returns Group section.
   */
  const renderSubmittedGroup = (group: TimeApprovalGroup) => (
    <section aria-label={memberName(group.userId)} className="grid min-w-0 gap-2" key={group.userId}>
      <h4 className="flex flex-wrap items-baseline gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {memberName(group.userId)}
        <span className="tabular-nums text-[var(--workbench-muted)]">{formatMinutes(group.totalMinutes)}</span>
      </h4>
      <ul className="grid min-w-0 gap-2">
        {group.entries.map((entry) => (
          <li className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2" data-testid="time-approval-row" key={entry.id}>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold tabular-nums text-[var(--workbench-text)]">{formatMinutes(entry.durationMinutes)}</span>
              <span className="min-w-0 break-words text-[var(--workbench-text)]">{describeEntry(entry)}</span>
              {entry.billable ? <span className="workbench-badge">{t('timeTracking.entry.billable')}</span> : null}
            </div>
            {entry.description ? <p className="whitespace-pre-wrap break-words text-sm text-[var(--workbench-muted)]">{entry.description}</p> : null}
            {rejectingEntryId === entry.id ? (
              <form className="grid min-w-0 gap-2" onSubmit={(event) => { void submitRejection(event, entry) }}>
                <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-reason-${entry.id}`}>
                  {t('timeTracking.approval.reason')}
                  <textarea className="workbench-input min-h-16 w-full min-w-0 px-3 py-2" id={`${id}-reason-${entry.id}`} maxLength={4000} name="reason" required />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className="workbench-button-primary min-h-8 px-3" disabled={pendingKey !== undefined} type="submit">
                    {t('timeTracking.approval.confirmReject')}
                  </button>
                  <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setRejectingEntryId(undefined)} type="button">
                    {t('timeTracking.form.cancel')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  aria-label={`${t('timeTracking.approval.approve')} ${memberName(entry.userId)} ${describeEntry(entry)}`}
                  className="workbench-button-primary min-h-8 px-3"
                  disabled={pendingKey !== undefined}
                  onClick={() => { void runAction(`approve:${entry.id}`, () => onTransitionEntry(entry, 'approve'), t('timeTracking.approval.approved')) }}
                  type="button"
                >
                  {t('timeTracking.approval.approve')}
                </button>
                <button
                  aria-label={`${t('timeTracking.approval.reject')} ${memberName(entry.userId)} ${describeEntry(entry)}`}
                  className="workbench-button-secondary min-h-8 px-3"
                  disabled={pendingKey !== undefined}
                  onClick={() => setRejectingEntryId(entry.id)}
                  type="button"
                >
                  {t('timeTracking.approval.reject')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="time-approval-queue">
      <h2 className="sr-only" id={`${id}-title`}>{t('timeTracking.approval.title')}</h2>
      <TimeWeekNavigator formatters={formatters} onMove={onMoveWeek} t={t} week={week} />

      {canManage === false ? (
        <p className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-medium text-[var(--workbench-muted)]" role="status">
          {t('timeTracking.approval.permissionDenied')}
        </p>
      ) : null}

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.approval.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isPartial ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-fg-amber-800" role="alert">
          {t('timeTracking.approval.partial')}
        </p>
      ) : null}
      {isLoading || (canManage === undefined && !hasLoadError) ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {canManage ? (
        <>
          {teamTimesheet ? (
            <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
              <table className="w-full min-w-[560px] border-collapse text-sm" data-testid="team-timesheet-table">
                <caption className="sr-only">{t('timeTracking.approval.teamTotals')}</caption>
                <thead>
                  <tr className="bg-[var(--workbench-surface-muted)] text-xs font-semibold text-[var(--workbench-muted)]">
                    {week.days.map((date) => <th className="px-2 py-2 text-right" key={date} scope="col">{formatters.day(date)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {week.days.map((date) => (
                      <td className="px-2 py-2 text-right tabular-nums text-[var(--workbench-text)]" key={date}>{formatMinutes(dayTotals.get(date) ?? 0)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}

          <div aria-live="polite" role="status">
            {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
          </div>
          {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}

          <section aria-labelledby={`${id}-submitted`} className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-submitted`}>
                {interpolate(t('timeTracking.approval.submittedHeading'), { count: submittedCount })}
              </h3>
              <button
                className="workbench-button-primary min-h-9 px-3"
                disabled={submittedCount === 0 || isPartial || pendingKey !== undefined}
                onClick={() => { void transitionWeek('approve') }}
                type="button"
              >
                {t('timeTracking.approval.approveWeek')}
              </button>
            </div>
            {submitted.length === 0 && !isLoading ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.approval.emptySubmitted')}</p>
            ) : submitted.map(renderSubmittedGroup)}
          </section>

          <section aria-labelledby={`${id}-approved`} className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-approved`}>
                {interpolate(t('timeTracking.approval.approvedHeading'), { count: approved.length })}
              </h3>
              <button
                className="workbench-button-secondary min-h-9 px-3"
                disabled={approved.length === 0 || isPartial || pendingKey !== undefined}
                onClick={() => { void transitionWeek('lock') }}
                type="button"
              >
                {t('timeTracking.approval.lockWeek')}
              </button>
            </div>
            {approved.length === 0 ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.approval.emptyApproved')}</p>
            ) : (
              <ul className="grid min-w-0 gap-2">
                {approved.map((entry) => (
                  <li className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2 text-sm" key={entry.id}>
                    <span className="font-semibold text-[var(--workbench-text)]">{memberName(entry.userId)}</span>
                    <span className="font-semibold tabular-nums text-[var(--workbench-text)]">{formatMinutes(entry.durationMinutes)}</span>
                    <span className="min-w-0 flex-1 break-words text-[var(--workbench-muted)]">{describeEntry(entry)}</span>
                    <button
                      aria-label={`${t('timeTracking.approval.lock')} ${memberName(entry.userId)} ${describeEntry(entry)}`}
                      className="workbench-button-secondary min-h-8 px-3"
                      disabled={pendingKey !== undefined}
                      onClick={() => { void runAction(`lock:${entry.id}`, () => onTransitionEntry(entry, 'lock'), t('timeTracking.approval.locked')) }}
                      type="button"
                    >
                      {t('timeTracking.approval.lock')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {lockedCount > 0 ? (
              <p className="text-xs font-medium text-[var(--workbench-muted)]">{interpolate(t('timeTracking.approval.lockedSummary'), { count: lockedCount })}</p>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  )
}
