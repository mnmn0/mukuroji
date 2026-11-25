import type { WorkflowDefinition, WorkflowStatusCategory } from '@mukuroji/contracts'

/** Workflow status a linked resource's open or closed state leads to. */
export type ConnectorStateStatus =
  | {
    /** The current status already agrees with the resource. */
    kind: 'unchanged'
  }
  | {
    /** The Work Item moves to this status. */
    kind: 'status'
    /** Workflow status ID to set. */
    statusId: string
  }
  | {
    /** The workflow has no status of the matching category that it allows from the current status. */
    kind: 'unavailable'
  }

/** Categories a closed resource maps to; a Work Item already in one of them stays where it is. */
const CLOSED_CATEGORIES: ReadonlySet<WorkflowStatusCategory> = new Set(['completed', 'canceled'])

/** Categories an open resource may move a closed Work Item back to, in order of preference. */
const REOPEN_CATEGORIES: readonly WorkflowStatusCategory[] = ['unstarted', 'backlog', 'started']

/**
 * Chooses the workflow status that matches the open or closed state of a linked resource, such as
 * a GitHub issue. A Work Item whose status category already agrees keeps its status. Otherwise the
 * first status of the matching category that the workflow allows from the current status is used:
 * `completed` for a closed resource, and `unstarted`, then `backlog`, then `started` for a reopened
 * one. When the workflow has no such status, or none that it allows from the current status, the
 * result is `unavailable` so the sync can refuse that one change without guessing a status and
 * without stopping the other linked resources.
 *
 * @param workflow - Workflow of the Work Item Type.
 * @param currentStatusId - Current workflow status ID.
 * @param state - Open or closed state of the resource.
 * @returns The status ID to set, `unchanged` when the current status already agrees, or
 *   `unavailable` when the workflow cannot follow the resource from the current status.
 */
export function resolveConnectorStateStatus(
  workflow: Pick<WorkflowDefinition, 'statuses' | 'transitions'>,
  currentStatusId: string,
  state: 'open' | 'closed',
): ConnectorStateStatus {
  const current = workflow.statuses.find((status) => status.id === currentStatusId)
  const isClosed = current !== undefined && CLOSED_CATEGORIES.has(current.category)
  if ((state === 'closed') === isClosed) return { kind: 'unchanged' }
  const reachable = new Set(workflow.transitions
    .filter((transition) => transition.fromStatusId === currentStatusId)
    .map((transition) => transition.toStatusId))
  const ordered = [...workflow.statuses].sort((left, right) => left.sortOrder - right.sortOrder)
  const categories: readonly WorkflowStatusCategory[] = state === 'closed' ? ['completed'] : REOPEN_CATEGORIES
  for (const category of categories) {
    const target = ordered.find((status) => status.category === category && reachable.has(status.id))
    if (target) return { kind: 'status', statusId: target.id }
  }
  return { kind: 'unavailable' }
}
