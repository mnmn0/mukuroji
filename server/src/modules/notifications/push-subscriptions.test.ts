import { describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import { Hono } from 'hono'
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { createPushSubscriptionRouter } from './adapter-in/http/push-subscription-router'
import { DynamoDbPushSubscriptionStore } from './adapter-out/dynamodb/push-subscription-store'
import type { PushSubscriptionStore } from './application/push-subscriptions'
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER,
  createPushConfiguration,
  createPushSubscriptionId,
  isPushServiceHost,
  readPushSubscriptionInput,
  readPushSubscriptionRemoval,
} from './domain/push-subscription'
import { NotificationError } from './notifications'

const p256dh = createP256PublicKey()
const auth = Buffer.alloc(16, 2).toString('base64url')

/**
 * Creates a valid uncompressed P-256 public key.
 *
 * @returns base64url-encoded key.
 */
function createP256PublicKey(): string {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return ecdh.getPublicKey().toString('base64url')
}
const endpoint = 'https://fcm.googleapis.com/fcm/send/device-token'

describe('push subscription validation', () => {
  test('accepts a browser subscription on a push service', () => {
    expect(readPushSubscriptionInput({ endpoint, keys: { p256dh, auth } })).toEqual({
      endpoint,
      keys: { p256dh, auth },
      subscriptionId: createPushSubscriptionId(endpoint),
    })
  })

  test('only allows push service hosts, so the worker cannot be pointed elsewhere', () => {
    expect(isPushServiceHost('fcm.googleapis.com')).toBe(true)
    expect(isPushServiceHost('web.push.apple.com')).toBe(true)
    expect(isPushServiceHost('wns2-by3p.notify.windows.com')).toBe(true)
    expect(isPushServiceHost('evilpush.apple.com')).toBe(false)
    expect(isPushServiceHost('fcm.googleapis.com.evil.example')).toBe(false)
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://169.254.169.254/latest',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://internal.example/fcm',
      `https://fcm.googleapis.com/${'x'.repeat(2_100)}`,
    ]) {
      expect(() => readPushSubscriptionInput({ endpoint: bad, keys: { p256dh, auth } }), bad).toThrow(NotificationError)
    }
  })

  test('rejects malformed keys and unknown fields', () => {
    const compressed = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]).toString('base64url')
    for (const body of [
      { endpoint, keys: { p256dh: compressed, auth } },
      { endpoint, keys: { p256dh, auth: Buffer.alloc(15).toString('base64url') } },
      { endpoint, keys: { p256dh: `${p256dh}=`, auth } },
      { endpoint, keys: { p256dh, auth, extra: 'x' } },
      { endpoint, keys: { p256dh, auth }, memberKey: 'someone-else' },
      { endpoint },
      'nope',
    ]) {
      expect(() => readPushSubscriptionInput(body)).toThrow(NotificationError)
    }
    expect(readPushSubscriptionRemoval({ endpoint })).toBe(endpoint)
    expect(() => readPushSubscriptionRemoval({ endpoint, other: 1 })).toThrow(NotificationError)
  })

  test('enables push only with a well-formed VAPID public key', () => {
    expect(createPushConfiguration(p256dh)).toEqual({ enabled: true, vapidPublicKey: p256dh })
    expect(createPushConfiguration('')).toEqual({ enabled: false })
    expect(createPushConfiguration(undefined)).toEqual({ enabled: false })
    expect(createPushConfiguration(auth)).toEqual({ enabled: false })
    // 65 bytes starting with 0x04 that are not a point on the curve, like a mistyped key.
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url')
    expect(createPushConfiguration(offCurve)).toEqual({ enabled: false })
  })
})

/** One recorded DynamoDB command. */
type SentCommand = GetCommand | QueryCommand | DeleteCommand | TransactWriteCommand

/**
 * Creates a fake document client backed by scripted responses.
 *
 * @param respond - Returns the response for each command.
 * @returns The client and the commands it received.
 */
function createClient(respond: (command: SentCommand) => Promise<Record<string, unknown>>) {
  const sent: SentCommand[] = []
  return {
    sent,
    client: {
      send: async (command: SentCommand) => {
        sent.push(command)
        return await respond(command)
      },
    },
  }
}

/**
 * Creates an error shaped like an AWS SDK exception.
 *
 * @param name - Exception name.
 * @param cancellationCodes - Transaction cancellation reason codes, if any.
 * @returns The error.
 */
