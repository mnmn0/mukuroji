/** Outcome of the last cross-Team timesheet submission, shown under the submit button. */
export type MyTimesheetSubmitNotice =
  | { kind: 'submitted'; count: number }
  | { kind: 'partial'; count: number; failed: number }
  | { kind: 'nothing' }
  | { kind: 'error' }
