import type { MessageKey } from '../../shared/i18n/i18n'

/** Number of table rows rendered at first, and added by each "show more" step. */
export const TASK_TABLE_RENDER_STEP = 200

/** Number of board cards rendered per status column at first, and added by each step. */
export const TASK_BOARD_COLUMN_RENDER_STEP = 50

/**
 * Formats the label of the button that renders the next step of a long list.
 *
 * @param t - Translator of the current locale.
 * @param stepSize - Number of items one step renders.
 * @param hiddenCount - Number of items not rendered yet.
 * @returns A label such as "Show 200 more (1,800 not shown)".
 */
export function formatShowMoreLabel(
  t: (key: MessageKey) => string,
  stepSize: number,
  hiddenCount: number,
): string {
  return t('tasks.showMore')
    .replace('{count}', String(Math.min(stepSize, hiddenCount)))
    .replace('{remaining}', String(hiddenCount))
}
