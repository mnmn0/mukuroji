import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import {
  DynamoDbEnterpriseSessionActivityClient,
  InMemoryEnterpriseSessionActivityClient,
} from './enterprise-session-activity'

/**
 * Creates a DynamoDB session activity client backed by an in-memory table.
 *
 * The fake honors the two condition expressions the client writes with, so conditional
 * failures reach the client the way DynamoDB reports them.
 *
 * @param rows - Table rows keyed by `connectionId`.
 * @param failure - Error every command throws instead of reaching the table.
 * @returns The client.
 */
function createDynamoSessionActivityClient(
  rows: Map<string, Record<string, unknown>>,
  failure?: Error,
) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  spyOn(documentClient, 'send').mockImplementation(async (command) => {
    if (failure) throw failure
    if (command instanceof GetCommand) {
      const key = command.input.Key?.connectionId
      return { Item: typeof key === 'string' ? rows.get(key) : undefined }
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item ?? {}
      const key = item.connectionId
      if (typeof key !== 'string') throw new TypeError('The row is missing a connection ID.')
      const existing = rows.get(key)
      const currentTime: unknown = command.input.ExpressionAttributeValues?.[':currentTime']
      const expiresAt: unknown = command.input.ExpressionAttributeValues?.[':expiresAt']
      const conditionFailed = command.input.ConditionExpression === 'attribute_not_exists(connectionId)'
        ? existing !== undefined
        : command.input.ConditionExpression ===
            'attribute_not_exists(connectionId) OR expiresAt < :expiresAt'
          ? existing !== undefined && typeof expiresAt === 'number' &&
            typeof existing.expiresAt === 'number' && existing.expiresAt >= expiresAt
          : typeof currentTime === 'number' && typeof existing?.lastSeenAt === 'number' &&
            existing.lastSeenAt > currentTime
      if (conditionFailed) {
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      rows.set(key, { ...item })
      return {}
    }
    throw new TypeError('Unexpected DynamoDB command.')
  })
  return new DynamoDbEnterpriseSessionActivityClient('session-table', documentClient)
}

test('persists server-verified MFA assurance without storing a raw access token', async () => {
  const client = new InMemoryEnterpriseSessionActivityClient()
  await client.recordAuthenticationAssurance({
    workspaceId: 'workspace-1',
    sessionId: 'access-token-sha256',
    authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    authenticatedAt: 1_000,
    expiresAt: 4_600,
  })

  expect(await client.getAuthenticationMethods(
    'workspace-1',
    'access-token-sha256',
  )).toEqual(['SOFTWARE_TOKEN_MFA'])
  expect(await client.getAuthenticationMethods(
    'workspace-2',
    'access-token-sha256',
  )).toEqual([])
})

test('enforces idle timeout and preserves verified authentication methods', async () => {
  const client = new InMemoryEnterpriseSessionActivityClient()
  await client.recordAuthenticationAssurance({
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    authenticationMethods: ['SMS_MFA'],
    authenticatedAt: 1_000,
    expiresAt: 4_600,
  })

  await expect(client.validateAndTouch({
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    authenticatedAt: 1_000,
    now: 1_050,
    idleTimeoutMinutes: 1,
    sessionLifetimeMinutes: 60,
    authenticationMethods: [],
  })).resolves.toEqual(['SMS_MFA'])
  await expect(client.validateAndTouch({
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    authenticatedAt: 1_000,
    now: 1_111,
    idleTimeoutMinutes: 1,
    sessionLifetimeMinutes: 60,
    authenticationMethods: [],
  })).rejects.toMatchObject({
    code: 'EnterpriseSessionIdleTimeout',
    status: 403,
  })
})

test('uses token authentication time as first-request idle baseline', async () => {
  const client = new InMemoryEnterpriseSessionActivityClient()

  await expect(client.validateAndTouch({
    workspaceId: 'workspace-1',
    sessionId: 'never-seen',
    authenticatedAt: 1_000,
    now: 1_061,
    idleTimeoutMinutes: 1,
    sessionLifetimeMinutes: 60,
    authenticationMethods: ['pwd'],
  })).rejects.toMatchObject({ code: 'EnterpriseSessionIdleTimeout' })
})

