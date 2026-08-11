import { createHash } from 'node:crypto'

/** Number of stable shards in the Planning update notification due index. */
export const PLANNING_UPDATE_SCHEDULE_SHARD_COUNT = 16

/** Default DynamoDB GSI used to find due Planning update notification targets. */
export const PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME = 'UpdateScheduleDueIndex'

/**
 * Assigns one Planning update target to a stable due-index shard.
 *
 * @param workspaceId - Workspace that owns the target row.
 * @param targetRecordKey - Canonical UPDATE_TARGET record key.
 * @returns A stable shard from `planning-update-00` through `planning-update-15`.
 */
export function createPlanningUpdateScheduleShard(
  workspaceId: string,
  targetRecordKey: string,
) {
  const digest = createHash('sha256')
    .update(`${requireScheduleKeyPart(workspaceId, 'Workspace ID')}\0${
      requireScheduleKeyPart(targetRecordKey, 'Planning update target record key')
    }`)
    .digest()
  return createPlanningUpdateScheduleShardName(
    digest.readUInt8(0) % PLANNING_UPDATE_SCHEDULE_SHARD_COUNT,
  )
}

/**
 * Returns the canonical name of one Planning update due-index shard.
 *
 * @param index - Zero-based shard index.
 * @returns Canonical Planning update schedule shard name.
 */
export function createPlanningUpdateScheduleShardName(index: number) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= PLANNING_UPDATE_SCHEDULE_SHARD_COUNT
  ) {
    throw new TypeError('Planning update schedule shard index is invalid.')
  }
  return `planning-update-${String(index).padStart(2, '0')}`
}

/**
 * Creates the sparse due-index sort key for one active Planning update cadence.
 *
 * The first notification is the reminder when it precedes the deadline, otherwise
 * the overdue stage at the deadline. A digest suffix gives equal instants a stable
 * total order without exposing or duplicating long physical keys in the GSI key.
 *
 * @param workspaceId - Workspace that owns the target row.
 * @param targetRecordKey - Canonical UPDATE_TARGET record key.
 * @param nextDueAt - Current cadence occurrence deadline.
 * @param reminderHoursBefore - Reminder offset before the deadline.
 * @returns Lexicographically sortable due-index record key.
 */
export function createPlanningUpdateNextNotificationAtRecordKey(
  workspaceId: string,
  targetRecordKey: string,
  nextDueAt: string,
  reminderHoursBefore: number,
) {
  const dueTime = requireScheduleTimestamp(nextDueAt, 'Planning update next deadline').getTime()
  if (!Number.isSafeInteger(reminderHoursBefore) || reminderHoursBefore < 0) {
    throw new TypeError('Planning update reminder offset must be a non-negative integer.')
  }
  const firstNotificationTime = reminderHoursBefore === 0
    ? dueTime
    : dueTime - reminderHoursBefore * 3_600_000
  if (
    !Number.isSafeInteger(firstNotificationTime) ||
    Math.abs(firstNotificationTime) > 8_640_000_000_000_000
  ) {
    throw new TypeError('Planning update first notification timestamp is invalid.')
  }
  const digest = createHash('sha256')
    .update(`${requireScheduleKeyPart(workspaceId, 'Workspace ID')}\0${
      requireScheduleKeyPart(targetRecordKey, 'Planning update target record key')
    }`)
    .digest('hex')
  return `${new Date(firstNotificationTime).toISOString()}#${digest}`
}

/**
 * Creates an inclusive DynamoDB String upper bound for a due-index query.
 *
 * @param asOf - Schedule execution timestamp.
 * @returns Upper bound that includes every target due at the exact instant.
 */
export function createPlanningUpdateScheduleUpperBound(asOf: string) {
  return `${requireScheduleTimestamp(asOf, 'Planning update schedule as-of timestamp').toISOString()}$`
}

/** Validates one non-empty source value used only to derive an opaque schedule key. */
function requireScheduleKeyPart(value: string, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required for the Planning update schedule index.`)
  }
  return value
}

/** Parses one timestamp used in a lexicographically ordered schedule key. */
function requireScheduleTimestamp(value: string, label: string) {
  const timestamp = new Date(value)
  if (typeof value !== 'string' || !Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`${label} is invalid.`)
  }
  return timestamp
}
