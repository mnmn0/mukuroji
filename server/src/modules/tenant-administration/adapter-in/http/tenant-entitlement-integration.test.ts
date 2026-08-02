import { afterEach, expect, test } from 'bun:test'
import type { TenantFeature } from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { TenantAdministrationError } from '../../domain/tenant-administration'

const {
  app,
  configureFakeProjectClients,
  createAnalyticsQueryInput,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

test('rejects a disabled feature on an actual authenticated API route', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    tenantEntitlementEnforcement: {
      async assertActive() {},
      async assertFeature() {
        throw new TenantAdministrationError(
          403,
          'TenantFeatureDisabled',
          'Analytics is not enabled for this Workspace.',
        )
      },
      async reserveUsage() {},
    },
  })

  const response = await app.request('/api/analytics/reports', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'TenantFeatureDisabled',
    message: 'Analytics is not enabled for this Workspace.',
  })
})

test('reserves mutation usage before entering an enabled feature route', async () => {
  configureFakeProjectClients(true)
  const reservations: Array<{
    workspaceId: string
    feature: TenantFeature
    units: number
    idempotencyKey?: string
  }> = []
  setTestAppDependencies({
    tenantEntitlementEnforcement: {
      async assertActive() {},
      async assertFeature() {},
      async reserveUsage(workspaceId, feature, units, idempotencyKey) {
        reservations.push({ workspaceId, feature, units, idempotencyKey })
      },
    },
  })
  const query = createAnalyticsQueryInput()

  const response = await app.request('/api/analytics/reports', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'analytics-report-1',
    },
    body: JSON.stringify({
      id: 'entitlement-metered-report',
      name: 'Entitlement metered report',
      visibility: 'personal',
      timeZone: 'UTC',
      filter: query.filter,
      widgets: query.widgets,
    }),
  })

  expect(response.status).toBe(201)
  expect(reservations).toEqual([{
    workspaceId: 'user#demo@example.com',
    feature: 'analytics',
    units: 1,
    idempotencyKey: expect.stringMatching(
      /^tenant-meter:v1:[a-f0-9]{64}:[a-f0-9]{64}$/u,
    ),
  }])
})

test('rejects an oversized idempotent metered body before reserving usage', async () => {
  configureFakeProjectClients(true)
  let reservations = 0
  setTestAppDependencies({
    tenantEntitlementEnforcement: {
      async assertActive() {},
      async assertFeature() {},
      async reserveUsage() {
        reservations += 1
      },
    },
  })

  const response = await app.request('/api/analytics/reports', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'oversized-metered-request',
    },
    body: JSON.stringify({ padding: 'x'.repeat(10 * 1024 * 1024) }),
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'TenantMeteringBodyTooLarge',
  })
  expect(reservations).toBe(0)
})

test('rejects public SSO discovery and start when the tenant feature is disabled', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-08-02T00:00:00.000Z'
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'provider-1',
    kind: 'oidc',
    displayName: 'Enterprise SSO',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
  await identity.putVerifiedDomain({
    workspaceId,
    domainId: 'domain-1',
    domain: 'example.com',
    status: 'verified',
    revision: 1,
    verificationRecordName: '_mukuroji-challenge.example.com',
    verifiedAt: now,
    enforceSso: true,
    identityProviderId: 'provider-1',
    createdAt: now,
    updatedAt: now,
  })
  const checkedFeatures: TenantFeature[] = []
  setTestAppDependencies({
    enterpriseIdentity: identity,
    tenantEntitlementEnforcement: {
      async assertActive() {},
      async assertFeature(_workspaceId, feature) {
        checkedFeatures.push(feature)
        throw new TenantAdministrationError(
          403,
          'TenantFeatureNotEntitled',
          'The tenant is not entitled to this feature.',
        )
      },
      async reserveUsage() {},
    },
  })

  const [discovery, start] = await Promise.all([
    app.request('/api/auth/sso/discovery?email=demo%40example.com'),
    app.request('/api/auth/sso/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com' }),
    }),
  ])

  expect(discovery.status).toBe(403)
  expect(start.status).toBe(403)
  expect(await discovery.json()).toMatchObject({ code: 'TenantFeatureNotEntitled' })
  expect(await start.json()).toMatchObject({ code: 'TenantFeatureNotEntitled' })
  expect(checkedFeatures).toEqual(['sso', 'sso'])
})