function awsError(name: string, cancellationCodes?: string[]): Error {
  const error = new Error(name)
  error.name = name
  if (cancellationCodes) Reflect.set(error, 'CancellationReasons', cancellationCodes.map((Code) => ({ Code })))
  return error
}

const subscription = readPushSubscriptionInput({ endpoint, keys: { p256dh, auth } })
const now = new Date('2026-10-19T00:00:00.000Z')

describe('DynamoDbPushSubscriptionStore', () => {
  test('takes an endpoint over from another member so one device never gets two people’s pushes', async () => {
    const { client, sent } = createClient(async (command) => {
      if (command instanceof GetCommand) return { Item: { workspaceId: 'ws-1', memberKey: 'bob' } }
      if (command instanceof QueryCommand) return { Count: 1 }
      return {}
    })
    await new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now)
    const transaction = sent.find((command) => command instanceof TransactWriteCommand)
    const items = transaction instanceof TransactWriteCommand ? transaction.input.TransactItems ?? [] : []
    const memberExpiresAt = Math.floor(now.getTime() / 1_000) + 180 * 86_400
    expect(items).toHaveLength(4)
    // The owner outlives the member rows it guards, so TTL never splits ownership.
    expect(items[0]?.Put?.Item).toMatchObject({ pk: `endpoint#${subscription.subscriptionId}`, workspaceId: 'ws-1', memberKey: 'ada', expiresAt: memberExpiresAt + 30 * 86_400 })
    expect(items[0]?.Put?.ConditionExpression).toBe('workspaceId = :ownerWorkspace AND memberKey = :ownerMember')
    expect(items[1]?.Put?.Item).toMatchObject({ pk: 'member#ws-1#ada', endpoint, p256dh, auth, expiresAt: memberExpiresAt })
    // A new device bumps the member's registration version, fencing the device count.
    expect(items[2]?.Update).toMatchObject({ Key: { pk: 'member#ws-1#ada', sk: 'devices' }, ConditionExpression: 'attribute_not_exists(version)' })
    expect(items[3]?.Delete?.Key).toEqual({ pk: 'member#ws-1#bob', sk: `subscription#${subscription.subscriptionId}` })
  })

  test('refreshes the member’s own subscription without counting it against the limit', async () => {
    const { client, sent } = createClient(async (command) => {
      if (command instanceof GetCommand) return { Item: { workspaceId: 'ws-1', memberKey: 'ada' } }
      return {}
    })
    await new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now)
    expect(sent.some((command) => command instanceof QueryCommand)).toBe(false)
    const transaction = sent.find((command) => command instanceof TransactWriteCommand)
    expect(transaction instanceof TransactWriteCommand ? transaction.input.TransactItems?.length : 0).toBe(2)
  })

  test('limits the devices one member registers', async () => {
    const { client } = createClient(async (command) => {
      if (command instanceof QueryCommand) return { Count: MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER }
      return {}
    })
    await expect(new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now))
      .rejects.toMatchObject({ status: 409, code: 'PushSubscriptionLimitExceeded' })
  })

  test('fences new devices with the registration version read alongside the count', async () => {
    const { client, sent } = createClient(async (command) => {
      if (command instanceof GetCommand && command.input.Key?.sk === 'devices') return { Item: { version: 7 } }
      if (command instanceof QueryCommand) return { Count: MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER - 1 }
      return {}
    })
    await new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now)
    const transaction = sent.find((command) => command instanceof TransactWriteCommand)
    const items = transaction instanceof TransactWriteCommand ? transaction.input.TransactItems ?? [] : []
    expect(items[2]?.Update).toMatchObject({
      ConditionExpression: 'version = :current',
      ExpressionAttributeValues: { ':current': 7, ':next': 8, ':workspace': 'ws-1' },
    })
  })

  test('retries a lost ownership race, then reports a conflict', async () => {
    let transactions = 0
    const { client } = createClient(async (command) => {
      if (command instanceof TransactWriteCommand) {
        transactions += 1
        throw awsError('TransactionCanceledException', ['None', 'ConditionalCheckFailed', 'None'])
      }
      return {}
    })
    await expect(new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now))
      .rejects.toMatchObject({ status: 409, code: 'PushSubscriptionConflict' })
    expect(transactions).toBe(3)
  })

  test('keeps throttling and other non-race cancellations as infrastructure failures', async () => {
    let transactions = 0
    const { client } = createClient(async (command) => {
      if (command instanceof TransactWriteCommand) {
        transactions += 1
        throw awsError('TransactionCanceledException', ['ThrottlingError', 'None', 'None'])
      }
      return {}
    })
    await expect(new DynamoDbPushSubscriptionStore(client, 'push').register('ws-1', 'ada', subscription, now))
      .rejects.toMatchObject({ name: 'TransactionCanceledException' })
    expect(transactions).toBe(1)
  })

  test('removes the member’s subscription and releases the endpoint only while still owned', async () => {
    const { client, sent } = createClient(async (command) => {
      if (command instanceof DeleteCommand && command.input.ConditionExpression) throw awsError('ConditionalCheckFailedException')
      return {}
    })
    await new DynamoDbPushSubscriptionStore(client, 'push').remove('ws-1', 'ada', endpoint)
    expect(sent.map((command) => command instanceof DeleteCommand ? command.input.Key : undefined)).toEqual([
      { pk: 'member#ws-1#ada', sk: `subscription#${subscription.subscriptionId}` },
      { pk: `endpoint#${subscription.subscriptionId}`, sk: 'owner' },
    ])
  })
})

