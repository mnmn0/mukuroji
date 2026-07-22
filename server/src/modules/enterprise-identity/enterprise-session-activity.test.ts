import { expect, test } from 'bun:test'
import { InMemoryEnterpriseSessionActivityClient } from './enterprise-session-activity'

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
