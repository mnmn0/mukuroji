import {
  createApiTestHarness,
  type ObservedWorkspaceMutationAuditContext,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createCognitoSdkTestError,
  createFakeAuthTokenSet,
  createWorkspaceAccessFake,
  expectStableWorkspaceMutationAuditContexts,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  AwsCognitoClient,
  FlociCognitoClient,
} from './cognito-client'
import type {
  WorkspaceAccessClient,
} from '../../../workspace-access/workspace-access'
import type {
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
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

      if (commandName === 'RespondToAuthChallengeCommand') {
        return { AuthenticationResult: { AccessToken: 'challenge-access-token' } }
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

      if (commandName === 'DescribeIdentityProviderCommand') {
        return {
          IdentityProvider: {
            ProviderName: 'EnterpriseOidc',
            ProviderType: 'OIDC',
            ProviderDetails: {
              oidc_issuer: 'https://idp.example.com',
              client_id: 'enterprise-client',
            },
          },
        }
      }

      if (commandName === 'DescribeUserPoolClientCommand') {
        return {
          UserPoolClient: {
            ClientId: 'mukuroji-sso-client',
            ClientSecret: undefined,
            SupportedIdentityProviders: ['EnterpriseOidc'],
            AllowedOAuthFlowsUserPoolClient: true,
            AllowedOAuthFlows: ['code'],
            AllowedOAuthScopes: ['openid', 'email', 'profile'],
            CallbackURLs: ['https://app.example.com/api/auth/sso/callback'],
            ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
          },
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
  await expect(client.respondToNewPasswordChallenge(
    'demo@example.com',
    'Permanent123!',
    'new-password-session',
  )).resolves.toMatchObject({
    AuthenticationResult: { AccessToken: 'challenge-access-token' },
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
        mfaConfigured: false,
        status: undefined,
      },
    ],
    nextToken: undefined,
  })
  await expect(client.getUserProfile('valid@example.com')).resolves.toMatchObject({
    id: 'valid@example.com',
  })
  await expect(client.describeEnterpriseIdentityProvider('EnterpriseOidc'))
    .resolves.toEqual({
      providerName: 'EnterpriseOidc',
      providerType: 'OIDC',
      providerDetails: {
        oidc_issuer: 'https://idp.example.com',
        client_id: 'enterprise-client',
      },
    })
  await expect(client.describeEnterpriseSsoAppClient('mukuroji-sso-client'))
    .resolves.toEqual({
      clientId: 'mukuroji-sso-client',
      hasClientSecret: false,
      supportedIdentityProviders: ['EnterpriseOidc'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ['code'],
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      callbackUrls: ['https://app.example.com/api/auth/sso/callback'],
    })
  expect(commandNames).toEqual([
    'InitiateAuthCommand',
    'RespondToAuthChallengeCommand',
    'GetUserCommand',
    'ListUsersCommand',
    'AdminGetUserCommand',
    'DescribeIdentityProviderCommand',
    'DescribeUserPoolClientCommand',
  ])
})

test('runs the Workspace identity lifecycle through the production AWS Cognito adapter', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const adminGetAttempts = new Map<string, number>()
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name === 'RespondToAuthChallengeCommand') {
        return { AuthenticationResult: createFakeAuthTokenSet() }
      }

      if (name === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      const username = typeof input.Username === 'string' ? input.Username : ''

      if (name === 'AdminGetUserCommand') {
        const attempt = (adminGetAttempts.get(username) ?? 0) + 1
        adminGetAttempts.set(username, attempt)
        const userId = username.startsWith('sub-') ? username.slice(4) : username

        if (
          (username === 'new-user@example.com' && attempt <= 2) ||
          (username === 'raced-user@example.com' && attempt <= 2)
        ) {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        if (userId === 'missing@example.com') {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        if (username === 'existing@example.com') {
          return {
            Username: 'CaseSensitiveExisting',
            UserAttributes: [
              { Name: 'email', Value: username },
              { Name: 'sub', Value: 'sub-existing' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }
        }

        const directoryId = userId === 'other-workspace@example.com'
          ? 'workspace#other'
          : 'user#demo@example.com'

        return {
          Username: userId,
          UserAttributes: [
            { Name: 'email', Value: userId },
            { Name: 'sub', Value: username.startsWith('sub-') ? username : `sub-${username}` },
            { Name: 'custom:directory_id', Value: directoryId },
            { Name: 'custom:workspace_id', Value: directoryId },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (name === 'AdminCreateUserCommand') {
        if (username === 'raced-user@example.com' && input.MessageAction !== 'RESEND') {
          throw createCognitoSdkTestError('UsernameExistsException', 400)
        }

        return {
          User: {
            Username: username,
            Attributes: [
              { Name: 'email', Value: username },
              { Name: 'sub', Value: `sub-${username}` },
              { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
              { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          },
        }
      }

      if (name === 'AdminDeleteUserCommand' && username === 'sub-missing@example.com') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (name === 'AdminDeleteUserCommand' && username === 'sub-forbidden@example.com') {
        throw createCognitoSdkTestError('AccessDeniedException', 403)
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ cognito: client })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'Demo@Example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(200)
  expect(await challengeResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual(['demo@example.com'])

  const invite = async (email: string) => {
    const response = await app.request('/api/workspace/invitations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, name: 'Invitee', role: 'member' }),
    })

    expect(response.status).toBe(201)
    return response.json()
  }

  await expect(invite('existing@example.com')).resolves.toMatchObject({
    invitation: {
      directoryClaimCleanupRequired: true,
      deliveryStatus: 'sent',
      identityOwnership: 'pre-existing',
    },
  })
  await expect(invite('new-user@example.com')).resolves.toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      identityOwnership: 'workspace-created',
    },
  })
  await expect(invite('raced-user@example.com')).resolves.toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      identityOwnership: 'ambiguous',
    },
  })
  await expect(client.provisionWorkspaceUser({
    email: 'other-workspace@example.com',
    directoryId: 'user#demo@example.com',
    beforeDirectoryClaimUpdate: async () => {},
  })).rejects.toMatchObject({
    code: 'WorkspaceDirectoryConflict',
    status: 409,
  })

  setTestAppDependencies({
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId: string,
        _actorMemberKey: string,
        invitationId: string,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-new-user@example.com',
          cognitoUsername: 'new-user@example.com',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId: string,
        invitationId: string,
        expectedVersion: number,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-new-user@example.com',
          cognitoUsername: 'new-user@example.com',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })
  const revokeResponse = await app.request(
    '/api/workspace/invitations/new-user%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )
  expect(revokeResponse.status).toBe(200)
  expect(await revokeResponse.json()).toMatchObject({
    invitation: { identityOwnership: 'workspace-created', status: 'revoked' },
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'missing@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-missing@example.com',
    cognitoUsername: 'missing@example.com',
  })).resolves.toBe('absent')
  await expect(client.deleteWorkspaceUser({
    userId: 'forbidden@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-forbidden@example.com',
    cognitoUsername: 'forbidden@example.com',
  })).rejects.toMatchObject({
    code: 'AccessDeniedException',
    status: 403,
  })

  expect(adminGetAttempts).toEqual(new Map([
    ['demo@example.com', 1],
    ['existing@example.com', 1],
    ['new-user@example.com', 2],
    ['sub-new-user@example.com', 1],
    ['raced-user@example.com', 3],
    ['other-workspace@example.com', 1],
    ['sub-missing@example.com', 1],
    ['missing@example.com', 1],
    ['sub-forbidden@example.com', 1],
  ]))
  expect(sentCommands
    .filter(({ name }) => name !== 'GetUserCommand')
    .map(({ name }) => name)).toEqual([
    'AdminGetUserCommand',
    'RespondToAuthChallengeCommand',
    'AdminListGroupsForUserCommand',
    'AdminGetUserCommand',
    'AdminUpdateUserAttributesCommand',
    'AdminCreateUserCommand',
    'AdminListGroupsForUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminListGroupsForUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminUpdateUserAttributesCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminListGroupsForUserCommand',
    'AdminGetUserCommand',
    'AdminDeleteUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminDeleteUserCommand',
  ])
  expect(sentCommands.find(({ name }) => name === 'RespondToAuthChallengeCommand')?.input).toEqual({
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ChallengeResponses: {
      USERNAME: 'demo@example.com',
      NEW_PASSWORD: 'Permanent123!',
    },
    ClientId: 'mukuroji-client',
    Session: 'new-password-session',
  })
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminGetUserCommand'
  ).every(({ input }) => input.UserPoolId === 'us-east-1_mukuroji')).toBe(true)
  expect(sentCommands.find(({ name, input }) =>
    name === 'AdminUpdateUserAttributesCommand' &&
    input.Username === 'CaseSensitiveExisting'
  )?.input).toEqual({
    UserPoolId: 'us-east-1_mukuroji',
    Username: 'CaseSensitiveExisting',
    UserAttributes: [
      { Name: 'email', Value: 'existing@example.com' },
      { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
      { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
      { Name: 'name', Value: 'Invitee' },
    ],
  })
  expect(sentCommands.find(({ name, input }) =>
    name === 'AdminCreateUserCommand' &&
    input.Username === 'new-user@example.com' &&
    input.MessageAction === undefined
  )?.input).toEqual({
    UserPoolId: 'us-east-1_mukuroji',
    Username: 'new-user@example.com',
    DesiredDeliveryMediums: ['EMAIL'],
    UserAttributes: [
      { Name: 'email', Value: 'new-user@example.com' },
      { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
      { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
      { Name: 'name', Value: 'Invitee' },
    ],
  })
  expect(sentCommands.filter(({ name, input }) =>
    name === 'AdminCreateUserCommand' && input.MessageAction === 'RESEND'
  ).map(({ input }) => input.Username)).toEqual([
    'CaseSensitiveExisting',
    'raced-user@example.com',
  ])
  expect(sentCommands.some(({ name, input }) =>
    (
      name === 'AdminUpdateUserAttributesCommand' ||
      name === 'AdminCreateUserCommand'
    ) && input.Username === 'other-workspace@example.com'
  )).toBe(false)
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand'
  ).map(({ input }) => input)).toEqual([
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-new-user@example.com',
    },
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-forbidden@example.com',
    },
  ])
})

test('preserves confirmed Cognito identities while removing invitation-owned directory claims', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name === 'AdminGetUserCommand') {
        const identityId = String(input.Username)

        if (identityId === 'sub-original-identity') {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        const userId = identityId.startsWith('sub-') ? identityId.slice(4) : identityId
        const username = userId === 'confirmed@example.com'
          ? 'CaseSensitiveConfirmed'
          : userId === 'linked@example.com'
            ? 'ExternalIdentity'
            : 'OtherWorkspaceIdentity'
        const directoryId = userId === 'other-workspace@example.com'
          ? 'workspace#other'
          : 'workspace#production'

        return {
          Username: username,
          UserAttributes: [
            { Name: 'email', Value: userId },
            { Name: 'sub', Value: identityId },
            { Name: 'custom:directory_id', Value: directoryId },
            { Name: 'custom:workspace_id', Value: directoryId },
          ],
          Enabled: true,
          UserStatus: 'CONFIRMED',
        }
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )

  await expect(client.deleteWorkspaceUser({
    userId: 'confirmed@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-confirmed@example.com',
    cognitoUsername: 'CaseSensitiveConfirmed',
  })).resolves.toBe('preserved')
  await client.unlinkWorkspaceUser({
    userId: 'confirmed@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-confirmed@example.com',
    cognitoUsername: 'CaseSensitiveConfirmed',
  })
  await client.unlinkWorkspaceUser({
    userId: 'linked@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-linked@example.com',
    cognitoUsername: 'ExternalIdentity',
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'other-workspace@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-other-workspace@example.com',
    cognitoUsername: 'OtherWorkspaceIdentity',
  })).resolves.toBe('preserved')
  await client.unlinkWorkspaceUser({
    userId: 'other-workspace@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-other-workspace@example.com',
    cognitoUsername: 'OtherWorkspaceIdentity',
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'replacement@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-original-identity',
    cognitoUsername: 'OriginalIdentity',
  })).resolves.toBe('absent')
  await client.unlinkWorkspaceUser({
    userId: 'replacement@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-original-identity',
    cognitoUsername: 'OriginalIdentity',
  })

  expect(sentCommands.filter(({ name }) => name === 'AdminDeleteUserCommand')).toEqual([])
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserAttributesCommand'
  ).map(({ input }) => input)).toEqual([
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-confirmed@example.com',
      UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
    },
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-linked@example.com',
      UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
    },
  ])
})

