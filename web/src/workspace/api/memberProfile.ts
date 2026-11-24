import type {
  MemberProfile,
  UpdateMemberDisplayNameRequest,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { isNonnegativeSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from './errors'

export type { MemberProfile, UpdateMemberDisplayNameRequest }

const memberProfileUrl = `${resolveApiBaseUrl('projects')}/me/profile`

/**
 * Loads the signed-in member's own profile.
 *
 * @param accessToken - Cognito access token.
 * @returns The profile with the member version a name change sends.
 */
export async function getMemberProfile(accessToken: string): Promise<MemberProfile> {
  const response = await fetch(memberProfileUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return readMemberProfileResponse(response)
}

/**
 * Changes the signed-in member's own display name.
 *
 * @param accessToken - Cognito access token.
 * @param input - New name (null removes it) and the member version it was read at.
 * @param mutationContext - Idempotency context of the request.
 * @returns The updated profile.
 */
export async function updateMemberProfile(
  accessToken: string,
  input: UpdateMemberDisplayNameRequest,
  mutationContext: MutationRequestContext,
): Promise<MemberProfile> {
  const response = await fetch(memberProfileUrl, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'PUT',
  })
  return readMemberProfileResponse(response)
}

/**
 * Checks whether a value is a member profile.
 *
 * @param value - Parsed value.
 * @returns Whether every field holds the expected type.
 */
export function isMemberProfile(value: unknown): value is MemberProfile {
  return isRecord(value) &&
    typeof value.memberKey === 'string' &&
    typeof value.email === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    typeof value.nameEditable === 'boolean' &&
    isNonnegativeSafeInteger(value.version)
}

/**
 * Reads a profile response, turning failures into a typed API error.
 *
 * @param response - Fetch response from the profile endpoint.
 * @returns The validated profile.
 */
async function readMemberProfileResponse(response: Response): Promise<MemberProfile> {
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code = isRecord(data) && typeof data.code === 'string' ? data.code : undefined
    throw new WorkspaceAccessApiError(response.status, 'Member profile request failed.', code)
  }
  const profile = isRecord(data) ? data.profile : undefined
  if (!isMemberProfile(profile)) {
    throw new WorkspaceAccessApiError(response.status, 'Member profile response is invalid.')
  }
  return profile
}
