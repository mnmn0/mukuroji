import type { WorkItemActionTarget } from '@mukuroji/contracts'

/** One destination-bearing Move request initiated by a direct status control or drag gesture. */
export type TaskStatusMoveRequest = {
  /** Workflow status selected by the direct interaction. */
  destinationWorkflowStatusId: string
  /** Revision-bound Work Item that permission and validation must evaluate. */
  target: WorkItemActionTarget
}

/** Mutable one-shot slot used to hand a direct Move input to the canonical action handler. */
export type TaskStatusMoveRequestSlot = {
  /** Request awaiting synchronous consumption by the matching Move handler. */
  current: TaskStatusMoveRequest | undefined
}

/**
 * Creates an immutable snapshot for one direct status Move entrance.
 *
 * @param target - Revision-bound Work Item selected by the direct entrance.
 * @param destinationWorkflowStatusId - Validated destination selected by the user.
 * @returns One-shot request whose object identity is also its cleanup token.
 */
export function createTaskStatusMoveRequest(
  target: WorkItemActionTarget,
  destinationWorkflowStatusId: string,
): TaskStatusMoveRequest {
  return {
    destinationWorkflowStatusId,
    target: { ...target },
  }
}

/**
 * Consumes a pending direct Move only when its complete target snapshot matches the action.
 *
 * A mismatched request is consumed as stale so a later command or keyboard action cannot inherit
 * a destination that was selected for another Work Item or revision.
 *
 * @param slot - Surface-local one-shot request slot.
 * @param target - Target accepted by the canonical permission and validation pipeline.
 * @returns Matching request, or undefined when the slot was empty or targeted another snapshot.
 */
export function consumeTaskStatusMoveRequest(
  slot: TaskStatusMoveRequestSlot,
  target: WorkItemActionTarget,
): TaskStatusMoveRequest | undefined {
  const request = slot.current
  if (!request) return undefined
  slot.current = undefined
  return isTaskStatusMoveRequestTarget(request, target) ? request : undefined
}

/**
 * Clears a request after denied, invalid, or failed dispatch without erasing a newer request.
 *
 * @param slot - Surface-local one-shot request slot.
 * @param request - Exact request object installed by the caller.
 * @returns Whether that request still owned and cleared the slot.
 */
export function clearTaskStatusMoveRequest(
  slot: TaskStatusMoveRequestSlot,
  request: TaskStatusMoveRequest,
): boolean {
  if (slot.current !== request) return false
  slot.current = undefined
  return true
}

/**
 * Checks Team, Work Item, and revision identity for a destination-bearing Move request.
 *
 * @param request - Direct Move request awaiting consumption.
 * @param target - Target accepted by the canonical action pipeline.
 * @returns Whether both snapshots identify the same revision-bound Work Item.
 */
export function isTaskStatusMoveRequestTarget(
  request: TaskStatusMoveRequest,
  target: WorkItemActionTarget,
): boolean {
  return request.target.teamId === target.teamId &&
    request.target.workItemId === target.workItemId &&
    request.target.expectedRevision !== undefined &&
    request.target.expectedRevision === target.expectedRevision
}
