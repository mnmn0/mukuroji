import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'

/**
 * Member index rows of the Work Items table (ADR 0038).
 *
 * Each row says that one Workspace member may be the owner or a contributor of one Work Item. The
 * rows are candidates only: readers re-read the canonical Work Item and decide involvement and
 * access from it, so a stale row costs one extra read and a missing row hides the Work Item from
 * the member's Focus queue. Writers therefore add rows in the same transaction as the Work Item.
 */

/** Row discriminator of a member index row. */
export const WORK_ITEM_MEMBER_INDEX_ENTRY_TYPE = 'work-item-member-index'

/** Stored schema version of a member index row. */
export const WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION = 1

/** Infix between the Workspace ID and the member key in the partition key. */
const MEMBER_INDEX_PARTITION_INFIX = '#member-work-items#'

/** Longest member key accepted in a partition key. */
const MEMBER_KEY_MAX_LENGTH = 256

/** One transaction action of the Work Items table. */
type WorkItemTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Stored member index row. */
export type WorkItemMemberIndexRecord = {
  /** `<Workspace ID>#member-work-items#<member key>`. */
  directoryTeamId: string
  /** `<encoded Team ID>#<encoded Work Item ID>`. */
  issueId: string
  /** Row discriminator. */
  entryType: typeof WORK_ITEM_MEMBER_INDEX_ENTRY_TYPE
  /** Stored schema version. */
  schemaVersion: typeof WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION
  /** Workspace that owns the Work Item. */
  directoryId: string
  /** Normalized member key of the owner or contributor. */
  memberKey: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item ID. */
  workItemId: string
}

/** Team-qualified Work Item reference read from a member index row. */
export type WorkItemMemberIndexReference = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item ID. */
  workItemId: string
}

/** Work Item fields that decide who is indexed. */
export type WorkItemMemberIndexSource = {
  /** Accountable owner member key. */
  assigneeUserId?: unknown
  /** Contributor assignments; entries without a member are ignored. */
  contributorAssignments?: unknown
}

/**
 * Normalizes a member key the same way Focus compares owners and contributors.
 *
 * @param value - Stored or principal member key.
 * @returns Trimmed lowercase key, or undefined when the value is not a usable key.
 */
export function normalizeWorkItemMemberIndexKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 && normalized.length <= MEMBER_KEY_MAX_LENGTH ? normalized : undefined
}

/**
 * Lists the distinct members a Work Item row indexes: its owner and every contributor with a member.
 *
 * @param source - Canonical Work Item fields.
 * @returns Normalized member keys in ascending order.
 */
export function listWorkItemMemberIndexKeys(source: WorkItemMemberIndexSource): string[] {
  const keys = new Set<string>()
  const owner = normalizeWorkItemMemberIndexKey(source.assigneeUserId)
  if (owner !== undefined) keys.add(owner)
  if (Array.isArray(source.contributorAssignments)) {
    for (const assignment of source.contributorAssignments) {
      if (typeof assignment !== 'object' || assignment === null) continue
      const member = normalizeWorkItemMemberIndexKey(Reflect.get(assignment, 'memberUserId'))
      if (member !== undefined) keys.add(member)
    }
  }
  return [...keys].sort()
}

/**
 * Creates the partition key that holds one member's index rows in a Workspace.
 *
 * @param directoryId - Workspace ID.
 * @param memberKey - Member key; normalized before use.
 * @returns Partition key value.
 */
export function createWorkItemMemberIndexPartitionKey(directoryId: string, memberKey: string): string {
  const normalized = normalizeWorkItemMemberIndexKey(memberKey)
  if (!directoryId || normalized === undefined) {
    throw new TypeError('Work Item member index requires a Workspace ID and a member key.')
  }
  return `${directoryId}${MEMBER_INDEX_PARTITION_INFIX}${normalized}`
}

/**
 * Creates the sort key of one Work Item in a member index partition.
 *
 * Both parts are URI-encoded so that no Team and Work Item pair can collide with another.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item ID.
 * @returns Sort key value.
 */
export function createWorkItemMemberIndexSortKey(teamId: string, workItemId: string): string {
  if (!teamId || !workItemId) {
    throw new TypeError('Work Item member index requires a Team ID and a Work Item ID.')
  }
  return `${encodeURIComponent(teamId)}#${encodeURIComponent(workItemId)}`
}

