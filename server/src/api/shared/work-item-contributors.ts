import { randomUUID } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type {
  ResolvedWorkItemConfiguration,
  WorkItemContributorAssignment,
} from '@mukuroji/contracts'
import { ProjectDataError, normalizeProjectMemberKey } from '../../modules/directory'
import {
  WorkItemContributorAssignmentError,
  listAddedContributorMembers,
  normalizeContributorAssignments,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workspaceDependencies } from './app-dependencies'
import { TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS } from './constants'
import { requireActiveWorkspaceAssignee } from './workspace-access'

/**
 * A validated contributor replacement and the commit-time fences it needs.
 */
export type ContributorAssignmentChange = {
  /** Normalized replacement list to store on the Work Item. */
  readonly contributorAssignments: WorkItemContributorAssignment[]
  /**
   * One active non-guest membership ConditionCheck per newly added member, committed with
   * the Work Item write so a member deactivated after validation is not assigned.
   */
  readonly memberConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/**
 * Work Item adapter input fields that carry a contributor change.
 */
export type ContributorAssignmentWriteFields = {
  /** Replacement contributor list; absent when the request does not change contributors. */
  contributorAssignments?: WorkItemContributorAssignment[]
  /** Caller authorization ConditionChecks including the contributor membership fences. */
  authorizationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/**
 * Reads and normalizes `contributorAssignments` from a Work Item create or update body.
 *
 * Every member newly added as a contributor must be an active non-guest Workspace
 * member, both now and when the Work Item write commits: the returned membership
 * ConditionChecks must be committed in the same transaction. Members who were already
 * contributors are not re-checked, so a later deactivation does not block unrelated edits.
 *
 * Job roles are validated against `resolvedConfiguration`; callers commit the
 * configuration guard built from the same resolved configuration, which fences a
 * concurrent configuration save that removes a role.
 *
 * @param directoryId - Workspace directory ID.
 * @param body - Configured create or update body.
 * @param resolvedConfiguration - Configuration that defines the available job roles.
 * @param existing - Contributors currently stored on the Work Item.
 * @returns The normalized replacement and its membership fences, or undefined when the body omits the field.
 * @throws ProjectDataError when the contributor list is invalid.
 * @throws WorkspaceAccessError when an added member is not an active non-guest member.
 */
export async function readContributorAssignmentChange(
  directoryId: string,
  body: { contributorAssignments?: unknown },
  resolvedConfiguration: ResolvedWorkItemConfiguration,
  existing: readonly WorkItemContributorAssignment[],
): Promise<ContributorAssignmentChange | undefined> {
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
  const memberConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = []
  for (let start = 0; start < addedMembers.length; start += CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY) {
    memberConditionChecks.push(...await Promise.all(
      addedMembers.slice(start, start + CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY)
        .map((memberUserId) => createContributorMemberConditionCheck(directoryId, memberUserId)),
    ))
  }
  return { contributorAssignments, memberConditionChecks }
}

/**
 * Builds the Work Item write fields for a contributor change.
 *
 * The membership fences are appended to the body's existing caller authorization
 * ConditionChecks so both commit in the Work Item transaction.
 *
 * @param body - Configured create or update body that may already carry authorization checks.
 * @param change - Contributor change read from the body, or undefined when it omits the field.
 * @returns Fields to spread into the adapter input; empty when contributors do not change.
 */
export function withContributorAssignmentChange(
  body: { authorizationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']> },
  change: ContributorAssignmentChange | undefined,
): ContributorAssignmentWriteFields {
  if (change === undefined) return {}
  return {
    contributorAssignments: change.contributorAssignments,
    ...(change.memberConditionChecks.length === 0
      ? {}
      : {
          authorizationConditionChecks: [
            ...(body.authorizationConditionChecks ?? []),
            ...change.memberConditionChecks,
          ],
        }),
  }
}

/**
 * Validates one newly added contributor and builds its commit-time membership fence.
 *
 * @param directoryId - Workspace directory ID.
 * @param memberUserId - Member being added as a contributor.
 * @returns A ConditionCheck requiring the member to stay active, non-guest, and unchanged.
 * @throws WorkspaceAccessError when the member is not an active non-guest member.
 * @throws ProjectDataError when membership fencing is unavailable.
 */
async function createContributorMemberConditionCheck(
  directoryId: string,
  memberUserId: string,
): Promise<NonNullable<TransactWriteCommandInput['TransactItems']>[number]> {
  await requireActiveWorkspaceAssignee(directoryId, memberUserId)
  const workspaceAccess = workspaceDependencies.workspaceAccess
  const createMemberCheck = workspaceAccess.createActiveMemberConditionCheck
  if (!createMemberCheck) {
    throw new ProjectDataError(
      503,
      'ContributorMembershipFenceUnavailable',
      'Contributor membership fencing is unavailable. Retry the request.',
    )
  }
  const conditionCheck = await createMemberCheck.call(
    workspaceAccess,
    directoryId,
    normalizeProjectMemberKey(memberUserId),
    TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
  )
  if (!conditionCheck) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceAssigneeInactive',
      'Only active non-guest Workspace members can be assigned.',
    )
  }
  return conditionCheck
}

/** Contributor member checks run at once; each makes a member and a profile lookup. */
const CONTRIBUTOR_MEMBER_CHECK_CONCURRENCY = 5
