import type { MessageKey } from '../../shared/i18n/i18n'
import { taskViewPrintPapers, type TaskViewPrintPaper } from './taskViewPrint'

/** Props for the print buttons of a table view. */
type TaskViewPrintButtonsProps = {
  /** Prints the view on the chosen paper. */
  onPrint: (paper: TaskViewPrintPaper) => void
  /** Test id of the button group. */
  testId: string
  /** Translator used for labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the "print on A3 / A4 landscape" buttons of a table view, hidden on paper.
 *
 * @param props - Print action, test id, and translator.
 * @returns The print button group.
 */
export function TaskViewPrintButtons({ onPrint, testId, t }: TaskViewPrintButtonsProps) {
  return (
    <div
      aria-label={t('tasks.table.print')}
      className="flex items-center gap-2"
      data-print-hidden=""
      data-testid={testId}
      role="group"
    >
      {taskViewPrintPapers.map((paper) => (
        <button
          className="rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 py-1 text-xs font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
          data-testid={`${testId}-${paper}`}
          key={paper}
          onClick={() => onPrint(paper)}
          type="button"
        >
          {t(paper === 'a3' ? 'tasks.gantt.printA3' : 'tasks.gantt.printA4')}
        </button>
      ))}
    </div>
  )
}
