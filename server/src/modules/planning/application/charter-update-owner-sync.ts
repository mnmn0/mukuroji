import {
  resolvePlanningUpdateReviewerMemberKey,
  type PlanningUpdateCadence,
  type ProjectCharterUpdateOwnerSync,
} from '@mukuroji/contracts'
import { PlanningError } from '../planning'

/** Attempts at moving the update owner when a concurrent Planning write moved the revision. */
const CHARTER_UPDATE_OWNER_SYNC_ATTEMPTS = 3

/** The Project's update target as one Planning read saw it. */
export type CharterUpdateOwnerSyncTarget<Read> = {
  /** Opaque read the other ports evaluate against, such as the snapshot the caller may see. */
  read: Read
  /** Planning revision of the read, which fences the cadence write. */
  revision: number
  /** Saved update cadence, when the target has one. */
  cadence?: PlanningUpdateCadence
  /** True when the update target is archived. */
  archived: boolean
}

/** Member a cadence names, as the recipient check resolved it. */
export type CharterUpdateOwnerSyncRecipient = {
  /** Workspace member key the cadence stores. */
  memberKey: string
}

/**
 * Planning, charter, and authorization access of the update owner synchronization. A port returns
 * `false` or `undefined` for an access refusal and throws for any other failure.
 */
export type CharterUpdateOwnerSyncPorts<Read, Recipient extends CharterUpdateOwnerSyncRecipient, Check> = {
  /**
   * Reads the Project's update target.
   *
   * @returns The target, or undefined when the Project has none.
   */
  readTarget(): Promise<CharterUpdateOwnerSyncTarget<Read> | undefined>
  /**
   * Checks the caller may change the target's update cadence, as the cadence endpoint requires.
   *
   * @param read - Read of the target.
   * @returns False when the caller is refused.
   */
  mayChangeCadence(read: Read): Promise<boolean>
  /**
   * Checks a member the cadence names still has the access their part needs.
   *
   * @param read - Read of the target.
   * @param memberKey - Member key from the cadence or the charter.
   * @param role - Least Project role the member needs.
   * @param permission - Enterprise permission the member also needs, if any.
   * @returns The member, or undefined when the member is refused.
   */
  resolveRecipient(
    read: Read,
    memberKey: string,
    role: 'member' | 'viewer',
    permission?: 'planning.write',
  ): Promise<Recipient | undefined>
  /**
   * Reads the stored charter owner.
   *
   * @returns Member key of the owner, or undefined when the charter names none.
   */
  readCharterOwner(): Promise<string | undefined>
  /**
   * Builds the conditions that the caller and the recipients still hold their access at the write.
   *
   * @param recipients - Members the new cadence names.
   * @returns Transaction condition checks.
   */
  createAuthorizationChecks(recipients: readonly Recipient[]): Check[]
  /**
   * Builds the condition that the stored charter still names the owner at the write.
   *
   * @param ownerMemberKey - Owner this synchronization applies.
   * @returns The condition check, or undefined when the charter store cannot provide one.
   */
  createCharterOwnerCheck(ownerMemberKey: string): Promise<Check | undefined>
  /**
   * Writes the cadence with the conditions, failing with a `PlanningError` on a conflict.
   *
   * @param read - Read the cadence came from.
   * @param cadence - Cadence with the new owner.
   * @param expectedRevision - Planning revision of the read.
   * @param checks - Conditions joined to the write.
   * @returns A promise that resolves once the cadence is written.
   */
  writeCadence(read: Read, cadence: PlanningUpdateCadence, expectedRevision: number, checks: Check[]): Promise<void>
  /**
   * Records a failure that the result reports only as `failed`.
   *
   * @param error - Failure.
   */
  reportFailure(error: unknown): void
}

/**
 * Moves a Project's health update owner to the new charter owner (ADR 0084, ADR 0122).
 *
 * The charter is already saved, so nothing here undoes it. The cadence is rewritten with only its
 * owner changed, under the same checks as the cadence endpoint: the caller must manage the
 * Project's update target, and the new owner must be able to publish updates in it. The cadence
 * write is fenced on the charter still naming this owner, so an older save that finishes after a
 * newer one cannot apply its owner. A Planning revision that moved between the read and the write
 * is read again and retried a few times.
 *
 * @param ports - Planning, charter, and authorization access.
 * @param ownerMemberKey - Member key of the new charter owner.
 * @returns What happened to the update owner.
 */
export async function syncCharterUpdateOwner<Read, Recipient extends CharterUpdateOwnerSyncRecipient, Check>(
  ports: CharterUpdateOwnerSyncPorts<Read, Recipient, Check>,
  ownerMemberKey: string,
): Promise<ProjectCharterUpdateOwnerSync> {
  const isSuperseded = async () => await ports.readCharterOwner() !== ownerMemberKey
  try {
    for (let attempt = 1; ; attempt += 1) {
      const target = await ports.readTarget()
      if (!target?.cadence || target.archived) return 'not-configured'
      const { cadence, read } = target
      if (cadence.updateOwnerMemberKey.toLowerCase() === ownerMemberKey.toLowerCase()) return 'unchanged'
      if (!await ports.mayChangeCadence(read)) return 'not-permitted'
      const owner = await ports.resolveRecipient(read, ownerMemberKey, 'member')
      if (!owner) return 'owner-not-eligible'
      const recipients: Recipient[] = [owner]
      if (cadence.escalationMemberKey) {
        const escalation = await ports.resolveRecipient(read, cadence.escalationMemberKey, 'viewer')
        // The escalation recipient lost access; the cadence must be fixed in Planning by hand.
        if (!escalation) return 'failed'
        recipients.push(escalation)
      }
      // The reviewer acknowledges with an update comment, so it is checked as the cadence
      // endpoint checks it. Without an explicit reviewer the escalation recipient reviews.
      const reviewerMemberKey = resolvePlanningUpdateReviewerMemberKey(cadence)
      if (reviewerMemberKey) {
        const reviewer = await ports.resolveRecipient(read, reviewerMemberKey, 'member', 'planning.write')
        // The reviewer lost access; the cadence must be fixed in Planning by hand.
        if (!reviewer) return 'failed'
        recipients.push(reviewer)
      }
      // A later save that moved the charter owner again owns the update owner from here on.
      if (await isSuperseded()) return 'superseded'
      const charterOwnerCheck = await ports.createCharterOwnerCheck(ownerMemberKey)
      const checks = [
        ...ports.createAuthorizationChecks(recipients),
        ...(charterOwnerCheck === undefined ? [] : [charterOwnerCheck]),
      ]
      try {
        await ports.writeCadence(read, { ...cadence, updateOwnerMemberKey: owner.memberKey }, target.revision, checks)
        return 'synced'
      } catch (error) {
        if (!(error instanceof PlanningError)) throw error
        if (error.code === 'PlanningAuthorizationChanged' && await isSuperseded()) return 'superseded'
        if (attempt < CHARTER_UPDATE_OWNER_SYNC_ATTEMPTS && error.code === 'PlanningRevisionConflict') continue
        throw error
      }
    }
  } catch (error) {
    ports.reportFailure(error)
    return 'failed'
  }
}
