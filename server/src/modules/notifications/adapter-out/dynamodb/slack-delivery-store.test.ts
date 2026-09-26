import { describe, expect, test } from 'bun:test'
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbSlackDeliveryStore } from './slack-delivery-store'
import { slackDeliveryShard } from '../../domain/slack-delivery'

const now = new Date('2026-09-26T12:00:00.000Z')
const recipientKey = 'workspace-1#member@example.test'
const shard = slackDeliveryShard(recipientKey)
const row = {
  recipientKey, notificationKey: '2026-09-26T11:00:00.000Z#event-1',
  workspaceId: 'workspace-1', recipientMemberKey: 'member@example.test',
  itemType: 'notification', version: 1, eventId: 'event-1', eventType: 'comment.created',
  occurredAt: '2026-09-26T11:00:00.000Z', reasons: ['mention'],
  inAppVisible: false, inboxState: 'archived', archivedAt: '2026-09-26T11:00:00.000Z',
  recipientStatusKey: `${recipientKey}#archived`,
  deliveryChannels: ['slack'], slackQueueShard: shard, slackDeliveryStatus: 'pending',
  slackNextAttemptAt: '2026-09-26T11:00:00.000Z', slackAttempts: 0, expiresAt: 2_000_000_000,
}

/** Creates a queue with recorded commands and a replaceable canonical row. */
function fixture(item: Record<string, unknown> = row) {
  const commands: Array<GetCommand | QueryCommand | UpdateCommand> = []
  const store = new DynamoDbSlackDeliveryStore({
    async send(command) {
      commands.push(command)
      if (command instanceof QueryCommand) return { Items: [row] }
      if (command instanceof GetCommand) return { Item: item }
      return {}
    },
  }, 'notifications')
  return { store, commands }
}

describe('Slack DynamoDB delivery queue', () => {
  test('rechecks canonical rows strongly and supports Slack without Inbox', async () => {
    const f = fixture()
    const [delivery] = await f.store.listDue(shard, now, 2)
    expect(delivery?.notification.eventId).toBe('event-1')
    const query = f.commands[0]
    const get = f.commands[1]
    expect(query?.input).toMatchObject({ IndexName: 'SlackDeliveryIndex', Limit: 2 })
    expect(get?.input).toMatchObject({ ConsistentRead: true })
  })
  test('skips removed or leased index candidates and rejects corrupt tenant identity', async () => {
    expect(await fixture({ ...row, slackQueueShard: undefined }).store.listDue(shard, now, 2)).toEqual([])
    expect(await fixture({ ...row, slackNextAttemptAt: '2026-09-26T13:00:00.000Z' }).store.listDue(shard, now, 2)).toEqual([])
    await expect(fixture({ ...row, workspaceId: 'other-workspace' }).store.listDue(shard, now, 2)).rejects.toThrow('Invalid Slack')
    await expect(fixture({ ...row, slackAttempts: -1 }).store.listDue(shard, now, 2)).rejects.toThrow('Invalid Slack')
  })
  test('fences claim, renewal and acknowledgement while preserving concurrent Inbox fields', async () => {
    const f = fixture()
    const [delivery] = await f.store.listDue(shard, now, 2)
    if (!delivery) throw new Error('Expected delivery')
    await f.store.claim(delivery, 'token-1', new Date(now.getTime() + 60_000))
    await f.store.renew(delivery, 'token-1', now)
    await f.store.finish(delivery, 'token-1', 'sent')
    const updates = f.commands.filter((command): command is UpdateCommand => command instanceof UpdateCommand)
    expect(updates[0]?.input.ConditionExpression).toContain('#version = :version')
    expect(updates[1]?.input.ConditionExpression).toContain('slackNextAttemptAt > :now')
    expect(updates[1]?.input.ConditionExpression).toContain('#version = :claimedVersion')
    expect(updates[1]?.input.ExpressionAttributeValues?.[':claimedVersion']).toBe(delivery.version + 1)
    expect(updates[2]?.input.ConditionExpression).toBe('slackLeaseToken = :token')
    expect(updates[2]?.input.UpdateExpression).toContain('slackQueueShard, slackNextAttemptAt')
    for (const update of updates) {
      expect(update.input.UpdateExpression).not.toContain('inboxState')
      expect(update.input.UpdateExpression).toContain('#version :one')
    }
  })
  test('lost claims return false and quiet-hour deferrals do not consume send attempts', async () => {
    const f = fixture()
    const [delivery] = await f.store.listDue(shard, now, 2)
    if (!delivery) throw new Error('Expected delivery')
    const competing = new DynamoDbSlackDeliveryStore({ async send() {
      const error = new Error('Conflict'); error.name = 'ConditionalCheckFailedException'; throw error
    } }, 'notifications')
    expect(await competing.claim(delivery, 'token', now)).toBe(false)
    expect(await competing.renew(delivery, 'token', now)).toBe(false)
    await f.store.finish(delivery, 'token', 'pending', new Date(now.getTime() + 60_000))
    expect(f.commands.at(-1)?.input).toMatchObject({ ExpressionAttributeValues: { ':minusOne': -1 } })
  })
})
