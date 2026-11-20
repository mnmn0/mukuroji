import type {
  TeamNotificationReminderSettings,
  UpdateTeamNotificationReminderSettingsRequest,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { NotificationsApiError } from './errors'

const notificationsApiBaseUrl = resolveApiBaseUrl()

/**
 * Builds the Team reminder settings URL.
 *
 * @param teamId - Team ID.
 * @returns Absolute API URL.
 */
function createTeamRemindersUrl(teamId: string) {
  return `${notificationsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/notification-reminders`
}

/**
 * Reads a Team's reminder settings.
 *
 * @param accessToken - API access token.
 * @param teamId - Team ID.
 * @returns The Team overrides, the defaults, and whether the caller may change them.
 */
export async function getTeamReminderSettings(accessToken: string, teamId: string) {
  return await requestTeamReminders(createTeamRemindersUrl(teamId), accessToken)
}

/**
 * Replaces a Team's reminder overrides.
 *
 * @param accessToken - API access token.
 * @param teamId - Team ID.
 * @param request - Expected revision and the complete overrides.
 * @param mutationContext - Mutation context shared across retries.
 * @returns The saved settings.
 */
export async function updateTeamReminderSettings(
  accessToken: string,
  teamId: string,
  request: UpdateTeamNotificationReminderSettingsRequest,
  mutationContext: MutationRequestContext,
) {
  return await requestTeamReminders(createTeamRemindersUrl(teamId), accessToken, {
    body: JSON.stringify(request),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'PUT',
  })
}

/**
 * Sends one Team reminder request and validates the response shape.
 *
 * @param url - API URL.
 * @param accessToken - API access token.
 * @param init - Request options.
 * @returns The settings in the response.
 * @throws NotificationsApiError for an error status or an unexpected body.
 */
async function requestTeamReminders(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<TeamNotificationReminderSettings> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  })
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code = readStringField(data, 'code')
    throw new NotificationsApiError(
      response.status,
      readStringField(data, 'message') ?? 'Unable to complete the Team reminder request.',
      code,
    )
  }
  const settings = readTeamReminderSettings(data)
  if (!settings) {
    throw new NotificationsApiError(502, 'The Team reminder response was not understood.')
  }
  return settings
}

/**
 * Validates a Team reminder settings response.
 *
 * @param value - Parsed response body.
 * @returns The settings, or undefined when the shape is unexpected.
 */
function readTeamReminderSettings(value: unknown): TeamNotificationReminderSettings | undefined {
  if (!isRecord(value) || !isRecord(value.days) || !isRecord(value.defaults)) return undefined
  const { teamId, revision, canManage, updatedAt } = value
  if (
    typeof teamId !== 'string' ||
    typeof revision !== 'number' ||
    typeof canManage !== 'boolean' ||
    (updatedAt !== undefined && typeof updatedAt !== 'string')
  ) {
    return undefined
  }
  const defaults = value.defaults
  const dueSoonDays = defaults.dueSoonDays
  const overdueReminderIntervalDays = defaults.overdueReminderIntervalDays
  const overdueEscalationDays = defaults.overdueEscalationDays
  const staleStartedDays = defaults.staleStartedDays
  const timesheetReminderDays = defaults.timesheetReminderDays
  if (
    typeof dueSoonDays !== 'number' ||
    typeof overdueReminderIntervalDays !== 'number' ||
    typeof overdueEscalationDays !== 'number' ||
    typeof staleStartedDays !== 'number' ||
    typeof timesheetReminderDays !== 'number'
  ) {
    return undefined
  }
  const days: TeamNotificationReminderSettings['days'] = {}
  for (const [field, count] of Object.entries(value.days)) {
    if (typeof count !== 'number') return undefined
    if (
      field === 'dueSoonDays' ||
      field === 'overdueReminderIntervalDays' ||
      field === 'overdueEscalationDays' ||
      field === 'staleStartedDays' ||
      field === 'timesheetReminderDays'
    ) {
      days[field] = count
    }
  }
  return {
    teamId,
    days,
    defaults: {
      dueSoonDays,
      overdueReminderIntervalDays,
      overdueEscalationDays,
      staleStartedDays,
      timesheetReminderDays,
    },
    revision,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    canManage,
  }
}

/**
 * Reads a string field from an untrusted object.
 *
 * @param value - Untrusted value.
 * @param field - Field name.
 * @returns The non-empty string, or undefined.
 */
function readStringField(value: unknown, field: string) {
  if (!isRecord(value)) return undefined
  const text = value[field]
  return typeof text === 'string' && text.trim() ? text : undefined
}

/**
 * Narrows an untrusted value to a plain object.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
