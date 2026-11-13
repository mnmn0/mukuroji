import type { TimeSheet } from '@mukuroji/contracts'
import { createInvalidTimeTrackingResponseError, createTeamTimeTrackingUrl, requestTimeTrackingJson } from './timeTrackingRequest'
import { readTimeSheet } from './timeTrackingValidation'

/**
 * Reads the Team's daily and weekly totals for a period.
 *
 * The response also tells whether the caller manages the Team: confidential costs are withheld
 * (`costsRedacted`) from everyone else.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team whose entries are totalled.
 * @param period - Inclusive start and exclusive end as ISO 8601 instants, and the display timezone.
 * @returns Team timesheet.
 */
export async function getTeamTimesheet(
  accessToken: string,
  teamId: string,
  period: { from: string; to: string; timeZone: string },
): Promise<TimeSheet> {
  const query = new URLSearchParams({ from: period.from, to: period.to, timeZone: period.timeZone })
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, `/timesheet?${query.toString()}`), accessToken)
  const timesheet = readTimeSheet(data)
  if (!timesheet) throw createInvalidTimeTrackingResponseError('Team timesheet')
  return timesheet
}