describe('push subscription routes', () => {
  /**
   * Creates the routes with a recording store.
   *
   * @param options - Principal kind and configuration.
   * @returns The app and recorded store calls.
   */
  function createRoutes(options: { principalKind?: string, enabled?: boolean } = {}) {
    const calls: string[] = []
    const store: PushSubscriptionStore = {
      register: async (workspaceId, memberKey, value) => { calls.push(`register ${workspaceId} ${memberKey} ${value.subscriptionId}`) },
      remove: async (workspaceId, memberKey, value) => { calls.push(`remove ${workspaceId} ${memberKey} ${value}`) },
    }
    const app = new Hono()
    app.route('/', createPushSubscriptionRouter({
      authenticate: async () => ({ directoryId: 'ws-1', userKey: 'ada', ...(options.principalKind ? { principalKind: options.principalKind } : {}) }),
      getStore: () => store,
      getConfiguration: () => (options.enabled === false ? { enabled: false } : { enabled: true, vapidPublicKey: p256dh }),
      mapError: (context, error) => context.json(
        { code: error instanceof NotificationError ? error.code : 'Error' },
        error instanceof NotificationError && error.status === 403 ? 403 : error instanceof NotificationError && error.status === 409 ? 409 : 400,
      ),
      readJson: async (request) => await request.json().catch(() => undefined),
      now: () => now,
    }))
    return { app, calls }
  }

  /**
   * Sends a JSON request with a bearer token.
   *
   * @param app - App under test.
   * @param method - HTTP method.
   * @param path - Request path.
   * @param body - JSON body.
   * @returns The response.
   */
  async function send(app: Hono, method: string, path: string, body?: unknown) {
    return await app.request(path, {
      method,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  test('returns the configuration to signed-in members only', async () => {
    const { app } = createRoutes()
    expect(await (await send(app, 'GET', '/api/push/config')).json()).toEqual({ enabled: true, vapidPublicKey: p256dh })
    expect((await app.request('/api/push/config')).status).toBe(401)
  })

  test('registers and removes the device for the authenticated member', async () => {
    const { app, calls } = createRoutes()
    expect((await send(app, 'PUT', '/api/push-subscriptions', { endpoint, keys: { p256dh, auth } })).status).toBe(204)
    expect((await send(app, 'DELETE', '/api/push-subscriptions', { endpoint })).status).toBe(204)
    expect(calls).toEqual([
      `register ws-1 ada ${subscription.subscriptionId}`,
      `remove ws-1 ada ${endpoint}`,
    ])
  })

  test('refuses service accounts, disabled deployments, and invalid bodies', async () => {
    expect((await send(createRoutes({ principalKind: 'service-account' }).app, 'PUT', '/api/push-subscriptions', { endpoint, keys: { p256dh, auth } })).status).toBe(403)
    expect((await send(createRoutes({ enabled: false }).app, 'PUT', '/api/push-subscriptions', { endpoint, keys: { p256dh, auth } })).status).toBe(409)
    const { app, calls } = createRoutes()
    expect((await send(app, 'PUT', '/api/push-subscriptions', { endpoint: 'https://internal.example/x', keys: { p256dh, auth } })).status).toBe(400)
    expect(calls).toEqual([])
  })
})
