import { afterEach, expect, test } from 'bun:test'
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { LambdaEvent } from 'hono/aws-lambda'
import { createAuditEvent, createMutationAuditContext } from './audit'
import { CollaborationError, type CollaborationClient } from './collaboration'
import type { NotificationClient, NotificationItem } from './notifications'
import {
  createWorkspaceSearchDocument,
  type WorkspaceSearchClient,
  type WorkspaceSearchQueryInput,
  type WorkspaceSearchResolvedScope,
} from './workspace-search'
import {
  app,
  AwsCognitoClient,
  CognitoServiceError,
  configureApiClientsForTest,
  DynamoDbDashboardSummaryClient,
  DynamoDbProjectDirectoryClient,
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
  handler,
  resetApiClientsForTest,
  WorkspaceAccessError,
  type ProjectRole,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './index'

afterEach(() => {
  resetApiClientsForTest()
})

test('uses a strongly consistent Work Item read for authorization-sensitive detail loads', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Item: {
          directoryId: 'workspace-1',
          teamId: 'core-team',
          directoryTeamId: 'workspace-1#team#core-team',
          issueId: 'issue-1',
          sortOrder: 1,
          title: 'Authorization-sensitive issue',
          assigneeUserId: 'member@example.com',
          status: 'todo',
          dueDate: '2026/07/12',
          priority: 'medium',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    { send: async () => ({}) } as unknown as DynamoDBClient,
    false,
  )

  const detail = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', {
    consistentIssueRead: true,
    eventLimit: 0,
  })

  expect(sentInputs).toHaveLength(1)
  expect(detail.issue).toMatchObject({ schemaVersion: 1, revision: 1 })
  expect(sentInputs[0]).toMatchObject({
    TableName: 'issues-table',
    ConsistentRead: true,
  })
})

test('pages filtered legacy comments with a scope-bound opaque event cursor', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryPage = 0
  const issueItem = {
    directoryId: 'workspace-1',
    teamId: 'core-team',
    directoryTeamId: 'workspace-1#team#core-team',
    issueId: 'issue-1',
    sortOrder: 1,
    title: 'Legacy comments',
    assigneeUserId: 'member@example.com',
    status: 'todo',
    dueDate: '2026/07/12',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if (!('KeyConditionExpression' in command.input)) {
        return { Item: issueItem }
      }

      queryPage += 1
      const eventId = queryPage === 1 ? '2026-07-12T00:02:00.000Z#newer' : '2026-07-12T00:01:00.000Z#older'
      return {
        Items: [{
          directoryId: 'workspace-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
          eventId,
          eventType: 'commented',
          actorUserId: 'member@example.com',
          body: queryPage === 1 ? 'Newer legacy comment' : 'Older legacy comment',
          summary: 'Comment was added.',
          createdAt: eventId.slice(0, 24),
        }],
        ...(queryPage === 1
          ? {
              LastEvaluatedKey: {
                directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
                eventId,
              },
            }
          : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    { send: async () => ({}) } as unknown as DynamoDBClient,
    false,
  )
  const options = {
    consistentIssueRead: true,
    eventLimit: 1,
    eventType: 'commented' as const,
    newestEventsFirst: true,
  }

  const first = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', options)
  const second = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', {
    ...options,
    eventCursor: first.nextEventCursor,
  })

  expect(first.comments.map((comment) => comment.body)).toEqual(['Newer legacy comment'])
  expect(first.nextEventCursor).toBeString()
  expect(second.comments.map((comment) => comment.body)).toEqual(['Older legacy comment'])
  expect(sentInputs[1]).toMatchObject({
    TableName: 'events-table',
    FilterExpression: 'eventType = :eventType',
    Limit: 1,
    ScanIndexForward: false,
  })
  expect(sentInputs[3]?.ExclusiveStartKey).toEqual({
    directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
    eventId: '2026-07-12T00:02:00.000Z#newer',
  })
})

test('serves the same authenticated API contract from Function URL root and /api paths', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: '   ',
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
      MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production',
    },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'Demo@Example.com',
        'custom:directory_id': 'workspace#production',
        'custom:workspace_id': 'workspace#production',
      })
      const accessToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_mukuroji',
        token_use: 'access',
      })

      const directResponse = await handler(createLambdaHttpEvent('/teams/projects', accessToken))
      const prefixedResponse = await handler(createLambdaHttpEvent('/api/teams/projects', accessToken))

      expect(directResponse.statusCode).toBe(200)
      expect(prefixedResponse.statusCode).toBe(200)
      expect(JSON.parse(directResponse.body)).toEqual(JSON.parse(prefixedResponse.body))
      expect(calls.directoryReads).toEqual([
        { directoryId: 'workspace#production', locale: 'ja' },
        { directoryId: 'workspace#production', locale: 'ja' },
      ])
    },
  )
})

test('rejects conflicting Cognito directory attributes on auth me', async () => {
  configureFakeProjectClients(true)
  configureFakeAuthenticatedUser({
    email: 'demo@example.com',
    'custom:directory_id': 'workspace#one',
    'custom:workspace_id': 'workspace#two',
  })

  const response = await app.request('/api/auth/me', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    message: 'Cognito workspace does not match the configured workspace.',
  })
})

test('rejects a Cognito directory that differs from the configured DynamoDB workspace partition', async () => {
  await withTestEnvironment(
    { MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production' },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'demo@example.com',
        'custom:directory_id': 'workspace#other',
      })

      const response = await app.request('/api/teams/projects', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        message: 'Cognito workspace does not match the configured workspace.',
      })
      expect(calls.directoryReads).toEqual([])
    },
  )
})

test('accepts one Cognito workspace attribute with the legacy directory environment fallback', async () => {
  await withTestEnvironment(
    {
      MUKUROJI_PROJECT_DIRECTORY_ID: 'workspace#legacy',
      MUKUROJI_WORKSPACE_DIRECTORY_ID: undefined,
    },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'demo@example.com',
        'custom:workspace_id': 'workspace#legacy',
      })

      const response = await app.request('/api/teams/projects', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(200)
      expect(calls.directoryReads).toEqual([
        { directoryId: 'workspace#legacy', locale: 'ja' },
      ])
    },
  )
})

test('rejects a token from another Cognito pool before calling GetUser', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: undefined,
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )
      const accessToken = createAccessToken([], {
        client_id: 'other-client',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other',
        token_use: 'access',
      })

      const response = await app.request('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ message: 'Authentication failed.' })
      expect(getUserCalls).toBe(0)
    },
  )
})

test('uses an explicit Floci public issuer and rejects other issuers before GetUser', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: '  http://localhost:4567/us-east-1_mukuroji/  ',
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )
      const validAccessToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'http://localhost:4567/us-east-1_mukuroji',
        token_use: 'access',
      })
      const wrongIssuerToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'http://localhost:4567/us-east-1_other',
        token_use: 'access',
      })

      const validResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${validAccessToken}` },
      })
      const wrongIssuerResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${wrongIssuerToken}` },
      })

      expect(validResponse.status).toBe(200)
      expect(wrongIssuerResponse.status).toBe(401)
      expect(await wrongIssuerResponse.json()).toEqual({ message: 'Authentication failed.' })
      expect(getUserCalls).toBe(1)
    },
  )
})

test('fails closed when production Cognito pool or client configuration is missing', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: undefined,
      COGNITO_USER_POOL_ID: undefined,
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )

      const response = await app.request('/api/auth/me', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ message: 'Cognito is not configured.' })
      expect(getUserCalls).toBe(0)
    },
  )
})

test('uses AWS Cognito SDK commands and excludes users with conflicting workspace attributes', async () => {
  const commandNames: string[] = []
  const sdkClient = {
    async send(command: object) {
      const commandName = command.constructor.name
      commandNames.push(commandName)

      if (commandName === 'InitiateAuthCommand') {
        return { AuthenticationResult: { AccessToken: 'access-token' } }
      }

      if (commandName === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      if (commandName === 'ListUsersCommand') {
        return {
          Users: [
            {
              Username: 'valid@example.com',
              Attributes: [
                { Name: 'email', Value: 'valid@example.com' },
                { Name: 'custom:directory_id', Value: 'workspace#production' },
                { Name: 'custom:workspace_id', Value: 'workspace#production' },
              ],
            },
            {
              Username: 'conflicting@example.com',
              Attributes: [
                { Name: 'email', Value: 'conflicting@example.com' },
                { Name: 'custom:directory_id', Value: 'workspace#production' },
                { Name: 'custom:workspace_id', Value: 'workspace#other' },
              ],
            },
          ],
        }
      }

      return {
        Username: 'valid@example.com',
        UserAttributes: [{ Name: 'email', Value: 'valid@example.com' }],
      }
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(sdkClient, 'us-east-1_mukuroji', 'mukuroji-client')

  await expect(client.initiatePasswordAuth('demo@example.com', 'password')).resolves.toMatchObject({
    AuthenticationResult: { AccessToken: 'access-token' },
  })
  await expect(client.getUser('access-token')).resolves.toMatchObject({
    Username: 'demo@example.com',
  })
  await expect(client.listUsers({ directoryId: 'workspace#production' })).resolves.toEqual({
    users: [
      {
        id: 'valid@example.com',
        username: 'valid@example.com',
        email: 'valid@example.com',
        name: undefined,
        enabled: undefined,
        status: undefined,
      },
    ],
    nextToken: undefined,
  })
  await expect(client.getUserProfile('valid@example.com')).resolves.toMatchObject({
    id: 'valid@example.com',
  })
  expect(commandNames).toEqual([
    'InitiateAuthCommand',
    'GetUserCommand',
    'ListUsersCommand',
    'AdminGetUserCommand',
  ])
})

test('keeps the AWS Cognito client contract for challenge and Workspace identity operations', async () => {
  const commandInputs: Array<{ name: string; input: Record<string, unknown> }> = []
  let adminGetUserCalls = 0
  const sdkClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name
      commandInputs.push({ name, input: command.input })

      if (name === 'RespondToAuthChallengeCommand') {
        return {
          AuthenticationResult: { AccessToken: 'challenge-access-token' },
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: 'next-session',
        }
      }

      if (name === 'AdminGetUserCommand') {
        adminGetUserCalls += 1

        if (adminGetUserCalls < 3) {
          throw {
            $metadata: { httpStatusCode: 404 },
            message: 'User not found',
            name: 'UserNotFoundException',
          }
        }

        return {
          Attributes: [
            { Name: 'email', Value: 'new@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace-1' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
          Username: 'new@example.com',
        }
      }

      if (name === 'AdminCreateUserCommand') {
        return {
          User: {
            Attributes: [
              { Name: 'email', Value: 'new@example.com' },
              { Name: 'custom:directory_id', Value: 'workspace-1' },
              { Name: 'name', Value: 'New User' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
            Username: 'new@example.com',
          },
        }
      }

      if (name === 'AdminDeleteUserCommand') {
        return {}
      }

      throw new Error(`Unexpected Cognito command: ${name}`)
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(sdkClient, 'us-east-1_mukuroji', 'mukuroji-client')

  await expect(
    client.respondToNewPasswordChallenge('demo@example.com', 'new-password', 'session-1'),
  ).resolves.toMatchObject({
    AuthenticationResult: { AccessToken: 'challenge-access-token' },
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: 'next-session',
  })
  await expect(client.findWorkspaceUser('missing@example.com')).resolves.toBeUndefined()
  await expect(client.provisionWorkspaceUser({
    directoryId: 'workspace-1',
    email: 'new@example.com',
    name: 'New User',
  })).resolves.toMatchObject({
    deliveryStatus: 'sent',
    identityOwnership: 'workspace-created',
    profile: {
      id: 'new@example.com',
      name: 'New User',
      status: 'FORCE_CHANGE_PASSWORD',
    },
  })
  await expect(client.findWorkspaceUser('new@example.com')).resolves.toMatchObject({
    directoryId: 'workspace-1',
    profile: { id: 'new@example.com' },
  })
  await expect(client.resendWorkspaceUserInvitation('new@example.com')).resolves.toBeUndefined()
  await expect(client.deleteWorkspaceUser('new@example.com')).resolves.toBeUndefined()

  expect(commandInputs.map(({ name }) => name)).toEqual([
    'RespondToAuthChallengeCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminDeleteUserCommand',
  ])
  expect(commandInputs[0]).toMatchObject({
    input: {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ChallengeResponses: {
        NEW_PASSWORD: 'new-password',
        USERNAME: 'demo@example.com',
      },
      ClientId: 'mukuroji-client',
      Session: 'session-1',
    },
    name: 'RespondToAuthChallengeCommand',
  })
})

test('normalizes AWS Cognito SDK errors inside the Cognito module', async () => {
  const sdkClient = {
    async send() {
      throw {
        $metadata: { httpStatusCode: 400 },
        message: 'Invalid credentials',
        name: 'NotAuthorizedException',
      }
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(sdkClient, 'us-east-1_mukuroji', 'mukuroji-client')

  await expect(client.initiatePasswordAuth('demo@example.com', 'password')).rejects.toMatchObject({
    code: 'NotAuthorizedException',
    message: 'Invalid credentials',
    status: 400,
  })
})

test('keeps the Bun development Cognito default on local Floci', async () => {
  await withTestEnvironment(
    {
      AWS_ENDPOINT_URL: undefined,
      AWS_LAMBDA_FUNCTION_NAME: undefined,
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_ENDPOINT: undefined,
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requestedUrls: string[] = []
      globalThis.fetch = (async (input) => {
        requestedUrls.push(String(input))

        return new Response(JSON.stringify({
          AuthenticationResult: { AccessToken: 'local-access-token' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch
      resetApiClientsForTest()

      try {
        const response = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'demo@example.com',
            password: 'password',
          }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ accessToken: 'local-access-token' })
        expect(requestedUrls).toEqual(['http://localhost:4566/'])
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

test('uses ALLOWED_ORIGINS for shared Hono CORS responses', async () => {
  await withTestEnvironment(
    { ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com' },
    async () => {
      const allowedResponse = await app.request('/api/health', {
        headers: { Origin: 'https://admin.example.com' },
      })
      const deniedResponse = await app.request('/api/health', {
        headers: { Origin: 'https://other.example.com' },
      })

      expect(allowedResponse.headers.get('access-control-allow-origin')).toBe(
        'https://admin.example.com',
      )
      expect(deniedResponse.headers.get('access-control-allow-origin')).toBeNull()
    },
  )
})

test('loads project directory from the authenticated user scoped partition', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/projects?locale=en', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(calls.directoryReads).toEqual([{ directoryId: 'user#demo@example.com', locale: 'en' }])
})

/** Notification visibility API test に使う render-ready item を作ります。 */
function createNotificationItem(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: 'notification-item',
    eventId: 'notification-event',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread',
    ...overrides,
  }
}

/** NotificationClient 経由で API の current visibility 判定結果を記録します。 */
function createNotificationVisibilityProbe(notifications: NotificationItem[]) {
  const visibility = new Map<string, boolean>()
  const client: NotificationClient = {
    async list(input) {
      const visibleNotifications: NotificationItem[] = []
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible) {
          visibleNotifications.push(notification)
        }
      }
      return { notifications: visibleNotifications }
    },
    async countUnread(input) {
      let count = 0
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible && notification.state === 'unread') {
          count += 1
        }
      }
      return count
    },
    async update() {
      throw new Error('Notification update is not configured for this visibility test.')
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  return { client, visibility }
}

test('serves permission-filtered notification timeline, state, and preference contracts', async () => {
  const projectCalls = configureFakeProjectClients(true, {
    detailAssigneeUserId: 'demo@example.com',
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    title: 'Notification API',
    deepLink: '/teams/core-team/issues?issueId=notification-api',
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-api',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  const calls: {
    filter?: string
    action?: string
    savedPreferenceVersion?: number
  } = {}
  const notificationClient: NotificationClient = {
    async list(input) {
      calls.filter = input.filter
      expect(input.workspaceId).toBe('user#demo@example.com')
      expect(input.memberKey).toBe('demo@example.com')
      expect(await input.isVisible?.(notification)).toBe(true)
      expect(await input.isVisible?.({ ...notification, issueId: undefined, projectId: 'hidden-project' })).toBe(false)
      return { notifications: [notification], nextCursor: 'next-page' }
    },
    async countUnread() {
      return calls.action === 'mark-read' ? 0 : 1
    },
    async update(input) {
      calls.action = input.action
      return { ...notification, state: 'read', readAt: '2026-07-12T13:00:00.000Z' }
    },
    async markAllRead() {
      return 1
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      calls.savedPreferenceVersion = input.preferences.version
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  configureApiClientsForTest({ notifications: notificationClient })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const listResponse = await app.request('/api/notifications?filter=unread&limit=20', { headers })
  expect(listResponse.status).toBe(200)
  expect(await listResponse.json()).toMatchObject({
    notifications: [{ id: 'opaque-notification-id', state: 'unread' }],
    nextCursor: 'next-page',
    unreadCount: 1,
  })
  expect(calls.filter).toBe('unread')
  expect(projectCalls.directoryReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    locale: 'ja',
    consistentRead: true,
  })

  const updateResponse = await app.request('/api/notifications/opaque-notification-id', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ action: 'mark-read' }),
  })
  expect(updateResponse.status).toBe(200)
  expect(await updateResponse.json()).toMatchObject({ state: 'read' })
  expect(calls.action).toBe('mark-read')

  const preferenceResponse = await app.request('/api/notification-preferences', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      version: 0,
      channels: { inApp: true, email: true, push: false },
      frequency: 'daily',
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Asia/Tokyo' },
    }),
  })
  expect(preferenceResponse.status).toBe(200)
  expect(await preferenceResponse.json()).toMatchObject({ version: 1, frequency: 'daily' })
  expect(calls.savedPreferenceVersion).toBe(0)
})

test('hides a notification after its Work Item moves to an inaccessible project', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'private-project',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'moved-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  let currentlyVisible = true
  const notificationClient = {
    async list(input) {
      currentlyVisible = await input.isVisible?.(notification) ?? true
      return { notifications: currentlyVisible ? [notification] : [] }
    },
    async countUnread(input) {
      return await input.isVisible?.(notification) ? 1 : 0
    },
    async update() {
      return notification
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant' as const,
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return input.preferences
    },
  } as NotificationClient
  configureApiClientsForTest({ notifications: notificationClient })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(currentlyVisible).toBe(false)
  expect(notification.projectId).toBe('private-project')
  expect(await response.json()).toMatchObject({ notifications: [], unreadCount: 0 })
})

test('keeps a shared-project notification visible under every active owner Team', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'shared-launch',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'shared-launch', role: 'viewer' }],
    teamProjects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    }],
  })
  const coreNotification = createNotificationItem({
    id: 'shared-project-core-notification',
    issueId: 'shared-project-core-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
  })
  const designNotification = createNotificationItem({
    id: 'shared-project-design-notification',
    issueId: 'shared-project-design-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
    teamId: 'design-team',
  })
  const probe = createNotificationVisibilityProbe([coreNotification, designNotification])
  configureApiClientsForTest({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(coreNotification.id)).toBe(true)
  expect(probe.visibility.get(designNotification.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: coreNotification.id }, { id: designNotification.id }],
    unreadCount: 2,
  })
})

test('hides stale assignee-only notifications after Work Item reassignment', async () => {
  configureFakeProjectClients(true, {
    detailAssigneeUserId: 'sato@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  const staleAssignment = createNotificationItem({
    id: 'stale-assignment',
    reasons: ['assignment'],
  })
  const staleDue = createNotificationItem({
    id: 'stale-due',
    reasons: ['due'],
  })
  const retainedMention = createNotificationItem({
    id: 'retained-mention',
    reasons: ['assignment', 'mention'],
  })
  const probe = createNotificationVisibilityProbe([staleAssignment, staleDue, retainedMention])
  configureApiClientsForTest({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(staleAssignment.id)).toBe(false)
  expect(probe.visibility.get(staleDue.id)).toBe(false)
  expect(probe.visibility.get(retainedMention.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: retainedMention.id }],
    unreadCount: 1,
  })
})

