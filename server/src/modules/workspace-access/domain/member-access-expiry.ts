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
 * Reports whether a stored Workspace member row grants access now: it is active and its access
 * expiry, if any, has not passed.
 *
 * Readers that load the member row directly, such as notification delivery and realtime, use it
 * so a member whose expiry passed is refused before the scheduled job writes the deactivation
 * (ADR 0095).
 *
 * @param row - Stored member row; only `status` and `accessExpiresAt` are read.
 * @param now - Current instant.
 * @returns Whether the member is active and not expired; a malformed expiry fails closed.
 */
export function isWorkspaceMemberRowActive(
  row: { readonly status?: unknown, readonly accessExpiresAt?: unknown },
  now: Date,
): boolean {
  if (row.status !== 'active') return false
  if (row.accessExpiresAt === undefined) return true
  if (typeof row.accessExpiresAt !== 'string') return false
  if (!isCanonicalUtcTimestamp(row.accessExpiresAt)) return false
  return !isMemberAccessExpired({ accessExpiresAt: row.accessExpiresAt }, now)
}

/**
 * Reports whether a value is a canonical UTC timestamp, the only form a member row stores.
 *
 * @param value - Stored timestamp.
 * @returns Whether the value is exactly what `Date.prototype.toISOString` writes for it.
 */
export function isCanonicalUtcTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/**
 * Pattern of the accepted expiry input: an ISO 8601 date and time with seconds optional,
 * fractional seconds optional, and a required UTC offset (`Z` or `±HH:MM`).
 */
const MEMBER_ACCESS_EXPIRY_INPUT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u

/**
 * Reports whether an expiry input names a real calendar date and time with an explicit UTC
 * offset, so `Date.parse` neither reads it as local time nor rolls an impossible date over.
 *
 * @param value - Untrusted expiry input.
 * @returns Whether the value has a valid shape, calendar date, time of day, and offset.
 */
function isMemberAccessExpiryInput(value: string): boolean {
  const match = MEMBER_ACCESS_EXPIRY_INPUT_PATTERN.exec(value)
  if (match === null) return false
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1) return false
  // Day 0 of the next month is the last day of this month.
  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
  if (dayNumber > daysInMonth) return false
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? '0') > 59) return false
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    return false
  }
  return true
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
  if (!Number.isFinite(expiresAt) || !isMemberAccessExpiryInput(value)) {
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