test('continues a refreshed session without advancing its last activity', async () => {
  const client = new InMemoryEnterpriseSessionActivityClient()
  await client.recordAuthenticationAssurance({
    workspaceId: 'workspace-1',
    sessionId: 'session-before-refresh',
    authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    authenticatedAt: 1_000,
    expiresAt: 4_600,
  })

  await expect(client.continueSession({
    workspaceId: 'workspace-1',
    previousSessionId: 'session-before-refresh',
    sessionId: 'session-after-refresh',
    expiresAt: 8_200,
  })).resolves.toBe(true)
  await expect(client.continueSession({
    workspaceId: 'workspace-2',
    previousSessionId: 'session-before-refresh',
    sessionId: 'session-in-other-workspace',
    expiresAt: 8_200,
  })).resolves.toBe(false)

  expect(await client.getAuthenticationMethods('workspace-1', 'session-after-refresh'))
    .toEqual(['SOFTWARE_TOKEN_MFA'])
  await expect(client.validateAndTouch({
    workspaceId: 'workspace-1',
    sessionId: 'session-after-refresh',
    authenticatedAt: 1_000,
    now: 1_000 + 61 * 60,
    idleTimeoutMinutes: 60,
    sessionLifetimeMinutes: 480,
    authenticationMethods: [],
  })).rejects.toMatchObject({ code: 'EnterpriseSessionIdleTimeout' })
})

test('continues a refreshed session in DynamoDB without advancing its last activity', async () => {
  const rows = new Map<string, Record<string, unknown>>([[
    'HTTP_SESSION#workspace-1#session-before-refresh',
    {
      connectionId: 'HTTP_SESSION#workspace-1#session-before-refresh',
      itemType: 'http-session-activity',
      workspaceId: 'workspace-1',
      lastSeenAt: 1_000,
      authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
      expiresAt: 9_000,
    },
  ]])
  const client = createDynamoSessionActivityClient(rows)

  await expect(client.continueSession({
    workspaceId: 'workspace-1',
    previousSessionId: 'session-before-refresh',
    sessionId: 'session-after-refresh',
    expiresAt: 8_200,
  })).resolves.toBe(true)

  expect(rows.get('HTTP_SESSION#workspace-1#session-after-refresh')).toEqual({
    connectionId: 'HTTP_SESSION#workspace-1#session-after-refresh',
    itemType: 'http-session-activity',
    workspaceId: 'workspace-1',
    lastSeenAt: 1_000,
    authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    // The later of the previous record's and the refreshed token's expiry.
    expiresAt: 9_000,
  })
  expect(await client.getAuthenticationMethods('workspace-1', 'session-after-refresh'))
    .toEqual(['SOFTWARE_TOKEN_MFA'])
  await expect(client.validateAndTouch({
    workspaceId: 'workspace-1',
    sessionId: 'session-after-refresh',
    authenticatedAt: 1_000,
    now: 1_000 + 61 * 60,
    idleTimeoutMinutes: 60,
    sessionLifetimeMinutes: 480,
    authenticationMethods: [],
  })).rejects.toMatchObject({ code: 'EnterpriseSessionIdleTimeout' })
})

test('does not continue a DynamoDB session without a valid previous activity', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    ['HTTP_SESSION#workspace-1#unreadable', {
      connectionId: 'HTTP_SESSION#workspace-1#unreadable',
      workspaceId: 'workspace-1',
      lastSeenAt: '1000',
      authenticationMethods: ['SOFTWARE_TOKEN_MFA'],
    }],
    ['HTTP_SESSION#workspace-1#other-workspace', {
      connectionId: 'HTTP_SESSION#workspace-1#other-workspace',
      workspaceId: 'workspace-2',
      lastSeenAt: 1_000,
    }],
  ])
  const client = createDynamoSessionActivityClient(rows)

  for (const previousSessionId of ['unreadable', 'other-workspace', 'missing']) {
    await expect(client.continueSession({
      workspaceId: 'workspace-1',
      previousSessionId,
      sessionId: `${previousSessionId}-after-refresh`,
      expiresAt: 8_200,
    })).resolves.toBe(false)
  }
  expect(rows.size).toBe(2)
})

