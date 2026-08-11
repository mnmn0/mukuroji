import type { BulkOperationAction } from '@mukuroji/contracts'

/** Toolbar mode including the canonical assign entrance backed by a bulk edit request. */
export type BulkOperationToolbarAction = BulkOperationAction['type'] | 'assign'

/** Canonical task action accepted through the Project bulk registry. */
export type BulkOperationTaskActionId = 'move' | 'assign' | 'archive'

/**
 * Plans whether a toolbar click may activate immediately or must await an accepted request prop.
 *
 * @param action - Toolbar mode selected by the user.
 * @param registryAvailable - Whether canonical Project permission and validation are available.
 * @returns Immediate local action or canonical action ID that the parent must accept first.
 */
export function resolveBulkOperationToolbarActionSelection(
  action: BulkOperationToolbarAction,
  registryAvailable: boolean,
):
  | { immediateAction: BulkOperationToolbarAction; requestedActionId?: never }
  | { immediateAction?: never; requestedActionId: BulkOperationTaskActionId } {
  const actionId = resolveBulkOperationTaskActionId(action)
  return actionId && registryAvailable
    ? { requestedActionId: actionId }
    : { immediateAction: action }
}

/**
 * Resolves the canonical registry action associated with a toolbar mode.
 *
 * @param action - Toolbar mode selected by the user.
 * @returns Canonical Project bulk action, or undefined for generic Edit.
 */
function resolveBulkOperationTaskActionId(
  action: BulkOperationToolbarAction,
): BulkOperationTaskActionId | undefined {
  return action === 'move' || action === 'assign' || action === 'archive'
    ? action
    : undefined
}
