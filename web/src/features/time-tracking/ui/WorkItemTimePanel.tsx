import type { RunningTimer, TimeEntry, TimeEstimate } from '@mukuroji/contracts'
import { useId, useMemo, useState, type FormEvent } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import type { TimeEntryDraftInput } from '../api/timeEntries'
import { isTimerOverlong, readTimerElapsedMilliseconds, sortTimeEntries, sumTimeEntryMinutes } from '../model/timeEntryLifecycle'
import { createTrailingPeriod, formatElapsed, formatMinutes, parseHoursInput, readLocalNoon, resolveBrowserTimeZone, toLocalDateKey } from '../model/timePeriod'
import { useActiveTimer } from '../queries/useActiveTimer'
import { useRejectionReasons } from '../queries/useRejectionReasons'
import { useTeamTimesheet } from '../queries/useTeamTimesheet'
import { useTimeEntries } from '../queries/useTimeEntries'
import { useTimeEstimate } from '../queries/useTimeEstimate'
import { useWorkItemActualMinutes } from '../queries/useWorkItemActualMinutes'
import { useTimeEntryMutations } from '../mutations/useTimeEntryMutations'
import { useTimeEstimateMutation } from '../mutations/useTimeEstimateMutation'
import { useTimerMutations } from '../mutations/useTimerMutations'
import { TimeEntryForm } from './TimeEntryForm'
import { TimeEntryList } from './TimeEntryList'
import {
  createTimeTrackingFormatters,
  describeTimeTrackingFailure,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'
import { useLocalToday, useNow } from './useNow'

/** Days of the member's own entries listed under a Work Item. */
const ownEntryPeriodDays = 90

/** Props of the pure Work Item time panel. */
export type WorkItemTimePanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Current time used for the running timer. */
  now: Date
  /** Work Item shown by the panel. */
  workItemId: string
  /** Team that owns the Work Item; Work Item identifiers are only unique within a Team. */
  teamId: string
  /** Today's local date, the default for a new entry; falls back to the date of `now`. */
  today?: string
  /** Running timer of the member, `null` when none runs, undefined while loading. */
  timer: RunningTimer | null | undefined
  /** Estimate, `null` when unset, undefined while loading. */
  estimate: TimeEstimate | null | undefined
  /** Team's actual minutes on the Work Item over the last year, undefined while loading. */
  actualMinutes: number | undefined
  /** Member's own entries on the Work Item, newest first. */
  entries: readonly TimeEntry[]
  /** Latest rejection reason keyed by entry identifier. */
  rejectionReasons?: Readonly<Record<string, string>>
  /** Whether the first read is still loading. */
  isLoading?: boolean
  /** Whether a read failed. */
  hasLoadError?: boolean
  /** Whether the member may only read. */
  readOnly?: boolean
  /** Whether the member manages the Team and may set the estimate; only Team managers may. */
  canEditEstimate?: boolean
  /** Link to the member's timesheet. */
  timesheetHref?: string
  /** Reloads the panel. */
  onRetry: () => void
  /** Starts the timer on this Work Item. */
  onStartTimer: (billable: boolean) => Promise<unknown>
  /** Stops the running timer and records it. */
  onStopTimer: (timer: RunningTimer) => Promise<unknown>
  /** Discards the running timer. */
  onDiscardTimer: (timer: RunningTimer) => Promise<unknown>
  /** Saves the estimate in minutes. */
  onSaveEstimate: (minutes: number, expectedRevision: number) => Promise<unknown>
  /** Records a manual entry. */
  onCreateEntry: (input: TimeEntryDraftInput) => Promise<unknown>
  /** Edits an entry. */
  onUpdateEntry: (entry: TimeEntry, input: TimeEntryDraftInput) => Promise<unknown>
  /** Submits an entry. */
  onSubmitEntry: (entry: TimeEntry) => Promise<unknown>
}

/** Props of the Work Item time panel connected to the API. */
export type WorkItemTimePanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item identifier. */
  workItemId: string
  /** Display locale. */
  locale: Locale
  /** Whether the member may only read. */
  readOnly?: boolean
  /** Link to the member's timesheet. */
  timesheetHref?: string
  /** Signed-in member key, so a manager's list keeps only their own entries. */
  memberKey?: string
}

/**
 * Connects the Work Item time panel to the timer, entry, estimate, and summary APIs.
 *
 * Setting the estimate needs Team-manager permission. Like the approval queue, the panel reads
 * that from the Team timesheet's `costsRedacted` flag (one day, shared by every panel of the Team),
 * and keeps the estimate controls hidden until it is known.
 *
 * @param props - Work Item and session.
 * @returns Connected panel.
 */
