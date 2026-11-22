import { useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/** Paper sizes offered for printing a task view, always in landscape. */
export type TaskViewPrintPaper = 'a3' | 'a4'

/** Paper sizes in the order the print buttons offer them. */
export const taskViewPrintPapers: readonly TaskViewPrintPaper[] = ['a3', 'a4']

/** Views that print on their own (task views and the Planning timeline), named by `data-print-root` on the view root. */
export type TaskViewPrintTarget = 'planning-timeline' | 'task-gantt' | 'task-table' | 'team-issue-table'

/** Printable width in CSS pixels of each landscape paper size, inside 8mm margins. */
const taskViewPrintableWidths: Readonly<Record<TaskViewPrintPaper, number>> = {
  // (420mm - 16mm) and (297mm - 16mm) at 96 CSS pixels per inch.
  a3: 1_526,
  a4: 1_062,
}

/**
 * Returns the printable width of one landscape paper size, for views that lay out to the paper.
 *
 * @param paper - Paper size to print on.
 * @returns Width in CSS pixels inside the print margins.
 */
export function taskViewPrintableWidth(paper: TaskViewPrintPaper): number {
  return taskViewPrintableWidths[paper]
}

/** Inputs for printing one task view. */
type TaskViewPrintInput = {
  /** Width in CSS pixels of the content that must fit across the paper. */
  contentWidth: number
  /** Called after the print dialog closes, once the screen layout is restored. */
  onAfterPrint?: () => void
  /** Paper size to print on. */
  paper: TaskViewPrintPaper
  /** Root element of the view, carrying `data-print-root`. */
  root: HTMLElement
  /** View being printed. */
  target: TaskViewPrintTarget
}

/**
 * Prints only one task view on landscape paper, zoomed down to the paper width.
 *
 * `index.css` hides everything outside the root while `html[data-print-target]` is set and the
 * root carries `data-print-paper`; both are removed when the print dialog closes.
 *
 * @param input - View root, its content width, paper, and the restore callback.
 */
export function printTaskView(input: TaskViewPrintInput): void {
  const { contentWidth, onAfterPrint, paper, root, target } = input
  const zoom = contentWidth > 0 ? Math.min(1, taskViewPrintableWidths[paper] / contentWidth) : 1
  const documentElement = document.documentElement
  /** Restores the screen layout after the print dialog closes. */
  const restore = () => {
    delete documentElement.dataset.printTarget
    delete root.dataset.printPaper
    root.style.removeProperty('zoom')
    onAfterPrint?.()
  }
  documentElement.dataset.printTarget = target
  root.dataset.printPaper = paper
  root.style.setProperty('zoom', String(zoom))
  window.addEventListener('afterprint', restore, { once: true })
  window.print()
}

/** Print state of a table view whose rows are rendered in steps. */
type TaskViewTablePrint = {
  /** Prints the table on the given paper. */
  print: (paper: TaskViewPrintPaper) => void
  /** Whether every row is rendered because the table is being printed. */
  printsAllRows: boolean
  /** Ref for the table view's root element, which carries `data-print-root`. */
  rootRef: RefObject<HTMLElement | null>
}

/**
 * Prints a table view with every row, including rows the screen still holds back behind
 * "show more", and with its columns zoomed down to the paper width.
 *
 * @param target - Table view being printed.
 * @param contentWidth - Total width in CSS pixels of the table's columns.
 * @returns The root ref, whether all rows are rendered, and the print action.
 */
export function useTaskViewTablePrint(target: TaskViewPrintTarget, contentWidth: number): TaskViewTablePrint {
  const rootRef = useRef<HTMLElement>(null)
  const [printsAllRows, setPrintsAllRows] = useState(false)
  /**
   * Renders every row, then prints only the table.
   *
   * @param paper - Paper size to print on.
   */
  const print = (paper: TaskViewPrintPaper) => {
    const root = rootRef.current
    if (!root) return
    // Rows left out of the DOM cannot reach the paper.
    flushSync(() => setPrintsAllRows(true))
    printTaskView({
      // The paper fits the columns' own widths, not however wide the screen stretched the table.
      contentWidth,
      onAfterPrint: () => setPrintsAllRows(false),
      paper,
      root,
      target,
    })
  }
  return { print, printsAllRows, rootRef }
}
