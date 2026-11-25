/** Current approval source that must be checked before an external notification. */
export type ApprovalNotificationSource = {
  /** Canonical tenant identifier. */
  workspaceId: string
  /** Team that owns the parent Work Item or Project. */
  teamId: string
  /** Parent Work Item identifier; absent for a Project file approval. */
  issueId?: string
  /** Parent Project identifier, read only when the approval has no parent Work Item. */
  projectId?: string
  /** Approval identifier captured by the audit event. */
  approvalId: string
  /** Captured file subject, absent for legacy rows or Work Item approvals. */
  fileId?: string
  /** Whether current Workspace membership is a guest. */
  guest: boolean
}

/** Rechecks current approval/file metadata visibility; scoped Files permission is checked by the caller. */
export type ApprovalNotificationReader = (source: ApprovalNotificationSource) => Promise<boolean>
