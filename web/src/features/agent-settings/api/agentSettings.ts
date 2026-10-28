import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentSettings,
  type UpdateAgentSettingsRequest,
} from '@mukuroji/contracts'
import {
  isNonnegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
} from '../../../shared/api/jsonValidation'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import { AgentSettingsApiError } from './errors'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '')

/**
 * Reads the Agent settings of one Team. Project briefs are limited to Projects the caller can view.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team whose settings are read.
 * @returns Validated settings; revision `0` means the defaults were never saved.
 */
export async function getTeamAgentSettings(
  accessToken: string,
  teamId: string,
): Promise<AgentSettings> {
  const data = await requestJson(createAgentSettingsPath(teamId), accessToken)
  return requireAgentSettings(data, teamId)
}

/**
 * Replaces the Agent settings of one Team. Omitted optional fields are cleared, and the save is
 * rejected with `409` when `expectedRevision` is no longer the saved revision.
 *
 * @param accessToken - Session access token of a Team manager.
 * @param teamId - Team whose settings are replaced.
 * @param input - Complete, revision-fenced replacement.
 * @param mutationContext - Idempotency and correlation identifiers shared by retries of this save.
 * @returns The saved settings as the server returned them.
 */
export async function updateTeamAgentSettings(
  accessToken: string,
  teamId: string,
  input: UpdateAgentSettingsRequest,
  mutationContext: MutationRequestContext,
): Promise<AgentSettings> {
  const data = await requestJson(createAgentSettingsPath(teamId), accessToken, {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'PUT',
  })
  return requireAgentSettings(data, teamId)
}

/**
 * Validates Agent settings read from an untrusted response.
 *
 * @param value - Unknown JSON value.
 * @returns The settings, or undefined when the shape is not supported.
 */
export function readAgentSettings(value: unknown): AgentSettings | undefined {
  if (!isRecord(value) || value.schemaVersion !== AGENT_SETTINGS_SCHEMA_VERSION) return undefined
  const {
    acceptanceCriteriaFieldId,
    allowTakeoverAfterLeaseExpiry,
    brief,
    fileFailedRunsToTriage,
    fileStalledRunsToTriage,
    leaseMinutes,
    readyStatusIds,
    requireAcceptanceCriteria,
    revision,
    teamId,
    updatedAt,
    updatedBy,
  } = value
  const projectBriefs = readProjectBriefs(value.projectBriefs)
  if (
    !isNonEmptyString(teamId) ||
    !isNonnegativeSafeInteger(revision) ||
    !isPositiveSafeInteger(leaseMinutes) ||
    typeof allowTakeoverAfterLeaseExpiry !== 'boolean' ||
    !Array.isArray(readyStatusIds) ||
    !readyStatusIds.every(isNonEmptyString) ||
    typeof requireAcceptanceCriteria !== 'boolean' ||
    // Servers older than Triage filing omit the flags, which then read as off.
    (fileFailedRunsToTriage !== undefined && typeof fileFailedRunsToTriage !== 'boolean') ||
    (fileStalledRunsToTriage !== undefined && typeof fileStalledRunsToTriage !== 'boolean') ||
    (acceptanceCriteriaFieldId !== undefined && !isNonEmptyString(acceptanceCriteriaFieldId)) ||
    (brief !== undefined && typeof brief !== 'string') ||
    !projectBriefs ||
    (updatedAt !== undefined && !(isNonEmptyString(updatedAt) && Number.isFinite(Date.parse(updatedAt)))) ||
    (updatedBy !== undefined && !isNonEmptyString(updatedBy))
  ) {
    return undefined
  }
  return {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    teamId,
    revision,
    leaseMinutes,
    allowTakeoverAfterLeaseExpiry,
    readyStatusIds: [...readyStatusIds],
    requireAcceptanceCriteria,
    ...(acceptanceCriteriaFieldId === undefined ? {} : { acceptanceCriteriaFieldId }),
    ...(brief === undefined ? {} : { brief }),
    projectBriefs,
    fileFailedRunsToTriage: fileFailedRunsToTriage === true,
    fileStalledRunsToTriage: fileStalledRunsToTriage === true,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  }
}

/**
 * Validates a response body and checks that it belongs to the requested Team.
 *
 * @param data - Parsed response body.
 * @param teamId - Team that was requested.
 * @returns Validated settings.
 */
function requireAgentSettings(data: unknown, teamId: string): AgentSettings {
  const settings = readAgentSettings(data)
  if (!settings || settings.teamId !== teamId) {
    throw new AgentSettingsApiError(502, 'Agent settings returned an unexpected response.')
  }
  return settings
}

/**
 * Validates the map of Project briefs.
 *
 * @param value - Unknown JSON value.
 * @returns Briefs keyed by Project ID, or undefined when the shape is not supported.
 */
function readProjectBriefs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([projectId, brief]) => projectId !== '' && typeof brief === 'string')) return undefined
  // Built as own properties, so a Project ID such as `__proto__` stays an ordinary entry.
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Returns whether a value is a non-empty string.
 *
 * @param value - Unknown value.
 * @returns Whether the value is a string with at least one character.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Builds the Web API path of a Team's Agent settings.
 *
 * @param teamId - Team ID.
 * @returns Request URL.
 */
function createAgentSettingsPath(teamId: string): string {
  return `${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-settings`
}

/**
 * Sends an authenticated request and converts failures to {@link AgentSettingsApiError}.
 *
 * @param path - Request URL.
 * @param accessToken - Session access token.
 * @param init - Request options.
 * @returns Parsed JSON body.
 */
async function requestJson(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message = isRecord(data) && typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : 'Unable to complete the Agent settings request.'
    throw new AgentSettingsApiError(
      response.status,
      message,
      isRecord(data) && typeof data.code === 'string' ? data.code : undefined,
    )
  }
  return data
}
