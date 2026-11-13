import type { TimeWeekPeriod } from '../model/timePeriod'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'

/** Props of the week navigator. */
export type TimeWeekNavigatorProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Moves by whole weeks; 0 returns to the current week. */
  onMove: (weeks: number) => void
}

/**
 * Previous / current / next week controls with the visible range.
 *
 * @param props - Week and move action.
 * @returns Navigator.
 */
export function TimeWeekNavigator({ formatters, onMove, t, week }: TimeWeekNavigatorProps) {
  const first = week.days[0] ?? ''
  const last = week.days.at(-1) ?? ''
  return (
    <nav aria-label={t('timeTracking.week.navigation')} className="flex min-w-0 flex-wrap items-center gap-2">
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(-1)} type="button">
        {t('timeTracking.week.previous')}
      </button>
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(0)} type="button">
        {t('timeTracking.week.current')}
      </button>
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(1)} type="button">
        {t('timeTracking.week.next')}
      </button>
      <h3 aria-live="polite" className="text-base font-semibold text-[var(--workbench-text)]">
        {formatters.day(first)} – {formatters.day(last)}
      </h3>
    </nav>
  )
}