test('keeps an already continued DynamoDB session and falls back to the refreshed expiry', async () => {
  const continued = {
    connectionId: 'HTTP_SESSION#workspace-1#session-after-refresh',
    workspaceId: 'workspace-1',
    lastSeenAt: 2_000,
    authenticationMethods: ['SMS_MFA'],
    expiresAt: 8_200,
  }
  const rows = new Map<string, Record<string, unknown>>([
    ['HTTP_SESSION#workspace-1#session-before-refresh', {
      connectionId: 'HTTP_SESSION#workspace-1#session-before-refresh',
      workspaceId: 'workspace-1',
      lastSeenAt: 1_000,
      authenticationMethods: ['SMS_MFA'],
      expiresAt: 'never',
    }],
    ['HTTP_SESSION#workspace-1#session-after-refresh', continued],
  ])
  const client = createDynamoSessionActivityClient(rows)

  await expect(client.continueSession({
    workspaceId: 'workspace-1',
    previousSessionId: 'session-before-refresh',
    sessionId: 'session-after-refresh',
    expiresAt: 8_200,
  })).resolves.toBe(true)
  expect(rows.get('HTTP_SESSION#workspace-1#session-after-refresh')).toBe(continued)

  await expect(client.continueSession({
    workspaceId: 'workspace-1',
    previousSessionId: 'session-before-refresh',
    sessionId: 'second-refresh',
    expiresAt: 12_000,
  })).resolves.toBe(true)
  expect(rows.get('HTTP_SESSION#workspace-1#second-refresh')).toMatchObject({
    lastSeenAt: 1_000,
    expiresAt: 12_000,
  })
})

test('reports a DynamoDB failure while continuing a session as unavailable', async () => {
  const client = createDynamoSessionActivityClient(new Map(), new Error('connection reset'))

  await expect(client.continueSession({
    workspaceId: 'workspace-1',
    previousSessionId: 'session-before-refresh',
    sessionId: 'session-after-refresh',
    expiresAt: 8_200,
  })).rejects.toMatchObject({
    code: 'EnterpriseSessionActivityUnavailable',
    status: 503,
  })
})

test('remembers a signed-out sign-in per Workspace until its tokens expire', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const dynamo = createDynamoSessionActivityClient(rows)
  const memory = new InMemoryEnterpriseSessionActivityClient()

  for (const client of [dynamo, memory]) {
    expect(await client.isSignInRevoked('workspace-a', 'origin-1')).toBe(false)
    await client.revokeSignIn({ workspaceId: 'workspace-a', signInId: 'origin-1', expiresAt: 1_800 })
    expect(await client.isSignInRevoked('workspace-a', 'origin-1')).toBe(true)
    expect(await client.isSignInRevoked('workspace-a', 'origin-2')).toBe(false)
    expect(await client.isSignInRevoked('workspace-b', 'origin-1')).toBe(false)
    await expect(client.revokeSignIn({ workspaceId: 'workspace-a', signInId: ' ', expiresAt: 1_800 }))
      .rejects.toMatchObject({ code: 'EnterpriseSessionDenied' })
  }
  // A later sign-out with an earlier bound keeps the longer revocation.
  await dynamo.revokeSignIn({ workspaceId: 'workspace-a', signInId: 'origin-1', expiresAt: 900 })
  // The record carries the table TTL attribute, so DynamoDB removes it after the tokens expire.
  expect([...rows.values()]).toEqual([{
    connectionId: 'HTTP_SIGN_IN_REVOKED#workspace-a#origin-1',
    itemType: 'http-sign-in-revocation',
    workspaceId: 'workspace-a',
    expiresAt: 1_800,
  }])
})

test('fails closed on a sign-out record of another Workspace or shape', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    ['HTTP_SIGN_IN_REVOKED#workspace-a#origin-1', {
      connectionId: 'HTTP_SIGN_IN_REVOKED#workspace-a#origin-1',
      itemType: 'http-sign-in-revocation',
      workspaceId: 'workspace-b',
      expiresAt: 1_800,
    }],
    ['HTTP_SIGN_IN_REVOKED#workspace-a#origin-2', {
      connectionId: 'HTTP_SIGN_IN_REVOKED#workspace-a#origin-2',
      workspaceId: 'workspace-a',
    }],
  ])
  const client = createDynamoSessionActivityClient(rows)

  for (const signInId of ['origin-1', 'origin-2']) {
    await expect(client.isSignInRevoked('workspace-a', signInId))
      .rejects.toMatchObject({ status: 503, code: 'EnterpriseSessionActivityUnavailable' })
  }
})

test('reports a DynamoDB failure of the sign-out record as unavailable', async () => {
  const client = createDynamoSessionActivityClient(new Map(), new Error('DynamoDB is down'))

  await expect(client.revokeSignIn({ workspaceId: 'workspace-a', signInId: 'origin-1', expiresAt: 1_800 }))
    .rejects.toMatchObject({ status: 503, code: 'EnterpriseSessionActivityUnavailable' })
  await expect(client.isSignInRevoked('workspace-a', 'origin-1'))
    .rejects.toMatchObject({ status: 503, code: 'EnterpriseSessionActivityUnavailable' })
})
