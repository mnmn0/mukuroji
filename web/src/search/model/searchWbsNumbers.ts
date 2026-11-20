import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import { createWorkItemOutlineKey } from '../../work-items/model/workItemHierarchy'

/** Prefix of the search identity of a Work Item: `team/<Team ID>/issue/<Work Item ID>`. */
const workItemIdentityPrefix = 'team/'

/** Separator between the Team ID and the Work Item ID in a Work Item search identity. */
const workItemIdentitySeparator = '/issue/'

/**
 * Reads the Team and Work Item IDs of a Work Item search result.
 *
 * The identity is `team/<Team ID>/issue/<Work Item ID>`; a Team ID never contains `/`, so the
 * first `/` after `team/` ends it even when the Work Item ID contains `/` or `/issue/`.
 *
 * @param result - Search result.
 * @returns The Team and Work Item IDs, or `undefined` for another entity or an unknown identity.
 */
export function readSearchWorkItemIdentity(
  result: WorkspaceSearchResult,
): { teamId: string, workItemId: string } | undefined {
  if (result.entityType !== 'work-item' || !result.id.startsWith(workItemIdentityPrefix)) return undefined
  const rest = result.id.slice(workItemIdentityPrefix.length)
  const separatorIndex = rest.indexOf('/')
  if (separatorIndex <= 0 || !rest.startsWith(workItemIdentitySeparator, separatorIndex)) return undefined
  const teamId = rest.slice(0, separatorIndex)
  const workItemId = rest.slice(separatorIndex + workItemIdentitySeparator.length)
  if (!workItemId || (result.teamId !== undefined && result.teamId !== teamId)) return undefined
  return { teamId, workItemId }
}

/**
 * Looks up the WBS number of a Work Item search result.
 *
 * @param result - Search result.
 * @param wbsNumbers - WBS numbers by `createWorkItemOutlineKey` key.
 * @returns The WBS number, or `undefined` for another entity or a Work Item outside the read trees.
 */
export function resolveSearchResultWbsNumber(
  result: WorkspaceSearchResult,
  wbsNumbers: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!wbsNumbers) return undefined
  const identity = readSearchWorkItemIdentity(result)
  return identity ? wbsNumbers.get(createWorkItemOutlineKey(identity.teamId, identity.workItemId)) : undefined
}
