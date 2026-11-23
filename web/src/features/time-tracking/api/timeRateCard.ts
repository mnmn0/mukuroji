import {
  isCurrencyCode,
  type SaveTimeRateCardRequest,
  type TimeRateCard,
  type TimeRateCardJobRoleRate,
  type TimeRateCardMemberRate,
  type TimeTrackingTeamSettingsResponse,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isOptionalString, isRecord } from '../../../shared/api/jsonValidation'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
} from './timeTrackingRequest'

/**
 * Reads one member row of a rate card response.
 *
 * @param value - Untrusted row.
 * @returns The row, or undefined when it is malformed.
 */
function readMemberRate(value: unknown): TimeRateCardMemberRate | undefined {
  if (!isRecord(value) || typeof value.userId !== 'string') return undefined
  if (value.hourlyRateMinor !== undefined && !isNonnegativeSafeInteger(value.hourlyRateMinor)) return undefined
  if (!isOptionalString(value.jobRoleId)) return undefined
  return {
    userId: value.userId,
    ...(typeof value.hourlyRateMinor === 'number' ? { hourlyRateMinor: value.hourlyRateMinor } : {}),
    ...(typeof value.jobRoleId === 'string' ? { jobRoleId: value.jobRoleId } : {}),
  }
}

/**
 * Reads one job role row of a rate card response.
 *
 * @param value - Untrusted row.
 * @returns The row, or undefined when it is malformed.
 */
function readJobRoleRate(value: unknown): TimeRateCardJobRoleRate | undefined {
  if (!isRecord(value) || typeof value.jobRoleId !== 'string' || !isNonnegativeSafeInteger(value.hourlyRateMinor)) return undefined
  return { jobRoleId: value.jobRoleId, hourlyRateMinor: value.hourlyRateMinor }
}

/**
 * Reads a rate card from a response body.
 *
 * @param value - Untrusted `rateCard` field.
 * @returns The rate card, or undefined when it is malformed.
 */
export function readTimeRateCard(value: unknown): TimeRateCard | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const { workspaceId, teamId, currency, revision, updatedAt, updatedBy } = value
  if (
    typeof workspaceId !== 'string' || typeof teamId !== 'string' || !isCurrencyCode(currency) ||
    !isNonnegativeSafeInteger(revision) || !isOptionalString(updatedAt) || !isOptionalString(updatedBy) ||
    !Array.isArray(value.memberRates) || !Array.isArray(value.jobRoleRates)
  ) return undefined
  const memberRates = value.memberRates.map(readMemberRate)
  const jobRoleRates = value.jobRoleRates.map(readJobRoleRate)
  if (memberRates.some((row) => row === undefined) || jobRoleRates.some((row) => row === undefined)) return undefined
  return {
    schemaVersion: 1,
    workspaceId,
    teamId,
    currency,
    memberRates: memberRates.filter((row) => row !== undefined),
    jobRoleRates: jobRoleRates.filter((row) => row !== undefined),
    revision,
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    ...(typeof updatedBy === 'string' ? { updatedBy } : {}),
  }
}

/**
 * Reads the time tracking settings of a Team: the Workspace currency and whether the caller may
 * manage the rate card.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team to read.
 * @returns The settings.
 */
export async function getTimeTrackingTeamSettings(
  accessToken: string,
  teamId: string,
): Promise<TimeTrackingTeamSettingsResponse> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-tracking/settings'), accessToken)
  if (!isRecord(data) || !isCurrencyCode(data.defaultCurrency) || typeof data.canManageRateCard !== 'boolean') {
    throw createInvalidTimeTrackingResponseError('Time tracking settings')
  }
  return { defaultCurrency: data.defaultCurrency, canManageRateCard: data.canManageRateCard }
}

/**
 * Reads a Team's confidential rate card.
 *
 * @param accessToken - Bearer token of a manager of the whole Team.
 * @param teamId - Team to read.
 * @returns The stored card, or an empty card at revision `0`.
 */
export async function getTimeRateCard(accessToken: string, teamId: string): Promise<TimeRateCard> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-rate-card'), accessToken)
  const rateCard = isRecord(data) ? readTimeRateCard(data.rateCard) : undefined
  if (!rateCard) throw createInvalidTimeTrackingResponseError('Time rate card')
  return rateCard
}

/**
 * Replaces a Team's rate card.
 *
 * @param accessToken - Bearer token of a manager of the whole Team.
 * @param teamId - Team whose card is replaced.
 * @param input - Whole card and the revision being replaced.
 * @returns The saved card.
 */
export async function saveTimeRateCard(
  accessToken: string,
  teamId: string,
  input: SaveTimeRateCardRequest,
): Promise<TimeRateCard> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-rate-card'), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const rateCard = isRecord(data) ? readTimeRateCard(data.rateCard) : undefined
  if (!rateCard) throw createInvalidTimeTrackingResponseError('Time rate card')
  return rateCard
}
