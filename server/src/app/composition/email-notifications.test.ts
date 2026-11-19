import { describe, expect, test } from 'bun:test'
import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import type { ChannelDelivery } from '../../modules/notifications'
import { createCognitoEmailRecipientReader, createProductionEmailNotificationHandler, parseEmailAppOrigin } from './email-notifications'

const delivery: ChannelDelivery = {
  workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
  notificationKey: 'key', attempts: 0, version: 1, nextAttemptAt: '2026-09-26T12:00:00.000Z', expiresAt: 2_000_000_000,
  notification: { id: 'n', eventId: 'e', eventType: 'comment.created', reasons: ['mention'], occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
}

/**
 * Creates a reader over a fixed membership row and Cognito response.
 * @param member - Workspace membership row, or undefined when absent.
 * @param user - AdminGetUser response, or an error to throw.
 * @returns Reader and the Cognito usernames it asked for.
 */
function reader(member: Record<string, unknown> | undefined, user: Record<string, unknown> | Error) {
  const usernames: Array<string | undefined> = []
  const read = createCognitoEmailRecipientReader(
    { send: async () => ({ Item: member, $metadata: {} }) },
    'workspace-access', 'pool-1',
    {
      send: async (command: unknown) => {
        if (!(command instanceof AdminGetUserCommand)) throw new Error('Unexpected command')
        usernames.push(command.input.Username)
        if (user instanceof Error) throw user
        return { ...user, $metadata: {} }
      },
    },
  )
  return { read, usernames }
}

describe('Email notification composition', () => {
  test('stays idle without a configured sender', async () => {
    const previous = process.env.NOTIFICATION_EMAIL_SENDER
    delete process.env.NOTIFICATION_EMAIL_SENDER
    try {
      expect(await createProductionEmailNotificationHandler()()).toBe(0)
    } finally {
      if (previous !== undefined) process.env.NOTIFICATION_EMAIL_SENDER = previous
    }
  })
  test('accepts only HTTPS application origins outside loopback development', () => {
    expect(parseEmailAppOrigin('https://app.example.test/path')).toBe('https://app.example.test')
    expect(parseEmailAppOrigin('http://localhost:5173')).toBe('http://localhost:5173')
    expect(() => parseEmailAppOrigin('http://app.example.test')).toThrow('HTTPS')
    expect(() => parseEmailAppOrigin(undefined)).toThrow('absolute URL')
  })
  test('reads the verified Cognito address of the active member by their Cognito username', async () => {
    const attributes = [{ Name: 'email', Value: 'member@example.test' }, { Name: 'email_verified', Value: 'true' }]
    const f = reader({ status: 'active', username: 'cognito-user' }, { Enabled: true, UserAttributes: attributes })
    expect(await f.read(delivery)).toEqual({ kind: 'verified', address: 'member@example.test' })
    expect(f.usernames).toEqual(['cognito-user'])
    expect(await reader({ status: 'active' }, { UserAttributes: [attributes[0]] }).read(delivery)).toEqual({ kind: 'unverified' })
    expect(await reader({ status: 'active' }, { Enabled: false, UserAttributes: attributes }).read(delivery)).toEqual({ kind: 'missing' })
    expect(await reader({ status: 'removed' }, { UserAttributes: attributes }).read(delivery)).toEqual({ kind: 'missing' })
    expect(await reader({ status: 'active' }, Object.assign(new Error('gone'), { name: 'UserNotFoundException' })).read(delivery)).toEqual({ kind: 'missing' })
    await expect(reader({ status: 'active' }, new Error('Cognito down')).read(delivery)).rejects.toThrow('Cognito down')
  })
})
