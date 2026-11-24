import { describe, expect, test } from 'bun:test'
import { DeleteCommand, GetCommand, QueryCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { createPushSubscriptionId } from '../../domain/push-subscription'
import { DynamoDbPushSubscriptionStore } from './push-subscription-store'

type SentCommand = GetCommand | QueryCommand | TransactWriteCommand | DeleteCommand

const now = new Date('2026-11-24T00:00:00.000Z')
const nowSeconds = now.getTime() / 1_000

/**
 * Builds one stored member subscription row.
 * @param name - Endpoint suffix.
 * @param expiresAt - Retention deadline in Unix seconds.
 * @returns Row as DynamoDB returns it.
 */
function row(name: string, expiresAt = nowSeconds + 60) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}`
  return {
    pk: 'member#ws-1#ada', sk: `subscription#${createPushSubscriptionId(endpoint)}`, subscriptionId: createPushSubscriptionId(endpoint),
    endpoint, p256dh: 'p', auth: 'a', updatedAt: '2026-11-20T00:00:00.000Z', expiresAt,
  }
}

/**
 * Creates a fake client over member rows and owner records.
 * @param rows - Member subscription rows.
 * @param owners - Owner record per subscription ID.
 * @returns Store and the commands it sent.
 */
function store(rows: Record<string, unknown>[], owners: Record<string, Record<string, unknown> | undefined>) {
  const sent: SentCommand[] = []
  const client = {
    send: async (command: SentCommand) => {
      sent.push(command)
      if (command instanceof QueryCommand) return { Items: rows }
      if (command instanceof GetCommand) {
        const pk = String(command.input.Key?.pk)
        return { Item: owners[pk.replace('endpoint#', '')] }
      }
      return {}
    },
  }
  return { directory: new DynamoDbPushSubscriptionStore(client, 'push'), sent }
}

const owner = { workspaceId: 'ws-1', memberKey: 'ada', changedAt: 1, revision: 'r' }

describe('DynamoDbPushSubscriptionStore devices for delivery', () => {
  test('lists only unexpired devices whose endpoint is still owned by the recipient', async () => {
    const live = row('live')
    const expired = row('expired', nowSeconds)
    const takenOver = row('taken-over')
    const removed = row('removed')
    const f = store([live, expired, takenOver, removed], {
      [live.subscriptionId]: owner,
      [takenOver.subscriptionId]: { ...owner, memberKey: 'grace' },
      [removed.subscriptionId]: { ...owner, removed: true },
    })
    const devices = await f.directory.listDevices('ws-1', 'ada', now, AbortSignal.timeout(5_000))
    expect(devices).toEqual([{ subscriptionId: live.subscriptionId, endpoint: live.endpoint, keys: { p256dh: 'p', auth: 'a' }, updatedAt: live.updatedAt }])
    const query = f.sent[0]
    expect(query instanceof QueryCommand && query.input.ConsistentRead).toBe(true)
  })

  test('fails closed on a row whose ID does not match its endpoint or whose expiry is missing or malformed', async () => {
    const corrupt = { ...row('a'), subscriptionId: 'other' }
    await expect(store([corrupt], {}).directory.listDevices('ws-1', 'ada', now, AbortSignal.timeout(5_000))).rejects.toThrow('invalid')
    for (const expiresAt of [undefined, '2000000000', 1.5, Number.NaN]) {
      const unbounded = { ...row('b'), expiresAt }
      await expect(store([unbounded], { [unbounded.subscriptionId]: owner }).directory.listDevices('ws-1', 'ada', now, AbortSignal.timeout(5_000)))
        .rejects.toThrow('invalid')
    }
  })

  test('deletes only the exact registration that was sent to', async () => {
    const f = store([], {})
    const device = { subscriptionId: 'id', endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' }, updatedAt: '2026-11-20T00:00:00.000Z' }
    await f.directory.removeGoneDevice('ws-1', 'ada', device, AbortSignal.timeout(5_000))
    const deletion = f.sent[0]
    if (!(deletion instanceof DeleteCommand)) throw new Error('Expected a delete')
    expect(deletion.input).toMatchObject({
      Key: { pk: 'member#ws-1#ada', sk: 'subscription#id' },
      ConditionExpression: 'updatedAt = :updatedAt', ExpressionAttributeValues: { ':updatedAt': device.updatedAt },
    })
  })
})