/**
 * Creates one member index row.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item ID.
 * @param memberKey - Normalized member key.
 * @returns Row to store.
 */
export function createWorkItemMemberIndexRecord(
  directoryId: string,
  teamId: string,
  workItemId: string,
  memberKey: string,
): WorkItemMemberIndexRecord {
  const normalized = normalizeWorkItemMemberIndexKey(memberKey)
  if (normalized === undefined) throw new TypeError('Work Item member index requires a member key.')
  return {
    directoryTeamId: createWorkItemMemberIndexPartitionKey(directoryId, normalized),
    issueId: createWorkItemMemberIndexSortKey(teamId, workItemId),
    entryType: WORK_ITEM_MEMBER_INDEX_ENTRY_TYPE,
    schemaVersion: WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION,
    directoryId,
    memberKey: normalized,
    teamId,
    workItemId,
  }
}

/**
 * Creates every member index row of a canonical Work Item.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item ID.
 * @param source - Canonical Work Item fields.
 * @returns Rows in member key order.
 */
export function createWorkItemMemberIndexRecords(
  directoryId: string,
  teamId: string,
  workItemId: string,
  source: WorkItemMemberIndexSource,
): WorkItemMemberIndexRecord[] {
  return listWorkItemMemberIndexKeys(source).map((memberKey) =>
    createWorkItemMemberIndexRecord(directoryId, teamId, workItemId, memberKey)
  )
}

/**
 * Creates the unconditional transaction actions that move a Work Item's member index from one
 * state to the next: a Put for each member that joined and a Delete for each member that left.
 *
 * Pass `before` as undefined for a new Work Item and `after` as undefined for a deleted one.
 * Append the actions after every condition-bearing action so cancellation indexes stay stable.
 *
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item ID.
 * @param before - Membership fields before the write.
 * @param after - Membership fields after the write.
 * @returns Transaction actions, empty when membership did not change.
 */
export function createWorkItemMemberIndexTransactItems(
  tableName: string,
  directoryId: string,
  teamId: string,
  workItemId: string,
  before: WorkItemMemberIndexSource | undefined,
  after: WorkItemMemberIndexSource | undefined,
): WorkItemTransactItem[] {
  const beforeKeys = new Set(before === undefined ? [] : listWorkItemMemberIndexKeys(before))
  const afterKeys = new Set(after === undefined ? [] : listWorkItemMemberIndexKeys(after))
  const puts = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort().map((memberKey) => ({
    Put: {
      TableName: tableName,
      Item: createWorkItemMemberIndexRecord(directoryId, teamId, workItemId, memberKey),
    },
  }))
  const deletes = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort().map((memberKey) => ({
    Delete: {
      TableName: tableName,
      Key: {
        directoryTeamId: createWorkItemMemberIndexPartitionKey(directoryId, memberKey),
        issueId: createWorkItemMemberIndexSortKey(teamId, workItemId),
      },
    },
  }))
  return [...puts, ...deletes]
}

/**
 * Checks whether a stored row is a member index row.
 *
 * @param value - Stored row.
 * @returns Whether the row has the exact member index shape.
 */
export function isWorkItemMemberIndexRecord(value: unknown): value is WorkItemMemberIndexRecord {
  if (typeof value !== 'object' || value === null) return false
  const directoryId = Reflect.get(value, 'directoryId')
  const memberKey = Reflect.get(value, 'memberKey')
  const teamId = Reflect.get(value, 'teamId')
  const workItemId = Reflect.get(value, 'workItemId')
  if (
    Reflect.get(value, 'entryType') !== WORK_ITEM_MEMBER_INDEX_ENTRY_TYPE ||
    Reflect.get(value, 'schemaVersion') !== WORK_ITEM_MEMBER_INDEX_SCHEMA_VERSION ||
    typeof directoryId !== 'string' || !directoryId ||
    typeof memberKey !== 'string' || normalizeWorkItemMemberIndexKey(memberKey) !== memberKey ||
    typeof teamId !== 'string' || !teamId ||
    typeof workItemId !== 'string' || !workItemId
  ) {
    return false
  }
  return Reflect.get(value, 'directoryTeamId') ===
      createWorkItemMemberIndexPartitionKey(directoryId, memberKey) &&
    Reflect.get(value, 'issueId') === createWorkItemMemberIndexSortKey(teamId, workItemId)
}