export function WorkItemTimePanelContainer({
  accessToken,
  locale,
  memberKey,
  readOnly = false,
  teamId,
  timesheetHref,
  workItemId,
}: WorkItemTimePanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  // The windows end at the next local midnight and move forward with the date.
  const today = useLocalToday()
  const period = useMemo(() => createTrailingPeriod(ownEntryPeriodDays, readLocalNoon(today)), [today])
  const accessProbe = useMemo(() => ({ ...createTrailingPeriod(1, readLocalNoon(today)), timeZone: resolveBrowserTimeZone() }), [today])
  const timer = useActiveTimer(accessToken)
  const estimate = useTimeEstimate(accessToken, teamId, workItemId)
  const actual = useWorkItemActualMinutes(accessToken, teamId, workItemId)
  // Managers would otherwise read every member's entries; the panel lists the member's own.
  const ownEntries = useTimeEntries(accessToken, teamId, period, memberKey ? { userId: memberKey } : {})
  const entries = useMemo(
    () => sortTimeEntries((ownEntries.data?.entries ?? []).filter((entry) => entry.workItemId === workItemId)).reverse(),
    [ownEntries.data, workItemId],
  )
  const rejectionReasons = useRejectionReasons(accessToken, entries)
  const teamAccess = useTeamTimesheet(accessToken, teamId, accessProbe, !readOnly)
  const entryMutations = useTimeEntryMutations(accessToken)
  const timerMutations = useTimerMutations(accessToken)
  const saveEstimate = useTimeEstimateMutation(accessToken, teamId, workItemId)
  const isTimerOnItem = timer.data?.teamId === teamId && timer.data.workItemId === workItemId
  const now = useNow(isTimerOnItem)

  return (
    <WorkItemTimePanel
      actualMinutes={actual.data}
      entries={entries}
      estimate={estimate.data}
      formatters={formatters}
      canEditEstimate={teamAccess.data ? !teamAccess.data.costsRedacted : false}
      hasLoadError={Boolean(timer.error ?? estimate.error ?? ownEntries.error ?? actual.error ?? rejectionReasons.error ?? teamAccess.error)}
      isLoading={timer.isLoading || estimate.isLoading || ownEntries.isLoading}
      now={now}
      onCreateEntry={(input) => entryMutations.create(teamId, input)}
      onDiscardTimer={(running) => timerMutations.discard(running)}
      onRetry={() => {
        void Promise.all([
          timer.mutate(),
          estimate.mutate(),
          ownEntries.mutate(),
          actual.mutate(),
          rejectionReasons.mutate(),
          teamAccess.mutate(),
        ]).catch(() => undefined)
      }}
      onSaveEstimate={(minutes, expectedRevision) => saveEstimate(minutes, expectedRevision)}
      onStartTimer={(billable) => timerMutations.start(teamId, { workItemId, billable })}
      onStopTimer={(running) => timerMutations.stop(running)}
      onSubmitEntry={(entry) => entryMutations.transition(entry, 'submit')}
      onUpdateEntry={(entry, input) => entryMutations.update(entry, input)}
      readOnly={readOnly}
      rejectionReasons={rejectionReasons.data}
      t={t}
      teamId={teamId}
      timer={timer.data}
      today={today}
      {...(timesheetHref ? { timesheetHref } : {})}
      workItemId={workItemId}
    />
  )
}

/**
 * Pure view of a Work Item's time: estimate against actual, the member's timer, and their entries.
 *
 * @param props - Time data and actions.
 * @returns Panel.
 */