test('returns Cognito groups and system admin status for the current user', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    groups: ['mukuroji-system-admins'],
    isSystemAdmin: true,
  })
})

test('returns Workspace role and active status for the current user', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/auth/me', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    workspaceRole: 'admin',
    workspaceMemberStatus: 'active',
  })
})

test('blocks a deactivated Workspace member before any business API read', async () => {
  const calls = configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })

  const response = await app.request('/api/teams/projects', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Workspace access is denied.' })
  expect(calls.directoryReads).toEqual([])
})

test('keeps guest Workspace members read-only even when they have a project role', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'guest' })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Guest must not create this task',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.taskCreates).toEqual([])
})

test('limits Workspace structure changes to owners and admins', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Unauthorized team' }),
  })

  expect(response.status).toBe(403)
  expect(calls.teamCreates).toEqual([])
})

test('rejects inactive Workspace members as task assignment candidates', async () => {
  const calls = configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['sato@example.com'],
  })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Inactive assignee task',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(409)
  expect(calls.taskCreates).toEqual([])
})

test('returns a NEW_PASSWORD_REQUIRED challenge without creating a session', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthChallenge: true })

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Temporary123!' }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'NEW_PASSWORD_REQUIRED',
    email: 'demo@example.com',
    session: 'new-password-session',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('returns a stable error when a new password violates the Cognito policy', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeError: new CognitoServiceError(
      400,
      'InvalidPasswordException',
      'Password did not conform with policy.',
    ),
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'weak',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidNewPassword',
    message: 'New password does not meet the password policy.',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('retries membership reconcile on normal login after password completion succeeded alone', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeTokens: true,
    passwordAuthTokens: true,
    workspaceReconcileFailures: 1,
  })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(503)

  const loginResponse = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Permanent123!' }),
  })

  expect(loginResponse.status).toBe(200)
  expect(await loginResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual([
    'demo@example.com',
    'demo@example.com',
  ])
})

test('returns owner and admin Workspace capabilities from the API source of truth', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/workspace/access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    currentMember: { role: 'admin', status: 'active' },
    capabilities: {
      canInvite: true,
      canManageMembers: true,
      canManageAdmins: false,
    },
  })
})

test('rejects deactivating a Workspace member who still manages an active project', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message: 'Transfer or remove all active project manager roles before deactivating this member.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
})

test('resends credentials when inviting an existing unconfirmed Workspace identity', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'invitee@example.com',
      name: 'Invitee',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['invitee@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invitee@example.com',
      identityOwnership: 'pre-existing',
      status: 'pending',
    },
  })
})

test('records ownership when invitation provisioning creates a new Cognito identity', async () => {
  const calls = configureFakeProjectClients(true, { workspaceUserMissing: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'new-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual([])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'new-user@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    },
  })
})

test('keeps raced Cognito ownership ambiguous while resending temporary credentials', async () => {
  const calls = configureFakeProjectClients(true, { workspaceProvisionRace: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'raced-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['raced-user@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'raced-user@example.com',
      identityOwnership: 'ambiguous',
      status: 'pending',
    },
  })
})

test('loads dashboard summary from the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/dashboard/summary', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projects: 1,
    tasks: 1,
    blocked: 0,
    updatedAt: '2026-06-03T00:00:00.000Z',
    source: 'dynamodb',
  })
  expect(calls.summaryReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      isSystemAdmin: false,
      userKey: 'demo@example.com',
    },
  ])
})

test('marks a workspace audit export as truncated when the 1,000 event cap leaves a cursor', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()
  let pageNumber = 0

  configureApiClientsForTest({
    auditEvents: {
      async query(input) {
        pageNumber += 1
        expect(input.limit).toBe(100)

        return {
          events: Array.from({ length: 100 }, () => event),
          nextCursor: `cursor-${pageNumber}`,
        }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      Origin: 'http://localhost:5173',
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
    'X-Audit-Truncated,X-Audit-Next-Cursor',
  )
  expect(response.headers.get('X-Audit-Truncated')).toBe('true')
  expect(response.headers.get('X-Audit-Next-Cursor')).toBe('cursor-10')
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1_000)
  expect(pageNumber).toBe(10)
})

test('omits truncation headers when a workspace audit export reaches the final page', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()

  configureApiClientsForTest({
    auditEvents: {
      async query() {
        return { events: [event] }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Audit-Truncated')).toBeNull()
  expect(response.headers.get('X-Audit-Next-Cursor')).toBeNull()
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1)
})

test('denies project tasks when the project is outside the user directory', async () => {
  const calls = configureFakeProjectClients(false)

  const response = await app.request('/api/projects/secret/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'secret' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('loads project tasks after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual([
    'onboarding-friction',
    'wireframe',
  ])
  expect(body.tasks[0]).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    teamId: 'core-team',
    source: 'dynamodb',
  })
  expect(body.tasks[1]).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    teamId: 'core-team',
    source: 'legacy',
    titleKey: 'tasks.item.wireframe',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('lists Cognito users for project member assignment when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUsersNextToken: 'following-page-token',
    role: 'manager',
  })

  const response = await app.request(
    '/api/projects/refero/users?query=sato&limit=1&nextToken=next-page-token',
    {
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    users: [
      {
        id: 'sato@example.com',
        username: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        enabled: true,
        status: 'CONFIRMED',
        workspaceStatus: 'active',
      },
    ],
    nextToken: 'following-page-token',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.userLists).toEqual([{
    directoryId: 'user#demo@example.com',
    limit: 1,
    paginationToken: 'next-page-token',
    query: 'sato',
  }])
  expect(calls.userProfiles).toEqual([])
})

test('continues Cognito pagination until an active Workspace assignment candidate is found', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUserPages: [
      { userIds: ['inactive@example.com'], nextToken: 'active-page' },
      { userIds: ['sato@example.com'], nextToken: 'following-page' },
    ],
    role: 'manager',
  })

  const response = await app.request('/api/projects/refero/users?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    users: [{ id: 'sato@example.com', workspaceStatus: 'active' }],
    nextToken: 'following-page',
  })
  expect(calls.userLists).toEqual([
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: undefined,
      query: undefined,
    },
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: 'active-page',
      query: undefined,
    },
  ])
})

test('keeps project members available when Cognito profile hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
  })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['demo@example.com'])
})

test('keeps project tasks available when Cognito assignee hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
    taskAssigneeUserId: 'sato@example.com',
  })

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual([
    'onboarding-friction',
    'wireframe',
  ])
  expect(body.tasks[1]).toMatchObject({
    id: 'wireframe',
    assigneeUserId: 'sato@example.com',
    source: 'legacy',
  })
  expect(calls.userProfiles).toEqual(['sato@example.com'])
})

test('creates a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規チーム',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    team: {
      id: 'new-team',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(calls.teamCreates).toEqual([
    { directoryId: 'user#demo@example.com', name: '新規チーム' },
  ])
})

test('creates a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
      tone: 'green',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    project: {
      id: 'new-project',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(calls.projectCreates).toEqual([
    {
      creatorUserKey: 'demo@example.com',
      directoryId: 'user#demo@example.com',
      name: '新規プロジェクト',
      teamId: 'core-team',
    },
  ])
})

test('returns conflict when project creation transaction is canceled', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ message: 'The same item already exists.' })
})

test('returns bad gateway when project creation transaction has no cancellation reasons', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'Project data is unavailable.' })
})

test('returns service unavailable when project creation transaction table is missing', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('missing table')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ message: 'Project data is not initialized.' })
})

test('returns not found when project creation transaction loses its active team', async () => {
  configureFakeProjectClients(true)
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
              ...(queryReads >= 2 ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ message: 'Team was not found.' })
})

test('archives a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
})

test('denies project task creation when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskCreates).toEqual([])
})

test('denies project member reads when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.memberReads).toEqual([])
})

test('updates a project member role when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, { role: 'manager' })

  const response = await app.request('/api/projects/refero/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      username: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'sato@example.com',
      projectId: 'refero',
      role: 'member',
    },
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('lets a system admin update project members without a project role', async () => {
  const calls = configureFakeProjectClients(false, { role: undefined })

  const response = await app.request('/api/projects/refero/members/viewer%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      role: 'viewer',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'viewer@example.com',
      email: 'viewer@example.com',
      username: 'viewer@example.com',
      name: 'Viewer User',
      enabled: true,
      status: 'CONFIRMED',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.roleChecks).toEqual([])
  expect(calls.accessChecks).toEqual([])
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'viewer@example.com',
      projectId: 'refero',
      role: 'viewer',
    },
  ])
  expect(calls.userProfiles).toEqual(['viewer@example.com', 'viewer@example.com'])
})

test('archives a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.projectArchives).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team', projectId: 'refero' },
  ])
})

test('DynamoDB directory client validates and ignores workspace bootstrap rows for reads and writes', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            ...createWorkspaceBootstrapItems(),
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'workspace#production',
              entryKey: 'PROJECT_MEMBER#refero#owner@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'owner@example.com',
              email: 'owner@example.com',
              role: 'manager',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      },
    ],
  })
  await expect(client.createTeam('workspace#production', { name: 'New Team' })).resolves.toEqual({
    team: {
      id: 'new-team',
      name: 'New Team',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[2]).toMatchObject({
    Item: {
      directoryId: 'workspace#production',
      entryType: 'team',
      teamId: 'new-team',
    },
  })
})

