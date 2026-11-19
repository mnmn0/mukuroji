import { describe, expect, test } from 'bun:test'
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbChannelDeliveryStore } from './channel-delivery-store'
import { emailDeliveryShard } from '../../domain/channel-delivery'

const now = new Date('2026-09-26T12:00:00.000Z')
const recipientKey = 'workspace-1#member@example.test'
const shard = emailDeliveryShard(recipientKey)
const row = {
  recipientKey, notificationKey: '2026-09-26T11:00:00.000Z#event-1',
  workspaceId: 'workspace-1', recipientMemberKey: 'member@example.test',
  itemType: 'notification', version: 1, eventId: 'event-1', eventType: 'comment.created',
  occurredAt: '2026-09-26T11:00:00.000Z', reasons: ['mention'],
  inAppVisible: true, inboxState: 'unread', recipientStatusKey: `${recipientKey}#unread`,
  deliveryChannels: ['inApp', 'email', 'slack'], emailQueueShard: shard, emailDeliveryStatus: 'pending',
  emailNextAttemptAt: '2026-09-26T11:00:00.000Z', emailAttempts: 0, expiresAt: 2_000_000_000,
  slackQueueShard: 'slack#3', slackDeliveryStatus: 'sent',
}

/** Creates an Email queue with recorded commands. */
function fixture(item: Record<string, unknown> = row) {
  const commands: Array<GetCommand | QueryCommand | UpdateCommand> = []
  const store = new DynamoDbChannelDeliveryStore({
    async send(command) {
      commands.push(command)
      if (command instanceof QueryCommand) return { Items: [row] }
      if (command instanceof GetCommand) return { Item: item }
      return {}
    },
  }, 'notifications', 'email')
  return { store, commands }
}

describe('Email DynamoDB delivery queue', () => {
  test('queries the Email index and leaves Slack delivery state untouched', async () => {
    const f = fixture()
    const batch = await f.store.listDue(shard, now, 2)
    expect(batch).toMatchObject({ invalidCount: 0, deliveries: [{ attempts: 0, nextAttemptAt: row.emailNextAttemptAt }] })
    expect(f.commands[0]?.input).toMatchObject({
      IndexName: 'EmailDeliveryIndex', KeyConditionExpression: 'emailQueueShard = :shard AND emailNextAttemptAt <= :now',
    })
    const delivery = batch.deliveries[0]!
    expect(await f.store.claim(delivery, 'lease-1', new Date(now.getTime() + 60_000))).toBe(true)
    await f.store.finish({ ...delivery, version: 2 }, 'lease-1', 'failed', undefined, 'EmailDeliveryRejected')
    const updates = f.commands.filter((command) => command instanceof UpdateCommand)
    expect(updates[0]?.input.UpdateExpression).toContain('emailLeaseToken = :token')
    expect(updates[1]?.input).toMatchObject({
      ConditionExpression: 'emailLeaseToken = :token',
      ExpressionAttributeValues: { ':failedShard': shard.replace('email#', 'email-failed#') },
    })
    for (const update of updates) expect(String(update.input.UpdateExpression)).not.toContain('slack')
  })
  test('rejects Email queue rows that no longer plan Email delivery', async () => {
    const f = fixture({ ...row, deliveryChannels: ['inApp'] })
    await expect(Promise.resolve(f.store.listDue(shard, now, 2))).resolves.toEqual({ deliveries: [], invalidCount: 1 })
  })
})
