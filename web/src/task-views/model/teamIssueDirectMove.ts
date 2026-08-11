import type {
  WorkItemActionContext,
  WorkItemActionResult,
  WorkItemActionTarget,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  TeamIssuesApiError,
  type TeamIssue,
  type UpdateTeamIssueInput,
} from '../../issues/api'
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
 * Existing Team Issue mutation callback used by the direct status Move adapter.
 *
 * @param issueId - Team Issue identifier selected by the canonical Move action.
 * @param input - Revalidated workflow status patch.
 * @returns Persisted Team Issue snapshot when supplied by the route mutation.
 */
export type TeamIssueDirectStatusMoveMutation = (
  issueId: string,
  input: UpdateTeamIssueInput,
) => Promise<TeamIssue | void>

/** Localized failure messages returned by a direct Team Board Move action. */
export type TeamIssueDirectStatusMoveMessages = {
  /** Message shown when persistence detects a stale Work Item revision. */
  conflict: string
  /** Message shown when the Team Issue mutation fails unexpectedly. */
  failed: string
  /** Message shown when a retained target or destination is no longer valid. */
  unavailable: string
}

/**
 * Consumes and executes one destination-bearing Team Board Move request.
 *
 * An empty slot returns undefined so command, context-menu, and keyboard Move entrances can retain
 * the existing detail-selector flow. Once a direct request exists, every mismatch is terminal and
 * never falls through to that detail flow.
 *
 * @param context - Canonical Move context accepted by the shared registry.
 * @param requestSlot - Surface-local one-shot destination request.
 * @param issues - Current permission-pruned Team Issue snapshots.
 * @param configuration - Current workflow configuration used to revalidate the destination.
 * @param onUpdateIssue - Existing route mutation and cache revalidation callback.
 * @param messages - Localized safe failure messages.
 * @returns Canonical mutation result, or undefined only when no direct request was installed.
 */
export function executeTeamIssueDirectStatusMove(
  context: WorkItemActionContext,
  requestSlot: TaskStatusMoveRequestSlot,
  issues: readonly TeamIssue[],
  configuration: WorkItemConfiguration | undefined,
  onUpdateIssue: TeamIssueDirectStatusMoveMutation | undefined,
  messages: TeamIssueDirectStatusMoveMessages,
): WorkItemActionResult | Promise<WorkItemActionResult> | undefined {
  const installedRequest = requestSlot.current
  if (!installedRequest) return undefined

  const target = resolveTeamIssueDirectMoveTarget(context)
  if (!target) {
    clearTaskStatusMoveRequest(requestSlot, installedRequest)
    return createFailedTaskActionResult(
      context.actionId,
      undefined,
      'TeamTaskMoveRequestMismatch',
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
      requestTargetsSameWorkItem ? 'WorkItemRevisionConflict' : 'TeamTaskMoveRequestMismatch',
      requestTargetsSameWorkItem ? 'conflict' : 'not-found',
      requestTargetsSameWorkItem ? messages.conflict : messages.unavailable,
      requestTargetsSameWorkItem,
    )
  }

  const issue = issues.find((candidate) =>
    candidate.teamId === target.teamId && candidate.id === target.workItemId
  )
  if (!issue) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      'TeamTaskActionTargetNotFound',
      'not-found',
      messages.unavailable,
    )
  }
  if (issue.revision !== target.expectedRevision) {
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
  const destinationAvailable = issue.workflowStatusId !== destinationWorkflowStatusId &&
    resolveEditableWorkflowStatuses(issue, configuration).some(
      (status) => status.id === destinationWorkflowStatusId,
    )
  if (!destinationAvailable || !onUpdateIssue) {
    return createFailedTaskActionResult(
      context.actionId,
      target,
      'TeamTaskMoveDestinationUnavailable',
      'validation',
      messages.unavailable,
    )
  }

  /** Converts a rejected direct mutation into the same canonical failure returned by detail Move. */
  const createMutationFailure = (error: unknown): WorkItemActionResult => {
    const conflict = isTeamIssueRevisionConflict(error)
    return createFailedTaskActionResult(
      context.actionId,
      target,
      conflict ? 'WorkItemRevisionConflict' : 'TeamTaskActionMutationFailed',
      conflict ? 'conflict' : 'unknown',
      conflict ? messages.conflict : messages.failed,
      conflict,
    )
  }

  try {
    return onUpdateIssue(issue.id, { workflowStatusId: destinationWorkflowStatusId }).then(
      (updatedIssue) => createSucceededTaskActionMutationResult(
        context.actionId,
        target,
        updatedIssue?.revision,
      ),
      createMutationFailure,
    )
  } catch (error) {
    return createMutationFailure(error)
  }
}

/**
 * Identifies a revision conflict preserved either directly or as a route-level error cause.
 *
 * @param error - Unknown Team Issue mutation failure.
 * @returns Whether the failure has the canonical Work Item revision conflict code.
 */
export function isTeamIssueRevisionConflict(error: unknown): boolean {
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
function resolveTeamIssueDirectMoveTarget(
  context: WorkItemActionContext,
): WorkItemActionTarget | undefined {
  if (context.selection.targets.length === 1) return context.selection.targets[0]
  return context.selection.targets.length === 0
    ? context.selection.focusedTarget
    : undefined
}
