/**
 * What keeps a member from being deactivated: something that would be left without a manager
 * or an owner.
 */
export type MemberDeactivationBlocker =
  | 'manages-projects'
  | 'owns-planning-entities'
  | 'manages-private-documents'

/** What a member still manages or owns, as read for a deactivation. */
export type MemberDeactivationBlockerState = {
  /** Whether the member holds a manager role in an active Project. */
  managesProjects: boolean
  /** Whether the member owns an active Planning entity. */
  ownsPlanningEntities: boolean
  /** Whether a private Document would be left without another manager. */
  managesPrivateDocuments: boolean
}

/**
 * Lists what keeps a member from being deactivated, in the order the deactivation checks them.
 *
 * An administrator's deactivation, the handover summary, and the scheduled deactivation of
 * expired members all apply this one policy (ADR 0095).
 *
 * @param state - What the member still manages or owns.
 * @returns The blockers; empty when the member can be deactivated.
 */
export function listMemberDeactivationBlockers(
  state: MemberDeactivationBlockerState,
): MemberDeactivationBlocker[] {
  const blockers: MemberDeactivationBlocker[] = []
  if (state.managesProjects) blockers.push('manages-projects')
  if (state.ownsPlanningEntities) blockers.push('owns-planning-entities')
  if (state.managesPrivateDocuments) blockers.push('manages-private-documents')
  return blockers
}

/**
 * Reports whether a Project access makes the member a manager who must be replaced first.
 *
 * @param access - The member's role in one active Project.
 * @returns Whether the role is manager.
 */
export function isManagerProjectAccess(access: { readonly role?: string }): boolean {
  return access.role === 'manager'
}

/**
 * Reports whether a Planning entity needs a new owner before the member leaves: it is not
 * archived and the member owns it.
 *
 * @param entity - Owner reference of a Planning entity.
 * @param memberKey - Member being deactivated.
 * @returns Whether the member owns the active entity.
 */
export function isActivePlanningEntityOwnedBy(
  entity: { readonly ownerMemberKey?: string, readonly archivedAt?: string },
  memberKey: string,
): boolean {
  return !entity.archivedAt && entity.ownerMemberKey === memberKey
}
