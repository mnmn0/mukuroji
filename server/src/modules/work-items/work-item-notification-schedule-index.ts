import { createHash } from 'node:crypto'

/** Number of stable shards shared by the Work Item notification schedule indexes. */
export const WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT = 16

/** Sparse GSI that lists open Work Items the notification schedule must evaluate. */
export const WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME = 'WorkItemNotificationDueIndex'

/** Sparse GSI that lists Work Items holding a Customer completion preparation marker. */
export const WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME =
  'WorkItemCustomerCompletionPreparationIndex'

/** Partition attribute shared by both notification schedule indexes. */
export const WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE = 'notificationScheduleShard'

/** Sort attribute of {@link WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME}; absent rows leave the index. */
export const WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE = 'notificationDueKey'

/** Sort attribute of {@link WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME}. */
export const WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_KEY_ATTRIBUTE =
  'customerCompletionPreparationAt'

/**
 * Sparse GSI that lists a Team's `started` Work Items by update time, so the Factory board reads
 * them without scanning the Team's other Work Items (ADR 0098).
 */
export const WORK_ITEM_TEAM_STARTED_INDEX_NAME = 'TeamStartedWorkItemIndex'

/**
 * Partition attribute of {@link WORK_ITEM_TEAM_STARTED_INDEX_NAME}: the row's `directoryTeamId`
 * while the Work Item is started and not archived; absent rows leave the index.
 */
export const WORK_ITEM_STARTED_DIRECTORY_TEAM_ID_ATTRIBUTE = 'startedDirectoryTeamId'

/**
 * Due key of a started Work Item. It sorts before every real date, so every run reads started
 * Work Items for the stale reminder whatever their due date is.
 */
export const WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY = '0000-00-00'

/** Work Item fields that decide whether and where the row sits in the due index. */
export type WorkItemNotificationDueState = {
  /** Archive timestamp; any value takes the row out of the index. */
  archivedAt?: unknown
  /** Workflow status category after the write. */
  statusCategory: unknown
  /** Canonical `YYYY-MM-DD` deadline, or an empty string when unscheduled. */
  dueDate: unknown
}

/**
 * DynamoDB update expression fragments that keep the notification index attributes, and the
 * started index attribute, current.
 */
export type WorkItemNotificationScheduleUpdate = {
  /** `SET` clauses to append to the update expression. */
  setExpressions: string[]
  /** `REMOVE` clauses to append to the update expression. */
  removeExpressions: string[]
  /** Expression attribute names used by the clauses. */
  expressionAttributeNames: Record<string, string>
  /** Expression attribute values used by the clauses. */
  expressionAttributeValues: Record<string, string>
}

/** Index attributes stored on a Work Item row. */
export type WorkItemNotificationScheduleAttributes = {
  /** Stable shard of the row. */
  notificationScheduleShard: string
  /** Due key, present only while the schedule must evaluate the row. */
  notificationDueKey?: string
  /** Team partition of the started index, present only while the Work Item is started. */
  startedDirectoryTeamId?: string
}

/**
 * Assigns one Work Item to a stable notification schedule shard.
 *
 * @param workspaceId - Workspace that owns the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns A stable shard from `work-item-schedule-00` through `work-item-schedule-15`.
 */
export function createWorkItemNotificationScheduleShard(
  workspaceId: string,
  teamId: string,
  issueId: string,
): string {
  const digest = createHash('sha256')
    .update(`${requireKeyPart(workspaceId, 'Workspace ID')}\0${
      requireKeyPart(teamId, 'Team ID')
    }\0${requireKeyPart(issueId, 'Work Item ID')}`)
    .digest()
  return createWorkItemNotificationScheduleShardName(
    digest.readUInt8(0) % WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT,
  )
}

/**
 * Returns the canonical name of one notification schedule shard.
 *
 * @param index - Zero-based shard index.
 * @returns Canonical shard name.
 * @throws TypeError when the index is outside the shard range.
 */
export function createWorkItemNotificationScheduleShardName(index: number): string {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT
  ) {
    throw new TypeError('Work Item notification schedule shard index is invalid.')
  }
  return `work-item-schedule-${String(index).padStart(2, '0')}`
}

/**
 * Returns the due-index sort key a Work Item should hold after a write.
 *
 * Archived Work Items and Work Items in a terminal status category leave the index. A started
 * Work Item always stays in it (stale reminders need it read on every run). Other open Work
 * Items stay only while they have a deadline, keyed by that deadline so the schedule can read
 * only the ones that are due soon or overdue.
 *
 * @param state - Work Item fields after the write.
 * @returns The due key, or undefined when the row must not be in the index.
 */
