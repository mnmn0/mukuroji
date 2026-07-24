import type { TaskTab } from '../model/taskView'

/** The DOM id shared by the task tab list and its active panel. */
export const taskTabPanelId = 'task-tabpanel'

/**
 * Builds the stable DOM id used by a task view tab.
 *
 * @param tab - Task view represented by the tab.
 * @returns The stable tab DOM id.
 */
export function createTaskTabId(tab: TaskTab) {
  return `task-tab-${tab}`
}
