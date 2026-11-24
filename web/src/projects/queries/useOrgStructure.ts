import type { OrgStructure } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getOrgStructure } from '../api/orgStructure'
import { ProjectDirectoryApiError } from '../api/errors'

/** First element of the OrgUnit structure query key. */
const orgStructureKeyPrefix = 'org-structure'

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
 * has no OrgUnits and offer a retry.
 *
 * @param accessToken - Bearer token.
 * @returns The structure, or an empty one when the reader may not see it.
 * @throws The read error for anything other than a refusal.
 */
export async function readOrgStructureForDisplay(accessToken: string): Promise<OrgStructure> {
  try {
    return await getOrgStructure(accessToken)
  } catch (error) {
    if (error instanceof ProjectDirectoryApiError && error.status === 403) return emptyOrgStructure
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
 * @returns The SWR state of the structure.
 */
export function useOrgStructure(accessToken: string | undefined) {
  return useSWR(
    accessToken ? [orgStructureKeyPrefix, accessToken] as const : null,
    async ([, token]) => await readOrgStructureForDisplay(token),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
