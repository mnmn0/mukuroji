import { afterEach, expect, test } from 'bun:test'
import type {
  TenantAdministrationSnapshot,
  TenantOperation,
} from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import type { AuditEventV1 } from '../../../audit/audit'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import type { TenantAdministrationClient } from '../../application/ports/tenant-administration-port'
import { createDefaultTenantAdministrationSnapshot } from '../../domain/tenant-administration'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace the harness resolves for the default test principal. */
const WORKSPACE_ID = 'user#demo@example.com'

/**
 * Creates one export operation fixture.
 *
 * @param status - Operation status.
 * @returns The operation.
 */
function createOperation(status: TenantOperation['status']): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: WORKSPACE_ID,
    kind: 'export',
    status,
    requestedBy: 'demo@example.com',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    updatedBy: 'demo@example.com',
    completedSteps: [],
    exportFormat: 'jsonl',
    revision: 0,
  }
}

/** Calls the tenant export ports received from the routes. */
type TenantPortCalls = {
  /** Number of accepted export requests. */
  exportRequests: number
  /** Number of signed download responses. */
  downloads: number
}

/**
 * Installs in-memory tenant administration ports and an audit event recorder.
 *
 * @returns Port call counters and the audit events written by the routes.
 */
function installTenantPorts() {
  const calls: TenantPortCalls = { exportRequests: 0, downloads: 0 }
  const events: AuditEventV1[] = []
  const snapshot: TenantAdministrationSnapshot = createDefaultTenantAdministrationSnapshot(
    WORKSPACE_ID,
    'demo@example.com',
    '2026-08-02T00:00:00.000Z',
  )
  const tenantAdministration: TenantAdministrationClient = {
    async assertActive() {},
    async ensureSnapshot() {
      return snapshot
    },
    async getSnapshot() {
      return snapshot
    },
    async updateProfile() {
      return snapshot.profile
    },
    async updateGovernance() {
      return snapshot.governance
    },
    async requestExport() {
      calls.exportRequests += 1
      return createOperation('requested')
    },
    async requestClosure() {
      return { ...createOperation('requested'), kind: 'closure' }
    },
    async getOperation() {
      return createOperation('completed')
    },
    async advanceOperation() {
      return createOperation('running')
    },
    async failOperation() {
      return createOperation('failed')
    },
    async pauseOperation() {
      return createOperation('paused')
    },
    async resumeOperation() {
      return createOperation('running')
    },
    async verifyClosure() {
      return { ...createOperation('verified'), kind: 'closure' }
    },
  }
  const auditEvents = getTestAppDependencies().workspace.auditEvents
  setTestAppDependencies({
    tenantAdministration,
    tenantExportDownload: {
      async createDownload() {
        calls.downloads += 1
        return {
          expiresAt: '2026-08-02T00:05:00.000Z',
          files: [{ name: 'manifest.json', url: 'https://signed.example/export' }],
        }
      },
    },
    auditEvents: {
      ...auditEvents,
      async putEvent(event: AuditEventV1) {
        events.push(event)
      },
    },
  })
  return { calls, events }
}

/**
 * Sends one tenant export lifecycle request.
 *
 * @param path - Tenant route path.
 * @param method - HTTP method.
 * @param authorization - Authorization header value.
 * @returns The response.
 */
async function sendTenantRequest(path: string, method: 'GET' | 'POST', authorization = 'Bearer test-token') {
  return await app.request(path, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify({ format: 'jsonl' }) } : {}),
  })
}

test('refuses tenant export to a Workspace admin without audit export permission', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })
  const { calls, events } = installTenantPorts()

  const exportResponse = await sendTenantRequest('/api/tenant/exports', 'POST')
  const downloadResponse = await sendTenantRequest('/api/tenant/operations/operation-1/download', 'GET')
  const snapshotResponse = await sendTenantRequest('/api/tenant/administration', 'GET')

  expect(exportResponse.status).toBe(403)
  expect(await exportResponse.json()).toMatchObject({ code: 'TenantExportAuditPermissionRequired' })
  expect(downloadResponse.status).toBe(403)
  expect(await downloadResponse.json()).toMatchObject({ code: 'TenantExportAuditPermissionRequired' })
  // Reading tenant administration stays open to the admin: only the export carries audit data.
  expect(snapshotResponse.status).not.toBe(403)
  expect(calls).toEqual({ exportRequests: 0, downloads: 0 })
  expect(events).toEqual([])
})

test('lets a Workspace owner export the tenant and audits each download link issuance', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'owner' })
  const { calls, events } = installTenantPorts()

  const exportResponse = await sendTenantRequest('/api/tenant/exports', 'POST')
  const downloadResponse = await sendTenantRequest('/api/tenant/operations/operation-1/download', 'GET')

  expect(exportResponse.status).toBe(201)
  expect(downloadResponse.status).toBe(200)
  expect(calls).toEqual({ exportRequests: 1, downloads: 1 })
  expect(events.map((event) => ({
    eventType: event.eventType,
    entity: event.entity,
    metadata: event.metadata,
  }))).toEqual([{
    eventType: 'tenant.export.downloaded',
    entity: { type: 'tenant', id: WORKSPACE_ID },
    metadata: { exportId: 'operation-1', partCount: 1 },
  }])
})

test('holds tenant export and closure to the sensitive-action reauthentication window', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'owner' })
  const { calls } = installTenantPorts()
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putSecurityPolicy({
    workspaceId: WORKSPACE_ID,
    loginMode: 'password-or-sso',
    mfaRequirement: 'optional',
    sessionLifetimeMinutes: 480,
    idleTimeoutMinutes: 480,
    reauthenticationIntervalMinutes: 480,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'disabled',
    ipAllowlist: [],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: false,
      maximumSessionLifetimeMinutes: 480,
      allowedGuestDomains: [],
      permissionCeiling: ['workspace.read'],
    },
    revision: 1,
    updatedAt: now,
    updatedBy: 'demo@example.com',
  })
  setTestAppDependencies({
    enterpriseIdentity: identity,
    enterpriseSessionActivity: {
      async getAuthenticationMethods() {
        return []
      },
      async recordAuthenticationAssurance() {
        return undefined
      },
      async validateAndTouch(input) {
        return [...input.authenticationMethods]
      },
    },
  })
  const authenticatedAt = Math.floor(Date.now() / 1000) - 60 * 60
  const authorization = `Bearer ${createAccessToken([], {
    auth_time: authenticatedAt,
    iat: authenticatedAt,
    token_use: 'access',
  })}`

  const snapshotResponse = await sendTenantRequest('/api/tenant/administration', 'GET', authorization)
  const exportResponse = await sendTenantRequest('/api/tenant/exports', 'POST', authorization)
  const closureResponse = await app.request('/api/tenant/closures', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'CLOSE' }),
  })
  const downloadResponse = await sendTenantRequest(
    '/api/tenant/operations/operation-1/download',
    'GET',
    authorization,
  )

  expect(snapshotResponse.status).toBe(200)
  for (const response of [exportResponse, closureResponse, downloadResponse]) {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'EnterpriseSessionReauthenticationRequired' })
  }
  expect(calls).toEqual({ exportRequests: 0, downloads: 0 })
})
