/** One place a quick-created Work Item can be put. */
export type MyTasksQuickCreateDestination = {
  /** Stable option value. */
  key: string
  /** Label shown in the destination select. */
  label: string
  /** Team that owns the new Work Item. */
  teamId: string
  /** Project the Work Item is assigned to; the Team alone when omitted. */
  projectId?: string
}

/** Values submitted by the quick create form. */
export type MyTasksQuickCreateInput = {
  /** Trimmed title. */
  title: string
  /** Chosen destination. */
  destination: MyTasksQuickCreateDestination
  /** Due date in `YYYY-MM-DD` form; unscheduled when omitted. */
  dueDate?: string
}
