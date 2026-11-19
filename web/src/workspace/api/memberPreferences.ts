import {
  MEMBER_PREFERENCE_FONT_SIZES,
  MEMBER_PREFERENCE_LOCALES,
  MEMBER_PREFERENCE_THEMES,
  type MemberPreferences,
  type UpdateMemberPreferencesInput,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { isNonnegativeSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import {
  createMutationHeaders,
  createMutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from './errors'

export type { MemberPreferences, UpdateMemberPreferencesInput }

const memberPreferencesUrl = `${resolveApiBaseUrl('projects')}/me/preferences`

/**
 * Loads the signed-in member's display preferences saved on the server.
 *
 * @param accessToken - Cognito access token.
 * @returns The saved preferences; revision 0 means nothing is saved yet.
 */
export async function getMemberPreferences(accessToken: string): Promise<MemberPreferences> {
  const response = await fetch(memberPreferencesUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return readMemberPreferencesResponse(response)
}

/**
 * Replaces the signed-in member's complete display preferences.
 *
 * @param accessToken - Cognito access token.
 * @param input - Complete next preferences and the revision they were read at.
 * @returns The saved preferences with their next revision.
 */
export async function replaceMemberPreferences(
  accessToken: string,
  input: UpdateMemberPreferencesInput,
): Promise<MemberPreferences> {
  const response = await fetch(memberPreferencesUrl, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(createMutationRequestContext()),
    },
    method: 'PUT',
  })
  return readMemberPreferencesResponse(response)
}

/**
 * Checks whether a response body is a valid preference payload.
 *
 * @param value - Parsed response body.
 * @returns Whether every present field holds a supported value.
 */
export function isMemberPreferences(value: unknown): value is MemberPreferences {
  return isRecord(value) &&
    isNonnegativeSafeInteger(value.revision) &&
    (value.locale === undefined || MEMBER_PREFERENCE_LOCALES.some((locale) => locale === value.locale)) &&
    (value.theme === undefined || MEMBER_PREFERENCE_THEMES.some((theme) => theme === value.theme)) &&
    (value.fontSize === undefined ||
      MEMBER_PREFERENCE_FONT_SIZES.some((fontSize) => fontSize === value.fontSize)) &&
    (value.timeZone === undefined || typeof value.timeZone === 'string')
}

/**
 * Reads a preference response, turning failures into a typed API error.
 *
 * @param response - Fetch response from the preference endpoint.
 * @returns The validated preferences.
 */
async function readMemberPreferencesResponse(response: Response): Promise<MemberPreferences> {
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code = isRecord(data) && typeof data.code === 'string' ? data.code : undefined
    throw new WorkspaceAccessApiError(response.status, 'Member preferences request failed.', code)
  }
  if (!isMemberPreferences(data)) {
    throw new WorkspaceAccessApiError(response.status, 'Member preferences response is invalid.')
  }
  return data
}
