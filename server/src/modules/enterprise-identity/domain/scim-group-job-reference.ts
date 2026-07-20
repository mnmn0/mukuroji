/**
 * Enterprise SCIM group reconciliation job の immutable stream reference です。
 */
export type EnterpriseScimGroupJobReference = {
  /** Job が属する canonical Workspace ID です。 */
  workspaceId: string
  /** State 内の reconciliation job を識別する immutable ID です。 */
  jobId: string
  /** Stale stream event を除外する monotonically increasing job revision です。 */
  revision: number
}
