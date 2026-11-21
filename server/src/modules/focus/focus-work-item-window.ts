import type { CanonicalWorkItem } from '@mukuroji/contracts'
import type { WorkItemMemberIndexReference } from '../work-items'
import type { FocusRelationGraphSource } from './focus-queue'

/** Most Work Items one Focus projection reads by reference; the aggregate read limit (ADR 0038). */
export const FOCUS_WORK_ITEM_REFERENCE_LIMIT = 10_000

/** Most member index rows read for the viewer's owned and contributed Work Items. */
export const FOCUS_MEMBER_INDEX_LIMIT = 5_000

/** A Focus source item that may point at one Work Item. */
export type FocusWorkItemSourceReference = {
  /** Team of the Work Item the source points at. */
  readonly teamId?: string
  /** Team-local ID of the Work Item the source points at. */
  readonly issueId?: string
}

/** One Planning Work Item dependency; both endpoints may need to be read. */
export type FocusPlanningDependencyReference = {
  /** Work Item that must finish first. */
  readonly predecessor: WorkItemMemberIndexReference
  /** Work Item that waits for the predecessor. */
  readonly successor: WorkItemMemberIndexReference
}

/** Reads the Focus Work Item window needs, injected by the composition root or route. */
export type FocusWorkItemWindowPorts<
  TNotification extends FocusWorkItemSourceReference,
  TApproval extends FocusWorkItemSourceReference,
> = {
  /** Teams the viewer may read, in a stable order. */
  readonly readableTeamIds: readonly string[]
  /** Mention notifications already being read for the projection. */
  readonly notifications: Promise<readonly TNotification[]>
  /** Reviewer approval window already being read for the projection. */
  readonly reviewerApprovals: Promise<readonly TApproval[]>
  /**
   * Lists the viewer's owned and contributed Work Items from the member index; absent when the
   * store has no index, which selects the complete read.
   */
  readonly listMemberWorkItemReferences?: (limit: number) => Promise<readonly WorkItemMemberIndexReference[]>
  /** Strongly reads canonical Work Items by reference; absent when the store cannot. */
  readonly readWorkItemsByReferences?: (
    references: readonly WorkItemMemberIndexReference[],
  ) => Promise<readonly CanonicalWorkItem[]>
  /** Reads every accessible, non-archived Work Item; used only when a reference read is absent. */
  readonly readAllAccessibleWorkItems: () => Promise<readonly CanonicalWorkItem[]>
  /** Reads the unfiltered relation graph of each Team. */
  readonly readRelationGraphs: (teamIds: readonly string[]) => Promise<readonly FocusRelationGraphSource[]>
  /** Reads the Workspace's Planning Work Item dependencies. */
  readonly readPlanningDependencies: () => Promise<readonly FocusPlanningDependencyReference[]>
  /** Keeps the rows of one Team that the viewer may read, with the same check as the full read. */
  readonly filterAccessibleTeamWorkItems: (
    teamId: string,
    workItems: readonly CanonicalWorkItem[],
  ) => readonly CanonicalWorkItem[]
  /** Creates the error raised when Focus would need more Work Items than it reads. */
  readonly createLimitExceededError: (limit: number) => Error
}

/** Work Items and their sources read for one Focus projection, before source filtering. */
export type FocusWorkItemWindow<TNotification, TApproval> = {
  /** Access-filtered, non-archived canonical Work Items the projection may need. */
  readonly workItems: CanonicalWorkItem[]
  /** Unfiltered relation graphs of the Teams read. */
  readonly relationGraphs: FocusRelationGraphSource[]
  /** Mention notifications read for the projection. */
  readonly notifications: TNotification[]
  /** Reviewer approval candidates read for the projection. */
  readonly reviewerApprovals: TApproval[]
}