test('DynamoDB directory client rejects malformed workspace bootstrap rows', async () => {
  const documentClient = {
    async send() {
      return {
        Items: [
          {
            directoryId: 'workspace#production',
            entryKey: 'WORKSPACE#METADATA',
            entryType: 'workspace-metadata',
            workspaceId: 'workspace#other',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).rejects.toMatchObject({
    status: 503,
    code: 'InvalidProjectDirectory',
  })
})

test('DynamoDB directory client creates duplicate named teams with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#新規チーム',
              entryType: 'team',
              teamId: '新規チーム',
              teamSortOrder: 10,
              nameJa: '新規チーム',
              nameEn: 'New Team',
              expanded: true,
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.createTeam('user#demo@example.com', { name: '新規チーム' })).resolves.toEqual({
    team: {
      id: '新規チーム-2',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '新規チーム-2',
      teamSortOrder: 20,
      entryKey: '000020#000000#TEAM#新規チーム-2',
    },
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  })
})

test('DynamoDB directory client creates duplicate named projects with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#新規プロジェクト',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: '新規プロジェクト',
              projectSortOrder: 10,
              nameJa: '新規プロジェクト',
              nameEn: 'New Project',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.createProject(
      'user#demo@example.com',
      'core-team',
      {
        name: '新規プロジェクト',
        tone: 'green',
      },
      { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    ),
  ).resolves.toEqual({
    project: {
      id: '新規プロジェクト-2',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
          ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: '新規プロジェクト-2',
            projectSortOrder: 20,
            entryKey: '000010#000020#PROJECT#新規プロジェクト-2',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#新規プロジェクト-2#demo@example.com',
            entryType: 'project-member',
            projectId: '新規プロジェクト-2',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: 'manager',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':memberEntryType': 'workspace-member',
            ':active': 'active',
            ':expectedVersion': 1,
            ':one': 1,
          },
        },
      },
    ],
  })
})

test('DynamoDB directory client initializes a missing local table before creating a team', async () => {
  const documentInputs: Array<Record<string, unknown>> = []
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      documentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryId', KeyType: 'HASH' },
              { AttributeName: 'entryKey', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectDirectoryClient(
    'MissingDirectoryTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.createTeam('user#demo@example.com', { name: '復旧チーム' })).resolves.toEqual({
    team: {
      id: '復旧チーム',
      name: '復旧チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingDirectoryTable',
      KeySchema: [
        { AttributeName: 'directoryId', KeyType: 'HASH' },
        { AttributeName: 'entryKey', KeyType: 'RANGE' },
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingDirectoryTable',
    }),
  ])
  expect(documentInputs.at(-1)).toMatchObject({
    TableName: 'MissingDirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '復旧チーム',
    },
  })
})

test('DynamoDB task client initializes a missing local table before reading tasks', async () => {
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'ProjectSortOrderIndex',
                KeySchema: [
                  { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
                  { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                ],
              },
            ],
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'MissingTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.getProjectTasks('user#demo@example.com', 'new-project')).resolves.toEqual({
    projectId: 'new-project',
    tasks: [],
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingTasksTable',
      KeySchema: [
        { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
        { AttributeName: 'taskId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'ProjectSortOrderIndex',
        }),
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingTasksTable',
    }),
  ])
})

test('DynamoDB task client fails fast when a local table exists with the wrong schema', async () => {
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1
        const error = new Error('missing index')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'CreateTableCommand') {
        const error = new Error('table exists')
        error.name = 'ResourceInUseException'
        throw error
      }

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'BrokenTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(
    client.getProjectTasks('user#demo@example.com', 'broken-project'),
  ).rejects.toThrow('does not match the expected schema')
  expect(queryAttempts).toBe(1)
})

test('creates a project task after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    task: {
      schemaVersion: 1,
      revision: 1,
      teamId: 'core-team',
      source: 'dynamodb',
      id: 'new-issue',
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      status: 'todo',
      dueDate: '2026/06/20',
      priority: 'medium',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
  expect(calls.taskCreates).toEqual([])
  expect(calls.issueCreates).toEqual([
    expect.objectContaining({
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      title: '新規タスク',
    }),
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('rejects project task creation when the canonical owner Team is ambiguous', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'デザインチーム',
      projects: [{ id: 'refero', name: 'Refero', tone: 'purple' }],
    }],
  })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '曖昧なタスク',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'AmbiguousProjectOwnerTeam',
    message: 'Project "refero" belongs to more than one active Team.',
  })
  expect(calls.issueCreates).toEqual([])
  expect(calls.taskCreates).toEqual([])
})

test('rejects legacy project task status updates through the compatibility endpoint', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks/wireframe', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'done',
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'LegacyProjectTaskReadOnly',
    message: 'Legacy project tasks are read-only.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskStatusUpdates).toEqual([])
})

test('updates a canonical Work Item through the project task compatibility endpoint', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    task: {
      schemaVersion: 1,
      revision: 2,
      id: 'onboarding-friction',
      teamId: 'core-team',
      source: 'dynamodb',
      status: 'done',
    },
  })
  expect(calls.taskReads).toEqual([])
  expect(calls.taskStatusUpdates).toEqual([])
  expect(calls.issueUpdates).toEqual([
    expect.objectContaining({
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    }),
  ])
})

test('loads team-owned issues with legacy project tasks after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.teamId).toBe('core-team')
  expect(body.issues).toHaveLength(2)
  expect(body.issues[0]).toMatchObject({
    id: 'onboarding-friction',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeEmail: 'sato@example.com',
  })
  expect(body.issues[1]).toMatchObject({
    id: 'wireframe',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.wireframe',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('loads all accessible canonical and legacy Work Items including unassigned items', async () => {
  const calls = configureFakeProjectClients(true, {
    taskAssigneeUserId: 'sato@example.com',
    unassignedIssue: true,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'onboarding-friction',
    'wireframe',
  ])
  expect(body.workItems[0]).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    teamId: 'core-team',
    source: 'dynamodb',
  })
  expect(body.workItems[0].assignedProjectId).toBeUndefined()
  expect(body.workItems[1]).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    assignedProjectId: 'refero',
    source: 'legacy',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, projectId: 'refero' },
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, projectId: 'refero' },
  ])
  expect(calls.migrationSourceBatchReads).toEqual([])
})

test('rejects an oversized Work Item aggregate instead of returning a silent partial response', async () => {
  const calls = configureFakeProjectClients(true, {
    legacyTaskIds: [],
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    code: 'WorkItemListLimitExceeded',
    message:
      'Workspace has more than 200 accessible Work Items. ' +
      'Refine the Workspace before loading the aggregate Work Item list.',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects Work Item aggregate Team fan-out beyond the hard cap before item reads', async () => {
  const additionalTeams = Array.from({ length: 24 }, (_, teamIndex) => ({
    id: `team-${teamIndex}`,
    name: `Team ${teamIndex}`,
    projects: Array.from({ length: 6 }, (_, projectIndex) => ({
      id: `project-${teamIndex}-${projectIndex}`,
      name: `Project ${teamIndex}-${projectIndex}`,
      tone: 'blue' as const,
    })),
  }))
  const calls = configureFakeProjectClients(true, {
    additionalTeams,
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      ...additionalTeams.flatMap((team) =>
        team.projects.map((project) => ({ projectId: project.id, role: 'manager' as const }))
      ),
    ],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('rejects Work Item aggregate legacy project fan-out beyond the hard cap', async () => {
  const teamProjects = Array.from({ length: 101 }, (_, projectIndex) => ({
    id: `project-${projectIndex}`,
    name: `Project ${projectIndex}`,
    tone: 'blue' as const,
  }))
  const calls = configureFakeProjectClients(true, {
    projectAccesses: teamProjects.map((project) => ({
      projectId: project.id,
      role: 'manager' as const,
    })),
    teamProjects,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('filters canonical Work Items for authorization before enforcing the response limit', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 200,
    legacyTaskIds: [],
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'work-item-200',
  ])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects a canonical partition that exceeds the bounded Work Item scan budget', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 1001,
    legacyTaskIds: [],
    teamIssueCount: 1001,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('deduplicates bounded legacy candidates before enforcing the response limit', async () => {
  const legacyTaskIds = Array.from({ length: 200 }, (_, index) => `legacy-${index}`)
  configureFakeProjectClients(true, {
    canonicalProjectIssueIds: legacyTaskIds.slice(0, 199),
    legacyTaskIds,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'onboarding-friction',
    'legacy-199',
  ])
})

test('checks canonical counterparts beyond the response limit before projecting legacy rows', async () => {
  const canonicalProjectIssueIds = [
    ...Array.from({ length: 220 }, (_, index) => `canonical-${index}`),
    'late-counterpart',
  ]
  configureFakeProjectClients(true, {
    canonicalProjectIssueIds,
    legacyTaskIds: ['late-counterpart', 'unmigrated'],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'onboarding-friction',
    'unmigrated',
  ])
})

test('suppresses a shared project legacy projection after migration to another owner Team', async () => {
  configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'デザインチーム',
      projects: [{ id: 'refero', name: 'Refero', tone: 'purple' }],
    }],
    migratedLegacyOwnerTeamId: 'design-team',
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.filter((workItem: { id: string }) => workItem.id === 'wireframe')).toEqual([
    expect.objectContaining({
      id: 'wireframe',
      teamId: 'design-team',
      source: 'dynamodb',
    }),
  ])
})

test('does not assign shared-project legacy rows to an arbitrary Team in compatibility reads', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'デザインチーム',
      projects: [{ id: 'refero', name: 'Refero', tone: 'purple' }],
    }],
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  const headers = { Authorization: 'Bearer test-token' }

  const projectResponse = await app.request('/api/projects/refero/tasks', { headers })
  const teamResponse = await app.request('/api/teams/core-team/issues', { headers })
  const detailResponse = await app.request('/api/teams/core-team/issues/wireframe', { headers })
  const aggregateResponse = await app.request('/api/work-items', { headers })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(detailResponse.status).toBe(404)
  expect(aggregateResponse.status).toBe(200)
  expect((await projectResponse.json()).tasks).toEqual([
    expect.objectContaining({ id: 'onboarding-friction', source: 'dynamodb' }),
  ])
  expect((await teamResponse.json()).issues).toEqual([
    expect.objectContaining({ id: 'onboarding-friction', source: 'dynamodb' }),
  ])
  expect((await aggregateResponse.json()).workItems)
    .not.toContainEqual(expect.objectContaining({ id: 'wireframe' }))
  expect(calls.taskReads).toEqual([])
  expect(calls.migrationSourceBatchReads).toEqual([])
})

test('keeps a migrated legacy source suppressed after reassignment to an inaccessible project', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'デザインチーム',
      projects: [
        { id: 'refero', name: 'Refero', tone: 'purple' },
        { id: 'private-project', name: 'Private', tone: 'purple' },
      ],
    }],
    migratedLegacyAssignedProjectId: 'private-project',
    migratedLegacyOwnerTeamId: 'design-team',
    migratedLegacySourceProjectId: 'refero',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.filter((workItem: { id: string }) => workItem.id === 'wireframe'))
    .toEqual([])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'design-team' },
  ])
  expect(calls.projectIssueReads).toEqual([])
  expect(calls.migrationSourceBatchReads).toEqual([])
})

test('does not suppress a legacy projection for a metadata-less same-Team canonical row', async () => {
  const calls = configureFakeProjectClients(true, {
    migratedLegacyAssignedProjectId: 'private-project',
    migratedLegacyHasSourceMetadata: false,
    migratedLegacyOwnerTeamId: 'core-team',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.filter((workItem: { id: string }) => workItem.id === 'wireframe'))
    .toEqual([
      expect.objectContaining({
        id: 'wireframe',
        source: 'legacy',
        teamId: 'core-team',
      }),
    ])
  expect(calls.migrationSourceBatchReads).toEqual([])
})

test('keeps an accessible metadata-less canonical row ahead of its legacy projection', async () => {
  const calls = configureFakeProjectClients(true, {
    migratedLegacyHasSourceMetadata: false,
    migratedLegacyOwnerTeamId: 'core-team',
    migratedLegacyUnassigned: true,
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.filter((workItem: { id: string }) => workItem.id === 'wireframe'))
    .toEqual([
      expect.objectContaining({
        id: 'wireframe',
        source: 'dynamodb',
        teamId: 'core-team',
      }),
    ])
  expect(calls.migrationSourceBatchReads).toEqual([])
})

test('does not let a project A migration source suppress a project B legacy task with the same ID', async () => {
  const calls = configureFakeProjectClients(true, {
    legacyTaskIds: ['wireframe'],
    migratedLegacyAssignedProjectId: 'private-project',
    migratedLegacyOwnerTeamId: 'core-team',
    migratedLegacySourceProjectId: 'project-a',
    projectAccesses: [{ projectId: 'project-b', role: 'manager' }],
    teamProjects: [
      { id: 'project-a', name: 'Project A', tone: 'blue' },
      { id: 'project-b', name: 'Project B', tone: 'green' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })

  const response = await app.request('/api/projects/project-b/tasks', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.tasks.filter((task: { id: string }) => task.id === 'wireframe')).toEqual([
    expect.objectContaining({ id: 'wireframe', source: 'legacy' }),
  ])
  expect(calls.migrationSourceBatchReads).toEqual([{
    directoryId: 'user#demo@example.com',
    keys: [{ issueId: 'wireframe', teamId: 'core-team' }],
  }])
})

test('maps an incomplete migration BatchGet lookup to service unavailable', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('RequestItems' in command.input) {
        return { UnprocessedKeys: command.input.RequestItems }
      }

      return { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  configureApiClientsForTest({
    teamIssues: new DynamoDbTeamIssuesClient(
      'WorkItemsTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      undefined,
      async () => {},
    ) as never,
  })

  const response = await app.request('/api/projects/refero/tasks', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    code: 'TeamIssueMigrationLookupIncomplete',
    message: 'Work Item migration identity lookup could not process every key.',
  })
})

test('suppresses reassigned migrations in project, Team, and detail compatibility reads', async () => {
  const calls = configureFakeProjectClients(true, {
    migratedLegacyAssignedProjectId: 'private-project',
    migratedLegacyOwnerTeamId: 'core-team',
    migratedLegacySourceProjectId: 'refero',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  const headers = { Authorization: 'Bearer test-token' }

  const projectResponse = await app.request('/api/projects/refero/tasks', { headers })
  const teamResponse = await app.request('/api/teams/core-team/issues', { headers })
  const detailResponse = await app.request('/api/teams/core-team/issues/wireframe', { headers })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(detailResponse.status).toBe(404)
  const projectBody = await projectResponse.json()
  const teamBody = await teamResponse.json()
  expect(projectBody.tasks.some((task: { id: string }) => task.id === 'wireframe')).toBe(false)
  expect(teamBody.issues.some((issue: { id: string }) => issue.id === 'wireframe')).toBe(false)
  expect(calls.migrationSourceBatchReads).toHaveLength(3)
  expect(calls.migrationSourceBatchReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    keys: [{ issueId: 'wireframe', teamId: 'core-team' }],
  })
})

test('loads legacy project task rows as team issue detail fallback', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues/wireframe', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'wireframe',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      status: 'in-progress',
      dueDate: '2026/06/03',
      priority: 'high',
    },
    comments: [],
    activity: [],
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
      readOptions: { consistentIssueRead: true },
    },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('rejects legacy project task updates through the team Work Item endpoint', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues/wireframe', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'LegacyProjectTaskReadOnly',
    message: 'Legacy project tasks are read-only.',
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.issueUpdates).toEqual([])
})

test('creates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規 Issue',
      description: 'Issue の説明',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    issue: {
      schemaVersion: 1,
      revision: 1,
      id: 'new-issue',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '新規 Issue',
      description: 'Issue の説明',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      status: 'todo',
      dueDate: '2026/06/20',
      priority: 'medium',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      source: 'dynamodb',
    },
  })
  expect(calls.issueCreates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: 'refero',
      directoryId: 'user#demo@example.com',
      reservedIssueIds: ['wireframe'],
      teamId: 'core-team',
      title: '新規 Issue',
    },
  ])
})

