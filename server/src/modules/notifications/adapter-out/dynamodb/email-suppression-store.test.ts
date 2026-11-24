import { describe, expect, test } from 'bun:test'
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbEmailSuppressionStore } from './email-suppression-store'
import { DEFAULT_NOTIFICATION_PREFERENCES, toNotificationItem } from '../../notifications'

const recipientKey = 'workspace-1#member@example.test'
const suppressionRow = {
  recipientKey, notificationKey: '!EMAIL_SUPPRESSION', itemType: 'email-suppression',
  addressHash: 'a'.repeat(64), reason: 'bounce', suppressedAt: '2026-09-26T12:00:00.000Z',
}

/** Creates a store over fixed rows that records every command. */
function fixture(rows: { suppression?: Record<string, unknown>, emailEnabledAt?: string }, conditionFails = false) {
  const commands: Array<GetCommand | UpdateCommand> = []
  const store = new DynamoDbEmailSuppressionStore({
    async send(command) {
      commands.push(command)
      if (command instanceof UpdateCommand) {
        if (conditionFails) throw Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' })
        return {}
      }
      if (command.input.Key?.notificationKey === '!EMAIL_SUPPRESSION') return { Item: rows.suppression }
      return { Item: {
        ...DEFAULT_NOTIFICATION_PREFERENCES, recipientKey, notificationKey: '!PREFERENCES', itemType: 'preferences', version: 1,
        updatedAt: '2026-09-01T00:00:00.000Z', channels: { ...DEFAULT_NOTIFICATION_PREFERENCES.channels, email: true },
        ...(rows.emailEnabledAt ? { emailEnabledAt: rows.emailEnabledAt } : {}),
      } }
    },
  }, 'notifications')
  return { store, commands }
}

describe('DynamoDB Email suppression store', () => {
  test('writes the suppression beside the preferences and never replaces a newer one', async () => {
    const f = fixture({})
    await f.store.record(recipientKey, { addressHash: 'a'.repeat(64), reason: 'complaint', suppressedAt: '2026-09-26T12:00:00.000Z' })
    expect(f.commands[0]?.input).toMatchObject({
      Key: { recipientKey, notificationKey: '!EMAIL_SUPPRESSION' },
      ConditionExpression: 'attribute_not_exists(suppressedAt) OR suppressedAt <= :suppressedAt',
      ExpressionAttributeValues: { ':itemType': 'email-suppression', ':reason': 'complaint' },
    })
    await fixture({}, true).store.record(recipientKey, { addressHash: 'a'.repeat(64), reason: 'bounce', suppressedAt: '2026-09-26T12:00:00.000Z' })
  })
  test('applies the suppression until Email is turned on again after it', async () => {
    expect(await fixture({ suppression: suppressionRow, emailEnabledAt: '2026-09-20T00:00:00.000Z' }).store.readActive(recipientKey))
      .toEqual({ addressHash: 'a'.repeat(64), reason: 'bounce', suppressedAt: '2026-09-26T12:00:00.000Z' })
    expect(await fixture({ suppression: suppressionRow, emailEnabledAt: '2026-09-27T00:00:00.000Z' }).store.readActive(recipientKey)).toBeUndefined()
    expect(await fixture({}).store.readActive(recipientKey)).toBeUndefined()
  })
  test('fails closed on a corrupt row and keeps the row out of the Inbox', async () => {
    await expect(fixture({ suppression: { ...suppressionRow, addressHash: 'member@example.test' } }).store.readActive(recipientKey)).rejects.toThrow()
    expect(toNotificationItem(suppressionRow, recipientKey, new Date())).toBeUndefined()
    expect(() => toNotificationItem({ ...suppressionRow, notificationKey: 'other' }, recipientKey, new Date())).toThrow()
  })
})
