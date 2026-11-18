/** Reads the Project managers that receive Work Item overdue escalations. */
export type ScheduledProjectManagerReader = {
  /**
   * Reads the current managers of every active Project in one Workspace.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @returns Sorted, lower-case manager member keys keyed by active Project ID.
   */
  readActiveProjectManagers(workspaceId: string): Promise<ReadonlyMap<string, readonly string[]>>
}
