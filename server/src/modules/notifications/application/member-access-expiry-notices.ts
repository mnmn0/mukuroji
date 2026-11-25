/** A member whose access ends soon. */
export type ExpiringWorkspaceMember = {
  /** Workspace of the member. */
  workspaceId: string
  /** Lower-case member key. */
  memberKey: string
  /** Display name the member set; absent when the member has none. */
  displayName?: string
  /** When the member's access ends (ISO 8601). */
  accessExpiresAt: string
}

/** An active Project the expiring member belongs to, with its current managers. */
export type ExpiringMemberProject = {
  /** Owning Team. */
  teamId: string
  /** Project ID. */
  projectId: string
  /** Lower-case member keys of the Project's current managers. */
  managerMemberKeys: readonly string[]
}

/** Reads members whose access ends soon and the Projects they belong to. */
export type ScheduledMemberAccessExpiryReader = {
  /**
   * Lists active members whose access ends after one instant and at or before another.
   *
   * @param after - Exclusive lower bound; members already expired are left out.
   * @param before - Inclusive upper bound.
   * @returns The members, ordered by Workspace and member.
   */
  listMembersExpiringBetween(after: Date, before: Date): Promise<ExpiringWorkspaceMember[]>
  /**
   * Reads the active Projects a member belongs to and their managers.
   *
   * @param workspaceId - Workspace of the member.
   * @param memberKey - Lower-case member key.
   * @returns The Projects, ordered by Team and Project.
   */
  readMemberProjects(workspaceId: string, memberKey: string): Promise<ExpiringMemberProject[]>
}

/** One manager to tell that a member's access ends soon. */
export type MemberAccessExpiryNoticeCandidate = {
  /** Workspace of the member. */
  workspaceId: string
  /** Team of the Project the notice is authorized against. */
  teamId: string
  /** Project the recipient manages and the member belongs to. */
  projectId: string
  /** Member whose access ends. */
  memberKey: string
  /** Display name of the member, when set. */
  memberDisplayName?: string
  /** When the member's access ends. */
  accessExpiresAt: string
  /** Manager who receives the notice. */
  recipientMemberKey: string
}

/**
 * Chooses the managers to tell that a member's access ends soon.
 *
 * Every manager of a Project the member belongs to is told once, against the first such Project
 * they manage, so a manager of several of the member's Projects gets one notice. The member is
 * never told about themselves.
 *
 * @param member - Member whose access ends soon.
 * @param projects - Active Projects the member belongs to, in Team and Project order.
 * @returns One candidate per manager.
 */
export function evaluateMemberAccessExpiryNotices(
  member: ExpiringWorkspaceMember,
  projects: readonly ExpiringMemberProject[],
): MemberAccessExpiryNoticeCandidate[] {
  const candidates = new Map<string, MemberAccessExpiryNoticeCandidate>()
  for (const project of projects) {
    for (const recipientMemberKey of project.managerMemberKeys) {
      if (recipientMemberKey === member.memberKey || candidates.has(recipientMemberKey)) continue
      candidates.set(recipientMemberKey, {
        workspaceId: member.workspaceId,
        teamId: project.teamId,
        projectId: project.projectId,
        memberKey: member.memberKey,
        ...(member.displayName ? { memberDisplayName: member.displayName } : {}),
        accessExpiresAt: member.accessExpiresAt,
        recipientMemberKey,
      })
    }
  }
  return [...candidates.values()]
}