test('requires manual cleanup instead of mutating a Cognito alias after stable lookup fails', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name !== 'AdminGetUserCommand') {
        return {}
      }

      if (input.Username === 'sub-alias-user') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (input.Username === 'CaseSensitiveAlias') {
        return {
          Username: 'CaseSensitiveAlias',
          UserAttributes: [
            { Name: 'email', Value: 'alias@example.com' },
            { Name: 'sub', Value: 'sub-alias-user' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      throw createCognitoSdkTestError('UserNotFoundException', 400)
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const cleanupInput = {
    userId: 'alias@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-alias-user',
    cognitoUsername: 'CaseSensitiveAlias',
  }

  await expect(client.deleteWorkspaceUser(cleanupInput)).resolves.toBe('manual-required')
  await expect(client.unlinkWorkspaceUser(cleanupInput)).resolves.toBe('manual-required')
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand' || name === 'AdminDeleteUserAttributesCommand'
  )).toEqual([])
})

test('requires manual cleanup when a Cognito stable identity lookup is inconclusive', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name !== 'AdminGetUserCommand') {
        return {}
      }

      if (input.Username === 'sub-colliding-identity') {
        return {
          Username: 'ReplacementIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'replacement@example.com' },
            { Name: 'sub', Value: 'sub-replacement-identity' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (input.Username === 'sub-missing-canonical-identity') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (input.Username === 'MissingCanonicalIdentity') {
        return {
          Username: 'MissingCanonicalIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'missing-sub@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      throw createCognitoSdkTestError('UserNotFoundException', 400)
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const collidingIdentityInput = {
    userId: 'collision@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-colliding-identity',
    cognitoUsername: 'CollisionIdentity',
  }
  const missingCanonicalIdentityInput = {
    userId: 'missing-sub@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-missing-canonical-identity',
    cognitoUsername: 'MissingCanonicalIdentity',
  }

  await expect(client.deleteWorkspaceUser(collidingIdentityInput)).resolves.toBe('manual-required')
  await expect(client.unlinkWorkspaceUser(collidingIdentityInput)).resolves.toBe('manual-required')
  await expect(client.deleteWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
    'manual-required',
  )
  await expect(client.unlinkWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
    'manual-required',
  )
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand' || name === 'AdminDeleteUserAttributesCommand'
  )).toEqual([])
})

test('cleans invitation-owned claims when revoking a pre-existing Cognito identity', async () => {
  const cleanupInputs: Array<Record<string, unknown>> = []
  const auditContexts: ObservedWorkspaceMutationAuditContext[] = []
  let cleanupMarkerClears = 0
  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
      async unlinkWorkspaceUser(input: Record<string, unknown>) {
        cleanupInputs.push(input)
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId,
        _actorMemberKey,
        invitationId,
        auditContext,
      ) {
        auditContexts.push({ stage: 'revokeInvitation', context: auditContext })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-existing',
          cognitoUsername: 'CaseSensitiveExisting',
          directoryClaimCleanupRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId,
        invitationId,
        expectedVersion,
        auditContext,
      ) {
        auditContexts.push({ stage: 'clearInvitationCleanupFailure', context: auditContext })
        cleanupMarkerClears += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-existing',
          cognitoUsername: 'CaseSensitiveExisting',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/invitations/existing%40example.com/revoke',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Idempotency-Key': 'workspace-revoke-1',
        'X-Correlation-Id': 'workspace-revoke-correlation',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(cleanupInputs).toEqual([{
    userId: 'existing@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-existing',
    cognitoUsername: 'CaseSensitiveExisting',
  }])
  expect(cleanupMarkerClears).toBe(1)
  expectStableWorkspaceMutationAuditContexts(auditContexts, {
    actorId: 'demo@example.com',
    clientCorrelationId: 'workspace-revoke-correlation',
    idempotencyKey: 'workspace-revoke-1',
    method: 'POST',
    requestBody: { invitationId: 'existing@example.com' },
    route: '/api/workspace/invitations/existing%40example.com/revoke',
    stages: ['revokeInvitation', 'clearInvitationCleanupFailure'],
    workspaceId: 'user#demo@example.com',
  })
  const responseBody = await response.json() as { invitation: Record<string, unknown> }
  expect(responseBody.invitation).toMatchObject({
    identityCleanupCompleted: true,
    identityOwnership: 'pre-existing',
    status: 'revoked',
  })
  expect(responseBody.invitation.directoryClaimCleanupRequired).toBeUndefined()
})

test('persists manual cleanup when stable Cognito mutation is unavailable', async () => {
  let manualMarkers = 0
  let cleanupCompletions = 0
  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
      async unlinkWorkspaceUser() {
        return 'manual-required' as const
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId,
        _actorMemberKey,
        invitationId,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-alias-user',
          cognitoUsername: 'CaseSensitiveAlias',
          directoryClaimCleanupRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async markInvitationManualCleanupRequired(
        _workspaceId,
        invitationId,
        expectedVersion,
      ) {
        manualMarkers += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityCleanupManualRequired: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage:
            'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
        }
      },
      async clearInvitationCleanupFailure() {
        cleanupCompletions += 1
        throw new Error('Manual cleanup must not be marked complete automatically.')
      },
    },
  })

  const response = await app.request(
    '/api/workspace/invitations/alias%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(manualMarkers).toBe(1)
  expect(cleanupCompletions).toBe(0)
  expect(await response.json()).toMatchObject({
    invitation: { identityCleanupManualRequired: true, status: 'revoked' },
  })
})