test('rejects a team issue assignment to a project outside the owning team', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '不正な割り当て',
      assignedProjectId: 'unknown-project',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(400)
  expect(calls.issueCreates).toEqual([])
})

test('rejects a team issue assignment when the user lacks target project member role', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      {
        projectId: 'refero',
        role: 'member',
      },
    ],
    teamProjects: [
      {
        id: 'refero',
        name: 'Refero',
        tone: 'blue',
      },
      {
        id: 'product-roadmap',
        name: 'プロダクトロードマップ',
        tone: 'yellow',
      },
    ],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '権限外プロジェクトへの割り当て',
      assignedProjectId: 'product-roadmap',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('loads team issue detail and creates comments after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)
  const collaborationCreates: Parameters<CollaborationClient['createComment']>[0][] = []
  const collaborationComments: Awaited<ReturnType<CollaborationClient['createComment']>>[] = []
  configureApiClientsForTest({
    collaboration: {
      async getThread() {
        return {
          comments: collaborationComments,
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async createComment(input) {
        collaborationCreates.push(input)
        const comment = {
          id: 'comment-2',
          rootCommentId: 'comment-2',
          authorMemberKey: input.actorMemberKey,
          bodyMarkdown: input.bodyMarkdown,
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T02:00:00.000Z',
          updatedAt: '2026-06-08T02:00:00.000Z',
          reactions: [],
        }
        collaborationComments.push(comment)
        return comment
      },
    } as CollaborationClient,
  })

  const detailResponse = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      assigneeEmail: 'sato@example.com',
    },
    comments: [
      {
        id: 'comment-1',
        body: '背景を確認します。',
      },
    ],
    activity: [
      {
        id: 'activity-1',
        type: 'created',
      },
    ],
  })

  const commentResponse = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: '追加コメント',
    }),
  })

  expect(commentResponse.status).toBe(201)
  expect(await commentResponse.json()).toEqual({
    comment: {
      id: 'comment-2',
      actorUserId: 'demo@example.com',
      body: '追加コメント',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
    activity: {
      id: 'comment-2',
      type: 'commented',
      actorUserId: 'demo@example.com',
      summary: 'Comment was added.',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true },
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
  expect(calls.issueComments).toEqual([])
  expect(collaborationCreates).toHaveLength(1)
  expect(collaborationCreates[0]).toMatchObject({
    actorMemberKey: 'demo@example.com',
    bodyMarkdown: '追加コメント',
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
  })

  const refreshedDetailResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(refreshedDetailResponse.status).toBe(200)
  expect(await refreshedDetailResponse.json()).toMatchObject({
    comments: [
      { id: 'comment-1', body: '背景を確認します。' },
      { id: 'comment-2', body: '追加コメント' },
    ],
  })
})

test('returns persisted collaboration comments together with inert legacy comments and reply cursors', async () => {
  const calls = configureFakeProjectClients(true)
  const threadInputs: Parameters<CollaborationClient['getThread']>[0][] = []
  configureApiClientsForTest({
    collaboration: {
      async getThread(input) {
        threadInputs.push(input)
        const pageBase = {
          watch: {
            subscribed: true,
            explicit: true,
            automatic: false,
            reasons: ['manual'],
            watcherCount: 2,
          },
          presence: [],
        }
        if (input.rootCommentId) {
          return {
            ...pageBase,
            comments: [{
              id: 'stored-reply',
              rootCommentId: input.rootCommentId,
              parentCommentId: input.rootCommentId,
              authorMemberKey: 'sato@example.com',
              bodyMarkdown: 'Persisted reply',
              version: 1,
              mentionMemberKeys: [],
              createdAt: '2026-07-12T00:01:00.000Z',
              updatedAt: '2026-07-12T00:01:00.000Z',
              reactions: [],
            }],
            nextCursor: 'older-replies',
          }
        }
        return {
          ...pageBase,
          comments: [{
            id: 'stored-root',
            rootCommentId: 'stored-root',
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: 'Persisted root',
            version: 2,
            mentionMemberKeys: [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:30.000Z',
            editedAt: '2026-07-12T00:00:30.000Z',
            reactions: [],
          }],
        }
      },
    } as CollaborationClient,
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    comments: [
      { id: 'stored-root', source: 'collaboration' },
      { id: 'stored-reply', source: 'collaboration' },
      {
        id: 'comment-1',
        source: 'legacy',
        capabilities: { canReply: false, canReact: false },
      },
    ],
    replyNextCursors: { 'stored-root': 'older-replies' },
  })
  expect(threadInputs).toHaveLength(2)
  expect(threadInputs[0]?.rootCommentId).toBeUndefined()
  expect(threadInputs[0]?.limit).toBe(10)
  expect(threadInputs[1]).toMatchObject({
    rootCommentId: 'stored-root',
    limit: 5,
    includeScopeState: false,
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: {
      consistentIssueRead: true,
      eventLimit: 50,
      newestEventsFirst: true,
      eventType: 'commented',
    },
  })
})

test('keeps a departed author in history while blocking deactivated member mutations', async () => {
  configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['departed@example.com'],
  })
  configureApiClientsForTest({
    collaboration: {
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? []
            : [{
                id: 'departed-comment',
                rootCommentId: 'departed-comment',
                authorMemberKey: 'departed@example.com',
                bodyMarkdown: 'This decision remains in history.',
                version: 1,
                mentionMemberKeys: [],
                createdAt: '2026-07-12T00:00:00.000Z',
                updatedAt: '2026-07-12T00:00:00.000Z',
                reactions: [],
              }],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
  })

  const historyResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(historyResponse.status).toBe(200)
  const history = await historyResponse.json() as { comments: unknown[] }
  expect(history.comments).toContainEqual(expect.objectContaining({
    id: 'departed-comment',
    authorMemberKey: 'departed@example.com',
    bodyMarkdown: 'This decision remains in history.',
  }))

  configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })
  let mutationCalls = 0
  configureApiClientsForTest({
    collaboration: {
      async updateComment() {
        mutationCalls += 1
        throw new Error('A deactivated member must not reach the collaboration store.')
      },
    } as CollaborationClient,
  })
  const mutationResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/departed-comment',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bodyMarkdown: 'Changed', expectedVersion: 1 }),
    },
  )

  expect(mutationResponse.status).toBe(403)
  expect(mutationCalls).toBe(0)
})

test('marks roots and replies in a resolved thread as non-replyable', async () => {
  configureFakeProjectClients(true)
  const root = {
    id: 'resolved-root',
    rootCommentId: 'resolved-root',
    authorMemberKey: 'demo@example.com',
    bodyMarkdown: 'Resolved decision',
    version: 2,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
    resolvedAt: '2026-07-12T00:01:00.000Z',
    reactions: [],
  }
  configureApiClientsForTest({
    collaboration: {
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? [{
                ...root,
                id: 'resolved-reply',
                parentCommentId: root.id,
                resolvedAt: undefined,
              }]
            : [root],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
          ...(input.rootCommentId ? { threadResolved: true } : {}),
        }
      },
    } as CollaborationClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(response.status).toBe(200)
  const body = await response.json() as {
    comments: Array<{ id: string; capabilities: { canReply: boolean } }>
  }
  expect(body.comments.find((comment) => comment.id === 'resolved-root')?.capabilities.canReply)
    .toBe(false)
  expect(body.comments.find((comment) => comment.id === 'resolved-reply')?.capabilities.canReply)
    .toBe(false)
})

test('denies collaboration reads without Work Item viewer access', async () => {
  configureFakeProjectClients(false)
  let reads = 0
  configureApiClientsForTest({
    collaboration: {
      async getThread() {
        reads += 1
        throw new Error('Collaboration store must not be called.')
      },
    } as CollaborationClient,
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(reads).toBe(0)
})

test('keeps guest members read-only for collaboration mutations', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })
  let writes = 0
  configureApiClientsForTest({
    collaboration: {
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    } as CollaborationClient,
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bodyMarkdown: 'Guest comment' }),
  })

  expect(response.status).toBe(403)
  expect(writes).toBe(0)
})

test('returns a client error when a comment mentions an inactive Workspace member', async () => {
  configureFakeProjectClients(true, { inactiveWorkspaceMemberKeys: ['inactive@example.com'] })
  let writes = 0
  configureApiClientsForTest({
    collaboration: {
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    } as CollaborationClient,
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bodyMarkdown: 'Please review this, @Inactive.',
      mentionMemberKeys: ['inactive@example.com'],
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    message: 'Mentioned Workspace member "inactive@example.com" is not active.',
  })
  expect(writes).toBe(0)
})

test('allows active system administrators to be mentioned without project membership', async () => {
  for (const unassignedIssue of [false, true]) {
    configureFakeProjectClients(true, {
      mentionAccessDeniedMemberKeys: ['admin@example.com'],
      systemAdminMemberKeys: ['admin@example.com'],
      unassignedIssue,
    })
    const writes: Parameters<CollaborationClient['createComment']>[0][] = []
    configureApiClientsForTest({
      collaboration: {
        async createComment(input) {
          writes.push(input)
          return {
            id: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            rootCommentId: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            authorMemberKey: input.actorMemberKey,
            bodyMarkdown: input.bodyMarkdown,
            version: 1,
            mentionMemberKeys: input.mentionMemberKeys ?? [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
            reactions: [],
          }
        },
      } as CollaborationClient,
    })

    const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bodyMarkdown: 'Please review this, @Admin.',
        mentionMemberKeys: ['admin@example.com'],
      }),
    })

    expect(response.status).toBe(201)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.mentionMemberKeys).toEqual(['admin@example.com'])
  }
})

test('allows a Workspace owner with viewer access to moderate a comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'owner' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  configureApiClientsForTest({
    collaboration: {
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes).toHaveLength(1)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('allows an assigned project manager to moderate another member comment', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  configureApiClientsForTest({
    collaboration: {
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('denies a project viewer from deleting another member comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  let deletes = 0
  configureApiClientsForTest({
    collaboration: {
      async deleteComment() {
        deletes += 1
        throw new CollaborationError(403, 'CommentDeleteDenied', 'Comment delete permission is required.')
      },
    } as CollaborationClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(403)
  expect(deletes).toBe(1)
})

test('reads and changes project watcher state through the project scope', async () => {
  configureFakeProjectClients(true)
  const reads: Parameters<CollaborationClient['getWatcherState']>[0][] = []
  const writes: Parameters<CollaborationClient['subscribe']>[0][] = []
  const watch = {
    subscribed: true,
    explicit: true,
    automatic: false,
    reasons: ['manual'],
    watcherCount: 3,
  }
  configureApiClientsForTest({
    collaboration: {
      async getWatcherState(input) {
        reads.push(input)
        return watch
      },
      async subscribe(input) {
        writes.push(input)
        return watch
      },
    } as CollaborationClient,
  })

  const readResponse = await app.request('/api/projects/refero/watch', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/projects/refero/watch', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(readResponse.status).toBe(200)
  expect(writeResponse.status).toBe(200)
  expect(reads).toEqual([{
    entityKey: 'user#demo@example.com#project#refero',
    memberKey: 'demo@example.com',
  }])
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    workspaceId: 'user#demo@example.com',
    entityKey: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    memberKey: 'demo@example.com',
  })
})

test('issues a one-time realtime ticket only after Work Item viewer access is confirmed', async () => {
  configureFakeProjectClients(true)
  const ticketInputs: Array<Record<string, unknown>> = []
  configureApiClientsForTest({
    realtimeTickets: {
      async createTicket(input) {
        ticketInputs.push(input)

        return {
          ticket: 'one-time-ticket',
          websocketUrl: 'wss://realtime.example.com/dev',
          expiresAt: '2026-07-12T00:01:00.000Z',
        }
      },
    },
  })

  const response = await app.request('/api/realtime/tickets', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    ticket: 'one-time-ticket',
    websocketUrl: 'wss://realtime.example.com/dev',
    expiresAt: '2026-07-12T00:01:00.000Z',
  })
  expect(ticketInputs).toEqual([{
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    projectId: 'refero',
    systemAdmin: false,
    canWrite: true,
    scopeKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
  }])
})

test('updates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '更新済み Issue',
      assignedProjectId: null,
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/22',
      priority: 'low',
      status: 'done',
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      teamId: 'core-team',
      title: '更新済み Issue',
      assigneeEmail: 'sato@example.com',
      status: 'done',
      dueDate: '2026/06/22',
      priority: 'low',
    },
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  })
  expect(calls.issueUpdates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: null,
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    },
  ])
})

test('returns a stable conflict code when a Work Item revision is stale', async () => {
  configureFakeProjectClients(true)
  const currentIssue = {
    schemaVersion: 1,
    revision: 2,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeUserId: 'sato@example.com',
    status: 'in-progress',
    dueDate: '2026/06/18',
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  configureApiClientsForTest({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })
})

test('requires a positive expected revision for Work Item updates', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'done' }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemRevision',
    message: 'Work Item expected revision is required.',
  })
})

