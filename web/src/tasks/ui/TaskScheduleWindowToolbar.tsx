/** Props for the period navigation of a windowed calendar or Gantt. */
export type TaskScheduleWindowToolbarProps = {
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
export function TaskScheduleWindowToolbar({
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
