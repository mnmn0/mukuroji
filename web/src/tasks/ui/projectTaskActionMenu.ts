import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import type { ProjectTask } from '../api/tasks'

/**
 * Opens the canonical Project task action menu for one row or card.
 *
 * @param task - Project task represented by the triggering row or card.
 * @param anchorPoint - Viewport coordinates used to anchor the menu.
 * @param returnFocusElement - Trigger element that regains focus after dismissal.
 * @returns Nothing.
 */
export type ProjectTaskActionMenuOpenHandler = (
  task: ProjectTask,
  anchorPoint: TaskActionContextMenuAnchorPoint,
  returnFocusElement: HTMLElement,
) => void