test('loads project execution issues with legacy task compatibility', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/projects/refero/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([
    'onboarding-friction',
    'wireframe',
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('DynamoDB task client queries the scoped project partition across pages', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              directoryProjectId: 'user#demo@example.com#project#refero',
              projectId: 'refero',
              taskId: 'wireframe',
              sortOrder: 10,
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
          LastEvaluatedKey: {
            directoryProjectId: 'user#demo@example.com#project#refero',
            taskId: 'wireframe',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            directoryProjectId: 'user#demo@example.com#project#refero',
            projectId: 'refero',
            taskId: 'brand-guideline',
            sortOrder: 20,
            titleKey: 'tasks.item.brandGuideline',
            assigneeKey: 'tasks.assignee.suzuki',
            status: 'review',
            dueDate: '2026/06/05',
            priority: 'medium',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(client.getProjectTasks('user#demo@example.com', 'refero')).resolves.toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
      {
        id: 'brand-guideline',
        titleKey: 'tasks.item.brandGuideline',
        assigneeKey: 'tasks.assignee.suzuki',
        status: 'review',
        dueDate: '2026/06/05',
        priority: 'medium',
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: {
        directoryProjectId: 'user#demo@example.com#project#refero',
        taskId: 'wireframe',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB Work Item list clients stop pagination at the requested read limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const legacyTask = {
    directoryId: 'user#demo@example.com',
    directoryProjectId: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    taskId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
  }
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Items: [command.input.TableName === 'LegacyTasksTable' ? legacyTask : canonicalWorkItem],
        LastEvaluatedKey: { more: true },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 1 })
  await workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 1 })
  await workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 1 })

  expect(sentInputs).toHaveLength(3)
  expect(sentInputs.map((input) => input.Limit)).toEqual([1, 1, 1])
})

test('DynamoDB Work Item list clients skip DynamoDB reads when limit is zero', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(
    projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ tasks: [] })
  await expect(
    workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  await expect(
    workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  expect(sentInputs).toEqual([])
})

test('DynamoDB Team and project Work Item clients read every page without a default Limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const pageCounts = new Map<string, number>()
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'work-item-1',
    sortOrder: 10,
    title: 'Work Item',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      const indexName = String(command.input.IndexName)
      const pageCount = (pageCounts.get(indexName) ?? 0) + 1
      pageCounts.set(indexName, pageCount)

      return {
        Items: [{
          ...canonicalWorkItem,
          issueId: `${indexName}-${pageCount}`,
          sortOrder: pageCount * 10,
        }],
        ...(pageCount === 1 ? { LastEvaluatedKey: { indexName, pageCount } } : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const teamResponse = await client.getTeamIssues(
    'user#demo@example.com',
    'core-team',
    { limit: undefined },
  )
  const projectResponse = await client.getProjectIssues(
    'user#demo@example.com',
    'refero',
    { limit: undefined },
  )

  expect(teamResponse.issues).toHaveLength(2)
  expect(projectResponse.issues).toHaveLength(2)
  expect(sentInputs).toHaveLength(4)
  expect(sentInputs.every((input) => !('Limit' in input))).toBe(true)
})

test('DynamoDB aggregate Work Item reads retain only validated private migration source metadata', async () => {
  let migrationSourceKey =
    'user#demo@example.com#project#refero#task#wireframe'
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#private-project',
    teamId: 'core-team',
    assignedProjectId: 'private-project',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Migrated Work Item',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      const item = { ...canonicalWorkItem, migrationSourceKey }
      return 'Key' in command.input ? { Item: item } : { Items: [item] }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const response = await client.getTeamIssuesForAggregate(
    'user#demo@example.com',
    'core-team',
  )

  expect(response.migrationSourceKeys).toEqual([
    'user#demo@example.com#project#refero#task#wireframe',
  ])
  expect(response.issues[0]).not.toHaveProperty('migrationSourceKey')

  migrationSourceKey = 'user#demo@example.com#project#refero#task#another-item'
  await expect(
    client.getTeamIssuesForAggregate('user#demo@example.com', 'core-team'),
  ).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })

  migrationSourceKey = 'another-workspace#project#refero#task#wireframe'
  await expect(
    client.getTeamIssuesForAggregate('user#demo@example.com', 'core-team'),
  ).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
})

test('DynamoDB migration source lookup chunks strongly consistent BatchGet requests', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.getTeamIssueMigrationSourceKeys(
    'user#demo@example.com',
    Array.from({ length: 101 }, (_, index) => ({
      teamId: 'core-team',
      issueId: `work-item-${index}`,
    })),
  )).resolves.toEqual(new Set())

  expect(sentInputs).toHaveLength(2)
  const tableRequests = sentInputs.map((input) =>
    (input.RequestItems as Record<string, {
      ConsistentRead?: boolean
      Keys: Array<Record<string, unknown>>
    }>).WorkItemsTable
  )
  expect(tableRequests.map((request) => request.Keys.length)).toEqual([100, 1])
  expect(tableRequests.every((request) => request.ConsistentRead === true)).toBe(true)
})

test('DynamoDB migration source lookup retries UnprocessedKeys and returns exact metadata', async () => {
  let attempt = 0
  const retryDelays: number[] = []
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#private-project',
    teamId: 'core-team',
    assignedProjectId: 'private-project',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Migrated Work Item',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    migrationSourceKey: 'user#demo@example.com#project#refero#task#wireframe',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      attempt += 1
      const requestItems = command.input.RequestItems as Record<string, {
        Keys: Array<Record<string, unknown>>
      }>
      if (attempt === 1) {
        return { UnprocessedKeys: requestItems }
      }

      return { Responses: { WorkItemsTable: [canonicalWorkItem] } }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    undefined,
    async (ms) => {
      retryDelays.push(ms)
    },
    () => 0.5,
  )

  await expect(client.getTeamIssueMigrationSourceKeys(
    'user#demo@example.com',
    [{ teamId: 'core-team', issueId: 'wireframe' }],
  )).resolves.toEqual(new Set([
    'user#demo@example.com#project#refero#task#wireframe',
  ]))
  expect(attempt).toBe(2)
  expect(retryDelays).toEqual([37])
})

test('DynamoDB migration source lookup fails closed when UnprocessedKeys remain', async () => {
  let attempts = 0
  const retryDelays: number[] = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      attempts += 1
      return {
        UnprocessedKeys: command.input.RequestItems,
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    undefined,
    async (ms) => {
      retryDelays.push(ms)
    },
    () => 0.5,
  )

  await expect(client.getTeamIssueMigrationSourceKeys(
    'user#demo@example.com',
    [{ teamId: 'core-team', issueId: 'wireframe' }],
  )).rejects.toMatchObject({
    code: 'TeamIssueMigrationLookupIncomplete',
    status: 503,
  })
  expect(attempts).toBe(3)
  expect(retryDelays).toEqual([37, 75])
})

test('DynamoDB legacy task client rejects mutations without sending writes', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(
    client.createProjectTask('user#demo@example.com', 'refero', {
      title: '新規タスク',
      assigneeUserId: 'suzuki@example.com',
      status: 'todo',
      dueDate: '2026/06/21',
      priority: 'medium',
    }),
  ).rejects.toMatchObject({
    code: 'LegacyProjectTaskReadOnly',
    status: 409,
  })
  await expect(
    client.updateProjectTaskStatus('user#demo@example.com', 'refero', 'wireframe', {
      status: 'done',
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({
    code: 'LegacyProjectTaskReadOnly',
    status: 409,
  })
  expect(sentInputs).toEqual([])
})

test('DynamoDB Work Item client increments revision with an atomic CAS update', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : { ...currentIssue, revision: 2, status: 'done' },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    { status: 'done', expectedRevision: 1 },
    'demo@example.com',
  )).resolves.toMatchObject({
    issue: { schemaVersion: 1, revision: 2, status: 'done' },
  })
  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Update: {
      ExpressionAttributeValues: {
        ':expectedRevision': 1,
        ':nextRevision': 2,
      },
      ConditionExpression:
        'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
        '(#revision = :expectedRevision OR ' +
        '(attribute_not_exists(#revision) AND :expectedRevision = :legacyRevision))',
    },
  })
})

test('DynamoDB Work Item update emits render-ready notification candidates', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Notification-ready Work Item',
    assigneeUserId: 'before@example.com',
    status: 'todo',
    dueDate: '2026/07/20',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : {
                ...currentIssue,
                revision: 2,
                assigneeUserId: 'after@example.com',
                status: 'review',
              },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'manager-sub', kind: 'user', displayName: 'manager@example.com' },
    idempotencyKey: 'notification-update',
    occurredAt: '2026-07-12T01:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'notification-update' },
  })
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await client.updateTeamIssue(
    'workspace-1',
    'core-team',
    'wireframe',
    {
      assigneeUserId: 'after@example.com',
      status: 'review',
      expectedRevision: 1,
    },
    'manager@example.com',
    auditContext,
  )

  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  const auditItem = Array.isArray(transactItems)
    ? (transactItems[2] as { Put?: { Item?: Record<string, unknown> } })?.Put?.Item
    : undefined

  expect(auditItem).toMatchObject({
    eventType: 'work-item.updated',
    summary: 'Work Item assignment changed.',
    metadata: {
      actorMemberKey: 'manager@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
      projectId: 'refero',
      deepLink: '/teams/core-team/issues?issueId=wireframe',
      notificationTitle: 'Notification-ready Work Item',
      notificationCandidates: [
        { memberKey: 'after@example.com', reason: 'assignment' },
        { memberKey: 'after@example.com', reason: 'status-change' },
      ],
    },
  })
})

test('DynamoDB Work Item client classifies revision CAS transaction conditions', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    titleKey: 'tasks.item.wireframe',
    assigneeUserId: 'sato@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'request-1' },
  })
  const runUpdate = (
    cancellationReasons: Array<{ Code: string }> | undefined,
    latestIssue: Record<string, unknown> | undefined,
  ) => {
    const sentInputs: Array<Record<string, unknown>> = []
    let issueReads = 0
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        sentInputs.push(command.input)

        if (command.constructor.name === 'GetCommand') {
          issueReads += 1
          return { Item: issueReads === 1 ? currentIssue : latestIssue }
        }

        if (command.constructor.name === 'TransactWriteCommand') {
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'

          if (cancellationReasons) {
            Object.assign(error, { CancellationReasons: cancellationReasons })
          }

          throw error
        }

        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    )
    const result = client.updateTeamIssue(
      'user#demo@example.com',
      'core-team',
      'wireframe',
      { status: 'done', expectedRevision: 1 },
      'demo@example.com',
      auditContext,
    )

    return { result, sentInputs }
  }

  const stateConflict = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    { ...currentIssue, revision: 2 },
  )
  await expect(stateConflict.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(stateConflict.sentInputs[0]).toMatchObject({
    TableName: 'IssuesTable',
    ConsistentRead: true,
  })
  expect(stateConflict.sentInputs.at(-1)).toMatchObject({
    TableName: 'IssuesTable',
    Key: {
      directoryTeamId: 'user#demo@example.com#team#core-team',
      issueId: 'wireframe',
    },
    ConsistentRead: true,
  })

  const auditConflict = runUpdate(
    [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    currentIssue,
  )
  await expect(auditConflict.result).rejects.toMatchObject({
    code: 'ConditionalCheckFailedException',
    status: 409,
  })
  expect(auditConflict.sentInputs).toHaveLength(2)

  const deletedIssue = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    undefined,
  )
  await expect(deletedIssue.result).rejects.toMatchObject({
    code: 'TeamIssueNotFound',
    status: 404,
  })

  const missingReasons = runUpdate(undefined, { ...currentIssue, revision: 2 })
  await expect(missingReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(missingReasons.sentInputs).toHaveLength(3)

  const missingReasonsWithoutRevisionChange = runUpdate(undefined, currentIssue)
  await expect(missingReasonsWithoutRevisionChange.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(missingReasonsWithoutRevisionChange.sentInputs).toHaveLength(3)

  const emptyReasons = runUpdate([], { ...currentIssue, revision: 2 })
  await expect(emptyReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(emptyReasons.sentInputs).toHaveLength(3)

  const unknownReason = runUpdate([{ Code: 'TransactionConflict' }], undefined)
  await expect(unknownReason.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(unknownReason.sentInputs).toHaveLength(2)

  const mixedReasons = runUpdate(
    [
      { Code: 'ConditionalCheckFailed' },
      { Code: 'ProvisionedThroughputExceeded' },
      { Code: 'None' },
    ],
    undefined,
  )
  await expect(mixedReasons.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(mixedReasons.sentInputs).toHaveLength(2)
})

test('DynamoDB dashboard summary client derives counts from directory and task data', async () => {
  const accessListReads: Array<{ directoryId: string; memberKey: string }> = []
  const directoryReads: Array<{ directoryId: string; locale: Locale }> = []
  const migrationSourceBatchReads: Array<Array<{ issueId: string; teamId: string }>> = []
  const taskReads: Array<{ directoryId: string; projectId: string }> = []
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory(directoryId, locale) {
        directoryReads.push({ directoryId, locale })
        expect(directoryId).toBe('user#demo@example.com')
        expect(locale).toBe('ja')

        return {
          teams: [
            {
              id: 'core-team',
              name: 'コアチーム',
              expanded: true,
              projects: [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
                {
                  id: 'new-project',
                  name: '新規プロジェクト',
                  tone: 'green',
                },
              ],
            },
          ],
        }
      },
      async getProjectAccess(_directoryId, projectId) {
        return projectId === 'refero'
          ? {
              projectId,
              role: 'manager' as ProjectRole,
            }
          : undefined
      },
      async getProjectAccessList(directoryId, memberKey) {
        accessListReads.push({ directoryId, memberKey })

        return [
          {
            projectId: 'refero',
            role: 'manager' as ProjectRole,
          },
        ]
      },
      async hasProjectAccess() {
        return true
      },
      async getProjectRole() {
        return 'manager' as ProjectRole
      },
      async getProjectMembers() {
        return {
          projectId: 'unused',
          members: [],
        }
      },
      async updateProjectMember() {
        return {
          member: {
            id: 'unused',
            email: 'unused@example.com',
            role: 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember() {
        return {
          projectId: 'unused',
          memberId: 'unused@example.com',
        }
      },
      async createTeam() {
        return {
          team: {
            id: 'unused',
            name: 'unused',
            projects: [],
          },
        }
      },
      async createProject() {
        return {
          project: {
            id: 'unused',
            name: 'unused',
          },
        }
      },
      async archiveTeam() {
        return {
          teamId: 'unused',
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject() {
        return {
          teamId: 'unused',
          projectId: 'unused',
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    {
      async getProjectTasks(directoryId, projectId) {
        taskReads.push({ directoryId, projectId })

        return {
          projectId,
          tasks: projectId === 'refero'
            ? [
                {
                  id: 'wireframe',
                  title: 'ワイヤーフレーム',
                  assignee: '佐藤 花子',
                  status: 'in-progress',
                  dueDate: '2026/06/03',
                  priority: 'high',
                },
                {
                  id: 'archive',
                  title: '完了済み',
                  assignee: '鈴木 太郎',
                  status: 'done',
                  dueDate: '2026/06/01',
                  priority: 'high',
                },
              ]
            : [
                {
                  id: 'planning',
                  title: '計画',
                  assignee: '田中 一郎',
                  status: 'todo',
                  dueDate: '2026/06/12',
                  priority: 'medium',
                },
              ],
        }
      },
      async createProjectTask() {
        return {
          task: {
            id: 'unused',
            title: 'unused',
            assignee: 'unused',
            status: 'todo',
            dueDate: '2026/06/03',
            priority: 'medium',
          },
        }
      },
      async updateProjectTaskStatus() {
        return {
          task: {
            id: 'unused',
            title: 'unused',
            assignee: 'unused',
            status: 'done',
            dueDate: '2026/06/03',
            priority: 'medium',
          },
        }
      },
    },
    {
      async getProjectIssues(_directoryId: string, projectId: string) {
        return {
          projectId,
          issues: [{
            schemaVersion: 1,
            revision: 1,
            id: 'canonical-review',
            teamId: 'core-team',
            assignedProjectId: projectId,
            title: 'Canonical review',
            assigneeUserId: 'sato@example.com',
            status: 'review' as const,
            dueDate: '2026/06/10',
            priority: 'medium' as const,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
            source: 'dynamodb' as const,
          }],
        }
      },
      async getTeamIssueMigrationSourceKeys(
        _directoryId: string,
        keys: readonly { issueId: string; teamId: string }[],
      ) {
        migrationSourceBatchReads.push(keys.map((key) => ({ ...key })))

        return new Set([
          'user#demo@example.com#project#refero#task#wireframe',
        ])
      },
    } as never,
  )

  const summary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })

  expect(summary.projects).toBe(1)
  expect(summary.tasks).toBe(1)
  expect(summary.blocked).toBe(0)
  expect(summary.source).toBe('dynamodb')
  expect(Date.parse(summary.updatedAt)).not.toBeNaN()
  expect(directoryReads).toEqual([
    { directoryId: 'user#demo@example.com', locale: 'ja' },
  ])
  expect(accessListReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'demo@example.com',
    },
  ])
  expect(taskReads).toEqual([{ directoryId: 'user#demo@example.com', projectId: 'refero' }])
  expect(migrationSourceBatchReads).toEqual([[
    { issueId: 'wireframe', teamId: 'core-team' },
    { issueId: 'archive', teamId: 'core-team' },
  ]])
})

test('DynamoDB dashboard keeps same-ID legacy tasks isolated by migration source project', async () => {
  let migrationSourceProjectId = 'project-a'
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory(_directoryId: string, _locale: 'ja' | 'en') {
        return {
          teams: [{
            id: 'core-team',
            name: 'Core Team',
            expanded: true,
            projects: [
              { id: 'project-a', name: 'Project A', tone: 'blue' as const },
              { id: 'project-b', name: 'Project B', tone: 'green' as const },
            ],
          }],
        }
      },
      async getProjectAccessList(_directoryId: string, _memberKey: string) {
        return [{ projectId: 'project-b', role: 'viewer' as ProjectRole }]
      },
    } as never,
    {
      async getProjectTasks(_directoryId: string, projectId: string) {
        return {
          projectId,
          tasks: [{
            id: 'wireframe',
            title: 'Wireframe',
            assignee: '佐藤 花子',
            status: 'in-progress' as const,
            dueDate: '2026/06/03',
            priority: 'high' as const,
          }],
        }
      },
    } as never,
    {
      async getProjectIssues(_directoryId: string, projectId: string) {
        return { projectId, issues: [] }
      },
      async getTeamIssueMigrationSourceKeys(
        directoryId: string,
        _keys: readonly { issueId: string; teamId: string }[],
      ) {
        return new Set([
          `${directoryId}#project#${migrationSourceProjectId}#task#wireframe`,
        ])
      },
    } as never,
  )

  const mismatchedSourceSummary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })
  expect(mismatchedSourceSummary.tasks).toBe(1)
  expect(mismatchedSourceSummary.blocked).toBe(1)

  migrationSourceProjectId = 'project-b'
  const exactSourceSummary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })
  expect(exactSourceSummary.tasks).toBe(0)
  expect(exactSourceSummary.blocked).toBe(0)
})

