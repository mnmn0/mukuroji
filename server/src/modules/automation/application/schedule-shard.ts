import { createHash } from 'node:crypto'

/** Number of stable shards in the Automation schedule due index. */
export const AUTOMATION_SCHEDULE_SHARD_COUNT = 16

/**
 * Assigns one Automation definition to a stable schedule shard.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param definitionId - Definition or execution identifier.
 * @returns Stable schedule shard name.
 */
export function createAutomationScheduleShard(workspaceId: string, definitionId: string) {
  const digest = createHash('sha256').update(`${workspaceId}\0${definitionId}`).digest()
  return `schedule-${String(digest[0]! % AUTOMATION_SCHEDULE_SHARD_COUNT).padStart(2, '0')}`
}