test('keeps legacy revoke in manual cleanup without mutating Cognito', async () => {
  let cognitoCleanupCalls = 0
  let cleanupCompletions = 0
  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'demo@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
            { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
          ],
        }
      },
      async isSystemAdmin() {
        return false
      },
      async getUserGroups() {
        return []
      },
      async deleteWorkspaceUser() {
        cognitoCleanupCalls += 1
        return 'deleted'
      },
      async unlinkWorkspaceUser() {
        cognitoCleanupCalls += 1
        return 'completed' as const
      },
      async findWorkspaceUser() {
        return {
          profile: {
            id: 'legacy@example.com',
            username: 'LegacyIdentity',
            email: 'legacy@example.com',
          },
          identityId: 'sub-legacy',
          directoryId: 'user#demo@example.com',
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId,
        _actorMemberKey,
        invitationId,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupManualRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId,
        invitationId,
        expectedVersion,
      ) {
        cleanupCompletions += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationManualCleanupRequired(
        _workspaceId,
        _invitationId,
        _expectedVersion,
      ) {
        return {
          id: 'legacy@example.com',
          email: 'legacy@example.com',
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupManualRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage:
            'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
        }
      },
    },
  })

  const response = await app.request(
    '/api/workspace/invitations/legacy%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(cognitoCleanupCalls).toBe(0)
  expect(cleanupCompletions).toBe(0)
  expect(await response.json()).toMatchObject({
    invitation: {
      identityCleanupManualRequired: true,
      identityOwnership: 'workspace-created',
      status: 'revoked',
    },
  })
})

