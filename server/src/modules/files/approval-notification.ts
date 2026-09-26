/** Current approval source that must be checked before an external notification. */
export type ApprovalNotificationSource = {
  /** Canonical tenant identifier. */
  workspaceId: string
  /** Parent Work Item's owning Team. */
  teamId: string
  /** Parent Work Item identifier. */
  issueId: string
  /** Approval identifier captured by the audit event. */
  approvalId: string
  /** Captured file subject, absent for legacy rows or Work Item approvals. */
  fileId?: string
  /** Whether current Workspace membership is a guest. */
  guest: boolean
}

/** Rechecks current approval/file metadata visibility; scoped Files permission is checked by the caller. */
export type ApprovalNotificationReader = (source: ApprovalNotificationSource) => Promise<boolean>
