import type { MyTimesheet, MyTimesheetSubmitResult, MyTimesheetTeam } from '@mukuroji/contracts'
import { isRecord, isStringArray } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import { createInvalidTimeTrackingResponseError, requestTimeTrackingJson, timeTrackingApiBaseUrl } from './timeTrackingRequest'
import { readTimeEntries, readTimeSheet } from './timeTrackingValidation'

/**
 * Reads the caller's own time in every Team they can view, for one period.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param period - Inclusive start and exclusive end as ISO 8601 instants, and the display timezone.
 * @returns One row per Team with the caller's own totals and entries.
 */
export async function getMyTimesheet(
  accessToken: string,
  period: { from: string; to: string; timeZone: string },
): Promise<MyTimesheet> {
  const query = new URLSearchParams({ from: period.from, to: period.to, timeZone: period.timeZone })
  const data = await requestTimeTrackingJson(`${timeTrackingApiBaseUrl}/time-tracking/my-timesheet?${query.toString()}`, accessToken)
  if (!isRecord(data) || typeof data.timeZone !== 'string' || !Array.isArray(data.teams)) {
    throw createInvalidTimeTrackingResponseError('Personal timesheet')
  }
  const teams: MyTimesheetTeam[] = []
  for (const value of data.teams) {
    const timesheet = isRecord(value) ? readTimeSheet(value.timesheet) : undefined
    const entries = isRecord(value) ? readTimeEntries(value.entries) : undefined
    if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.name !== 'string' || !timesheet || !entries) {
      throw createInvalidTimeTrackingResponseError('Personal timesheet')
    }
    teams.push({ teamId: value.teamId, name: value.name, timesheet, entries })
  }
  return { timeZone: data.timeZone, teams }
}

/**
 * Submits the caller's draft and rejected time of every Team in a period at once.
 *
 * Each Team's entries then go through that Team's own approval.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param period - Inclusive start and exclusive end as ISO 8601 instants.
 * @param context - Mutation identity shared by retries.
 * @returns Submitted counts per Team and the entries that still need a retry.
 */
export async function submitMyTimesheet(
  accessToken: string,
  period: { from: string; to: string },
  context: MutationRequestContext,
): Promise<MyTimesheetSubmitResult> {
  const data = await requestTimeTrackingJson(`${timeTrackingApiBaseUrl}/time-tracking/my-timesheet/submit`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({ from: period.from, to: period.to }),
  })
  if (
    !isRecord(data) || typeof data.count !== 'number' || !isStringArray(data.failedEntryIds) ||
    typeof data.partialFailure !== 'boolean' || !Array.isArray(data.teams)
  ) {
    throw createInvalidTimeTrackingResponseError('Personal timesheet submission')
  }
  const teams: MyTimesheetSubmitResult['teams'] = []
  for (const value of data.teams) {
    if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.count !== 'number' || !isStringArray(value.failedEntryIds)) {
      throw createInvalidTimeTrackingResponseError('Personal timesheet submission')
    }
    teams.push({ teamId: value.teamId, count: value.count, failedEntryIds: value.failedEntryIds })
  }
  return { count: data.count, failedEntryIds: data.failedEntryIds, partialFailure: data.partialFailure, teams }
}

