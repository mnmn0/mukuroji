import type {
  TimePeriodClose,
  WorkspaceTimePeriodResult,
  WorkspaceTimePeriodTeamResult,
  WorkspaceTimePeriodTeamState,
} from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
  timeTrackingApiBaseUrl,
} from './timeTrackingRequest'

/** A Team's closed months and what the caller may change. */
export type TeamTimePeriods = {
  /** Closed months in month order. */
  closedPeriods: TimePeriodClose[]
  /** Whether the caller manages the whole Team and may close or reopen its months. */
  canManagePeriods: boolean
}

/** One month's close state across the Workspace's Teams. */
export type WorkspaceTimePeriodState = {
  /** Month as `YYYY-MM`. */
  month: string
  /** Each Team with its close, when the month is closed for it. */
  teams: WorkspaceTimePeriodTeamState[]
}

/**
 * Reads one month close from a response body.
 *
 * @param value - Untrusted close.
 * @returns The close, or undefined when it is malformed.
 */
function readTimePeriodClose(value: unknown): TimePeriodClose | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const { workspaceId, teamId, month, timeZone, closedBy, closedAt } = value
  if (
    typeof workspaceId !== 'string' || typeof teamId !== 'string' || typeof month !== 'string' ||
    typeof timeZone !== 'string' || typeof closedBy !== 'string' || typeof closedAt !== 'string'
  ) return undefined
  return { schemaVersion: 1, workspaceId, teamId, month, timeZone, closedBy, closedAt }
}

/**
 * Reads one Team's outcome of a Workspace-wide close or reopen.
 *
 * @param value - Untrusted outcome.
 * @returns The outcome, or undefined when it is malformed.
 */
function readWorkspaceTeamResult(value: unknown): WorkspaceTimePeriodTeamResult | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string') return undefined
  const { status } = value
  if (
    status !== 'closed' && status !== 'already-closed' && status !== 'reopened' &&
    status !== 'not-closed' && status !== 'failed'
  ) return undefined
  return { teamId: value.teamId, status }
}

/**
 * Reads the result of a Workspace-wide close or reopen.
 *
 * @param value - Untrusted response body.
 * @returns The result.
 * @throws TimeTrackingApiError when the body is malformed.
 */
function readWorkspaceResult(value: unknown): WorkspaceTimePeriodResult {
  if (!isRecord(value) || typeof value.month !== 'string' || !Array.isArray(value.results) || typeof value.partialFailure !== 'boolean') {
    throw createInvalidTimeTrackingResponseError('Workspace time period')
  }
  const results = value.results.map(readWorkspaceTeamResult)
  if (results.some((result) => result === undefined)) throw createInvalidTimeTrackingResponseError('Workspace time period')
  return {
    month: value.month,
    results: results.filter((result) => result !== undefined),
    partialFailure: value.partialFailure,
  }
}

/**
 * Builds the URL of a Workspace-wide month endpoint.
 *
 * @param month - Month as `YYYY-MM`.
 * @param action - `close`, `reopen`, or undefined to read the month.
 * @returns Request URL.
 */
function createWorkspacePeriodUrl(month: string, action?: 'close' | 'reopen'): string {
  return `${timeTrackingApiBaseUrl}/time-periods/${encodeURIComponent(month)}${action ? `/${action}` : ''}`
}

/**
 * Lists a Team's closed months.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team to read.
 * @returns Closed months and the caller's permissions.
 */
export async function getTeamTimePeriods(accessToken: string, teamId: string): Promise<TeamTimePeriods> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-periods'), accessToken)
  if (!isRecord(data) || !Array.isArray(data.closedPeriods)) throw createInvalidTimeTrackingResponseError('Time periods')
  const closedPeriods = data.closedPeriods.map(readTimePeriodClose)
  if (closedPeriods.some((close) => close === undefined)) throw createInvalidTimeTrackingResponseError('Time periods')
  return {
    closedPeriods: closedPeriods.filter((close) => close !== undefined),
    canManagePeriods: data.canManagePeriods === true,
  }
}

