import type { TimePeriodClose } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { monthPattern, readReason, type Feedback } from './timePeriodForm'
import type { TeamTimePeriods } from '../api/timePeriods'
import {
  describeTimeTrackingFailure,
  interpolate,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'

/** Props of the month close view. */
export type TimePeriodClosePanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date formatters. */
  formatters: TimeTrackingFormatters
  /** Formats a `YYYY-MM` month for display. */
  formatMonth: (month: string) => string
  /** IANA timezone a new close uses for the month boundaries. */
  timeZone: string
  /** Month the close form starts with, as `YYYY-MM`. */
  defaultMonth: string
  /** The Team's closed months and the caller's permissions; absent while loading. */
  periods?: TeamTimePeriods
  /** Whether the Team's closed months are loading. */
  isLoading?: boolean
  /** Whether reading the Team's closed months failed. */
  hasLoadError?: boolean
  /** Reloads the Team's closed months. */
  onRetry: () => void
  /** Closes a month of the Team. */
  onCloseMonth: (month: string) => Promise<unknown>
  /** Reopens a month of the Team with a reason. */
  onReopenMonth: (month: string, reason: string) => Promise<unknown>
}

/**
 * Closes and reopens a Team's months.
 *
 * @param props - Close state, permissions, and actions.
 * @returns Month close view.
 */
export function TimePeriodClosePanel({
  defaultMonth,
  formatMonth,
  formatters,
  hasLoadError = false,
  isLoading = false,
  onCloseMonth,
  onReopenMonth,
  onRetry,
  periods,
  t,
  timeZone,
}: TimePeriodClosePanelProps) {
  const id = useId()
  const [month, setMonth] = useState(defaultMonth)
  const [pendingKey, setPendingKey] = useState<string>()
  const [reopeningMonth, setReopeningMonth] = useState<string>()
  const [feedback, setFeedback] = useState<Feedback>()
  const canManage = periods?.canManagePeriods === true

  /**
   * Runs one action unless another is pending.
   *
   * @param key - Pending action identity.
   * @param operation - Action to run.
   * @returns Whether the action succeeded.
   */
  const run = async (key: string, operation: () => Promise<void>) => {
    if (pendingKey) return false
    setPendingKey(key)
    try {
      await operation()
      return true
    } finally {
      setPendingKey(undefined)
    }
  }

  /**
   * Closes the chosen month of the Team.
   *
   * @param event - Close form submission.
   */
  const submitClose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!monthPattern.test(month)) return
    setFeedback(undefined)
    await run('close', async () => {
      try {
        await onCloseMonth(month)
        setFeedback({ tone: 'status', text: interpolate(t('timeTracking.periods.closed'), { month: formatMonth(month) }) })
      } catch (error) {
        setFeedback(isAlreadyClosed(error)
          ? { tone: 'status', text: interpolate(t('timeTracking.periods.alreadyClosed'), { month: formatMonth(month) }) }
          : { tone: 'error', text: describeTimeTrackingFailure(t, error) })
      }
    })
  }

  /**
   * Reopens a Team month with the typed reason.
   *
   * @param event - Reason form submission.
   * @param close - Month being reopened.
   */
  const submitReopen = async (event: FormEvent<HTMLFormElement>, close: TimePeriodClose) => {
    event.preventDefault()
    const reason = readReason(event)
    if (!reason) {
      setFeedback({ tone: 'error', text: t('timeTracking.periods.reasonRequired') })
      return
    }
    setFeedback(undefined)
    await run(`reopen:${close.month}`, async () => {
      try {
        await onReopenMonth(close.month, reason)
        setReopeningMonth(undefined)
        setFeedback({ tone: 'status', text: interpolate(t('timeTracking.periods.reopened'), { month: formatMonth(close.month) }) })
      } catch (error) {
        setFeedback({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
      }
    })
  }

  const closedPeriods = [...(periods?.closedPeriods ?? [])].sort((left, right) => right.month.localeCompare(left.month))

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-5" data-testid="time-period-close">
      <div className="grid min-w-0 gap-1">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.periods.title')}</h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.periods.description')}</p>
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.periods.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading && !periods ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.periods.loading')}</p> : null}

      {periods && !canManage ? (
        <p className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-medium text-[var(--workbench-muted)]" role="status">
          {t('timeTracking.periods.readOnly')}
        </p>
      ) : null}

      {canManage ? (
        <form className="flex min-w-0 flex-wrap items-end gap-3" onSubmit={(event) => { void submitClose(event) }}>
          <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-month`}>
            {t('timeTracking.periods.month')}
            <input
              className="workbench-input min-h-9 px-3"
              id={`${id}-month`}
              onChange={(event) => setMonth(event.target.value)}
              pattern="[0-9]{4}-[0-9]{2}"
              placeholder="YYYY-MM"
              required
              type="month"
              value={month}
            />
          </label>
          <button className="workbench-button-primary min-h-9 px-3" disabled={pendingKey !== undefined || !monthPattern.test(month)} type="submit">
            {t('timeTracking.periods.close')}
          </button>
          <p className="basis-full text-xs font-medium text-[var(--workbench-muted)]">{interpolate(t('timeTracking.periods.timeZone'), { timeZone })}</p>
        </form>
      ) : null}

      <div aria-live="polite" role="status">
        {feedback?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{feedback.text}</p> : null}
      </div>
      {feedback?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{feedback.text}</p> : null}

      {periods ? (
        <section aria-labelledby={`${id}-closed`} className="grid min-w-0 gap-2">
          <h3 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-closed`}>{t('timeTracking.periods.closedHeading')}</h3>
          {closedPeriods.length === 0 ? (
            <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.periods.empty')}</p>
          ) : (
            <ul className="grid min-w-0 gap-2">
              {closedPeriods.map((close) => (
                <li className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2" data-testid="time-period-row" key={close.month}>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-[var(--workbench-text)]">{formatMonth(close.month)}</span>
                    <span className="min-w-0 flex-1 break-words text-[var(--workbench-muted)]">
                      {interpolate(t('timeTracking.periods.closedAt'), { date: formatters.date(close.closedAt), timeZone: close.timeZone })}
                    </span>
                    {canManage && reopeningMonth !== close.month ? (
                      <button
                        aria-label={interpolate(t('timeTracking.periods.reopenMonth'), { month: formatMonth(close.month) })}
                        className="workbench-button-secondary min-h-8 px-3"
                        disabled={pendingKey !== undefined}
                        onClick={() => setReopeningMonth(close.month)}
                        type="button"
                      >
                        {t('timeTracking.periods.reopen')}
                      </button>
                    ) : null}
                  </div>
                  {canManage && reopeningMonth === close.month ? (
                    <form className="grid min-w-0 gap-2" onSubmit={(event) => { void submitReopen(event, close) }}>
                      <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-reason-${close.month}`}>
                        {t('timeTracking.periods.reopenReason')}
                        <textarea autoFocus className="workbench-input min-h-16 w-full min-w-0 px-3 py-2" id={`${id}-reason-${close.month}`} maxLength={4000} name="reason" required />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button className="workbench-button-primary min-h-8 px-3" disabled={pendingKey !== undefined} type="submit">
                          {t('timeTracking.periods.confirmReopen')}
                        </button>
                        <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setReopeningMonth(undefined)} type="button">
                          {t('timeTracking.form.cancel')}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

    </section>
  )
}

/**
 * Tells whether a close failed because the month was closed already.
 *
 * @param error - Failure from the close request.
 * @returns Whether the API answered `TimePeriodAlreadyClosed`.
 */
function isAlreadyClosed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'TimePeriodAlreadyClosed'
}
