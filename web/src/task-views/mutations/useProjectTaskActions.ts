import type {
  ProjectTaskViewScope,
  WorkItemActionContext,
  WorkItemActionSelection,
  WorkItemActionTarget,
} from '@mukuroji/contracts'
import { useMemo } from 'react'
import {
  createTaskSurfaceActionRegistry,
  resolveTaskSurfaceActionTarget,
  resolveTaskSurfaceActionTargets,
  useTaskSurfaceActions,
  type CreateTaskSurfaceActionRegistryOptions,
  type TaskSurfaceActionController,
  type TaskSurfaceActionDisabledReasons,
  type TaskSurfaceActionHandler,
  type TaskSurfaceActionHandlers,
  type TaskSurfaceActionLabels,
  type TaskSurfaceActionPermission,
  type TaskSurfaceActionPermissions,
} from './useTaskSurfaceActions'
import type { TaskActionExecutionResult } from '../model/taskActionRegistry'
import type { TaskActionRegistry } from '../model/taskActionRegistry'

/** Executes one Project-surface action after the shared permission and validation pipeline. */
export type ProjectTaskActionHandler = TaskSurfaceActionHandler

/** Evaluates Project action access against the concrete target snapshot. */
export type ProjectTaskActionPermission = TaskSurfaceActionPermission

/** Optional target-aware permission evaluators indexed by canonical action ID. */
export type ProjectTaskActionPermissions = TaskSurfaceActionPermissions

/** Existing Project task entrances available to the canonical action registry. */
export type ProjectTaskActionHandlers = TaskSurfaceActionHandlers

/** Localized labels shown for every canonical Project task action. */
export type ProjectTaskActionLabels = TaskSurfaceActionLabels

/** Localized disabled reasons shared by Project action entrances. */
export type ProjectTaskActionDisabledReasons = TaskSurfaceActionDisabledReasons

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
  labels: ProjectTaskActionLabels
  /** Localized reasons used for unavailable or invalid actions. */
  disabledReasons: ProjectTaskActionDisabledReasons
  /** Existing safe UI or mutation entrances for canonical actions. */
  handlers: ProjectTaskActionHandlers
  /** Target-aware permission checks evaluated before action-specific validation. */
  permissions?: ProjectTaskActionPermissions
  /** Receives every normalized pipeline result regardless of invocation path. */
  onExecutionResult?: (result: TaskActionExecutionResult) => void
}

/** Project action operations consumed by the task screen interaction adapter. */
export type ProjectTaskActionController = TaskSurfaceActionController

/** Options used by the pure Project action registry compatibility factory. */
export type CreateProjectTaskActionRegistryOptions = CreateTaskSurfaceActionRegistryOptions

/**
 * Adapts the Project route to the surface-neutral task action controller.
 *
 * @param options - Current Project scope, selection, labels, and safe action entrances.
 * @returns Shared action registry and execution operations.
 */
export function useProjectTaskActions(
  options: UseProjectTaskActionsOptions,
): ProjectTaskActionController {
  const scope = useMemo<ProjectTaskViewScope>(() => ({
    kind: 'project',
    projectId: options.projectId,
    ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
  }), [options.projectId, options.teamId])

  return useTaskSurfaceActions({
    ...(options.activeViewId !== undefined ? { activeViewId: options.activeViewId } : {}),
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

/**
 * Creates all nine canonical Project action definitions in contract order.
 *
 * @param options - Safe handlers and localized disabled reasons.
 * @returns Deterministic registry containing every canonical action identifier.
 */
export function createProjectTaskActionRegistry(
  options: CreateProjectTaskActionRegistryOptions,
): TaskActionRegistry {
  return createTaskSurfaceActionRegistry(options)
}

/**
 * Resolves the sole selected Project target, or its focused target when nothing is selected.
 *
 * @param context - Canonical Project action invocation context.
 * @returns One actionable target, or undefined for an empty or multiple selection.
 */
export function resolveProjectTaskActionTarget(
  context: WorkItemActionContext,
): WorkItemActionTarget | undefined {
  return resolveTaskSurfaceActionTarget(context)
}

/**
 * Resolves selected Project targets, or the focused target when the selection is empty.
 *
 * @param context - Canonical Project action invocation context.
 * @returns Ordered actionable targets, including multiple bulk targets.
 */
export function resolveProjectTaskActionTargets(
  context: WorkItemActionContext,
): readonly WorkItemActionTarget[] {
  return resolveTaskSurfaceActionTargets(context)
}
