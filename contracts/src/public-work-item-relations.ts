import type { WorkItemRelationType } from './work-items'

/**
 * Relation types the Public API reads and writes, from the named Work Item's point of view.
 *
 * `child` and `blockedBy` are the reverse of `parent` and `blocks`; the server stores both
 * directions of every link, so either side can name it.
 */
export const PUBLIC_WORK_ITEM_RELATION_TYPES = [
  'parent',
  'child',
  'blocks',
  'blockedBy',
  'related',
  'duplicate',
] as const satisfies readonly WorkItemRelationType[]

/** One relation type the Public API accepts. */
export type PublicWorkItemRelationType = typeof PUBLIC_WORK_ITEM_RELATION_TYPES[number]

/**
 * Relation types `GET /api/v1/work-items/{workItemId}/relations` returns. Children are left out:
 * a parent can have any number of them, and `GET .../hierarchy` lists them in sibling order.
 */
export const PUBLIC_WORK_ITEM_LISTED_RELATION_TYPES = [
  'parent',
  'blocks',
  'blockedBy',
  'related',
  'duplicate',
] as const satisfies readonly PublicWorkItemRelationType[]

/**
 * Tells whether a value is a relation type the Public API accepts.
 *
 * @param value - Value to test.
 * @returns Whether the value is one of {@link PUBLIC_WORK_ITEM_RELATION_TYPES}.
 */
export function isPublicWorkItemRelationType(value: unknown): value is PublicWorkItemRelationType {
  return PUBLIC_WORK_ITEM_RELATION_TYPES.some((type) => type === value)
}

/** One relation of a Work Item, as the Public API returns it. */
export type PublicWorkItemRelation = {
  /** Relation type from the named Work Item's point of view. */
  type: PublicWorkItemRelationType
  /** Other Work Item of the relation, in the same Team. */
  targetWorkItemId: string
  /** When the relation was created; absent for relations stored before the time was recorded. */
  createdAt?: string
}

/** Response of `GET /api/v1/work-items/{workItemId}/relations`. */
export type PublicWorkItemRelationList = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose relations were read. */
  workItemId: string
  /**
   * Relations whose other Work Item the client may read, except children. At most
   * `WORK_ITEM_RELATION_ID_LIMIT` per Work Item.
   */
  relations: PublicWorkItemRelation[]
}

/** Body of `POST /api/v1/work-items/{workItemId}/relations`. */
export type CreatePublicWorkItemRelationRequest = {
  /** Relation type from the named Work Item's point of view. */
  type: PublicWorkItemRelationType
  /** Other Work Item, in the same Team. */
  targetWorkItemId: string
}

/** Response of creating or deleting a Work Item relation through the Public API. */
export type PublicWorkItemRelationMutation = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns both Work Items. */
  teamId: string
  /** Work Item named in the path. */
  workItemId: string
  /** The relation created or removed, from the named Work Item's point of view. */
  relation: PublicWorkItemRelation
}
