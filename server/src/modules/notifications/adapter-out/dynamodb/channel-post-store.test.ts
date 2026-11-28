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

test('delivers a valid post on the next run after unreadable candidates filled the read budget', async () => {
  const ids: string[] = []
  const probe = await queuedStore(Array.from({ length: 80 }, (_, index) => post(`event-${index}`)))
  const target = probe.shardOf('event-0')
  for (let index = 0; index < 80 && ids.length < 6; index += 1) {
    if (probe.shardOf(`event-${index}`) === target) ids.push(`event-${index}`)
  }
  expect(ids).toHaveLength(6)
  const valid = String(ids[5])
  const { store } = await queuedStore(ids.map((id) => (id === valid ? post(id) : post(id, 'other-team'))))

  const first = await store.listDue(String(target), now, 2)
  expect(first.posts).toEqual([])
  expect(first.invalidCount).toBe(4)
  expect(first.truncated).toBe(true)
  // The first run moved the unreadable rows out of the partition, so the next run reaches the valid post.
  const second = await store.listDue(String(target), now, 2)
  expect(second.invalidCount).toBe(1)
  expect(second.posts.map((queued) => queued.eventId)).toEqual([valid])
  expect(second.truncated).not.toBe(true)
})

test('skips a retired webhook version that another run deferred after the due index was read', async () => {
  const key = { recipientKey: 'workspace-1#!channel-secret-cleanup', notificationKey: 'SECRET#team#core#00000000-0000-4000-8000-000000000001' }
  const row = {
    ...key, itemType: 'channel-secret-cleanup', workspaceId: 'workspace-1', scope: 'team', teamId: 'core',
    secretVersion: '00000000-0000-4000-8000-000000000001', attempts: 1,
    slackQueueShard: 'channel-secret-cleanup', slackNextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
  }
  const client = {
    async send(command: unknown): Promise<Record<string, unknown>> {
      // The index still lists the row as due; the table row was already deferred.
      if (command instanceof QueryCommand) return { Items: [key] }
      if (command instanceof GetCommand) return { Item: row }
      throw new Error('Unexpected command')
    },
  }
  const store = new DynamoDbChannelPostStore(client, 'NotificationsTable')
  await expect(store.listDueRetiredSecrets(now, 20)).resolves.toEqual({ secrets: [], invalidCount: 0 })
  await expect(store.listDueRetiredSecrets(new Date(now.getTime() + 60_000), 20)).resolves.toMatchObject({
    secrets: [{ workspaceId: 'workspace-1', secretVersion: row.secretVersion, attempts: 1 }],
  })
})
