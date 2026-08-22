import type {
  ResolvedWorkItemConfiguration,
  WorkItemActionContext,
  WorkItemActionResult,
  WorkItemActionTarget,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../../issues/api'
import type { CanonicalWorkItem } from '../../tasks/api'
import { resolveEditableWorkflowStatuses } from '../../work-items/model/workItemDisplay'
import {
  clearTaskStatusMoveRequest,
  consumeTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from './taskStatusMoveRequest'
import {
  createFailedTaskActionResult,
  createSucceededTaskActionMutationResult,
} from './taskActionRegistry'

/**
 * Existing optimistic My Tasks status mutation used by the direct Move adapter.
 *
 * @param task - Current canonical Work Item snapshot selected by the action.
 * @param workflowStatusId - Revalidated destination workflow status.
 * @returns Persisted Work Item snapshot, or undefined when persistence was not applied.
 */
export type MyTaskDirectStatusMoveMutation = (
  task: CanonicalWorkItem,
  workflowStatusId: string,
) => Promise<CanonicalWorkItem | undefined>

/** Localized safe failure messages returned by a direct My Tasks Move action. */
export type MyTaskDirectStatusMoveMessages = {
  /** Message shown when persistence detects a stale Work Item revision. */
  conflict: string
  /** Message shown when the status mutation fails unexpectedly. */
  failed: string
  /** Message shown when the retained Work Item no longer exists. */
  notFound: string
  /** Message shown when the target, configuration, or destination is no longer available. */
  unavailable: string
}

/**
 * Consumes and executes one destination-bearing My Tasks Move request.
 *
 * An empty slot returns undefined so command, context-menu, and keyboard Move entrances retain the
 * existing status-selector flow. Once a direct request exists, every mismatch is terminal and can
 * never fall through to that selector.
 *
 * @param context - Canonical Move context accepted by the shared registry.
 * @param requestSlot - Surface-local one-shot destination request.
 * @param tasks - Current permission-pruned My Tasks snapshots.
 * @param configurationsByTeam - Current workflow configurations indexed by Team ID.
 * @param moveTaskStatus - Existing optimistic mutation and cache reconciliation callback.
 * @param messages - Localized safe failure messages.
 * @returns Canonical mutation result, or undefined only when no direct request was installed.
 */
export function executeMyTaskDirectStatusMove(
  context: WorkItemActionContext,
  requestSlot: TaskStatusMoveRequestSlot,
  tasks: readonly CanonicalWorkItem[],
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  moveTaskStatus: MyTaskDirectStatusMoveMutation | undefined,
  messages: MyTaskDirectStatusMoveMessages,
): WorkItemActionResult | Promise<WorkItemActionResult> | undefined {
  const installedRequest = requestSlot.current
  if (!installedRequest) return undefined

  const target = resolveMyTaskDirectMoveTarget(context)
  if (!target) {
    clearTaskStatusMoveRequest(requestSlot, installedRequest)
    return createFailedTaskActionResult(
      context.actionId,
      undefined,
      'MyTasksMoveTargetMismatch',
      'validation',
      messages.unavailable,
    )
  }

  const requestTargetsSameWorkItem = installedRequest.target.teamId === target.teamId &&
    installedRequest.target.workItemId === target.workItemId
  const request = consumeTaskStatusMoveRequest(requestSlot, target)
  if (!request) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      requestTargetsSameWorkItem ? 'WorkItemRevisionConflict' : 'MyTasksMoveTargetMismatch',
      requestTargetsSameWorkItem ? 'conflict' : 'not-found',
      requestTargetsSameWorkItem ? messages.conflict : messages.notFound,
      requestTargetsSameWorkItem,
    )
  }

  const task = tasks.find((candidate) =>
    candidate.teamId === target.teamId && candidate.id === target.workItemId
  )
  if (!task) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      'MyTasksActionTargetNotFound',
      'not-found',
      messages.notFound,
    )
  }
  if (target.expectedRevision === undefined || task.revision !== target.expectedRevision) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      'WorkItemRevisionConflict',
      'conflict',
      messages.conflict,
      true,
    )
  }

  const destinationWorkflowStatusId = request.destinationWorkflowStatusId
  const configuration = configurationsByTeam[task.teamId]?.configuration
  const destinationAvailable = task.workflowStatusId !== destinationWorkflowStatusId &&
    resolveEditableWorkflowStatuses(task, configuration).some(
      (status) => status.id === destinationWorkflowStatusId,
    )
  if (!destinationAvailable || !moveTaskStatus) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      'MyTasksMoveUnavailable',
      'unavailable',
      messages.unavailable,
    )
  }

  /** Converts a rejected direct mutation into the same canonical failure as selector Move. */
  const createMutationFailure = (error: unknown): WorkItemActionResult => {
    const conflict = isMyTaskDirectMoveRevisionConflict(error)
    return createFailedTaskActionResult(
      context.actionId,
      target,
      conflict ? 'WorkItemRevisionConflict' : 'MyTasksMoveFailed',
      conflict ? 'conflict' : 'unknown',
      conflict ? messages.conflict : messages.failed,
      conflict,
    )
  }

  try {
    return moveTaskStatus(task, destinationWorkflowStatusId).then(
      (updatedTask) => updatedTask
        ? createSucceededTaskActionMutationResult(
            context.actionId,
            target,
            updatedTask.revision,
          )
        : createFailedTaskActionResult(
            context.actionId,
            target,
            'MyTasksMoveNotApplied',
            'unavailable',
            messages.unavailable,
          ),
      createMutationFailure,
    )
  } catch (error) {
    return createMutationFailure(error)
  }
}

/**
 * Identifies a revision conflict preserved directly or as a route-level error cause.
 *
 * @param error - Unknown My Tasks status mutation failure.
 * @returns Whether the failure has the canonical Work Item revision conflict code.
 */
export function isMyTaskDirectMoveRevisionConflict(error: unknown): boolean {
  if (error instanceof TeamIssuesApiError) {
    return error.code === 'WorkItemRevisionConflict'
  }
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof TeamIssuesApiError && cause.code === 'WorkItemRevisionConflict'
}

/**
 * Resolves the sole selected target, or the focused target when nothing is selected.
 *
 * @param context - Canonical direct Move context.
 * @returns One actionable target, or undefined for an empty or multiple selection.
 */
function resolveMyTaskDirectMoveTarget(
  context: WorkItemActionContext,
): WorkItemActionTarget | undefined {
  if (context.selection.targets.length === 1) return context.selection.targets[0]
  return context.selection.targets.length === 0
    ? context.selection.focusedTarget
    : undefined
}