test('DynamoDB dashboard omits legacy fallback when a project has multiple owner Teams', async () => {
  let legacyReads = 0
  let migrationSourceReads = 0
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory(_directoryId: string, _locale: 'ja' | 'en') {
        return {
          teams: [
            {
              id: 'core-team',
              name: 'Core Team',
              expanded: true,
              projects: [{ id: 'refero', name: 'Refero', tone: 'blue' as const }],
            },
            {
              id: 'design-team',
              name: 'Design Team',
              expanded: true,
              projects: [{ id: 'refero', name: 'Refero', tone: 'purple' as const }],
            },
          ],
        }
      },
      async getProjectAccessList(_directoryId: string, _memberKey: string) {
        return [{ projectId: 'refero', role: 'viewer' as ProjectRole }]
      },
    } as never,
    {
      async getProjectTasks(_directoryId: string, projectId: string) {
        legacyReads += 1
        return {
          projectId,
          tasks: [{
            id: 'wireframe',
            title: 'Wireframe',
            assignee: '佐藤 花子',
            status: 'in-progress' as const,
            dueDate: '2026/06/03',
            priority: 'high' as const,
          }],
        }
      },
    } as never,
    {
      async getProjectIssues(_directoryId: string, projectId: string) {
        return {
          projectId,
          issues: [{
            schemaVersion: 1 as const,
            revision: 1,
            id: 'canonical-review',
            teamId: 'core-team',
            assignedProjectId: projectId,
            title: 'Canonical review',
            status: 'review' as const,
            dueDate: '2026/06/10',
            priority: 'medium' as const,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
            source: 'dynamodb' as const,
          }],
        }
      },
      async getTeamIssueMigrationSourceKeys() {
        migrationSourceReads += 1
        return new Set<string>()
      },
    } as never,
  )

  const summary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })

  expect(summary.projects).toBe(1)
  expect(summary.tasks).toBe(1)
  expect(summary.blocked).toBe(0)
  expect(legacyReads).toBe(0)
  expect(migrationSourceReads).toBe(0)
})

test('DynamoDB directory client reads project access consistently for Workspace guards', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return { Items: createProjectMemberFixtureItems() }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.getProjectAccessList('user#demo@example.com', 'demo@example.com'),
  ).resolves.toEqual([{ projectId: 'refero', role: 'manager' }])
  expect(sentInputs).toEqual([
    expect.objectContaining({
      TableName: 'DirectoryTable',
      ConsistentRead: true,
    }),
  ])
})

test('DynamoDB directory client reads every page from the user partition', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
          LastEvaluatedKey: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
            entryType: 'project',
            teamId: 'core-team',
            teamSortOrder: 10,
            projectId: 'refero',
            projectSortOrder: 10,
            nameJa: 'Refero',
            nameEn: 'Refero',
            tone: 'blue',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: {
        directoryId: 'user#demo@example.com',
        entryKey: '000010#000000#TEAM#core-team',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB directory client omits archived teams and projects', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000020#PROJECT#archived-project',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'archived-project',
              projectSortOrder: 20,
              nameJa: 'Archived Project',
              nameEn: 'Archived Project',
              tone: 'green',
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000000#TEAM#archived-team',
              entryType: 'team',
              teamId: 'archived-team',
              teamSortOrder: 20,
              nameJa: 'Archived Team',
              nameEn: 'Archived Team',
              expanded: true,
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000010#PROJECT#hidden-project',
              entryType: 'project',
              teamId: 'archived-team',
              teamSortOrder: 20,
              projectId: 'hidden-project',
              projectSortOrder: 10,
              nameJa: 'Hidden Project',
              nameEn: 'Hidden Project',
              tone: 'yellow',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  await expect(client.hasProjectAccess('user#demo@example.com', 'refero')).resolves.toBe(true)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'archived-project'),
  ).resolves.toBe(false)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'hidden-project'),
  ).resolves.toBe(false)
})

test('DynamoDB directory client archives teams and projects with conditional updates', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.archiveTeam('user#demo@example.com', 'core-team')).resolves.toEqual({
    teamId: 'core-team',
    archivedAt: expect.any(String),
  })
  await expect(
    client.archiveProject('user#demo@example.com', 'core-team', 'refero'),
  ).resolves.toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Key: {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression:
      'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
  })
  expect(sentInputs[3]).toMatchObject({
    TableName: 'DirectoryTable',
    Key: {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000010#PROJECT#refero',
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression:
      'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
  })
})

test('DynamoDB directory client manages project member roles', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              name: 'Z Manager',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.getProjectMembers('user#demo@example.com', 'refero'),
  ).resolves.toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      {
        id: 'zmanager@example.com',
        email: 'zmanager@example.com',
        name: 'Z Manager',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    ],
  })
  await expect(
    client.getProjectRole('user#demo@example.com', 'refero', 'DEMO@example.com'),
  ).resolves.toBe('manager')
  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'sato@example.com', {
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }, 1),
  ).resolves.toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      updatedAt: expect.any(String),
    },
  })
  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).resolves.toEqual({
    projectId: 'refero',
    memberId: 'demo@example.com',
  })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[3]).toMatchObject({
    TransactItems: [
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#sato@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'sato@example.com',
            email: 'sato@example.com',
            name: '佐藤 花子',
            role: 'member',
          },
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#sato@example.com',
          },
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
    ],
  })
  expect(sentInputs[5]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
          ConditionExpression: '#role = :manager',
          ExpressionAttributeNames: {
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':manager': 'manager',
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':expectedUpdatedAt': '2026-06-08T00:00:00.000Z',
            ':expectedRole': 'manager',
          },
        },
      },
    ],
  })
  expect(sentInputs[4]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client keeps at least one project manager', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs).toHaveLength(2)
})

test('DynamoDB directory client treats manager guard transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'zmanager@example.com',
                    email: 'zmanager@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if ('Key' in command.input) {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Delete: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats deleted target member transaction cancellation as member not found', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'demo@example.com',
                    email: 'demo@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats manager downgrade transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeOtherManager: queryReads === 1,
          }),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Put: {
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            role: 'viewer',
          },
        },
      },
      {
        Update: {
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager update loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.updateProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      {
        email: 'demo@example.com',
        role: 'viewer',
      },
      1,
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager removal loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.removeProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client does not reread manager state when cancellation reasons are missing', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: createProjectMemberFixtureItems(),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'TransactionCanceledException',
  })
  expect(sentInputs).toHaveLength(2)
})

test('search endpoint parses filters and revalidates comment scope against current RBAC', async () => {
  configureFakeProjectClients(true)
  let capturedInput: WorkspaceSearchQueryInput | undefined
  let resolvedProjectId: string | undefined
  configureApiClientsForTest({
    workspaceSearch: {
      async search(input) {
        capturedInput = input
        const document = createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Current scope comment',
          body: 'Search body',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
        })
        resolvedProjectId = (await input.resolveCurrentScope?.(document))?.projectId
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })
  const filters = {
    keyword: 'scope',
    projectIds: ['refero'],
    customFields: [{ fieldId: 'score', operator: 'greater-than', value: 5 }],
  }

  const response = await app.request(
    `/api/search?filters=${encodeURIComponent(JSON.stringify(filters))}&limit=25`,
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput?.filters).toEqual(filters)
  expect(capturedInput?.limit).toBe(25)
  expect(capturedInput?.access.projectIds.has('refero')).toBe(true)
  expect(capturedInput?.access.teamIds.has('core-team')).toBe(true)
  expect(resolvedProjectId).toBe('refero')
})

test('search endpoint refreshes comment content from its current source snapshot', async () => {
  configureFakeProjectClients(true)
  let resolvedScope: WorkspaceSearchResolvedScope | undefined
  configureApiClientsForTest({
    collaboration: {
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: 'Current private decision',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
    workspaceSearch: {
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Stale title',
          body: 'Stale private decision',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
          updatedAt: '2026-06-08T01:00:00.000Z',
        }))
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      body: 'Current private decision',
      creatorUserId: 'sato@example.com',
      updatedAt: '2026-07-12T02:00:00.000Z',
    },
  })
})

test('search endpoint fails closed for missing, deleted, or malformed comment sources', async () => {
  configureFakeProjectClients(true)
  const resolvedScopes: Array<WorkspaceSearchResolvedScope | undefined> = []
  let snapshotReads = 0
  configureApiClientsForTest({
    collaboration: {
      async getCommentSnapshot(input) {
        snapshotReads += 1
        if (input.commentId === 'missing') return undefined
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          deletedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
    workspaceSearch: {
      async search(input) {
        for (const [commentId, parentId] of [
          ['missing', 'team/core-team/issue/issue-1'],
          ['deleted', 'team/core-team/issue/issue-1'],
          ['malformed', 'team/core-team/issue/other'],
        ] as const) {
          resolvedScopes.push(await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
            workspaceId: input.workspaceId,
            entityType: 'comment',
            entityId: `team/core-team/issue/issue-1/comment/${commentId}`,
            parentId,
            title: 'Stale title',
            body: 'Stale body',
            url: `/teams/core-team/issues?issueId=issue-1&commentId=${commentId}`,
            teamId: 'core-team',
          })))
        }
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScopes).toEqual([undefined, undefined, undefined])
  expect(snapshotReads).toBe(2)
})

test('search endpoint excludes archived Team documents for system administrators', async () => {
  configureFakeProjectClients(true, { systemAdminMemberKeys: ['demo@example.com'] })
  let resolvedScope: unknown = 'not-called'
  configureApiClientsForTest({
    workspaceSearch: {
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'work-item',
          entityId: 'team/archived-team/issue/issue-1',
          title: 'Archived Team item',
          url: '/teams/archived-team/issues?issueId=issue-1',
          teamId: 'archived-team',
        }))
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toBeUndefined()
})

test('saved view endpoints forward create update list and revision delete contracts', async () => {
  configureFakeProjectClients(true)
  const calls = {
    creates: [] as unknown[],
    deletes: [] as unknown[],
    lists: [] as unknown[],
    updates: [] as unknown[],
  }
  const view = {
    schemaVersion: 1 as const,
    id: 'view-1',
    name: 'Review queue',
    visibility: 'personal' as const,
    ownerUserId: 'demo@example.com',
    filters: { statuses: ['review'] },
    layout: { mode: 'table' as const, sort: [], columns: ['title'] },
    revision: 1,
    canEdit: true,
    favorite: false,
    pinned: false,
    isDefault: false,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  configureApiClientsForTest({
    workspaceSearch: {
      async listSavedViews(input) {
        calls.lists.push(input)
        return { views: [view] }
      },
      async createSavedView(input) {
        calls.creates.push(input)
        return view
      },
      async updateSavedView(input) {
        calls.updates.push(input)
        return { ...view, revision: 2, favorite: true }
      },
      async deleteSavedView(input) {
        calls.deletes.push(input)
        return { id: input.viewId, revision: input.expectedRevision }
      },
    } as unknown as WorkspaceSearchClient,
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'saved-view-request-1',
  }
  const listResponse = await app.request('/api/saved-views', { headers })
  const createResponse = await app.request('/api/saved-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Review queue',
      visibility: 'personal',
      filters: { statuses: ['review'] },
      layout: { mode: 'table', sort: [], columns: ['title'] },
    }),
  })
  const updateResponse = await app.request('/api/saved-views/view-1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, favorite: true }),
  })
  const deleteResponse = await app.request('/api/saved-views/view-1?expectedRevision=2', {
    method: 'DELETE',
    headers,
  })

  expect([listResponse.status, createResponse.status, updateResponse.status, deleteResponse.status])
    .toEqual([200, 201, 200, 200])
  expect(calls.lists).toHaveLength(1)
  expect(calls.creates).toHaveLength(1)
  expect(calls.creates[0]).toMatchObject({ idempotencyKey: 'saved-view-request-1' })
  expect(calls.updates).toHaveLength(1)
  expect(calls.deletes).toEqual([
    expect.objectContaining({ viewId: 'view-1', expectedRevision: 2 }),
  ])
})

