import type { MyTimesheet } from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'
import type { MyTimesheetSubmitNotice } from '../model/myTimesheetSubmitNotice'
import { formatMinutes } from '../model/timePeriod'


/** Props of the personal timesheet across Teams. */
export type MyTimesheetPanelProps = {
  /** The caller's own time per Team, when loaded. */
  timesheet?: MyTimesheet
  /** Local dates of the week shown, in order. */
  days: readonly string[]
  /** Whether the timesheet is loading. */
  isLoading: boolean
  /** Whether the timesheet failed to load. */
  failed: boolean
  /** Whether a submission is running. */
  isSubmitting: boolean
  /** Outcome of the last submission. */
  notice?: MyTimesheetSubmitNotice
  /** Moves by whole weeks; turned off while a submission runs, so its outcome stays on its week. */
  onMoveWeek: (weeks: number) => void
  /** Submits every Team's drafts in the week. */
  onSubmit: () => void
  /** Re-fetches the timesheet. */
  onRetry: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Shows the caller's own time of every Team as one week table and submits it at once.
 *
 * @param props - Timesheet, week, submission state, and actions.
 * @returns The personal timesheet section.
 */
export function MyTimesheetPanel({
  days,
  failed,
  isLoading,
  isSubmitting,
  notice,
  onMoveWeek,
  onRetry,
  onSubmit,
  t,
  timesheet,
}: MyTimesheetPanelProps) {
  const teams = timesheet?.teams ?? []
  const pendingCount = teams.reduce((total, team) =>
    total + team.entries.filter((entry) => entry.status === 'draft' || entry.status === 'rejected').length, 0)
  return (
    <section className="grid gap-4" data-testid="my-timesheet">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg-0d1833">{t('myTimesheet.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('myTimesheet.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="workbench-button-secondary min-h-9 px-3" type="button" disabled={isSubmitting} onClick={() => onMoveWeek(-1)}>
            {t('myTimesheet.previous')}
          </button>
          <span className="text-sm font-semibold text-[var(--workbench-text)]" aria-live="polite">
            {days[0]} – {days.at(-1)}
          </span>
          <button className="workbench-button-secondary min-h-9 px-3" type="button" disabled={isSubmitting} onClick={() => onMoveWeek(1)}>
            {t('myTimesheet.next')}
          </button>
        </div>
      </div>
      {failed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-tone-f2c7c7 bg-tone-fff7f7 px-4 py-3 text-sm font-semibold text-fg-9f3f3f" role="alert">
          <span>{t('myTimesheet.error')}</span>
          <button className="rounded-md border border-tone-d99696 px-3 py-2 text-xs font-bold" type="button" onClick={onRetry}>
            {t('workload.retry')}
          </button>
        </div>
      ) : isLoading ? (
        <div className="border border-slate-200 bg-surface px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]" aria-live="polite">
          {t('workload.loading')}
        </div>
      ) : teams.length === 0 ? (
        <p className="border border-dashed border-slate-300 bg-surface px-5 py-6 text-sm font-semibold text-fg-0d1833">{t('myTimesheet.empty')}</p>
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-surface" tabIndex={0}>
          <table className="w-full min-w-[640px] border-collapse text-left text-sm" data-testid="my-timesheet-table">
            <caption className="sr-only">{t('myTimesheet.table.label')}</caption>
            <thead>
              <tr className="border-b border-slate-200 bg-tone-fbfcfd text-xs font-bold text-fg-69758a">
                <th className="px-4 py-3" scope="col">{t('myTimesheet.table.team')}</th>
                {days.map((day) => <th className="px-3 py-3 text-right" key={day} scope="col">{day.slice(5)}</th>)}
                <th className="px-3 py-3 text-right" scope="col">{t('myTimesheet.table.total')}</th>
                <th className="px-3 py-3 text-right" scope="col">{t('myTimesheet.table.pending')}</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const minutesByDay = new Map(team.timesheet.days.map((group) => [group.key, group.minutes]))
                const pending = team.entries.filter((entry) => entry.status === 'draft' || entry.status === 'rejected').length
                return (
                  <tr className="border-b border-slate-100 last:border-b-0" key={team.teamId}>
                    <th className="px-4 py-3 font-bold text-fg-0d1833" scope="row">{team.name}</th>
                    {days.map((day) => (
                      <td className="px-3 py-3 text-right tabular-nums" key={day}>{formatMinutes(minutesByDay.get(day) ?? 0)}</td>
                    ))}
                    <td className="px-3 py-3 text-right font-bold tabular-nums">
                      {formatMinutes(team.timesheet.days.reduce((total, group) => total + group.minutes, 0))}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{pending}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="workbench-button-primary min-h-9 px-4"
          disabled={isSubmitting || isLoading || failed || pendingCount === 0}
          type="button"
          onClick={onSubmit}
        >
          {isSubmitting ? t('myTimesheet.submitting') : t('myTimesheet.submit')}
        </button>
        {notice ? <p className="text-sm font-semibold text-[var(--workbench-text)]" role="status">{formatNotice(notice, t)}</p> : null}
      </div>
    </section>
  )
}

/**
 * Turns a submission outcome into text.
 *
 * @param notice - Submission outcome.
 * @param t - Translator.
 * @returns Status text.
 */
function formatNotice(notice: MyTimesheetSubmitNotice, t: (key: MessageKey) => string): string {
  if (notice.kind === 'submitted') return t('myTimesheet.submitted').replace('{count}', String(notice.count))
  if (notice.kind === 'partial') {
    return t('myTimesheet.partial').replace('{count}', String(notice.count)).replace('{failed}', String(notice.failed))
  }
  if (notice.kind === 'nothing') return t('myTimesheet.nothing')
  return t('myTimesheet.submitError')
}
