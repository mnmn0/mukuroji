import type { WorkspaceMember } from '../api/access'

/**
 * Turns the last day a member may work into the instant their access ends.
 *
 * Access ends when that day ends in the administrator's time zone.
 *
 * @param lastDay - Date input value (`YYYY-MM-DD`).
 * @returns The ISO 8601 instant access ends, or undefined when the value is not a date.
 */
export function readAccessExpiryFromLastDay(lastDay: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(lastDay)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const lastDayDate = new Date(year, month - 1, day)
  // A value such as 2026-02-31 rolls over to another day and is refused.
  if (lastDayDate.getMonth() !== month - 1 || lastDayDate.getDate() !== day) return undefined
  return new Date(year, month - 1, day + 1).toISOString()
}

/**
 * Turns the instant a member's access ends into the last day they may work.
 *
 * @param accessExpiresAt - ISO 8601 instant access ends.
 * @returns Date input value (`YYYY-MM-DD`) in the local time zone, or an empty string when unreadable.
 */
export function formatAccessExpiryLastDay(accessExpiresAt: string | undefined): string {
  if (!accessExpiresAt) return ''
  const expiresAt = Date.parse(accessExpiresAt)
  if (!Number.isFinite(expiresAt)) return ''
  // The instant just before the end belongs to the last day.
  const lastMoment = new Date(expiresAt - 1)
  return [
    String(lastMoment.getFullYear()).padStart(4, '0'),
    String(lastMoment.getMonth() + 1).padStart(2, '0'),
    String(lastMoment.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * Reports whether a member's access has ended.
 *
 * @param accessExpiresAt - ISO 8601 instant access ends, when set.
 * @param now - Current instant.
 * @returns Whether the expiry is set and has passed.
 */
export function hasMemberAccessExpired(accessExpiresAt: string | undefined, now: Date): boolean {
  if (!accessExpiresAt) return false
  const expiresAt = Date.parse(accessExpiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime()
}

/**
 * Lists the members who can take over from a leaving member: active, unexpired, non-guest
 * members other than the leaver.
 *
 * A member whose access expired keeps an active row until their own roles are handed over, but
 * can no longer be given a Project role, so they are not offered as a successor.
 *
 * @param leaverKey - Member key of the leaving member.
 * @param members - Every Workspace member.
 * @param now - Current instant.
 * @returns The candidates, in the order of `members`.
 */
export function listOffboardingSuccessors(
  leaverKey: string,
  members: readonly WorkspaceMember[],
  now: Date,
): WorkspaceMember[] {
  return members.filter((candidate) =>
    candidate.memberKey !== leaverKey &&
    candidate.status === 'active' &&
    candidate.role !== 'guest' &&
    !hasMemberAccessExpired(candidate.accessExpiresAt, now)
  )
}
