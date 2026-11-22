import { AUDIT_EVENT_TYPE_FILTER_LIMIT, type AuditEventFilters } from '@mukuroji/contracts'

/**
 * Values of the audit search form as the member typed them.
 */
export type AuditLogFilterDraft = {
  /** Actor ID to match, or empty for every actor. */
  readonly actorId: string
  /** Event types separated by commas, or empty for every type. */
  readonly eventTypes: string
  /** Target type to match, or empty for every target. */
  readonly targetType: string
  /** Target ID to match; only used together with a target type. */
  readonly targetId: string
  /** First day of the period as `YYYY-MM-DD`, or empty. */
  readonly fromDate: string
  /** Last day of the period as `YYYY-MM-DD`, or empty. */
  readonly toDate: string
}

/** Form values that match every event. */
export const emptyAuditLogFilterDraft: AuditLogFilterDraft = {
  actorId: '',
  eventTypes: '',
  targetType: '',
  targetId: '',
  fromDate: '',
  toDate: '',
}

/**
 * Reason a filter draft cannot be searched.
 */
export type AuditLogFilterProblem =
  | 'targetIdWithoutType'
  | 'tooManyEventTypes'
  | 'invalidPeriod'

/** Result of turning a draft into search filters. */
export type AuditLogFilterResult =
  | {
    /** The draft is valid. */
    readonly ok: true
    /** Filters to send to the server. */
    readonly filters: AuditEventFilters
  }
  | {
    /** The draft is not valid. */
    readonly ok: false
    /** What the member needs to fix. */
    readonly problem: AuditLogFilterProblem
  }

/** Date of the form `YYYY-MM-DD`. */
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u

/**
 * Turns the search form into server filters, reading the period in the member's time zone.
 *
 * The first day starts at 00:00 and the last day ends at 23:59:59.999 in that zone.
 *
 * @param draft - Form values.
 * @param timeZone - IANA time zone of the member; undefined uses the browser's.
 * @returns The filters, or the problem that blocks the search.
 */
export function buildAuditLogFilters(draft: AuditLogFilterDraft, timeZone?: string): AuditLogFilterResult {
  const actorId = draft.actorId.trim()
  const targetType = draft.targetType.trim()
  const targetId = draft.targetId.trim()
  const eventTypes = [...new Set(draft.eventTypes.split(',').map((type) => type.trim()).filter(Boolean))]
  if (targetId && !targetType) return { ok: false, problem: 'targetIdWithoutType' }
  if (eventTypes.length > AUDIT_EVENT_TYPE_FILTER_LIMIT) return { ok: false, problem: 'tooManyEventTypes' }
  const from = draft.fromDate ? zonedDayBoundary(draft.fromDate, timeZone, 'start') : undefined
  const to = draft.toDate ? zonedDayBoundary(draft.toDate, timeZone, 'end') : undefined
  if (from === null || to === null || (from && to && Date.parse(from) > Date.parse(to))) {
    return { ok: false, problem: 'invalidPeriod' }
  }
  return {
    ok: true,
    filters: {
      ...(actorId ? { actorId } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetType && targetId ? { targetId } : {}),
      ...(eventTypes.length > 0 ? { eventTypes } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
  }
}

/**
 * Returns whether filters narrow the search in any way.
 *
 * @param filters - Search filters.
 * @returns Whether at least one filter is set.
 */
export function hasAuditLogFilters(filters: AuditEventFilters): boolean {
  return Object.keys(filters).length > 0
}

/**
 * Finds the UTC instant where a calendar day starts or ends in a time zone.
 *
 * @param date - Day as `YYYY-MM-DD`.
 * @param timeZone - IANA time zone; undefined uses the browser's.
 * @param boundary - Whether to return the first or last millisecond of the day.
 * @returns ISO 8601 instant, or null when the date or time zone is invalid.
 */
export function zonedDayBoundary(
  date: string,
  timeZone: string | undefined,
  boundary: 'start' | 'end',
): string | null {
  const match = datePattern.exec(date)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const localMidnight = Date.UTC(year, month - 1, day)
  const check = new Date(localMidnight)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  const nextMidnight = Date.UTC(year, month - 1, day + 1)
  try {
    const start = localMidnight - zoneOffset(localMidnight, timeZone)
    const end = nextMidnight - zoneOffset(nextMidnight, timeZone) - 1
    return new Date(boundary === 'start' ? start : end).toISOString()
  } catch {
    return null
  }
}

/**
 * Measures how far a time zone's wall clock is ahead of UTC around a wall-clock time.
 *
 * The offset is read at the wall-clock time taken as UTC and then again at the corrected
 * instant, which settles on the right offset on either side of a daylight-saving change.
 *
 * @param wallClock - Wall-clock time expressed as if it were UTC, in milliseconds.
 * @param timeZone - IANA time zone; undefined uses the browser's.
 * @returns Offset in milliseconds.
 */
function zoneOffset(wallClock: number, timeZone: string | undefined): number {
  const first = offsetAt(wallClock, timeZone)
  return offsetAt(wallClock - first, timeZone)
}

/**
 * Reads a time zone's offset from UTC at one instant.
 *
 * @param instant - UTC instant in milliseconds.
 * @param timeZone - IANA time zone; undefined uses the browser's.
 * @returns Offset in milliseconds.
 */
function offsetAt(instant: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  return asUtc - Math.floor(instant / 1000) * 1000
}
