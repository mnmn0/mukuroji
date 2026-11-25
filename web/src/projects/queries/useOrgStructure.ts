import type { OrgStructure } from '@mukuroji/contracts'
import useSWR from 'swr'
import { resolveEnterpriseSessionErrorAction } from '../../auth/enterpriseSessionErrors'
import { getOrgStructure } from '../api/orgStructure'
import { ProjectDirectoryApiError } from '../api/errors'

/** First element of the OrgUnit structure query key. */
const orgStructureKeyPrefix = 'org-structure'

/** Reports an authenticated request's session failure to the shared session flow and rethrows it. */
export type OrgStructureRequestGuard = <Result>(request: Promise<Result>) => Promise<Result>

/** Structure of a Workspace without OrgUnits, which every screen shows as before. */
const emptyOrgStructure: OrgStructure = { orgUnits: [], teamAssignments: [], revision: 0 }

/**
 * Tells whether an SWR key belongs to the OrgUnit structure query.
 *
 * @param key - SWR cache key.
 * @returns Whether the key is an OrgUnit structure key.
 */
export function isOrgStructureKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === orgStructureKeyPrefix
}

/**
 * Reads the OrgUnit structure for the screens that group by OrgUnit.
 *
 * A member who may not read the structure, such as a guest, sees the Workspace as having no
 * OrgUnits. Any other failure is rethrown, so a screen can tell it apart from a Workspace that
 * has no OrgUnits and offer a retry. A 403 from the Enterprise session policy, such as an idle
 * timeout or a denied IP, is rethrown too, so it reaches the sign-in or recovery flow.
 *
 * @param accessToken - Bearer token.
 * @param guardRequest - Optional session guard that reports a failure it rethrows; a refusal of
 * the structure itself never reaches it.
 * @returns The structure, or an empty one when the reader may not see it.
 * @throws The read error for anything other than a refusal of the structure itself.
 */
export async function readOrgStructureForDisplay(
  accessToken: string,
  guardRequest?: OrgStructureRequestGuard,
): Promise<OrgStructure> {
  const request = readOrgStructureOrRefusal(accessToken)
  const result = await (guardRequest ? guardRequest(request) : request)
  return result ?? emptyOrgStructure
}

/**
 * Reads the structure, answering a refusal of the structure itself with nothing.
 *
 * @param accessToken - Bearer token.
 * @returns The structure, or undefined when the reader may not see it.
 * @throws The read error for anything other than a refusal of the structure itself.
 */
async function readOrgStructureOrRefusal(accessToken: string): Promise<OrgStructure | undefined> {
  try {
    return await getOrgStructure(accessToken)
  } catch (error) {
    if (
      error instanceof ProjectDirectoryApiError &&
      error.status === 403 &&
      resolveEnterpriseSessionErrorAction(error, '/').kind === 'stay'
    ) {
      return undefined
    }
    throw error
  }
}

/**
 * Loads the OrgUnit tree and Team memberships of the Workspace.
 *
 * A member who may not read the structure, such as a guest, sees the Workspace as having no
 * OrgUnits, so the screens that group by OrgUnit stay as they were. Other failures stay in
 * `error` for the screen to show with a retry.
 *
 * @param accessToken - Bearer token; nothing is read without it.
 * @param guardRequest - Optional session guard, so a sign-in or IP policy failure reaches the
 * shared re-authentication or recovery flow on screens that do not report errors themselves.
 * @returns The SWR state of the structure.
 */
export function useOrgStructure(accessToken: string | undefined, guardRequest?: OrgStructureRequestGuard) {
  return useSWR(
    accessToken ? [orgStructureKeyPrefix, accessToken] as const : null,
    async ([, token]) => await readOrgStructureForDisplay(token, guardRequest),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
