/**
 * Currency a Workspace uses for time costs, budgets, and rate cards until an administrator
 * chooses another one.
 */
export const DEFAULT_WORKSPACE_CURRENCY = 'JPY'

/** Maximum number of member rows one Team rate card can hold. */
export const TIME_RATE_CARD_MEMBER_LIMIT = 500

/** Maximum number of job role rows one Team rate card can hold. */
export const TIME_RATE_CARD_JOB_ROLE_LIMIT = 100

/** Upper bound for one hourly rate, in minor currency units. */
export const TIME_RATE_CARD_MAX_HOURLY_RATE_MINOR = 1_000_000_000

/**
 * Default rate of one member in a Team rate card.
 *
 * A row names the member's own rate, the job role whose rate the member takes, or both. The
 * member's own rate wins over the job role's rate.
 */
export type TimeRateCardMemberRate = {
  /** Canonical Workspace member key. */
  userId: string
  /** Confidential hourly rate in the rate card currency's minor units. */
  hourlyRateMinor?: number
  /** Job role, from the Work Item configuration, whose rate applies when the member has none. */
  jobRoleId?: string
}

/** Default rate of one job role in a Team rate card. */
export type TimeRateCardJobRoleRate = {
  /** Stable job role ID from the Work Item configuration. */
  jobRoleId: string
  /** Confidential hourly rate in the rate card currency's minor units. */
  hourlyRateMinor: number
}

/**
 * Confidential default hourly rates of a Team, applied to new time entries that carry no rate.
 *
 * Only a manager of the whole Team may read or change it.
 */
export type TimeRateCard = {
  /** Contract schema version. */
  schemaVersion: 1
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Team whose new time entries take these rates. */
  teamId: string
  /** ISO 4217 currency of every rate in the card. */
  currency: string
  /** Rates of individual members, sorted by member key. */
  memberRates: TimeRateCardMemberRate[]
  /** Rates of job roles, sorted by job role ID. */
  jobRoleRates: TimeRateCardJobRoleRate[]
  /** Optimistic concurrency revision; `0` for a Team that has not saved a rate card. */
  revision: number
  /** Last update timestamp; absent before the first save. */
  updatedAt?: string
  /** Member key that saved the card last; absent before the first save. */
  updatedBy?: string
}

/** Request body of `PUT /api/teams/:teamId/time-rate-card`, replacing the whole card. */
export type SaveTimeRateCardRequest = {
  /** ISO 4217 currency of every rate in the card. */
  currency: string
  /** Complete list of member rates; an empty list removes every member rate. */
  memberRates: TimeRateCardMemberRate[]
  /** Complete list of job role rates; an empty list removes every job role rate. */
  jobRoleRates: TimeRateCardJobRoleRate[]
  /** Revision read before editing; `0` for the first save. */
  expectedRevision: number
}

/** Response of the Team rate card routes. */
export type TimeRateCardResponse = {
  /** The stored card, or an empty card at revision `0`. */
  rateCard: TimeRateCard
}

/** Response of `GET /api/teams/:teamId/time-tracking/settings`. */
export type TimeTrackingTeamSettingsResponse = {
  /** Currency new entries and budgets take when the request names none. */
  defaultCurrency: string
  /** Whether the caller may read and change the Team rate card. */
  canManageRateCard: boolean
}

/**
 * Returns whether a value is an upper-case three-letter ISO 4217 currency code.
 *
 * @param value - Untrusted value.
 * @returns `true` for a code such as `JPY` or `USD`.
 */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value)
}

/** ISO 4217 codes the runtime knows, read once. */
let supportedCurrencyCodes: ReadonlySet<string> | undefined

/**
 * Returns whether a value is an ISO 4217 code that the runtime's `Intl` knows, such as `JPY`.
 *
 * Use it where a person types a currency; stored values keep the shape check of {@link isCurrencyCode}
 * so that a runtime with a shorter list still reads them.
 *
 * @param value - Untrusted value.
 * @returns `true` for a known code; `false` for an unknown one such as `ZZZ`.
 */
export function isKnownCurrencyCode(value: unknown): value is string {
  if (!isCurrencyCode(value)) return false
  supportedCurrencyCodes ??= new Set(Intl.supportedValuesOf('currency'))
  return supportedCurrencyCodes.has(value)
}
