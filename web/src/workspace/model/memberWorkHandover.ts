import type { BulkOperationRequest, CanonicalWorkItem } from '@mukuroji/contracts'

/** Largest number of Work Items one handover request can carry, as for any bulk operation. */
export const MEMBER_WORK_HANDOVER_BATCH_LIMIT = 100

/** One open Work Item a member still owns or contributes to. */
export type MemberWorkHandoverItem = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** Human-readable key, such as `PT-12`, when the Work Item has one. */
  key?: string
  /** Work Item title. */
  title: string
  /** Revision the handover expects, so a change made meanwhile is not overwritten. */
  revision: number
  /** Whether the member is the accountable owner. */
  owner: boolean
  /** Whether the member holds a contributor share that is not `done`. */
  contributor: boolean
}

/**
 * Lists the Work Items whose responsibility moves when a member hands over their work.
 *
 * A Work Item is listed when the member is its accountable owner or holds a contributor share
 * that is not `done`. A finished share stays with the member as the record of who did it, so a
 * Work Item where the member only has finished shares is not listed.
 *
 * @param workItems - Open Work Items already narrowed to the member by the server.
 * @param memberKey - Member whose work is handed over.
 * @returns The Work Items to hand over, in the order given.
 */
export function listMemberWorkHandoverItems(
  workItems: readonly CanonicalWorkItem[],
  memberKey: string,
): MemberWorkHandoverItem[] {
  const member = memberKey.trim().toLowerCase()
  return workItems.flatMap((workItem) => {
    const owner = workItem.assigneeUserId.trim().toLowerCase() === member
    const contributor = (workItem.contributorAssignments ?? []).some((assignment) =>
      assignment.memberUserId?.toLowerCase() === member && assignment.status !== 'done')
    if (!owner && !contributor) return []
    return [{
      teamId: workItem.teamId,
      workItemId: workItem.id,
      ...(workItem.key ? { key: workItem.key } : {}),
      title: workItem.title,
      revision: workItem.revision,
      owner,
      contributor,
    }]
  })
}

/**
 * Builds the bulk request that hands the listed Work Items from one member to another.
 *
 * At most {@link MEMBER_WORK_HANDOVER_BATCH_LIMIT} Work Items go into one request; the rest are
 * handed over by running the handover again.
 *
 * @param workspaceId - Workspace that scopes the request.
 * @param items - Work Items to hand over.
 * @param fromMemberKey - Member whose work moves.
 * @param toMemberKey - Active member who takes it over.
 * @returns The bulk reassignment request.
 */
export function createMemberWorkHandoverRequest(
  workspaceId: string,
  items: readonly MemberWorkHandoverItem[],
  fromMemberKey: string,
  toMemberKey: string,
): BulkOperationRequest {
  return {
    workspaceId,
    items: items.slice(0, MEMBER_WORK_HANDOVER_BATCH_LIMIT).map((item) => ({
      teamId: item.teamId,
      workItemId: item.workItemId,
      expectedRevision: item.revision,
    })),
    action: {
      type: 'reassign-member',
      fromMemberUserId: fromMemberKey.trim().toLowerCase(),
      toMemberUserId: toMemberKey.trim().toLowerCase(),
    },
  }
}
