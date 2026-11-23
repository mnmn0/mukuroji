import { expect, test } from 'bun:test'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoDbPlanningMilestoneScopeReader } from '../../modules/planning/adapter-out/dynamodb/milestone-scope-reader'
import { createPlanningMilestoneNotificationRevalidator } from './planning-milestone-notifications'

/**
 * Creates a DocumentClient stub that answers Planning entity reads from one row.
 *
 * @param row - Stored row returned for every read, or undefined for a missing row.
 * @returns The stub and the recorded reads.
 */
function createPlanningReads(row: () => Record<string, unknown> | undefined) {
  const reads: GetCommand['input'][] = []
  const documentClient = {
    send: async (command: GetCommand) => {
      reads.push(command.input)
      return { Item: row() }
    },
  }
  return { documentClient, reads }
}

const milestoneRow = {
  workspaceId: 'workspace-1', recordKey: 'ENTITY#beta%20launch', entryType: 'planning-entity',
  id: 'beta launch', type: 'milestone', teamId: 'core', projectId: 'platform',
}

test('reads a current Milestone scope strongly and fails closed on other rows', async () => {
  let row: Record<string, unknown> | undefined = milestoneRow
  const { documentClient, reads } = createPlanningReads(() => row)
  const reader = createDynamoDbPlanningMilestoneScopeReader({ documentClient, planningTableName: 'planning' })

  expect(await reader.readCurrentMilestoneScope('workspace-1', 'beta launch'))
    .toEqual({ teamId: 'core', projectId: 'platform' })
  expect(reads[0]).toEqual({
    TableName: 'planning', Key: { workspaceId: 'workspace-1', recordKey: 'ENTITY#beta%20launch' }, ConsistentRead: true,
  })
  row = { ...milestoneRow, archivedAt: '2026-11-22T00:00:00.000Z' }
  expect(await reader.readCurrentMilestoneScope('workspace-1', 'beta launch')).toBeUndefined()
  row = { ...milestoneRow, type: 'phase' }
  expect(await reader.readCurrentMilestoneScope('workspace-1', 'beta launch')).toBeUndefined()
  row = { ...milestoneRow, teamId: undefined }
  expect(await reader.readCurrentMilestoneScope('workspace-1', 'beta launch')).toBeUndefined()
  row = undefined
  expect(await reader.readCurrentMilestoneScope('workspace-1', 'beta launch')).toBeUndefined()
  row = { ...milestoneRow, workspaceId: 'workspace-2' }
  await expect(reader.readCurrentMilestoneScope('workspace-1', 'beta launch')).rejects.toThrow('invalid')
})

test('asks the Collaboration client for the exact Milestone watcher row', async () => {
  const asked: Array<{ entityKey: string; memberKey: string }> = []
  const revalidator = createPlanningMilestoneNotificationRevalidator(
    { readCurrentMilestoneScope: async () => ({ teamId: 'core' }) },
    {
      getMemberWatcherState: async (input) => {
        asked.push({ entityKey: input.entityKey, memberKey: input.memberKey })
        return { subscribed: input.memberKey === 'watcher@example.com', explicit: true, automatic: false, reasons: ['manual'] }
      },
    },
  )

  expect(await revalidator.isWatching('workspace-1', 'beta launch', 'watcher@example.com')).toBe(true)
  expect(await revalidator.isWatching('workspace-1', 'beta launch', 'other@example.com')).toBe(false)
  expect(asked[0]).toEqual({ entityKey: 'workspace-1#planning-entity#beta%20launch', memberKey: 'watcher@example.com' })
  expect(await revalidator.readCurrentMilestoneScope('workspace-1', 'beta launch')).toEqual({ teamId: 'core' })
})
