import {
  WORK_ITEM_WEB_LINK_LIMIT,
  type PublicWorkItemWebLink,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'

/** Web links stored for one Work Item, with the revision that orders their writes. */
export type WorkItemWebLinkState = {
  /** Revision of the stored links; 0 when nothing is stored yet. */
  revision: number
  /**
   * Creation time of the Work Item the links were saved for. A Work Item deleted and created again
   * with the same ID has another creation time, so the old links never show on the new one.
   */
  workItemCreatedAt: string
  /** Links, oldest first. */
  links: PublicWorkItemWebLink[]
}

/** One change of a Work Item's web links, which the audit event names. */
export type WorkItemWebLinkChange = {
  /** Whether a link was added or removed. */
  kind: 'added' | 'removed'
  /** The link that was added or removed. */
  link: PublicWorkItemWebLink
}

/** Write of a Work Item's whole link list with a compare-and-set on its revision. */
export type WriteWorkItemWebLinksInput<TCheck, TAuditContext> = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose links are written. */
  workItemId: string
  /** Creation time of the Work Item, stored with the links. */
  workItemCreatedAt: string
  /** Revision read before the write, or 0 when no row was stored. */
  expectedRevision: number
  /** Complete link list after the change, oldest first. */
  links: PublicWorkItemWebLink[]
  /** The change, for the audit event. */
  change: WorkItemWebLinkChange
  /** ISO timestamp of the write. */
  writtenAt: string
  /** Server-built checks that fail the write when the Work Item or the caller's access changed. */
  conditionChecks: readonly TCheck[]
  /** Request audit context; the store records the change in the same transaction. */
  auditContext: TAuditContext
}

/** Persistence port of the web links of each Work Item. */
export type WorkItemWebLinkStore<TCheck, TAuditContext> = {
  /**
   * Reads the stored links of a Work Item with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The stored state, or `null` when no link was ever saved.
   */
  get(workspaceId: string, teamId: string, workItemId: string): Promise<WorkItemWebLinkState | null>
  /**
   * Replaces the link list when its revision is still the expected one.
   *
   * @param input - Write input.
   * @returns The stored state.
   */
  write(input: WriteWorkItemWebLinksInput<TCheck, TAuditContext>): Promise<WorkItemWebLinkState>
}

/**
 * Reads the links that belong to the current Work Item: links saved for an earlier Work Item with
 * the same ID are left out, while their revision is kept so a write replaces that row.
 *
 * @param state - Stored state, or `null`.
 * @param workItemCreatedAt - Creation time of the current Work Item.
 * @returns The revision to write against and the current links.
 */
export function currentWorkItemWebLinks(
  state: WorkItemWebLinkState | null,
  workItemCreatedAt: string,
): { revision: number, links: PublicWorkItemWebLink[] } {
  if (state === null) return { revision: 0, links: [] }
  return { revision: state.revision, links: state.workItemCreatedAt === workItemCreatedAt ? state.links : [] }
}

/**
 * Adds a link to the end of a list, refusing a URL that is already linked and a full list.
 *
 * @param links - Current links.
 * @param link - Link to add.
 * @returns The new list.
 */
export function addWorkItemWebLink(links: readonly PublicWorkItemWebLink[], link: PublicWorkItemWebLink): PublicWorkItemWebLink[] {
  if (links.some((existing) => existing.url === link.url)) {
    throw new ProjectDataError(409, 'WorkItemWebLinkDuplicate', 'This URL is already linked to the Work Item.')
  }
  if (links.length >= WORK_ITEM_WEB_LINK_LIMIT) {
    throw new ProjectDataError(409, 'WorkItemWebLinkLimitExceeded', `A Work Item can hold at most ${WORK_ITEM_WEB_LINK_LIMIT} links. Remove one first.`)
  }
  return [...links, link]
}

/**
 * Removes a link from a list.
 *
 * @param links - Current links.
 * @param linkId - Link to remove.
 * @returns The removed link and the new list.
 */
export function removeWorkItemWebLink(
  links: readonly PublicWorkItemWebLink[],
  linkId: string,
): { removed: PublicWorkItemWebLink, links: PublicWorkItemWebLink[] } {
  const removed = links.find((link) => link.id === linkId)
  if (removed === undefined) {
    throw new ProjectDataError(404, 'WorkItemWebLinkNotFound', 'The link was not found on this Work Item.')
  }
  return { removed, links: links.filter((link) => link.id !== linkId) }
}