test('acknowledges manual Cognito cleanup with actor and invitation version', async () => {
  const acknowledgements: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async acknowledgeInvitationManualCleanup(
        workspaceId: string,
        actorMemberKey: string,
        invitationId: string,
        expectedVersion: number,
      ) {
        acknowledgements.push({
          workspaceId,
          actorMemberKey,
          invitationId,
          expectedVersion,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'ambiguous',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/legacy%40example.com/cleanup/acknowledge',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 7 }),
    },
  )

  expect(response.status).toBe(200)
  expect(acknowledgements).toEqual([{
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    invitationId: 'legacy@example.com',
    expectedVersion: 7,
  }])
  expect(await response.json()).toMatchObject({
    invitation: { identityCleanupCompleted: true, version: 8 },
  })
})

test('rejects disabled existing Cognito identities before mutating invitation attributes', async () => {
  const commandNames: string[] = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      commandNames.push(name)

      if (name === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      if (name === 'AdminGetUserCommand') {
        return {
          Username: 'DisabledIdentity',
          UserAttributes: [{ Name: 'email', Value: 'disabled@example.com' }],
          Enabled: false,
          UserStatus: 'CONFIRMED',
        }
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  configureFakeProjectClients(true)
  setTestAppDependencies({ cognito: client })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'disabled@example.com', role: 'member' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'CognitoUserDisabled',
    message: 'The existing Cognito user is disabled. Re-enable it before sending a Workspace invitation.',
  })
  expect(commandNames).toEqual([
    'GetUserCommand',
    'AdminListGroupsForUserCommand',
    'AdminGetUserCommand',
  ])
})

test('rejects a disabled Cognito identity discovered after UsernameExists', async () => {
  const commandNames: string[] = []
  let adminGetAttempts = 0
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      commandNames.push(name)

      if (name === 'AdminGetUserCommand') {
        adminGetAttempts += 1

        if (adminGetAttempts === 1) {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        return {
          Username: 'DisabledRaceIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'disabled-race@example.com' },
            { Name: 'sub', Value: 'sub-disabled-race' },
          ],
          Enabled: false,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (name === 'AdminCreateUserCommand') {
        throw createCognitoSdkTestError('UsernameExistsException', 400)
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  let cleanupMarkerCalls = 0

  await expect(client.provisionWorkspaceUser({
    email: 'disabled-race@example.com',
    directoryId: 'workspace#production',
    beforeDirectoryClaimUpdate: async () => {
      cleanupMarkerCalls += 1
    },
  })).rejects.toMatchObject({
    code: 'CognitoUserDisabled',
    status: 409,
  })
  expect(cleanupMarkerCalls).toBe(0)
  expect(commandNames).toEqual([
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
  ])
})

test('keeps Floci usernames case-sensitive and rejects disabled race identities', async () => {
  await withTestEnvironment(
    {
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requests: Array<{ action: string; payload: Record<string, unknown> }> = []
      let adminGetAttempts = 0
      globalThis.fetch = (async (_input, init) => {
        const target = new Headers(init?.headers).get('X-Amz-Target') ?? ''
        const action = target.split('.').at(-1) ?? ''
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ action, payload })

        if (action === 'AdminGetUser') {
          adminGetAttempts += 1

          if (adminGetAttempts === 1) {
            return new Response(JSON.stringify({ __type: 'UserNotFoundException' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          return new Response(JSON.stringify({
            Username: 'DisabledFlociIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'disabled-floci@example.com' },
              { Name: 'sub', Value: 'sub-disabled-floci' },
            ],
            Enabled: false,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (action === 'AdminCreateUser' && payload.MessageAction !== 'RESEND') {
          return new Response(JSON.stringify({ __type: 'UsernameExistsException' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const client = new FlociCognitoClient('http://localhost:4566')
        await client.resendWorkspaceUserInvitation('CaseSensitiveFlociUser')
        let cleanupMarkerCalls = 0

        await expect(client.provisionWorkspaceUser({
          email: 'disabled-floci@example.com',
          directoryId: 'workspace#production',
          beforeDirectoryClaimUpdate: async () => {
            cleanupMarkerCalls += 1
          },
        })).rejects.toMatchObject({
          code: 'CognitoUserDisabled',
          status: 409,
        })
        expect(cleanupMarkerCalls).toBe(0)
        expect(requests.map(({ action }) => action)).toEqual([
          'AdminCreateUser',
          'AdminGetUser',
          'AdminCreateUser',
          'AdminGetUser',
        ])
        expect(requests[0]?.payload).toMatchObject({
          MessageAction: 'RESEND',
          Username: 'CaseSensitiveFlociUser',
        })
        expect(requests.some(({ action }) => action === 'AdminUpdateUserAttributes')).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

test('keeps Floci cleanup manual when a stable identity lookup is inconclusive', async () => {
  await withTestEnvironment(
    {
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requests: Array<{ action: string; payload: Record<string, unknown> }> = []
      globalThis.fetch = (async (_input, init) => {
        const target = new Headers(init?.headers).get('X-Amz-Target') ?? ''
        const action = target.split('.').at(-1) ?? ''
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ action, payload })

        if (action !== 'AdminGetUser') {
          return new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (payload.Username === 'sub-colliding-identity') {
          return new Response(JSON.stringify({
            Username: 'ReplacementIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'replacement@example.com' },
              { Name: 'sub', Value: 'sub-replacement-identity' },
              { Name: 'custom:directory_id', Value: 'workspace#production' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (payload.Username === 'MissingCanonicalIdentity') {
          return new Response(JSON.stringify({
            Username: 'MissingCanonicalIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'missing-sub@example.com' },
              { Name: 'custom:directory_id', Value: 'workspace#production' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response(JSON.stringify({ __type: 'UserNotFoundException' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const client = new FlociCognitoClient('http://localhost:4566')
        const collidingIdentityInput = {
          userId: 'collision@example.com',
          directoryId: 'workspace#production',
          cognitoIdentityId: 'sub-colliding-identity',
          cognitoUsername: 'CollisionIdentity',
        }
        const missingCanonicalIdentityInput = {
          userId: 'missing-sub@example.com',
          directoryId: 'workspace#production',
          cognitoIdentityId: 'sub-missing-canonical-identity',
          cognitoUsername: 'MissingCanonicalIdentity',
        }

        await expect(client.deleteWorkspaceUser(collidingIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.unlinkWorkspaceUser(collidingIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.deleteWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.unlinkWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
          'manual-required',
        )
        expect(requests.some(({ action }) =>
          action === 'AdminDeleteUser' || action === 'AdminDeleteUserAttributes'
        )).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
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
      resetTestApp()

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

test('returns Cognito groups and system admin status for the current user', async () => {
  configureFakeProjectClients(true, {
    systemAdminMemberKeys: ['demo@example.com'],
  })

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

test('reads every AWS Cognito group page and deduplicates current membership', async () => {
  const requestedTokens: Array<string | undefined> = []
  const sdkClient = {
    async send(command: { input: { NextToken?: string } }) {
      requestedTokens.push(command.input.NextToken)
      return command.input.NextToken
        ? {
            Groups: [
              { GroupName: 'project-writers' },
              { GroupName: 'workspace-readers' },
            ],
          }
        : {
            Groups: [
              { GroupName: 'workspace-readers' },
              { GroupName: 'shared-group' },
            ],
            NextToken: 'groups-page-2',
          }
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'ap-northeast-1_mukuroji',
    'mukuroji-client',
  )

  await expect(client.getUserGroups('demo@example.com')).resolves.toEqual([
    'workspace-readers',
    'shared-group',
    'project-writers',
  ])
  expect(requestedTokens).toEqual([undefined, 'groups-page-2'])
})

test('reads every Floci Cognito group page for current membership', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'local-client',
    COGNITO_USER_POOL_ID: 'us-east-1_local',
  }, async () => {
    const originalFetch = globalThis.fetch
    const requestedTokens: Array<unknown> = []
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestedTokens.push(payload.NextToken)
      return Response.json(payload.NextToken
        ? { Groups: [{ GroupName: 'project-writers' }] }
        : {
            Groups: [{ GroupName: 'workspace-readers' }],
            NextToken: 'groups-page-2',
          })
    }) as typeof fetch
    try {
      const client = new FlociCognitoClient('http://localhost:4566')
      await expect(client.getUserGroups('demo@example.com')).resolves.toEqual([
        'workspace-readers',
        'project-writers',
      ])
      expect(requestedTokens).toEqual([undefined, 'groups-page-2'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