export function createWorkItemNotificationDueKey(
  state: WorkItemNotificationDueState,
): string | undefined {
  if (state.archivedAt !== undefined && state.archivedAt !== null) return undefined
  if (state.statusCategory === 'started') return WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY
  if (state.statusCategory !== 'backlog' && state.statusCategory !== 'unstarted') {
    return undefined
  }
  return typeof state.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.dueDate)
    ? state.dueDate
    : undefined
}

/**
 * Creates the index attributes to store on a new Work Item row: the notification schedule shard and
 * due key, and the Team started index partition the Factory board reads (ADR 0098).
 *
 * @param workspaceId - Workspace that owns the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param state - Work Item fields of the new row.
 * @returns Attributes to merge into the row.
 */
export function createWorkItemNotificationScheduleAttributes(
  workspaceId: string,
  teamId: string,
  issueId: string,
  state: WorkItemNotificationDueState,
): WorkItemNotificationScheduleAttributes {
  const dueKey = createWorkItemNotificationDueKey(state)
  const startedDirectoryTeamId = createWorkItemStartedDirectoryTeamId(workspaceId, teamId, state)
  return {
    notificationScheduleShard: createWorkItemNotificationScheduleShard(workspaceId, teamId, issueId),
    ...(dueKey ? { notificationDueKey: dueKey } : {}),
    ...(startedDirectoryTeamId ? { startedDirectoryTeamId } : {}),
  }
}

/**
 * Returns the started-index partition a Work Item should hold after a write.
 *
 * @param workspaceId - Workspace that owns the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param state - Work Item fields after the write.
 * @returns The Team partition while the Work Item is started and not archived, otherwise undefined.
 */
export function createWorkItemStartedDirectoryTeamId(
  workspaceId: string,
  teamId: string,
  state: WorkItemNotificationDueState,
): string | undefined {
  if (state.archivedAt !== undefined && state.archivedAt !== null) return undefined
  if (state.statusCategory !== 'started') return undefined
  return `${requireKeyPart(workspaceId, 'Workspace ID')}#team#${requireKeyPart(teamId, 'Team ID')}`
}

/**
 * Creates update expression fragments that move a Work Item to its index positions after a write,
 * in the notification schedule indexes and the Team started index.
 *
 * The shard is written on every update, so a row saved before the index existed joins it the
 * next time it changes.
 *
 * @param workspaceId - Workspace that owns the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param state - Work Item fields after the write.
 * @returns Clauses, names, and values to merge into the update.
 */
export function createWorkItemNotificationScheduleUpdate(
  workspaceId: string,
  teamId: string,
  issueId: string,
  state: WorkItemNotificationDueState,
): WorkItemNotificationScheduleUpdate {
  const attributes = createWorkItemNotificationScheduleAttributes(workspaceId, teamId, issueId, state)
  const expressionAttributeNames: Record<string, string> = {
    '#notificationScheduleShard': WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE,
    '#notificationDueKey': WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE,
    '#startedDirectoryTeamId': WORK_ITEM_STARTED_DIRECTORY_TEAM_ID_ATTRIBUTE,
  }
  const expressionAttributeValues: Record<string, string> = {
    ':notificationScheduleShard': attributes.notificationScheduleShard,
  }
  const setExpressions = ['#notificationScheduleShard = :notificationScheduleShard']
  const removeExpressions: string[] = []
  if (attributes.notificationDueKey) {
    expressionAttributeValues[':notificationDueKey'] = attributes.notificationDueKey
    setExpressions.push('#notificationDueKey = :notificationDueKey')
  } else {
    removeExpressions.push('#notificationDueKey')
  }
  if (attributes.startedDirectoryTeamId) {
    expressionAttributeValues[':startedDirectoryTeamId'] = attributes.startedDirectoryTeamId
    setExpressions.push('#startedDirectoryTeamId = :startedDirectoryTeamId')
  } else {
    removeExpressions.push('#startedDirectoryTeamId')
  }
  return { setExpressions, removeExpressions, expressionAttributeNames, expressionAttributeValues }
}

/**
 * Validates one non-blank key part.
 *
 * @param value - Candidate key part.
 * @param label - Name used in the error.
 * @returns The key part.
 * @throws TypeError when the value is blank.
 */
function requireKeyPart(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} is required for the notification schedule shard.`)
  }
  return value
}
