import type { TimeTrackingGroupBy, TimeTrackingSummary } from '@mukuroji/contracts'
import { isFiniteNumber, isRecord } from '../../../shared/api/jsonValidation'
import { createInvalidTimeTrackingResponseError, createTeamTimeTrackingUrl, requestTimeTrackingJson } from './timeTrackingRequest'

/** Fields of a summary request. */
export type TimeSummaryInput = {
  /** Inclusive start as an ISO 8601 instant. */
  from: string
  /** Exclusive end as an ISO 8601 instant. */
  to: string
  /** IANA timezone used for calendar grouping. */
  timeZone: string
  /** Grouping dimension. */
  groupBy: TimeTrackingGroupBy
}

/** Grouped minutes that the Work Item time panel needs from a summary. */
export type TimeSummaryMinutes = Pick<TimeTrackingSummary, 'totalMinutes'> & {
  /** Minutes keyed by group key. */
  minutesByKey: Record<string, number>
}

/**
 * Reads the Team's actual minutes grouped by one dimension.
 *
 * Only the minute totals are validated and returned; confidential money fields are not read.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team whose entries are summarized.
 * @param input - Period, timezone, and grouping.
 * @returns Total minutes and minutes per group.
 */
export async function getTimeSummaryMinutes(
  accessToken: string,
  teamId: string,
  input: TimeSummaryInput,
): Promise<TimeSummaryMinutes> {
  const query = new URLSearchParams({ from: input.from, to: input.to, timeZone: input.timeZone, groupBy: input.groupBy })
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, `/time-tracking/summary?${query.toString()}`), accessToken)
  if (!isRecord(data) || !isFiniteNumber(data.totalMinutes) || !Array.isArray(data.groups)) {
    throw createInvalidTimeTrackingResponseError('Time summary')
  }
  const minutesByKey: Record<string, number> = {}
  for (const group of data.groups) {
    if (!isRecord(group) || typeof group.key !== 'string' || !isFiniteNumber(group.minutes)) {
      throw createInvalidTimeTrackingResponseError('Time summary')
    }
    minutesByKey[group.key] = group.minutes
  }
  return { totalMinutes: data.totalMinutes, minutesByKey }
}