/**
 * Closes one month of a Team.
 *
 * @param accessToken - Bearer token of a manager of the whole Team.
 * @param teamId - Team whose month is closed.
 * @param month - Month as `YYYY-MM`.
 * @param timeZone - IANA timezone of the month boundaries.
 * @returns The stored close.
 */
export async function closeTeamTimePeriod(
  accessToken: string,
  teamId: string,
  month: string,
  timeZone: string,
): Promise<TimePeriodClose> {
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/time-periods/${encodeURIComponent(month)}/close`),
    accessToken,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeZone }) },
  )
  const period = isRecord(data) ? readTimePeriodClose(data.period) : undefined
  if (!period) throw createInvalidTimeTrackingResponseError('Time period')
  return period
}

/**
 * Reopens a closed month of a Team.
 *
 * @param accessToken - Bearer token of a manager of the whole Team.
 * @param teamId - Team whose month is reopened.
 * @param month - Month as `YYYY-MM`.
 * @param reason - Reason recorded in the audit log.
 * @returns The close that was removed.
 */
export async function reopenTeamTimePeriod(
  accessToken: string,
  teamId: string,
  month: string,
  reason: string,
): Promise<TimePeriodClose> {
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/time-periods/${encodeURIComponent(month)}/reopen`),
    accessToken,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
  )
  const period = isRecord(data) ? readTimePeriodClose(data.period) : undefined
  if (!period) throw createInvalidTimeTrackingResponseError('Time period')
  return period
}

/**
 * Reads one month's close state for every Team of the Workspace.
 *
 * @param accessToken - Bearer token of a Workspace administrator.
 * @param month - Month as `YYYY-MM`.
 * @returns Each Team with its close.
 */
export async function getWorkspaceTimePeriod(accessToken: string, month: string): Promise<WorkspaceTimePeriodState> {
  const data = await requestTimeTrackingJson(createWorkspacePeriodUrl(month), accessToken)
  if (!isRecord(data) || typeof data.month !== 'string' || !Array.isArray(data.teams)) {
    throw createInvalidTimeTrackingResponseError('Workspace time period')
  }
  const teams: WorkspaceTimePeriodTeamState[] = []
  for (const team of data.teams) {
    if (!isRecord(team) || typeof team.teamId !== 'string') throw createInvalidTimeTrackingResponseError('Workspace time period')
    if (team.name !== undefined && typeof team.name !== 'string') throw createInvalidTimeTrackingResponseError('Workspace time period')
    const named = typeof team.name === 'string' ? { teamId: team.teamId, name: team.name } : { teamId: team.teamId }
    if (team.close === undefined) {
      teams.push(named)
      continue
    }
    const close = readTimePeriodClose(team.close)
    if (!close) throw createInvalidTimeTrackingResponseError('Workspace time period')
    teams.push({ ...named, close })
  }
  return { month: data.month, teams }
}

/**
 * Closes one month for every Team of the Workspace.
 *
 * @param accessToken - Bearer token of a Workspace administrator.
 * @param month - Month as `YYYY-MM`.
 * @param timeZone - IANA timezone of the month boundaries.
 * @returns Each Team's outcome.
 */
export async function closeWorkspaceTimePeriod(
  accessToken: string,
  month: string,
  timeZone: string,
): Promise<WorkspaceTimePeriodResult> {
  return readWorkspaceResult(await requestTimeTrackingJson(createWorkspacePeriodUrl(month, 'close'), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeZone }),
  }))
}

/**
 * Reopens one month for every Team of the Workspace.
 *
 * @param accessToken - Bearer token of a Workspace administrator.
 * @param month - Month as `YYYY-MM`.
 * @param reason - Reason recorded in each Team's audit log.
 * @returns Each Team's outcome.
 */
export async function reopenWorkspaceTimePeriod(
  accessToken: string,
  month: string,
  reason: string,
): Promise<WorkspaceTimePeriodResult> {
  return readWorkspaceResult(await requestTimeTrackingJson(createWorkspacePeriodUrl(month, 'reopen'), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }))
}