test('keeps a primary mutation successful when search projection fails', async () => {
  configureFakeProjectClients(true)
  let projectedTitle: string | undefined
  configureApiClientsForTest({
    workspaceSearch: {
      async upsertDocument(document) {
        projectedTitle = document.title
        throw new Error('Search index unavailable')
      },
    } as unknown as WorkspaceSearchClient,
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Search resilient Team' }),
    })

    expect(response.status).toBe(201)
    expect(projectedTitle).toBe('Search resilient Team')
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

test('keeps a committed mutation successful when search document construction fails', async () => {
  configureFakeProjectClients(true)
  let projectionWrites = 0
  configureApiClientsForTest({
    workspaceSearch: {
      async upsertDocument(document) {
        projectionWrites += 1
        return createWorkspaceSearchDocument(document)
      },
    } as unknown as WorkspaceSearchClient,
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'x'.repeat(501) }),
    })

    expect(response.status).toBe(201)
    expect(projectionWrites).toBe(0)
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

function createProjectMemberFixtureItems(
  options: {
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    archivedProject?: boolean
    archivedTeam?: boolean
    includeOtherManager?: boolean
    includeTargetMember?: boolean
    targetRole?: ProjectRole
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true
  const includeTargetMember = options.includeTargetMember ?? true
  const targetRole = options.targetRole ?? 'manager'

  return [
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
      entryType: 'team',
      teamId: 'core-team',
      teamSortOrder: 10,
      nameJa: 'コアチーム',
      nameEn: 'Core Team',
      expanded: true,
      ...(options.archivedTeam ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000010#PROJECT#refero',
      entryType: 'project',
      teamId: 'core-team',
      teamSortOrder: 10,
      projectId: 'refero',
      projectSortOrder: 10,
      nameJa: 'Refero',
      nameEn: 'Refero',
      tone: 'blue',
      ...(options.archivedProject ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    ...(includeTargetMember
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: targetRole,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
    ...(includeOtherManager
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'zmanager@example.com',
            email: 'zmanager@example.com',
            role: 'manager',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
  ]
}

function createDirectoryMutationAuditContext() {
  return createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'directory-mutation-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/projects/refero/members/demo@example.com' },
    source: { kind: 'api', requestId: 'directory-mutation-request' },
  })
}

function createFakeAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'audit-export-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'GET', path: '/api/audit/events/export' },
    source: { kind: 'api', requestId: 'audit-export-request' },
  })

  return createAuditEvent({
    context,
    eventType: 'project.updated',
    entity: { type: 'project', id: 'refero' },
  })
}

function configureFakeProjectClients(
  hasProjectAccess: boolean,
  options: {
    /** Cognito user pagination fake が page ごとに返す user ID と token です。 */
    cognitoUserPages?: Array<{ userIds: string[]; nextToken?: string }>
    /** Cognito user 一覧 fake が返す次 page token です。 */
    cognitoUsersNextToken?: string
    profileError?: Error
    inactiveWorkspaceMemberKeys?: string[]
    mentionAccessDeniedMemberKeys?: string[]
    /** NEW_PASSWORD_REQUIRED challenge で Cognito が返す error です。 */
    newPasswordChallengeError?: CognitoServiceError
    newPasswordChallengeTokens?: boolean
    passwordAuthChallenge?: boolean
    passwordAuthTokens?: boolean
    projectAccesses?: Array<{ projectId: string; role?: ProjectRole }>
    role?: ProjectRole
    systemAdminMemberKeys?: string[]
    taskAssigneeUserId?: string
    /** Notification 認可で再取得する Work Item の現在 assigned Project ID です。 */
    detailAssignedProjectId?: string
    /** Notification 認可で再取得する Work Item の現在担当者です。 */
    detailAssigneeUserId?: string
    teamProjects?: Array<{ id: string; name: string; tone: 'blue' | 'purple' | 'green' | 'yellow' }>
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    /** Legacy task と同じ ID の canonical row を所有する Team ID です。 */
    migratedLegacyOwnerTeamId?: string
    /** Migration 後の canonical row が現在アサインされている project ID です。 */
    migratedLegacyAssignedProjectId?: string
    /** Migration metadata が指す元 legacy project ID です。 */
    migratedLegacySourceProjectId?: string
    /** Migrated canonical fake に stable source metadata が存在するかどうかです。 */
    migratedLegacyHasSourceMetadata?: boolean
    /** Migrated canonical fake が project 未アサインかどうかです。 */
    migratedLegacyUnassigned?: boolean
    /** Legacy project task fake が返す task ID です。 */
    legacyTaskIds?: string[]
    /** Project 別 canonical Work Item fake が返す Issue ID です。 */
    canonicalProjectIssueIds?: string[]
    /** Team Issue fake が返す canonical Work Item 数です。 */
    teamIssueCount?: number
    /** Team Issue fake の先頭に置く閲覧不可 Work Item 数です。 */
    inaccessibleTeamIssueCount?: number
    unassignedIssue?: boolean
    workspaceRole?: WorkspaceRole
    workspaceReconcileFailures?: number
    workspaceStatus?: WorkspaceMemberStatus
    /** Invitation provisioning 時に Cognito user が存在しない状態を再現します。 */
    workspaceUserMissing?: boolean
    /** AdminCreateUser と競合して temporary-password user が作成された状態を再現します。 */
    workspaceProvisionRace?: boolean
  } = {},
) {
  const role = 'role' in options ? options.role : 'manager'
  const workspaceRole = options.workspaceRole ?? 'owner'
  const workspaceStatus = options.workspaceStatus ?? 'active'
  let workspaceReconcileFailures = options.workspaceReconcileFailures ?? 0
  const calls = {
    accessChecks: [] as Array<{ directoryId: string; projectId: string }>,
    directoryReads: [] as Array<{
      directoryId: string
      locale: string
      consistentRead?: boolean
    }>,
    memberDeletes: [] as Array<{ directoryId: string; projectId: string; memberKey: string }>,
    memberReads: [] as Array<{ directoryId: string; projectId: string }>,
    memberUpdates: [] as Array<{
      directoryId: string
      memberKey: string
      projectId: string
      role: string
    }>,
    migrationSourceBatchReads: [] as Array<{
      directoryId: string
      keys: Array<{ issueId: string; teamId: string }>
    }>,
    projectArchives: [] as Array<{ directoryId: string; teamId: string; projectId: string }>,
    projectCreates: [] as Array<{
      creatorUserKey: string
      directoryId: string
      name: string
      teamId: string
    }>,
    roleChecks: [] as Array<{ directoryId: string; memberKey: string; projectId: string }>,
    summaryReads: [] as Array<{
      directoryId: string
      isSystemAdmin: boolean
      userKey: string
    }>,
    teamArchives: [] as Array<{ directoryId: string; teamId: string }>,
    teamCreates: [] as Array<{ directoryId: string; name: string }>,
    issueComments: [] as Array<{ actorUserId: string; directoryId: string; issueId: string; teamId: string }>,
    issueCreates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      reservedIssueIds?: string[]
      teamId: string
      title: string
    }>,
    issueDetails: [] as Array<{
      directoryId: string
      issueId: string
      teamId: string
      readOptions?: {
        consistentIssueRead?: boolean
        eventCursor?: string
        eventLimit?: number
        eventType?: string
        newestEventsFirst?: boolean
      }
    }>,
    issueReads: [] as Array<{ directoryId: string; limit?: number; teamId: string }>,
    issueUpdates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      issueId: string
      teamId: string
    }>,
    projectIssueReads: [] as Array<{ directoryId: string; limit?: number; projectId: string }>,
    taskCreates: [] as Array<{ directoryId: string; projectId: string; title: string }>,
    taskReads: [] as Array<{ directoryId: string; limit?: number; projectId: string }>,
    taskStatusUpdates: [] as Array<{
      directoryId: string
      projectId: string
      status: string
      taskId: string
    }>,
    userLists: [] as Array<{
      directoryId?: string
      limit?: number
      paginationToken?: string
      query?: string
    }>,
    userProfiles: [] as string[],
    workspaceInvitationResends: [] as string[],
    workspaceReconciliations: [] as string[],
  }
  const createWorkspaceMember = (memberKey: string) => ({
    id: memberKey,
    memberKey,
    email: memberKey,
    name: memberKey === 'demo@example.com' ? 'Demo User' : undefined,
    role: memberKey === 'demo@example.com' ? workspaceRole : 'member' as WorkspaceRole,
    status: memberKey === 'demo@example.com'
      ? workspaceStatus
      : options.inactiveWorkspaceMemberKeys?.includes(memberKey)
        ? 'deactivated' as WorkspaceMemberStatus
        : 'active' as WorkspaceMemberStatus,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  })

  configureApiClientsForTest({
    collaboration: {
      async getThread() {
        return {
          comments: [],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          reactions: [],
        }
      },
    } as CollaborationClient,
    cognito: {
      async initiatePasswordAuth() {
        if (options.passwordAuthChallenge) {
          return {
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: 'new-password-session',
          }
        }

        if (options.passwordAuthTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async respondToNewPasswordChallenge() {
        if (options.newPasswordChallengeError) {
          throw options.newPasswordChallengeError
        }

        if (options.newPasswordChallengeTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'Demo@Example.com',
            },
          ],
        }
      },
      async listUsers(input) {
        calls.userLists.push(input)
        const page = options.cognitoUserPages?.[calls.userLists.length - 1]

        if (page) {
          return {
            users: page.userIds.map(createFakeCognitoProfile),
            nextToken: page.nextToken,
          }
        }

        return {
          users: [createFakeCognitoProfile('sato@example.com')],
          nextToken: options.cognitoUsersNextToken,
        }
      },
      async getUserProfile(userId) {
        calls.userProfiles.push(userId)

        if (options.profileError) {
          throw options.profileError
        }

        return createFakeCognitoProfile(userId)
      },
      async isSystemAdmin(userId) {
        return options.systemAdminMemberKeys?.includes(userId.toLowerCase()) ?? false
      },
      async findWorkspaceUser(userId) {
        if (options.workspaceUserMissing || options.workspaceProvisionRace) {
          return undefined
        }

        return {
          profile: {
            ...createFakeCognitoProfile(userId),
            status: 'FORCE_CHANGE_PASSWORD',
          },
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser(input) {
        if (options.workspaceProvisionRace) {
          calls.workspaceInvitationResends.push(input.email)
          return {
            profile: {
              ...createFakeCognitoProfile(input.email),
              status: 'FORCE_CHANGE_PASSWORD',
            },
            identityOwnership: 'ambiguous',
            deliveryStatus: 'sent',
          }
        }

        return {
          profile: createFakeCognitoProfile(input.email),
          identityOwnership: input.existingUser ? 'pre-existing' : 'workspace-created',
          deliveryStatus: input.existingUser ? 'not-required' : 'sent',
        }
      },
      async resendWorkspaceUserInvitation(userId) {
        calls.workspaceInvitationResends.push(userId)
      },
      async deleteWorkspaceUser() {},
    },
    dashboardSummary: {
      async getSummary(directoryId, accessContext) {
        calls.summaryReads.push({
          directoryId,
          isSystemAdmin: accessContext.isSystemAdmin,
          userKey: accessContext.userKey,
        })

        return {
          projects: 1,
          tasks: 1,
          blocked: 0,
          updatedAt: '2026-06-03T00:00:00.000Z',
          source: 'dynamodb',
        }
      },
    },
    projectDirectory: {
      async getProjectDirectory(directoryId, locale, consistentRead) {
        calls.directoryReads.push({
          directoryId,
          locale,
          ...(consistentRead === undefined ? {} : { consistentRead }),
        })

        return {
          teams: [
            {
              id: 'core-team',
              name: locale === 'en' ? 'Core Team' : 'コアチーム',
              expanded: true,
              projects: options.teamProjects ?? [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
              ],
            },
            ...(options.additionalTeams ?? []),
          ],
        }
      },
      async getProjectAccess(directoryId, projectId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return undefined
        }

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)
        }

        if (!hasProjectAccess) {
          return undefined
        }

        return {
          projectId,
          role,
        }
      },
      async getProjectAccessList(directoryId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId: '*' })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return []
        }

        if (options.projectAccesses) {
          return options.projectAccesses
        }

        if (!hasProjectAccess) {
          return []
        }

        return [
          {
            projectId: 'refero',
            role,
          },
        ]
      },
      async hasProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        return hasProjectAccess
      },
      async getProjectRole(directoryId, projectId, memberKey) {
        calls.roleChecks.push({ directoryId, projectId, memberKey })

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)?.role
        }

        return role
      },
      async getProjectMembers(directoryId, projectId) {
        calls.memberReads.push({ directoryId, projectId })

        return {
          projectId,
          members: [
            {
              id: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async updateProjectMember(directoryId, projectId, memberKey, input) {
        calls.memberUpdates.push({
          directoryId,
          memberKey,
          projectId,
          role: String(input.role),
        })

        return {
          member: {
            id: memberKey,
            email: String(input.email ?? memberKey),
            name: typeof input.name === 'string' ? input.name : undefined,
            role: input.role === 'member' ? 'member' : input.role === 'manager' ? 'manager' : 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember(directoryId, projectId, memberKey) {
        calls.memberDeletes.push({ directoryId, projectId, memberKey })

        return {
          projectId,
          memberId: memberKey,
        }
      },
      async createTeam(directoryId, input) {
        calls.teamCreates.push({ directoryId, name: String(input.name) })

        return {
          team: {
            id: 'new-team',
            name: String(input.name),
            expanded: true,
            projects: [],
          },
        }
      },
      async createProject(directoryId, teamId, input, creator) {
        calls.projectCreates.push({
          creatorUserKey: creator.userKey,
          directoryId,
          name: String(input.name),
          teamId,
        })

        return {
          project: {
            id: 'new-project',
            name: String(input.name),
            tone: 'green',
          },
        }
      },
      async archiveTeam(directoryId, teamId) {
        calls.teamArchives.push({ directoryId, teamId })

        return {
          teamId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject(directoryId, teamId, projectId) {
        calls.projectArchives.push({ directoryId, teamId, projectId })

        return {
          teamId,
          projectId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    workspaceAccess: {
      async getMember(_workspaceId, memberKey) {
        return createWorkspaceMember(memberKey)
      },
      async getActiveMember(_workspaceId, memberKey) {
        const member = createWorkspaceMember(memberKey)
        return member.status === 'active' ? member : undefined
      },
      async listActiveMembers() {
        return [
          createWorkspaceMember('demo@example.com'),
          createWorkspaceMember('sato@example.com'),
          createWorkspaceMember('suzuki@example.com'),
          createWorkspaceMember('viewer@example.com'),
        ].filter((member) => member.status === 'active')
      },
      async getAccessSnapshot(_workspaceId, memberKey) {
        const currentMember = createWorkspaceMember(memberKey)
        return {
          currentMember,
          members: [currentMember, createWorkspaceMember('sato@example.com')],
          invitations: [],
          capabilities: {
            canInvite: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageMembers: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageAdmins: currentMember.role === 'owner',
          },
        }
      },
      async getInvitation() {
        return undefined
      },
      async createInvitation(_workspaceId, _actorMemberKey, input) {
        return {
          id: input.email,
          email: input.email,
          name: input.name,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: input.deliveryStatus === 'failed' ? 'delivery-failed' : 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationCleanupFailure(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
      async clearInvitationCleanupFailure(_workspaceId, invitationId, expectedVersion) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async prepareResend() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async revokeInvitation() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async prepareReinvite() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async reconcileAuthenticatedMember(_workspaceId, input) {
        calls.workspaceReconciliations.push(input.memberKey)

        if (workspaceReconcileFailures > 0) {
          workspaceReconcileFailures -= 1
          throw new WorkspaceAccessError(
            503,
            'WorkspaceAccessUnavailable',
            'Workspace membership update failed.',
          )
        }

        return createWorkspaceMember(input.memberKey)
      },
      async updateMember(_workspaceId, _actorMemberKey, memberKey, input) {
        return {
          ...createWorkspaceMember(memberKey),
          role: input.role ?? createWorkspaceMember(memberKey).role,
          status: input.status ?? createWorkspaceMember(memberKey).status,
          version: input.expectedVersion + 1,
        }
      },
    },
    projectTasks: {
      async getProjectTasks(directoryId, projectId, readOptions) {
        calls.taskReads.push({
          directoryId,
          projectId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const tasks = (options.legacyTaskIds ?? ['wireframe']).map((taskId, index) => ({
          id: taskId,
          ...(taskId === 'wireframe'
            ? { titleKey: 'tasks.item.wireframe' as const }
            : { title: `Legacy Work Item ${index}` }),
          assigneeKey: 'tasks.assignee.sato' as const,
          assigneeUserId: options.taskAssigneeUserId,
          status: 'in-progress' as const,
          dueDate: '2026/06/03',
          priority: 'high' as const,
        }))
        return {
          projectId,
          tasks: readOptions?.limit === undefined ? tasks : tasks.slice(0, readOptions.limit),
        }
      },
      async createProjectTask(directoryId, projectId, input) {
        calls.taskCreates.push({ directoryId, projectId, title: String(input.title) })

        return {
          task: {
            id: 'new-task',
            title: String(input.title),
            assigneeUserId: String(input.assigneeUserId),
            status: 'todo',
            dueDate: String(input.dueDate),
            priority: 'high',
          },
        }
      },
      async updateProjectTaskStatus(directoryId, projectId, taskId, input) {
        calls.taskStatusUpdates.push({
          directoryId,
          projectId,
          status: String(input.status),
          taskId,
        })

        return {
          task: {
            id: taskId,
            titleKey: 'tasks.item.wireframe',
            assigneeKey: 'tasks.assignee.sato',
            status: input.status === 'done' ? 'done' : 'todo',
            dueDate: '2026/06/03',
            priority: 'high',
          },
        }
      },
    },
    teamIssues: {
      async getTeamIssues(directoryId, teamId, readOptions) {
        calls.issueReads.push({
          directoryId,
          teamId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = [
          ...Array.from({ length: options.teamIssueCount ?? 1 }, (_, index) => ({
            schemaVersion: 1 as const,
            revision: 1,
            id: index === 0 ? 'onboarding-friction' : `work-item-${index}`,
            teamId,
            assignedProjectId: index < (options.inaccessibleTeamIssueCount ?? 0)
              ? 'private-project'
              : options.unassignedIssue ? undefined : 'refero',
            title: index === 0
              ? '初回オンボーディングの離脱要因を減らす'
              : `Work Item ${index}`,
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: 'sato@example.com',
            status: 'in-progress' as const,
            dueDate: '2026/06/18',
            priority: 'high' as const,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb' as const,
          })),
          ...(options.migratedLegacyOwnerTeamId === teamId
            ? [{
                schemaVersion: 1 as const,
                revision: 1,
                id: 'wireframe',
                teamId,
                assignedProjectId: options.migratedLegacyUnassigned
                  ? undefined
                  : options.migratedLegacyAssignedProjectId ?? 'refero',
                title: 'Migrated wireframe',
                assigneeUserId: 'sato@example.com',
                status: 'in-progress' as const,
                dueDate: '2026/06/03',
                priority: 'high' as const,
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-06-01T00:00:00.000Z',
                source: 'dynamodb' as const,
              }]
            : []),
        ]
        return {
          teamId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getTeamIssuesForAggregate(directoryId, teamId, readOptions) {
        const response = await this.getTeamIssues(directoryId, teamId, readOptions)
        const containsMigratedIssue = response.issues.some((issue) =>
          issue.id === 'wireframe' && issue.teamId === options.migratedLegacyOwnerTeamId
        )

        return {
          ...response,
          migrationSourceKeys: containsMigratedIssue &&
            options.migratedLegacyHasSourceMetadata !== false
            ? [
                `${directoryId}#project#${options.migratedLegacySourceProjectId ?? 'refero'}` +
                '#task#wireframe',
              ]
            : [],
        }
      },
      async getTeamIssueMigrationSourceKeys(directoryId, keys) {
        const migrationSourceKey =
          `${directoryId}#project#${options.migratedLegacySourceProjectId ?? 'refero'}` +
          '#task#wireframe'
        calls.migrationSourceBatchReads.push({
          directoryId,
          keys: keys.map((key) => ({ ...key })),
        })

        const containsMigratedIssue = keys.some((key) =>
          key.teamId === options.migratedLegacyOwnerTeamId &&
          key.issueId === 'wireframe'
        )

        return containsMigratedIssue && options.migratedLegacyHasSourceMetadata !== false
          ? new Set([migrationSourceKey])
          : new Set<string>()
      },
      async getProjectIssues(directoryId, projectId, readOptions) {
        calls.projectIssueReads.push({
          directoryId,
          projectId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = options.canonicalProjectIssueIds
          ? options.canonicalProjectIssueIds.map((issueId, index) => ({
              schemaVersion: 1 as const,
              revision: 1,
              id: issueId,
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: `Canonical Work Item ${index}`,
              assigneeUserId: 'sato@example.com',
              status: 'in-progress' as const,
              dueDate: '2026/06/18',
              priority: 'high' as const,
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
              source: 'dynamodb' as const,
            }))
          : [
              {
                schemaVersion: 1 as const,
                revision: 1,
                id: 'onboarding-friction',
                teamId: 'core-team',
                assignedProjectId: projectId,
                title: '初回オンボーディングの離脱要因を減らす',
                assigneeUserId: 'sato@example.com',
                status: 'in-progress' as const,
                dueDate: '2026/06/18',
                priority: 'high' as const,
                createdAt: '2026-06-08T00:00:00.000Z',
                updatedAt: '2026-06-08T00:00:00.000Z',
                source: 'dynamodb' as const,
              },
              ...(options.migratedLegacyOwnerTeamId &&
                !options.migratedLegacyUnassigned &&
                projectId === (options.migratedLegacyAssignedProjectId ?? 'refero')
                ? [{
                    schemaVersion: 1 as const,
                    revision: 1,
                    id: 'wireframe',
                    teamId: options.migratedLegacyOwnerTeamId,
                    assignedProjectId: options.migratedLegacyAssignedProjectId ?? 'refero',
                    title: 'Migrated wireframe',
                    assigneeUserId: 'sato@example.com',
                    status: 'in-progress' as const,
                    dueDate: '2026/06/03',
                    priority: 'high' as const,
                    createdAt: '2026-06-01T00:00:00.000Z',
                    updatedAt: '2026-06-01T00:00:00.000Z',
                    source: 'dynamodb' as const,
                  }]
                : []),
            ]
        return {
          projectId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getTeamIssueDetail(directoryId, teamId, issueId, readOptions) {
        calls.issueDetails.push({
          directoryId,
          teamId,
          issueId,
          ...(readOptions ? { readOptions } : {}),
        })

        if (issueId === 'wireframe') {
          throw {
            status: 404,
            code: 'TeamIssueNotFound',
            message: 'Issue was not found.',
          }
        }

        return {
          issue: {
            schemaVersion: 1,
            revision: 1,
            id: issueId,
            teamId,
            assignedProjectId: options.unassignedIssue
              ? undefined
              : options.detailAssignedProjectId ?? 'refero',
            title: '初回オンボーディングの離脱要因を減らす',
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: options.detailAssigneeUserId ?? 'sato@example.com',
            status: 'in-progress',
            dueDate: '2026/06/18',
            priority: 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
          comments: [
            {
              id: 'comment-1',
              actorUserId: 'demo@example.com',
              body: '背景を確認します。',
              createdAt: '2026-06-08T01:00:00.000Z',
            },
          ],
          activity: [
            {
              id: 'activity-1',
              type: 'created',
              actorUserId: 'demo@example.com',
              summary: 'Issue was created.',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async createTeamIssue(directoryId, teamId, input, actorUserId, reservedIssueIds = []) {
        calls.issueCreates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          reservedIssueIds,
          teamId,
          title: String(input.title),
        })

        return {
          issue: {
            schemaVersion: 1,
            revision: 1,
            id: 'new-issue',
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: String(input.title),
            description: typeof input.description === 'string' ? input.description : undefined,
            assigneeUserId: String(input.assigneeUserId),
            status: 'todo',
            dueDate: String(input.dueDate),
            priority: 'medium',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueUpdates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          issueId,
          teamId,
        })

        return {
          issue: {
            schemaVersion: 1,
            revision: 2,
            id: issueId,
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: typeof input.title === 'string' ? input.title : '初回オンボーディングの離脱要因を減らす',
            assigneeUserId: typeof input.assigneeUserId === 'string' ? input.assigneeUserId : 'sato@example.com',
            status: input.status === 'done' ? 'done' : 'in-progress',
            dueDate: typeof input.dueDate === 'string' ? input.dueDate : '2026/06/18',
            priority: input.priority === 'low' ? 'low' : 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T02:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async createTeamIssueComment(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueComments.push({ actorUserId, directoryId, issueId, teamId })

        return {
          comment: {
            id: 'comment-2',
            actorUserId,
            body: String(input.body),
            createdAt: '2026-06-08T02:00:00.000Z',
          },
          activity: {
            id: 'activity-2',
            type: 'commented',
            actorUserId,
            summary: 'Comment was added.',
            createdAt: '2026-06-08T02:00:00.000Z',
          },
        }
      },
    },
  })

  return calls
}

function configureFakeAuthenticatedUser(
  attributes: Record<string, string>,
  onGetUser: () => void = () => undefined,
) {
  configureApiClientsForTest({
    cognito: {
      async initiatePasswordAuth() {
        return {}
      },
      async getUser() {
        onGetUser()

        return {
          Username: attributes.email ?? 'demo@example.com',
          UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
        }
      },
      async listUsers() {
        return { users: [] }
      },
      async getUserProfile(userId) {
        return createFakeCognitoProfile(userId)
      },
    },
  })
}

function createLambdaHttpEvent(rawPath: string, accessToken: string) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${accessToken}`,
      host: 'example.lambda-url.us-east-1.on.aws',
    },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'function-url',
      authentication: null,
      authorizer: {},
      domainName: 'example.lambda-url.us-east-1.on.aws',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'bun:test',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '11/Jul/2026:00:00:00 +0000',
      timeEpoch: 1_783_728_000_000,
    },
  } satisfies Extract<LambdaEvent, { rawPath: string }>
}

async function withTestEnvironment(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>,
) {
  const originalValues = new Map(
    Object.keys(values).map((name) => [name, Bun.env[name]]),
  )

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete Bun.env[name]
    } else {
      Bun.env[name] = value
    }
  }

  try {
    await callback()
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) {
        delete Bun.env[name]
      } else {
        Bun.env[name] = value
      }
    }
  }
}

function createFakeCognitoProfile(userId: string) {
  const id = userId.trim().toLowerCase()
  const names: Record<string, string> = {
    'demo@example.com': 'Demo User',
    'sato@example.com': '佐藤 花子',
    'suzuki@example.com': '鈴木 太郎',
    'viewer@example.com': 'Viewer User',
  }

  return {
    id,
    username: id,
    email: id,
    name: names[id],
    enabled: true,
    status: 'CONFIRMED',
  }
}

function createFakeAuthTokenSet() {
  return {
    AccessToken: 'test-token',
    IdToken: 'test-id-token',
    RefreshToken: 'test-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  }
}

function createWorkspaceBootstrapItems() {
  return [
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE#METADATA',
      entryType: 'workspace-metadata',
      workspaceId: 'workspace#production',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE_MEMBER#owner@example.com',
      entryType: 'workspace-member',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
      role: 'owner',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'EMAIL_ALIAS#owner@example.com',
      entryType: 'email-alias',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
    },
  ]
}

function createAccessToken(groups: string[] = [], claims: Record<string, unknown> = {}) {
  const payload = Buffer
    .from(JSON.stringify({ ...claims, 'cognito:groups': groups }))
    .toString('base64url')

  return `header.${payload}.signature`
}
