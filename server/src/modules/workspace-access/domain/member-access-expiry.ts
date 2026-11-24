import type { WorkspaceRole } from './workspace-role'

/** Longest time ahead an access expiry may be set, in days (about five years). */
export const MEMBER_ACCESS_EXPIRY_MAX_DAYS = 1_830

/**
 * Reports whether a member's access expiry has passed.
 *
 * A member whose expiry has passed is treated as deactivated at every membership check, before
 * the scheduled job writes the deactivation (ADR 0095).
 *
 * @param member - Member whose stored expiry is checked.
 * @param now - Current instant.
 * @returns Whether the member has an expiry at or before `now`.
 */
export function isMemberAccessExpired(
  member: { readonly accessExpiresAt?: string },
  now: Date,
): boolean {
  if (member.accessExpiresAt === undefined) return false
  const expiresAt = Date.parse(member.accessExpiresAt)
  // A stored value that does not parse fails closed.
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime()
}

/**
 * Reports whether a Workspace role can be given an access expiry.
 *
 * Owners are left out so a Workspace cannot lose its last owner by expiry.
 *
 * @param role - Current Workspace role of the member.
 * @returns Whether an expiry may be set on the role.
 */
export function canMemberAccessExpire(role: WorkspaceRole): boolean {
  return role !== 'owner'
}

/**
 * Reads an access expiry an administrator asked for.
 *
 * @param value - Untrusted value; `null` clears the expiry.
 * @param now - Current instant.
 * @returns The canonical UTC timestamp, or undefined to clear it.
 * @throws RangeError when the value is not a timestamp in the allowed future window.
 */
export function readMemberAccessExpiry(value: unknown, now: Date): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string' || value.length > 64) {
    throw new RangeError('Access expiry must be an ISO 8601 timestamp or null.')
  }
  const expiresAt = Date.parse(value)
  if (!Number.isFinite(expiresAt) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw new RangeError('Access expiry must be an ISO 8601 timestamp or null.')
  }
  if (expiresAt <= now.getTime()) {
    throw new RangeError('Access expiry must be in the future.')
  }
  if (expiresAt > now.getTime() + MEMBER_ACCESS_EXPIRY_MAX_DAYS * 86_400_000) {
    throw new RangeError('Access expiry is too far in the future.')
  }
  return new Date(expiresAt).toISOString()
}
