import { randomUUID } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type {
  PublicWorkItemWebLink,
  PublicWorkItemWebLinkList,
  PublicWorkItemWebLinkMutation,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import {
  addWorkItemWebLink,
  createWorkItemRevisionConditionCheck,
  currentWorkItemWebLinks,
  removeWorkItemWebLink,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { workItemDependencies } from './app-dependencies'
import { createPlanningCallerAuthorizationConditionChecks } from './planning-access'
import { requireWorkspaceBusinessWrite, type WorkspacePrincipal } from './project-access'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from './work-item-access'

/** Times a link write reads again after another write to the Work Item or its links committed first. */
const WEB_LINK_CONFLICT_ATTEMPTS = 3

/** Transaction item committed with a link write, such as an idempotency receipt. */
type WebLinkCoWrite = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * Builds the writes committed with a link change, given the response the change returns.
 * The Public API uses it for the idempotency receipt; Web routes pass none.
 */
export type WorkItemWebLinkCoWrites = (response: PublicWorkItemWebLinkMutation) => Promise<readonly WebLinkCoWrite[]>

/** A validated link to add, before the server gives it an ID. */
export type NewWorkItemWebLink = {
  /** Normalized `http` or `https` URL. */
  url: string
  /** Trimmed title, when one was given. */
  title?: string
}

/**
 * Tells whether an error is a lost race on the Work Item, its links, or the caller's member row.
 *
 * @param error - Error raised by the link store.
 * @returns Whether reading again and retrying can succeed.
 */
function isRetryableConflict(error: unknown) {
  return error instanceof ProjectDataError && error.code === 'WorkItemWebLinkConflict'
}

/**
 * Lists the links of a Work Item the principal can view.
 *
 * @param principal - Caller with current permissions.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The links, oldest first.
 */
export async function listWorkItemWebLinks(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<PublicWorkItemWebLinkList> {
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const state = await workItemDependencies.workItemWebLinks.get(principal.directoryId, teamId, workItemId)
  return {
    schemaVersion: 1,
    teamId: detail.issue.teamId,
    workItemId: detail.issue.id,
    items: currentWorkItemWebLinks(state, detail.issue.createdAt).links,
  }
}

/**
 * Checks that the principal may change the links of a Work Item, without changing anything. An
 * idempotent replay calls it before returning the stored response.
 *
 * @param principal - Caller with current permissions.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 */
export async function authorizeWorkItemWebLinkChange(principal: WorkspacePrincipal, teamId: string, workItemId: string) {
  requireWorkspaceBusinessWrite(principal)
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
}

/**
 * Applies one change to a Work Item's links. Each attempt reads the Work Item and the links again,
 * checks member access, and commits only while the Work Item revision, the link revision, and the
 * caller's member row are still the ones read.
 *
 * @param principal - Caller with current permissions.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @param auditContext - Request audit context.
 * @param change - Builds the new list and the changed link from the current list.
 * @param coWrites - Builds writes committed with the change, such as an idempotency receipt.
 * @returns The changed link.
 */
async function changeWorkItemWebLinks(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  auditContext: MutationAuditContext,
  change: (links: readonly PublicWorkItemWebLink[], issue: TeamIssueResponseItem) => {
    kind: 'added' | 'removed'
    link: PublicWorkItemWebLink
    links: PublicWorkItemWebLink[]
  },
  coWrites?: WorkItemWebLinkCoWrites,
): Promise<PublicWorkItemWebLinkMutation> {
  requireWorkspaceBusinessWrite(principal)
  // The write commits only while the caller's member row, and any enterprise role source, still
  // match what authorized it.
  const callerChecks = createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account')
  for (let attempt = 1; ; attempt += 1) {
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    const issue = detail.issue
    const state = await workItemDependencies.workItemWebLinks.get(principal.directoryId, teamId, workItemId)
    const current = currentWorkItemWebLinks(state, issue.createdAt)
    const changed = change(current.links, issue)
    const response: PublicWorkItemWebLinkMutation = { schemaVersion: 1, teamId, workItemId, link: changed.link }
    try {
      await workItemDependencies.workItemWebLinks.write({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
        workItemCreatedAt: issue.createdAt,
        expectedRevision: current.revision,
        links: changed.links,
        change: { kind: changed.kind, link: changed.link },
        writtenAt: new Date().toISOString(),
        // The Work Item revision pins its Project, so a move to a Project the caller cannot edit,
        // or a deletion, after the check cannot let the link through.
        conditionChecks: [
          createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, workItemId, issue.revision),
          ...callerChecks,
          ...(coWrites ? await coWrites(response) : []),
        ],
        auditContext,
      })
      return response
    } catch (error) {
      if (attempt >= WEB_LINK_CONFLICT_ATTEMPTS || !isRetryableConflict(error)) throw error
    }
  }
}

/**
 * Adds a link to a Work Item the principal can edit.
 *
 * @param principal - Caller with current permissions.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @param input - Validated URL and title.
 * @param auditContext - Request audit context.
 * @param coWrites - Builds writes committed with the change, such as an idempotency receipt.
 * @returns The added link.
 */
export function createWorkItemWebLink(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  input: NewWorkItemWebLink,
  auditContext: MutationAuditContext,
  coWrites?: WorkItemWebLinkCoWrites,
): Promise<PublicWorkItemWebLinkMutation> {
  const link: PublicWorkItemWebLink = {
    id: randomUUID().replaceAll('-', ''),
    url: input.url,
    ...(input.title === undefined ? {} : { title: input.title }),
    createdByMemberId: principal.userKey,
    createdAt: new Date().toISOString(),
  }
  return changeWorkItemWebLinks(principal, teamId, workItemId, auditContext, (links) => ({
    kind: 'added',
    link,
    links: addWorkItemWebLink(links, link),
  }), coWrites)
}

/**
 * Removes a link from a Work Item the principal can edit.
 *
 * @param principal - Caller with current permissions.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @param linkId - Link to remove.
 * @param auditContext - Request audit context.
 * @param coWrites - Builds writes committed with the change, such as an idempotency receipt.
 * @returns The removed link.
 */
export function deleteWorkItemWebLink(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  linkId: string,
  auditContext: MutationAuditContext,
  coWrites?: WorkItemWebLinkCoWrites,
): Promise<PublicWorkItemWebLinkMutation> {
  return changeWorkItemWebLinks(principal, teamId, workItemId, auditContext, (links) => {
    const { removed, links: remaining } = removeWorkItemWebLink(links, linkId)
    return { kind: 'removed', link: removed, links: remaining }
  }, coWrites)
}
