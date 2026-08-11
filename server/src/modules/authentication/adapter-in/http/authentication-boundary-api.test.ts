import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeAuthenticatedUser,
  configureFakeProjectClients,
  createAccessToken,
  resetTestApp,
  withTestEnvironment,
} = createApiTestHarness()
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
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
        { consistentRead: true, directoryId: 'workspace#legacy', locale: 'ja' },
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
      COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
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
      const ssoAccessToken = createAccessToken([], {
        client_id: 'mukuroji-sso-client',
        iss: 'http://localhost:4567/us-east-1_mukuroji',
        token_use: 'access',
      })

      const validResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${validAccessToken}` },
      })
      const ssoResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${ssoAccessToken}` },
      })
      const wrongIssuerResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${wrongIssuerToken}` },
      })

      expect(validResponse.status).toBe(200)
      expect(ssoResponse.status).toBe(200)
      expect(wrongIssuerResponse.status).toBe(401)
      expect(await wrongIssuerResponse.json()).toEqual({ message: 'Authentication failed.' })
      expect(getUserCalls).toBe(2)
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
