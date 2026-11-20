/** Amount of storage the schedule read through one source call. */
export type ScheduledReadProgress = {
  /** Pages (queries or scans) read. */
  pages: number
  /** Items the store evaluated. */
  items: number
}

/** Paging settings for one source call. */
export type ScheduledReadOptions = {
  /** Items per page. */
  pageSize: number
  /** Safety bound on pages, for reads that grow with the organization rather than with due work. */
  maxPages: number
}

/** Durable Customer completion marker to clear after its notifications are prepared. */
export type ScheduledCompletionMarker = {
  /** Physical Work Item partition key. */
  directoryTeamId: string
  /** Physical Work Item sort key. */
  issueId: string
  /** Work Item revision captured by the marker. */
  revision: number
}

/** One Team the daily timesheet reminder pass visits. */
export type ScheduledTeam = {
  /** Workspace that owns the Team. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
}

/**
 * Reads the Work Items and Teams the notification schedule evaluates.
 *
 * Rows are returned as untrusted records; the schedule validates them before use.
 */
export type ScheduledWorkItemSource = {
  /**
   * Visits every open Work Item that can need a scheduled notification, oldest deadline first
   * within each shard: Work Items due on or before the bound, and every started Work Item.
   *
   * @param upperBoundDate - Inclusive `YYYY-MM-DD` deadline bound.
   * @param options - Paging settings; `maxPages` is not applied, because the index bounds the read.
   * @param visit - Handles one eventually consistent index copy of a Work Item row.
   * @returns Pages and items read.
   */
  readDueWorkItems(
    upperBoundDate: string,
    options: ScheduledReadOptions,
    visit: (row: Record<string, unknown>) => Promise<void>,
  ): Promise<ScheduledReadProgress>
  /**
   * Visits the current copy of every Work Item that holds a Customer completion marker.
   *
   * @param options - Paging settings; `maxPages` is not applied.
   * @param visit - Handles one strongly consistent Work Item row.
   * @returns Pages and items read.
   */
  readCompletionMarkerWorkItems(
    options: ScheduledReadOptions,
    visit: (row: Record<string, unknown>) => Promise<void>,
  ): Promise<ScheduledReadProgress>
  /**
   * Reads the current copy of a Work Item named by an index copy.
   *
   * @param row - Index copy carrying the Work Item table keys.
   * @returns The strongly consistent row, or undefined when it no longer exists.
   */
  readCurrentWorkItem(row: Record<string, unknown>): Promise<Record<string, unknown> | undefined>
  /**
   * Clears a Customer completion marker unless a newer marker replaced it.
   *
   * @param marker - Marker that was prepared.
   */
  clearCompletionMarker(marker: ScheduledCompletionMarker): Promise<void>
  /**
   * Lists every Team for the daily timesheet reminder pass.
   *
   * @param options - Paging settings; exceeding `maxPages` fails the call.
   * @returns Distinct Teams and the pages and items read.
   */
  listTeams(options: ScheduledReadOptions): Promise<{
    /** Distinct Workspace and Team pairs. */
    teams: ScheduledTeam[]
    /** Pages and items read. */
    progress: ScheduledReadProgress
  }>
}
