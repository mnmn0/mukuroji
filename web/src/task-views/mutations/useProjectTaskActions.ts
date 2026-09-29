import type {
  ProjectTaskViewScope,
  WorkItemActionId,
  WorkItemActionSelection,
} from '@mukuroji/contracts'
import { useMemo } from 'react'
import {
  useTaskSurfaceActions,
  type TaskSurfaceActionController,
  type TaskSurfaceActionDisabledReasons,
  type TaskSurfaceActionHandlers,
  type TaskSurfaceActionLabels,
  type TaskSurfaceActionPermissions,
} from './useTaskSurfaceActions'
import type { TaskActionExecutionResult } from '../model/taskActionRegistry'

/** Canonical Project actions backed by the existing bulk mutation toolbar. */
export const projectTaskBulkActionIds: readonly WorkItemActionId[] = ['move', 'assign', 'archive']

/** Input used to register and execute Project task actions. */
export type UseProjectTaskActionsOptions = {
  /** Saved task view active when an action is invoked. */
  activeViewId?: string
  /** Current Project identifier. */
  projectId: string
  /** Optional Team qualifier for a Team-selected Project route. */
  teamId?: string
  /** Permission-pruned focus and selection snapshot. */
  selection: WorkItemActionSelection
  /** Localized action labels. */
  labels: TaskSurfaceActionLabels
  /** Localized reasons used for unavailable or invalid actions. */
  disabledReasons: TaskSurfaceActionDisabledReasons
  /** Existing safe UI or mutation entrances for canonical actions. */
  handlers: TaskSurfaceActionHandlers
  /** Target-aware permission checks evaluated before action-specific validation. */
  permissions?: TaskSurfaceActionPermissions
  /** Receives every normalized pipeline result regardless of invocation path. */
  onExecutionResult?: (result: TaskActionExecutionResult) => void
}

/**
 * Adapts the Project route to the surface-neutral task action controller.
 *
 * @param options - Current Project scope, selection, labels, and safe action entrances.
 * @returns Shared action registry and execution operations.
 */
export function useProjectTaskActions(
  options: UseProjectTaskActionsOptions,
): TaskSurfaceActionController {
  const scope = useMemo<ProjectTaskViewScope>(() => ({
    kind: 'project',
    projectId: options.projectId,
    ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
  }), [options.projectId, options.teamId])

  return useTaskSurfaceActions({
    ...(options.activeViewId !== undefined ? { activeViewId: options.activeViewId } : {}),
    bulkActionIds: projectTaskBulkActionIds,
    disabledReasons: options.disabledReasons,
    handlers: options.handlers,
    labels: options.labels,
    ...(options.onExecutionResult !== undefined
      ? { onExecutionResult: options.onExecutionResult }
      : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    registrationId: `project-task-actions:${options.projectId}`,
    scope,
    selection: options.selection,
    surface: 'project',
  })
}
