import { expect, test } from 'bun:test'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { ChannelPostContent } from '../../application/ports/channel-posts'
import { DynamoDbChannelPostStore, channelPostShards } from './channel-post-store'

/** Clock of these tests. */
const now = new Date('2026-11-25T00:00:00.000Z')

/**
 * Builds a queued post for a Team channel.
 * @param eventId - Event ID.
 * @param sourceTeamId - Team the source belongs to.
 * @returns Post contents.
 */
function post(eventId: string, sourceTeamId = 'core'): ChannelPostContent {
  return {
    workspaceId: 'workspace-1', eventId, eventType: 'work-item.overdue', target: { scope: 'team', teamId: 'core' },
    occurredAt: now.toISOString(), source: { teamId: sourceTeamId, issueId: `issue-${eventId}`, dueDate: '2026-11-24' },
  }
}

/**
 * Queues posts through the store and serves them back from an in-memory table whose due index
 * returns one candidate per page.
 * @param contents - Posts to queue; all land in the same partition when their IDs hash alike.
 * @returns The store and the queue partition of each post.
 */
async function queuedStore(contents: ChannelPostContent[]) {
  const rows = new Map<string, Record<string, unknown>>()
  const client = {
    async send(command: unknown): Promise<Record<string, unknown>> {
      if (command instanceof PutCommand) {
        const item = command.input.Item ?? {}
        rows.set(`${String(item.recipientKey)}|${String(item.notificationKey)}`, item)
        return {}
      }
      if (command instanceof QueryCommand) {
        const shard = command.input.ExpressionAttributeValues?.[':shard']
        // Resume after the last returned row, as DynamoDB does, even if earlier rows changed partition.
        const all = [...rows.values()]
        const after = command.input.ExclusiveStartKey?.eventId
        const from = after === undefined ? 0 : all.findIndex((row) => row.eventId === after) + 1
        const due = all.slice(from).filter((row) => row.slackQueueShard === shard)
        const page = due.slice(0, 1)
        return {
          Items: page,
          ...(due.length > 1 ? { LastEvaluatedKey: { eventId: page[0]?.eventId } } : {}),
        }
      }
      if (command instanceof GetCommand) {
        const key = command.input.Key ?? {}
        return { Item: rows.get(`${String(key.recipientKey)}|${String(key.notificationKey)}`) }
      }
      if (command instanceof UpdateCommand) {
        const key = command.input.Key ?? {}
        const row = rows.get(`${String(key.recipientKey)}|${String(key.notificationKey)}`)
        if (row) row.slackQueueShard = command.input.ExpressionAttributeValues?.[':failed']
        return {}
      }
      throw new Error('Unexpected command')
    },
  }
  const store = new DynamoDbChannelPostStore(client, 'notifications')
  for (const content of contents) await store.enqueue(content, now)
  const shardOf = (eventId: string) => [...rows.values()].find((row) => row.eventId === eventId)?.slackQueueShard
  return { store, shardOf, rows }
}

test('reads past unreadable candidates to the valid posts behind them, and refuses a source from another Team', async () => {
  // Find three events that share a partition so the paging is exercised.
  const ids: string[] = []
  const probe = await queuedStore(Array.from({ length: 40 }, (_, index) => post(`event-${index}`)))
  const target = probe.shardOf('event-0')
  for (let index = 0; index < 40 && ids.length < 3; index += 1) {
    if (probe.shardOf(`event-${index}`) === target) ids.push(`event-${index}`)
  }
  expect(ids).toHaveLength(3)
  expect(channelPostShards()).toContain(String(target))
  const [mismatched, valid, later] = ids
  const { store, rows } = await queuedStore([post(String(mismatched), 'other-team'), post(String(valid)), post(String(later))])

  const page = await store.listDue(String(target), now, 2)
  expect(page.invalidCount).toBe(1)
  expect(page.posts.map((queued) => queued.eventId)).toEqual([String(valid), String(later)])
  // The unreadable row leaves the due partition, so the next run is not held back by it.
  const moved = [...rows.values()].find((row) => row.eventId === mismatched)
  expect(moved?.slackQueueShard).toBe(String(target).replace('slack-channel#', 'slack-channel-failed#'))
  const next = await store.listDue(String(target), now, 2)
  expect(next.invalidCount).toBe(0)
})

test('reports a partition whose read budget ran out on candidates that are no longer due', async () => {
  const ids: string[] = []
  const probe = await queuedStore(Array.from({ length: 80 }, (_, index) => post(`event-${index}`)))
  const target = probe.shardOf('event-0')
  for (let index = 0; index < 80 && ids.length < 6; index += 1) {
    if (probe.shardOf(`event-${index}`) === target) ids.push(`event-${index}`)
  }
  expect(ids).toHaveLength(6)
  const { store, rows } = await queuedStore(ids.map((id) => post(id)))
  // The index still lists these rows, but the table already moved them to a later attempt.
  for (const row of rows.values()) row.slackNextAttemptAt = '2026-11-25T01:00:00.000Z'

  const page = await store.listDue(String(target), now, 2)
  expect(page.posts).toEqual([])
  expect(page.invalidCount).toBe(0)
  expect(page.truncated).toBe(true)
})