/**
 * Reads only the Work Items a Focus projection can use (ADR 0038).
 *
 * Those are the viewer's owned and contributed Work Items from the member index, the targets of
 * mention notifications and reviewer approvals, and both endpoints of every `blockedBy` relation
 * and Planning Work Item dependency in a readable Team. Every Work Item is read again from its
 * canonical row, archived ones are dropped, and each Team's rows go through the same access check
 * as the complete read, so the queue and the blocked count do not change.
 *
 * Falls back to the complete accessible read when the store has no reference reads.
 *
 * @param ports - Source reads and the access check.
 * @returns Work Items, relation graphs, and the source items they were selected from.
 */
export async function readFocusWorkItemWindow<
  TNotification extends FocusWorkItemSourceReference,
  TApproval extends FocusWorkItemSourceReference,
>(
  ports: FocusWorkItemWindowPorts<TNotification, TApproval>,
): Promise<FocusWorkItemWindow<TNotification, TApproval>> {
  const { listMemberWorkItemReferences, readWorkItemsByReferences } = ports
  if (listMemberWorkItemReferences === undefined || readWorkItemsByReferences === undefined) {
    const workItems = [...await ports.readAllAccessibleWorkItems()]
    const teamIds = [...new Set(workItems.map((workItem) => workItem.teamId))]
    const [relationGraphs, notifications, reviewerApprovals] = await Promise.all([
      ports.readRelationGraphs(teamIds),
      ports.notifications,
      ports.reviewerApprovals,
    ])
    return {
      workItems,
      relationGraphs: [...relationGraphs],
      notifications: [...notifications],
      reviewerApprovals: [...reviewerApprovals],
    }
  }
  const readableTeamIds = new Set(ports.readableTeamIds)
  const [memberReferences, relationGraphs, planningDependencies, notifications, reviewerApprovals] =
    await Promise.all([
      listMemberWorkItemReferences(FOCUS_MEMBER_INDEX_LIMIT),
      ports.readRelationGraphs([...readableTeamIds]),
      ports.readPlanningDependencies(),
      ports.notifications,
      ports.reviewerApprovals,
    ])
  const references = new Map<string, WorkItemMemberIndexReference>()
  /**
   * Adds one Work Item reference when its Team is readable.
   *
   * @param teamId - Team of the Work Item.
   * @param workItemId - Team-local Work Item ID.
   */
  const addReference = (teamId: string | undefined, workItemId: string | undefined) => {
    if (teamId === undefined || workItemId === undefined || workItemId.length === 0) return
    if (!readableTeamIds.has(teamId)) return
    references.set(JSON.stringify([teamId, workItemId]), { teamId, workItemId })
  }
  for (const reference of memberReferences) addReference(reference.teamId, reference.workItemId)
  for (const notification of notifications) addReference(notification.teamId, notification.issueId)
  for (const approval of reviewerApprovals) addReference(approval.teamId, approval.issueId)
  for (const graph of relationGraphs) {
    for (const relation of graph.relations) {
      if (relation.type !== 'blockedBy') continue
      addReference(graph.teamId, relation.sourceWorkItemId)
      addReference(graph.teamId, relation.targetWorkItemId)
    }
  }
  for (const dependency of planningDependencies) {
    addReference(dependency.predecessor.teamId, dependency.predecessor.workItemId)
    addReference(dependency.successor.teamId, dependency.successor.workItemId)
  }
  if (references.size > FOCUS_WORK_ITEM_REFERENCE_LIMIT) {
    throw ports.createLimitExceededError(FOCUS_WORK_ITEM_REFERENCE_LIMIT)
  }
  const rows = await readWorkItemsByReferences([...references.values()])
  const rowsByTeamId = new Map<string, CanonicalWorkItem[]>()
  for (const row of rows) {
    if (row.archivedAt !== undefined || !readableTeamIds.has(row.teamId)) continue
    const teamRows = rowsByTeamId.get(row.teamId) ?? []
    teamRows.push(row)
    rowsByTeamId.set(row.teamId, teamRows)
  }
  const workItems = ports.readableTeamIds.flatMap((teamId) =>
    ports.filterAccessibleTeamWorkItems(teamId, rowsByTeamId.get(teamId) ?? [])
  )
  return {
    workItems,
    relationGraphs: [...relationGraphs],
    notifications: [...notifications],
    reviewerApprovals: [...reviewerApprovals],
  }
}
