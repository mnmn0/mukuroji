import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createTaskCalendarMonthWindow,
  createTaskGanttWindow,
  getCurrentTaskMonth,
  shiftTaskMonth,
} from '../model/taskScheduleWindow'

/** Resolves a localized period-navigation message. */
type TaskScheduleWindowTranslator = (key: MessageKey) => string

/** Props for the period navigation of a windowed calendar or Gantt. */
type TaskScheduleWindowToolbarProps = {
  /** Accessible name of the navigation group. */
  ariaLabel: string
  /** Visible period, such as `2026-11-01 – 2026-11-30`. */
  periodLabel: string
  /** Note explaining which Work Items the period loads. */
  note?: string
  /** Label of the button that moves to the previous period. */
  previousLabel: string
  /** Label of the button that moves to the period containing today. */
  currentLabel: string
  /** Label of the button that moves to the next period. */
  nextLabel: string
  /** Moves to the previous period. */
  onPrevious: () => void
  /** Moves to the period containing today. */
  onCurrent: () => void
  /** Moves to the next period. */
  onNext: () => void
  /** Stable test identifier of the toolbar. */
  testId: string
}

/**
 * Renders previous / current / next controls for the visible period of a calendar or Gantt.
 *
 * @param props - Labels and period movement callbacks.
 * @returns The period navigation toolbar.
 */
function TaskScheduleWindowToolbar({
  ariaLabel,
  currentLabel,
  nextLabel,
  note,
  onCurrent,
  onNext,
  onPrevious,
  periodLabel,
  previousLabel,
  testId,
}: TaskScheduleWindowToolbarProps) {
  const buttonClassName = 'rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 py-1 text-xs font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
  return (
    <div
      aria-label={ariaLabel}
      className="flex flex-wrap items-center gap-2 border-b border-[var(--workbench-border)] bg-surface px-4 py-2"
      data-testid={testId}
      role="group"
    >
      <button className={buttonClassName} onClick={onPrevious} type="button">
        {previousLabel}
      </button>
      <button className={buttonClassName} onClick={onCurrent} type="button">
        {currentLabel}
      </button>
      <button className={buttonClassName} onClick={onNext} type="button">
        {nextLabel}
      </button>
      <p
        aria-live="polite"
        className="text-sm font-semibold text-[var(--workbench-text)]"
        data-testid={`${testId}-period`}
      >
        {periodLabel}
      </p>
      {note ? (
        <p className="basis-full text-xs font-medium text-[var(--workbench-muted)]">{note}</p>
      ) : null}
    </div>
  )
}

/** Props for the month navigation of a windowed calendar. */
export type TaskCalendarMonthNavigationProps = {
  /** Month the calendar shows, in `YYYY-MM` form. */
  month: string
  /** Moves the calendar to another month. */
  onMonthChange: (month: string) => void
  /** Translator used for labels. */
  t: TaskScheduleWindowTranslator
}

/**
 * Renders the month navigation of a windowed calendar.
 *
 * It is shown with the calendar and also alone when the month fails to load, so another month
 * can still be chosen.
 *
 * @param props - Visible month, movement callback, and translator.
 * @returns The calendar month navigation.
 */
export function TaskCalendarMonthNavigation({ month, onMonthChange, t }: TaskCalendarMonthNavigationProps) {
  const window = createTaskCalendarMonthWindow(month)
  return (
    <TaskScheduleWindowToolbar
      ariaLabel={t('tasks.calendar.monthNavigation')}
      currentLabel={t('tasks.calendar.currentMonth')}
      nextLabel={t('tasks.calendar.nextMonth')}
      note={t('tasks.scheduleWindow.note')}
      onCurrent={() => onMonthChange(getCurrentTaskMonth())}
      onNext={() => onMonthChange(shiftTaskMonth(month, 1))}
      onPrevious={() => onMonthChange(shiftTaskMonth(month, -1))}
      periodLabel={t('tasks.scheduleWindow.range')
        .replace('{from}', window.from)
        .replace('{to}', window.to)}
      previousLabel={t('tasks.calendar.previousMonth')}
      testId="task-calendar-month-navigation"
    />
  )
}

/** Props for the period navigation of a windowed Gantt. */
export type TaskGanttPeriodNavigationProps = {
  /** First month of the period, in `YYYY-MM` form. */
  startMonth: string
  /** Moves the period to start at another month. */
  onStartMonthChange: (month: string) => void
  /** Translator used for labels. */
  t: TaskScheduleWindowTranslator
}

/**
 * Renders the period navigation of a windowed Gantt.
 *
 * It is shown with the Gantt and also alone when the period fails to load, so another period
 * can still be chosen.
 *
 * @param props - First month, movement callback, and translator.
 * @returns The Gantt period navigation.
 */
export function TaskGanttPeriodNavigation({
  onStartMonthChange,
  startMonth,
  t,
}: TaskGanttPeriodNavigationProps) {
  const window = createTaskGanttWindow(startMonth)
  return (
    <TaskScheduleWindowToolbar
      ariaLabel={t('tasks.gantt.periodNavigation')}
      currentLabel={t('tasks.gantt.currentPeriod')}
      nextLabel={t('tasks.gantt.nextPeriod')}
      note={t('tasks.scheduleWindow.note')}
      onCurrent={() => onStartMonthChange(getCurrentTaskMonth())}
      onNext={() => onStartMonthChange(shiftTaskMonth(startMonth, 1))}
      onPrevious={() => onStartMonthChange(shiftTaskMonth(startMonth, -1))}
      periodLabel={t('tasks.scheduleWindow.range')
        .replace('{from}', window.from)
        .replace('{to}', window.to)}
      previousLabel={t('tasks.gantt.previousPeriod')}
      testId="task-gantt-period-navigation"
    />
  )
}