export function WorkItemTimePanel({
  actualMinutes,
  canEditEstimate = false,
  entries,
  estimate,
  formatters,
  hasLoadError = false,
  isLoading = false,
  now,
  onCreateEntry,
  onDiscardTimer,
  onRetry,
  onSaveEstimate,
  onStartTimer,
  onStopTimer,
  onSubmitEntry,
  onUpdateEntry,
  readOnly = false,
  rejectionReasons,
  t,
  teamId,
  timer,
  timesheetHref,
  today,
  workItemId,
}: WorkItemTimePanelProps) {
  const id = useId()
  const [isCreating, setIsCreating] = useState(false)
  // Revision of the estimate when its editor opened, so a change made elsewhere meanwhile is a
  // revision conflict rather than overwritten; undefined while the editor is closed.
  const [estimateEditRevision, setEstimateEditRevision] = useState<number>()
  const isEditingEstimate = estimateEditRevision !== undefined
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | 'discard' | 'estimate'>()
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const isTimerOnItem = timer?.teamId === teamId && timer.workItemId === workItemId
  const isTimerElsewhere = Boolean(timer) && !isTimerOnItem
  const overlong = timer ? isTimerOverlong(timer.startedAt, now) : false
  const ownMinutes = sumTimeEntryMinutes(entries)
  const remainingMinutes = estimate && actualMinutes !== undefined ? estimate.estimateMinutes - actualMinutes : undefined

  /**
   * Runs one panel action, announcing success or the reason it failed.
   *
   * @param action - Pending action name.
   * @param operation - Operation to run.
   * @param successText - Text announced after success.
   * @returns Whether the action succeeded.
   */
  const runAction = async (
    action: 'start' | 'stop' | 'discard' | 'estimate',
    operation: () => Promise<unknown>,
    successText: string,
  ): Promise<boolean> => {
    if (pendingAction) return false
    setPendingAction(action)
    setMessage(undefined)
    try {
      await operation()
      setMessage({ tone: 'status', text: successText })
      return true
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
      return false
    } finally {
      setPendingAction(undefined)
    }
  }

  /**
   * Saves the typed estimate.
   *
   * @param event - Estimate form submission.
   */
  const submitEstimate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('estimateHours')
    const minutes = typeof value === 'string' ? parseHoursInput(value) : undefined
    if (minutes === undefined) {
      setMessage({ tone: 'error', text: t('timeTracking.estimate.invalid') })
      return
    }
    const expectedRevision = estimateEditRevision ?? estimate?.revision ?? 0
    if (await runAction('estimate', () => onSaveEstimate(minutes, expectedRevision), t('timeTracking.estimate.saved'))) {
      setEstimateEditRevision(undefined)
    }
  }

  /**
   * Renders stop and discard for the member's running timer.
   *
   * @param running - Timer to act on.
   * @returns Timer actions.
   */
  const renderTimerActions = (running: RunningTimer) => (
    <div className="flex flex-wrap gap-2">
      {overlong ? null : (
        <button
          className="workbench-button-primary min-h-9 px-4"
          disabled={pendingAction !== undefined}
          onClick={() => { void runAction('stop', () => onStopTimer(running), t('timeTracking.timer.stopped')) }}
          type="button"
        >
          {t('timeTracking.timer.stop')}
        </button>
      )}
      <button
        className="workbench-button-secondary min-h-9 px-4"
        disabled={pendingAction !== undefined}
        onClick={() => {
          if (!window.confirm(t('timeTracking.timer.discardConfirm'))) return
          void runAction('discard', () => onDiscardTimer(running), t('timeTracking.timer.discarded'))
        }}
        type="button"
      >
        {t('timeTracking.timer.discard')}
      </button>
    </div>
  )

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 gap-3 border-t border-[var(--workbench-border)] pt-4"
      data-testid="work-item-time-panel"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.panel.title')}</h3>
        {timesheetHref ? (
          <a className="text-sm font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline" href={timesheetHref}>
            {t('timeTracking.panel.openTimesheet')}
          </a>
        ) : null}
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.panel.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      <dl className="grid min-w-0 grid-cols-3 gap-2 max-[520px]:grid-cols-1" data-testid="work-item-time-totals">
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.panel.estimate')}</dt>
          <dd className="text-base font-semibold tabular-nums text-[var(--workbench-text)]">
            {estimate ? formatMinutes(estimate.estimateMinutes) : estimate === null ? t('timeTracking.panel.notSet') : '–'}
          </dd>
        </div>
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.panel.actual')}</dt>
          <dd className="text-base font-semibold tabular-nums text-[var(--workbench-text)]">
            {actualMinutes === undefined ? '–' : formatMinutes(actualMinutes)}
          </dd>
        </div>
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
            {remainingMinutes !== undefined && remainingMinutes < 0 ? t('timeTracking.panel.over') : t('timeTracking.panel.remaining')}
          </dt>
          <dd className={`text-base font-semibold tabular-nums ${remainingMinutes !== undefined && remainingMinutes < 0 ? 'text-fg-red-700' : 'text-[var(--workbench-text)]'}`}>
            {remainingMinutes === undefined ? '–' : formatMinutes(Math.abs(remainingMinutes))}
          </dd>
        </div>
      </dl>
      <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('timeTracking.panel.actualHint')}</p>

      {readOnly || !canEditEstimate ? null : isEditingEstimate ? (
        <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={(event) => { void submitEstimate(event) }}>
          <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-estimate`}>
            {t('timeTracking.estimate.label')}
            <input
              aria-describedby={`${id}-estimate-help`}
              className="workbench-input h-9 w-32 px-3"
              defaultValue={estimate ? String(estimate.estimateMinutes / 60) : ''}
              id={`${id}-estimate`}
              inputMode="decimal"
              name="estimateHours"
            />
          </label>
          <button className="workbench-button-primary min-h-9 px-3" disabled={pendingAction !== undefined} type="submit">
            {t('timeTracking.estimate.save')}
          </button>
          <button className="workbench-button-secondary min-h-9 px-3" onClick={() => setEstimateEditRevision(undefined)} type="button">
            {t('timeTracking.form.cancel')}
          </button>
          <span className="w-full text-xs text-[var(--workbench-muted)]" id={`${id}-estimate-help`}>{t('timeTracking.estimate.help')}</span>
        </form>
      ) : (
        <div>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setEstimateEditRevision(estimate?.revision ?? 0)} type="button">
            {estimate ? t('timeTracking.estimate.edit') : t('timeTracking.estimate.add')}
          </button>
        </div>
      )}

      {timer && isTimerOnItem ? (
        <div className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3" data-testid="work-item-time-running">
          <p className="flex flex-wrap items-baseline gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            <span>{t('timeTracking.timer.running')}</span>
            <span aria-hidden="true" className="text-lg tabular-nums">{formatElapsed(readTimerElapsedMilliseconds(timer.startedAt, now))}</span>
            <span className="text-xs font-medium text-[var(--workbench-muted)]">
              {t('timeTracking.timer.startedAt')} {formatters.time(timer.startedAt)}
            </span>
          </p>
          {overlong ? <p className="text-xs font-semibold text-fg-red-700">{t('timeTracking.timer.overlong')}</p> : null}
          {readOnly ? null : renderTimerActions(timer)}
        </div>
      ) : (
        <>
          {readOnly ? null : (
            <form
              className="flex min-w-0 flex-wrap items-center gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                const billable = new FormData(event.currentTarget).get('billable') === 'on'
                void runAction('start', () => onStartTimer(billable), t('timeTracking.timer.started'))
              }}
            >
              <button
                className="workbench-button-primary min-h-9 px-4"
                disabled={pendingAction !== undefined || isTimerElsewhere || timer === undefined}
                type="submit"
              >
                {t('timeTracking.timer.start')}
              </button>
              <label className="flex items-center gap-2 text-sm font-medium text-[var(--workbench-text)]">
                <input name="billable" type="checkbox" />
                {t('timeTracking.form.billable')}
              </label>
            </form>
          )}
          {timer && isTimerElsewhere ? (
            <div className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3" data-testid="work-item-time-elsewhere">
              <p className="flex flex-wrap items-baseline gap-2 text-xs font-medium text-[var(--workbench-muted)]">
                <span>{t('timeTracking.timer.runningElsewhere')}</span>
                <span aria-hidden="true" className="tabular-nums">{formatElapsed(readTimerElapsedMilliseconds(timer.startedAt, now))}</span>
              </p>
              {overlong ? <p className="text-xs font-semibold text-fg-red-700">{t('timeTracking.timer.overlong')}</p> : null}
              {/* The other item may no longer show a time section, so its timer can be stopped from here. */}
              {renderTimerActions(timer)}
            </div>
          ) : null}
        </>
      )}

      <div aria-live="polite" role="status">
        {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
      </div>
      {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}

      <div className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h4 className="workbench-eyebrow text-[var(--workbench-muted)]">
            {t('timeTracking.panel.ownEntries')} · {formatMinutes(ownMinutes)}
          </h4>
          {readOnly || isCreating ? null : (
            <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setIsCreating(true)} type="button">
              {t('timeTracking.panel.addEntry')}
            </button>
          )}
        </div>
        {isCreating ? (
          <TimeEntryForm
            defaultDate={today ?? toLocalDateKey(now)}
            fixedWorkItemId={workItemId}
            onCancel={() => setIsCreating(false)}
            onSave={async (input) => {
              await onCreateEntry(input)
              setIsCreating(false)
              setMessage({ tone: 'status', text: t('timeTracking.entry.created') })
            }}
            t={t}
          />
        ) : null}
        {entries.length === 0 && !isLoading ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.panel.empty')}</p>
        ) : (
          <TimeEntryList
            entries={entries}
            formatters={formatters}
            {...(readOnly ? {} : { onSubmit: onSubmitEntry, onUpdate: onUpdateEntry })}
            showDate
            {...(rejectionReasons ? { rejectionReasons } : {})}
            t={t}
          />
        )}
      </div>
    </section>
  )
}
