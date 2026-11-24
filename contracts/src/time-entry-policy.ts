/** How a Team treats a time entry that breaks one of its checks. */
export type TimeEntryCheckMode = 'off' | 'warn' | 'reject'

/** Longest daily total a Team may allow, in minutes. */
export const MAX_TIME_ENTRY_DAILY_LIMIT_MINUTES = 24 * 60

/** Checks a Team applies when a member records or edits time. */
export type TeamTimeEntryPolicy = {
  /** What happens when an entry's time range overlaps another entry of the same member. */
  overlap: TimeEntryCheckMode
  /** What happens when a member's recorded time on one local day exceeds `dailyLimitMinutes`. */
  dailyLimit: TimeEntryCheckMode
  /** Most minutes a member may record on one local day, 1 to 1,440. */
  dailyLimitMinutes: number
}

/** Policy of a Team that has not chosen one: no checks, with a 10-hour day ready to turn on. */
export const DEFAULT_TEAM_TIME_ENTRY_POLICY: TeamTimeEntryPolicy = {
  overlap: 'off',
  dailyLimit: 'off',
  dailyLimitMinutes: 10 * 60,
}

/** A Team's saved policy with its revision, as the policy API returns it. */
export type TeamTimeEntryPolicyRecord = TeamTimeEntryPolicy & {
  /** Team identifier. */
  teamId: string
  /** Optimistic concurrency revision; 0 while the Team uses the defaults. */
  revision: number
  /** When the policy was last saved; absent while the Team uses the defaults. */
  updatedAt?: string
}

/** A time entry that overlaps other entries of the same member. */
export type TimeEntryOverlapWarning = {
  /** Warning kind. */
  code: 'TimeEntryOverlap'
  /** Identifiers of the overlapping entries. */
  entryIds: string[]
}

/** A local day whose recorded total exceeds the Team's daily limit. */
export type TimeEntryDailyLimitWarning = {
  /** Warning kind. */
  code: 'TimeEntryDailyLimitExceeded'
  /** Local `YYYY-MM-DD` date in the Workspace time zone. */
  date: string
  /** Minutes recorded on that date, including the saved entry. */
  minutes: number
  /** Team daily limit in minutes. */
  limitMinutes: number
}

/** A check the saved entry broke in a Team that only warns about it. */
export type TimeEntryPolicyWarning = TimeEntryOverlapWarning | TimeEntryDailyLimitWarning

/**
 * Validates a check mode.
 *
 * @param value - Untrusted mode.
 * @returns The mode, or undefined when it is not one of `off`, `warn`, `reject`.
 */
function readTimeEntryCheckMode(value: unknown): TimeEntryCheckMode | undefined {
  return value === 'off' || value === 'warn' || value === 'reject' ? value : undefined
}

/**
 * Validates a Team time entry policy.
 *
 * @param value - Untrusted policy.
 * @returns The policy, or undefined when a mode or the daily limit is invalid.
 */
export function readTeamTimeEntryPolicy(value: unknown): TeamTimeEntryPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const overlap = readTimeEntryCheckMode(Reflect.get(value, 'overlap'))
  const dailyLimit = readTimeEntryCheckMode(Reflect.get(value, 'dailyLimit'))
  const dailyLimitMinutes: unknown = Reflect.get(value, 'dailyLimitMinutes')
  if (
    overlap === undefined ||
    dailyLimit === undefined ||
    typeof dailyLimitMinutes !== 'number' ||
    !Number.isInteger(dailyLimitMinutes) ||
    dailyLimitMinutes < 1 ||
    dailyLimitMinutes > MAX_TIME_ENTRY_DAILY_LIMIT_MINUTES
  ) {
    return undefined
  }
  return { overlap, dailyLimit, dailyLimitMinutes }
}

/**
 * Validates one warning returned with a saved entry.
 *
 * @param value - Untrusted warning.
 * @returns The warning, or undefined when it is malformed or of an unknown kind.
 */
export function readTimeEntryPolicyWarning(value: unknown): TimeEntryPolicyWarning | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code: unknown = Reflect.get(value, 'code')
  if (code === 'TimeEntryOverlap') {
    const entryIds: unknown = Reflect.get(value, 'entryIds')
    if (!Array.isArray(entryIds) || !entryIds.every((id): id is string => typeof id === 'string')) return undefined
    return { code, entryIds }
  }
  if (code === 'TimeEntryDailyLimitExceeded') {
    const date: unknown = Reflect.get(value, 'date')
    const minutes: unknown = Reflect.get(value, 'minutes')
    const limitMinutes: unknown = Reflect.get(value, 'limitMinutes')
    if (
      typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 ||
      typeof limitMinutes !== 'number' || !Number.isInteger(limitMinutes) || limitMinutes < 1
    ) {
      return undefined
    }
    return { code, date, minutes, limitMinutes }
  }
  return undefined
}
