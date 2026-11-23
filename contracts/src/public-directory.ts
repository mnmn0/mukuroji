import type { ProjectLifecycleState } from './project-charter'

/**
 * Credential owner returned by `GET /api/v1/me`, so a client can refer to "me" without being told
 * its member ID separately.
 */
export type PublicCredentialOwner = {
  /** Response schema version. */
  schemaVersion: 1
  /** Workspace the credential belongs to. */
  workspaceId: string
  /** Workspace member ID of the credential owner; the value Work Items use as `assigneeUserId`. */
  memberId: string
  /** Display name of the owner, when the Workspace member has one. */
  name?: string
  /** Email address of the owner. */
  email: string
}

/** Project listed under a Team by `GET /api/v1/teams`. */
export type PublicTeamProject = {
  /** Project ID within the Team. */
  id: string
  /** Display name of the Project. */
  name: string
  /** Lifecycle state of the Project. */
  lifecycleState: ProjectLifecycleState
  /** Workspace-unique Project code, when the charter has one. */
  code?: string
  /** Member ID of the accountable Project manager, when the charter names one. */
  ownerMemberId?: string
  /** Planned start date in `YYYY-MM-DD`, when the charter has one. */
  plannedStartDate?: string
  /** Planned end date in `YYYY-MM-DD`, when the charter has one. */
  plannedEndDate?: string
}

/** Team listed by `GET /api/v1/teams`, with the Projects in it the credential owner can view. */
export type PublicTeam = {
  /** Team ID, used as `teamId` by the other Public API operations. */
  id: string
  /** Display name of the Team. */
  name: string
  /** Projects of the Team that the credential owner can view, in directory order. */
  projects: PublicTeamProject[]
}

/** Response of `GET /api/v1/teams`. */
export type PublicTeamList = {
  /** Response schema version. */
  schemaVersion: 1
  /** Teams the credential owner can view, in directory order. */
  items: PublicTeam[]
}

/** Role a member holds in a Project. */
export type PublicProjectMemberRole = 'manager' | 'member' | 'viewer'

/** Active member of a Project returned by `GET /api/v1/projects/{projectId}/members`. */
export type PublicProjectMember = {
  /** Workspace member ID, usable as a Work Item `assigneeUserId`. */
  id: string
  /** Display name, when the Workspace member has one. */
  name?: string
  /** Email address of the member. */
  email: string
  /** Role of the member in the Project. */
  role: PublicProjectMemberRole
}

/** Response of `GET /api/v1/projects/{projectId}/members`. */
export type PublicProjectMemberList = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Project. */
  teamId: string
  /** Project whose members are listed. */
  projectId: string
  /** Active Workspace members of the Project. */
  items: PublicProjectMember[]
}

/**
 * Response of `GET /api/v1/work-item-keys/{key}`, which resolves a Work Item key such as
 * `ABC-123` to the Team and Work Item it names.
 */
export type PublicWorkItemKeyLookup = {
  /** Response schema version. */
  schemaVersion: 1
  /** Canonical uppercase key that was resolved. */
  key: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID within the Team. */
  workItemId: string
}
