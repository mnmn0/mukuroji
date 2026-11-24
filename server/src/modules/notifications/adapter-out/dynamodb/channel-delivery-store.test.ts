import { describe, expect, test } from 'bun:test'
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbChannelDeliveryStore } from './channel-delivery-store'
import type { ChannelDelivery } from '../../application/channel-delivery'
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
  test('waits while Slack holds an unexpired lease so neither channel cancels the other', async () => {
    const f = fixture()
    const delivery = (await f.store.listDue(shard, now, 2)).deliveries[0]!
    await f.store.claim(delivery, 'lease-1', new Date(now.getTime() + 60_000), now)
    const claim = f.commands.find((command) => command instanceof UpdateCommand)
    expect(claim?.input.ConditionExpression).toContain('(attribute_not_exists(slackLeaseToken) OR slackNextAttemptAt <= :now)')
    // Its own unexpired lease also blocks the claim, so a digest never takes a row another worker leased.
    expect(claim?.input.ConditionExpression).toContain('(attribute_not_exists(emailLeaseToken) OR emailNextAttemptAt <= :now)')
    expect(claim?.input.ExpressionAttributeValues?.[':now']).toBe(now.toISOString())
  })
  test('rejects Email queue rows that no longer plan Email delivery', async () => {
    const f = fixture({ ...row, deliveryChannels: ['inApp'] })
    await expect(Promise.resolve(f.store.listDue(shard, now, 2))).resolves.toEqual({ deliveries: [], invalidCount: 1 })
  })
  test('lists the recipient\'s other digest rows, including unattempted ones that are not due yet', async () => {
    const digestRow = (key: string, fields: Record<string, unknown> = {}) => ({
      ...row, notificationKey: `2026-09-26T11:00:00.000Z#${key}`, eventId: key, deliveryFrequency: 'daily', ...fields,
    })
    const rows: Record<string, Record<string, unknown>> = {
      opener: digestRow('opener'),
      due: digestRow('due', { emailNextAttemptAt: '2026-09-26T11:30:00.000Z' }),
      later: digestRow('later', { emailNextAttemptAt: '2026-09-27T09:00:00.000Z' }),
      retried: digestRow('retried', { emailNextAttemptAt: '2026-09-26T12:10:00.000Z', emailAttempts: 1 }),
      leased: digestRow('leased', { emailNextAttemptAt: '2026-09-26T12:01:00.000Z', emailDeliveryStatus: 'sending', emailAttempts: 1 }),
      instant: digestRow('instant', { deliveryFrequency: 'instant' }),
    }
    const commands: Array<GetCommand | QueryCommand | UpdateCommand> = []
    const store = new DynamoDbChannelDeliveryStore({
      async send(command) {
        commands.push(command)
        if (command instanceof QueryCommand) {
          return { Items: [...Object.values(rows), { recipientKey: 'workspace-1#other@example.test', notificationKey: 'x' }]
            .map((item) => ({ recipientKey: item.recipientKey, notificationKey: item.notificationKey })) }
        }
        if (command instanceof GetCommand) return { Item: rows[String(command.input.Key?.notificationKey).split('#')[1] ?? ''] }
        return {}
      },
    }, 'notifications', 'email')
    const opener = (await store.listDue(shard, now, 1)).deliveries[0]!
    expect(opener).toMatchObject({ notificationKey: '2026-09-26T11:00:00.000Z#opener', deliveryFrequency: 'daily' })
    const { deliveries: companions, complete } = await store.listCompanions(opener, now, 49)
    expect(complete).toBe(true)
    expect(companions.map((companion) => companion.notificationKey.split('#')[1])).toEqual(['due', 'later'])
    const query = commands.filter((command) => command instanceof QueryCommand).at(-1)
    expect(query?.input).toMatchObject({
      IndexName: 'EmailDeliveryIndex', KeyConditionExpression: 'emailQueueShard = :shard AND emailNextAttemptAt <= :horizon',
      FilterExpression: 'recipientKey = :recipientKey',
      ExpressionAttributeValues: { ':shard': shard, ':recipientKey': recipientKey, ':horizon': '2026-10-04T12:00:00.000Z' },
    })
    expect(await store.listCompanions(opener, now, 1)).toMatchObject({ deliveries: [expect.anything()], complete: true })
  })
  test('reports an incomplete companion scan when the page budget runs out first', async () => {
    let page = 0
    const store = new DynamoDbChannelDeliveryStore({
      async send(command) {
        if (command instanceof QueryCommand) { page += 1; return { Items: [], LastEvaluatedKey: { page } } }
        return {}
      },
    }, 'notifications', 'email')
    const opener: ChannelDelivery = {
      workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
      notificationKey: '2026-09-26T11:00:00.000Z#opener', attempts: 0, version: 1, deliveryFrequency: 'daily',
      nextAttemptAt: '2026-09-26T12:00:00.000Z', expiresAt: Date.parse('2026-09-26T12:00:00.000Z') / 1_000 + 3_600,
      notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created',
        reasons: ['mention'], title: 'Review', occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
    }
    expect(await store.listCompanions(opener, new Date('2026-09-26T12:00:00.000Z'), 49)).toEqual({ deliveries: [], complete: false })
    expect(page).toBe(10)
  })
  test('reports an incomplete companion scan when a candidate row is corrupt', async () => {
    const store = new DynamoDbChannelDeliveryStore({
      async send(command) {
        if (command instanceof QueryCommand) return { Items: [{ recipientKey: 'workspace-1#member@example.test', notificationKey: 'broken' }] }
        if (command instanceof GetCommand) return { Item: { recipientKey: 'workspace-1#member@example.test', notificationKey: 'broken', emailQueueShard: emailDeliveryShard('workspace-1#member@example.test'), emailNextAttemptAt: 'not-a-date' } }
        return {}
      },
    }, 'notifications', 'email')
    const opener: ChannelDelivery = {
      workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
      notificationKey: '2026-09-26T11:00:00.000Z#opener', attempts: 0, version: 1, deliveryFrequency: 'daily',
      nextAttemptAt: '2026-09-26T12:00:00.000Z', expiresAt: Date.parse('2026-09-26T12:00:00.000Z') / 1_000 + 3_600,
      notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created',
        reasons: ['mention'], title: 'Review', occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
    }
    expect(await store.listCompanions(opener, new Date('2026-09-26T12:00:00.000Z'), 49)).toEqual({ deliveries: [], complete: false })
  })
})
