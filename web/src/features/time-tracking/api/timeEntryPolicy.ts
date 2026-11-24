import { readTeamTimeEntryPolicy, type TeamTimeEntryPolicy, type TeamTimeEntryPolicyRecord } from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isOptionalString, isRecord } from '../../../shared/api/jsonValidation'
import { createInvalidTimeTrackingResponseError, createTeamTimeTrackingUrl, requestTimeTrackingJson } from './timeTrackingRequest'

/** A Team's time entry checks with whether the signed-in member may change them. */
export type TeamTimeEntryPolicyView = {
  /** Saved policy, or the defaults at revision 0. */
  policy: TeamTimeEntryPolicyRecord
  /** Whether the member manages the whole Team and may save the policy. */
  canEdit: boolean
}

/** Fields of a policy update. */
export type SaveTeamTimeEntryPolicyInput = TeamTimeEntryPolicy & {
  /** Revision being replaced, or 0 while the Team uses the defaults. */
  expectedRevision: number
}

/**
 * Validates the policy response of the API.
 *
 * @param value - Unknown JSON value.
 * @returns The policy view, or undefined when the shape is invalid.
 */
export function readTeamTimeEntryPolicyView(value: unknown): TeamTimeEntryPolicyView | undefined {
  if (!isRecord(value) || typeof value.canEdit !== 'boolean' || !isRecord(value.policy)) return undefined
  const { teamId, revision, updatedAt } = value.policy
  const policy = readTeamTimeEntryPolicy(value.policy)
  if (!policy || typeof teamId !== 'string' || !isNonnegativeSafeInteger(revision) || !isOptionalString(updatedAt)) {
    return undefined
  }
  return {
    policy: { ...policy, teamId, revision, ...(updatedAt === undefined ? {} : { updatedAt }) },
    canEdit: value.canEdit,
  }
}

/**
 * Reads a Team's time entry checks.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team whose checks are read.
 * @returns The policy and whether the member may change it.
 */
export async function getTeamTimeEntryPolicy(accessToken: string, teamId: string): Promise<TeamTimeEntryPolicyView> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-entry-policy'), accessToken)
  const view = readTeamTimeEntryPolicyView(data)
  if (!view) throw createInvalidTimeTrackingResponseError('Time entry policy')
  return view
}

/**
 * Saves a Team's time entry checks.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team whose checks are saved.
 * @param input - Modes, daily limit, and the revision being replaced.
 * @returns The saved policy.
 */
export async function saveTeamTimeEntryPolicy(
  accessToken: string,
  teamId: string,
  input: SaveTeamTimeEntryPolicyInput,
): Promise<TeamTimeEntryPolicyView> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-entry-policy'), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      overlap: input.overlap,
      dailyLimit: input.dailyLimit,
      dailyLimitMinutes: input.dailyLimitMinutes,
      expectedRevision: input.expectedRevision,
    }),
  })
  const view = readTeamTimeEntryPolicyView(data)
  if (!view) throw createInvalidTimeTrackingResponseError('Time entry policy')
  return view
}
