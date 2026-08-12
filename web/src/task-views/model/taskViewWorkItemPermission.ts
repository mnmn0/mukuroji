import type {
  CanonicalWorkItem,
  TaskViewWritableProjectScope,
} from '@mukuroji/contracts'

/** Server-authoritative Work Item write scopes returned with one task-view collection. */
export type TaskViewWorkItemWriteCapabilities = {
  /** Team-qualified Project scopes where the current viewer may mutate Work Items. */
  writableProjectScopes: readonly TaskViewWritableProjectScope[]
  /** Team scopes where the current viewer may mutate unassigned Work Items. */
  writableTeamIds: readonly string[]
}

/** Work Item identity fields needed to evaluate its authoritative mutation scope. */
export type TaskViewWorkItemWriteTarget = Pick<
  CanonicalWorkItem,
  'assignedProjectId' | 'teamId'
>

/**
 * Checks whether exact server-returned scopes allow mutation of one Work Item.
 *
 * Project-assigned items require the Team-qualified Project pair. Team permission is used only for
 * unassigned items so a broad Team identifier never widens a Project-scoped grant.
 *
 * @param capabilities - Current viewer write scopes from the exact task-view list response.
 * @param target - Canonical Work Item whose current ownership scope must be writable.
 * @returns Whether the current Work Item scope is explicitly writable.
 */
export function canWriteTaskViewWorkItem(
  capabilities: TaskViewWorkItemWriteCapabilities,
  target: TaskViewWorkItemWriteTarget,
): boolean {
  if (!target.assignedProjectId) {
    return capabilities.writableTeamIds.includes(target.teamId)
  }

  return capabilities.writableProjectScopes.some((scope) =>
    scope.teamId === target.teamId && scope.projectId === target.assignedProjectId
  )
}
