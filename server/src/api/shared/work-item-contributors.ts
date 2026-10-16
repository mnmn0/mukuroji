import { randomUUID } from 'node:crypto'
import type {
  ResolvedWorkItemConfiguration,
  WorkItemContributorAssignment,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  WorkItemContributorAssignmentError,
  listAddedContributorMembers,
  normalizeContributorAssignments,
} from '../../modules/work-items'
import { requireActiveWorkspaceAssignee } from './workspace-access'

/**
 * Reads and normalizes `contributorAssignments` from a Work Item create or update body.
 *
 * Every member newly added as a contributor must be an active non-guest Workspace
 * member. Members who were already contributors are not re-checked, so a later
 * deactivation does not block unrelated edits.
 *
 * @param directoryId - Workspace directory ID.
 * @param body - Configured create or update body.
 * @param resolvedConfiguration - Configuration that defines the available job roles.
 * @param existing - Contributors currently stored on the Work Item.
 * @returns The normalized replacement list, or undefined when the body omits the field.
 * @throws ProjectDataError when the contributor list is invalid.
 */
export async function readContributorAssignmentChange(
  directoryId: string,
  body: { contributorAssignments?: unknown },
  resolvedConfiguration: ResolvedWorkItemConfiguration,
  existing: readonly WorkItemContributorAssignment[],
): Promise<WorkItemContributorAssignment[] | undefined> {
  if (!('contributorAssignments' in body)) {
    return undefined
  }
  let contributorAssignments: WorkItemContributorAssignment[]
  try {
    contributorAssignments = normalizeContributorAssignments(body.contributorAssignments, {
      jobRoles: resolvedConfiguration.configuration.jobRoles ?? [],
      existing,
      createAssignmentId: () => randomUUID().replaceAll('-', ''),
    })
  } catch (error) {
    if (error instanceof WorkItemContributorAssignmentError) {
      throw new ProjectDataError(400, error.code, error.message)
    }
    throw error
  }
  // Members are independent, so they are checked a few at a time instead of one by one.
  const addedMembers = listAddedContributorMembers(contributorAssignments, existing)
  for (let start = 0; start < addedMembers.length; start += CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY) {
    await Promise.all(addedMembers.slice(start, start + CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY)
      .map((memberUserId) => requireActiveWorkspaceAssignee(directoryId, memberUserId)))
  }
  return contributorAssignments
}

/** Contributor member checks run at once; each makes a member and a profile lookup. */
const CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY = 5
