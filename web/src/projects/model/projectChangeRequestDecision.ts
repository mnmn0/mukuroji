/**
 * Error raised when a requested date change conflicts with Work Item dependencies, so the
 * approver resolves the conflict on the Work Item first.
 */
export class ProjectChangeRequestScheduleConflictError extends Error {
  /** Work Item whose change conflicts. */
  readonly workItemId: string

  /**
   * Creates the error.
   *
   * @param workItemId - Work Item whose change conflicts.
   */
  constructor(workItemId: string) {
    super(`The date change of Work Item "${workItemId}" conflicts with its dependencies.`)
    this.name = 'ProjectChangeRequestScheduleConflictError'
    this.workItemId = workItemId
  }
}
