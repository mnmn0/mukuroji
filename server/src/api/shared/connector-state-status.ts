import type { WorkflowDefinition, WorkflowStatusCategory } from '@mukuroji/contracts'

/** Categories a closed resource maps to; a Work Item already in one of them stays where it is. */
const CLOSED_CATEGORIES: ReadonlySet<WorkflowStatusCategory> = new Set(['completed', 'canceled'])

/** Categories an open resource may move a closed Work Item back to, in order of preference. */
const REOPEN_CATEGORIES: readonly WorkflowStatusCategory[] = ['unstarted', 'backlog', 'started']

/**
 * Chooses the workflow status that matches the open or closed state of a linked resource, such as
 * a GitHub issue. A Work Item whose status category already agrees keeps its status. Otherwise the
 * first status of the matching category that the workflow allows from the current status is used:
 * `completed` for a closed resource, and `unstarted`, then `backlog`, then `started` for a reopened
 * one. When no transition leads there, the first such status of the workflow is returned and the
 * workflow rules reject the change, which the sync records as a failure instead of guessing.
 *
 * @param workflow - Workflow of the Work Item Type.
 * @param currentStatusId - Current workflow status ID.
 * @param state - Open or closed state of the resource.
 * @returns The status ID to set, or `undefined` when the current status already agrees.
 */
export function resolveConnectorStateStatus(
  workflow: Pick<WorkflowDefinition, 'statuses' | 'transitions'>,
  currentStatusId: string,
  state: 'open' | 'closed',
): string | undefined {
  const current = workflow.statuses.find((status) => status.id === currentStatusId)
  const isClosed = current !== undefined && CLOSED_CATEGORIES.has(current.category)
  if ((state === 'closed') === isClosed) return undefined
  const reachable = new Set(workflow.transitions
    .filter((transition) => transition.fromStatusId === currentStatusId)
    .map((transition) => transition.toStatusId))
  const ordered = [...workflow.statuses].sort((left, right) => left.sortOrder - right.sortOrder)
  const categories: readonly WorkflowStatusCategory[] = state === 'closed' ? ['completed'] : REOPEN_CATEGORIES
  for (const category of categories) {
    const target = ordered.find((status) => status.category === category && reachable.has(status.id))
    if (target) return target.id
  }
  for (const category of categories) {
    const target = ordered.find((status) => status.category === category)
    if (target) return target.id
  }
  return undefined
}
