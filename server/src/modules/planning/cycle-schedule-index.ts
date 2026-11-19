import { createHash } from 'node:crypto'

/**
 * Number of stable shards for Cycle automation in the Planning due index.
 *
 * Cycle entity rows share `UpdateScheduleDueIndex` with update targets. Their shard names use a
 * different prefix, so the update notification schedule never reads them.
 */
export const PLANNING_CYCLE_SCHEDULE_SHARD_COUNT = 16

/**
 * Assigns one Cycle entity row to a stable due-index shard.
 *
 * @param workspaceId - Workspace that owns the Cycle row.
 * @param recordKey - Cycle entity record key.
 * @returns A stable shard from `planning-cycle-00` through `planning-cycle-15`.
 */
export function createPlanningCycleScheduleShard(workspaceId: string, recordKey: string) {
  const digest = createHash('sha256').update(`${workspaceId}\0${recordKey}`).digest()
  return createPlanningCycleScheduleShardName(
    digest.readUInt8(0) % PLANNING_CYCLE_SCHEDULE_SHARD_COUNT,
  )
}

/**
 * Returns the canonical name of one Cycle automation due-index shard.
 *
 * @param index - Zero-based shard index.
 * @returns Canonical shard name.
 */
export function createPlanningCycleScheduleShardName(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= PLANNING_CYCLE_SCHEDULE_SHARD_COUNT) {
    throw new TypeError('Planning Cycle schedule shard index is invalid.')
  }
  return `planning-cycle-${String(index).padStart(2, '0')}`
}

/**
 * Creates the due-index sort key of one Cycle automation step.
 *
 * @param workspaceId - Workspace that owns the Cycle row.
 * @param recordKey - Cycle entity record key.
 * @param dueAt - ISO timestamp at which the step becomes due.
 * @returns Lexicographically sortable due-index sort key.
 */
export function createPlanningCycleScheduleRecordKey(
  workspaceId: string,
  recordKey: string,
  dueAt: string,
) {
  const timestamp = new Date(dueAt)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError('Planning Cycle schedule time is invalid.')
  }
  const digest = createHash('sha256').update(`${workspaceId}\0${recordKey}`).digest('hex')
  return `${timestamp.toISOString()}#${digest}`
}
