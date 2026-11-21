import type { TimeSheet } from '@mukuroji/contracts'
import { createInvalidTimeTrackingResponseError, createTeamTimeTrackingUrl, requestTimeTrackingJson } from './timeTrackingRequest'
import { readTimeSheet } from './timeTrackingValidation'

/**
 * Reads the caller's daily and weekly totals in a Team for a period.
 *
 * The response tells whether the caller manages time in the Team (`canManageTeam`). Members get
 * only their own time; Team time managers also get other members' time in the Projects they
 * manage and outside any Project.
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
