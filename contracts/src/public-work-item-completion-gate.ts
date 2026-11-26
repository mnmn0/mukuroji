import type { WorkItemCompletionGateConditionStatus } from './work-item-completion-gate'

/** Response of `GET /api/v1/work-items/{workItemId}/completion-gate`. */
export type PublicWorkItemCompletionGate = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose completion Gate was evaluated. */
  workItemId: string
  /** Work Item revision the Gate was evaluated at. */
  revision: number
  /**
   * Every condition the Team evaluates, in display order, with whether the Work Item meets it.
   * Empty when the Team sets no completion Gate.
   */
  conditions: WorkItemCompletionGateConditionStatus[]
  /**
   * Whether a `required` condition is unmet or could not be checked, so moving the Work Item into
   * the `completed` category would be rejected at this revision.
   */
  blocksCompletion: boolean
}
