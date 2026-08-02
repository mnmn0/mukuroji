import { expect, test } from 'bun:test'
import type {
  TenantAdministrationSnapshot,
  TenantOperation,
} from '@mukuroji/contracts'
import { createDefaultTenantAdministrationSnapshot } from '../../domain/tenant-administration'
import { TenantAdministrationError } from '../../domain/tenant-administration'
import type { TenantAdministrationClient } from '../../application/ports/tenant-administration-port'
import { createTenantAdministrationRouter } from './tenant-administration-router'

/** Creates one export operation fixture returned by the HTTP adapter test port. */
function createOperation(): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: 'workspace-1',
    kind: 'export',
    status: 'requested',
    requestedBy: 'owner-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    updatedBy: 'owner-1',
    completedSteps: [],
    exportFormat: 'jsonl',
    revision: 0,
  }
}

/** Creates a complete in-memory tenant application port for router tests. */
function createClient(
  snapshot: TenantAdministrationSnapshot,
  ensureCalls: Array<[string, string, number | undefined]>,
): TenantAdministrationClient {
  const operation = createOperation()
  return {
    async ensureSnapshot(workspaceId, ownerMemberKey, activeSeats) {
      ensureCalls.push([workspaceId, ownerMemberKey, activeSeats])
      return snapshot
    },
    async getSnapshot() {
      return snapshot
    },
    async updateProfile() {
      return snapshot.profile
    },
    async updateEntitlement() {
      return snapshot.entitlement
    },
    async updateGovernance() {
      return snapshot.governance
    },
    async assertFeature() {},
    async reserveUsage() {
      return snapshot.usage
    },
    async requestExport() {
      return operation
    },
    async requestClosure() {
      return { ...operation, kind: 'closure' }
    },
    async getOperation() {
      return operation
    },
    async advanceOperation() {
      return operation
    },
    async pauseOperation() {
      return { ...operation, status: 'paused' }
    },
    async resumeOperation() {
      return { ...operation, status: 'running' }
    },
    async verifyClosure() {
      return { ...operation, kind: 'closure', status: 'verified' }
    },
  }
}

test('initializes tenant state from authoritative owner and active-seat membership', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
    undefined,
    4,
  )
  const ensureCalls: Array<[string, string, number | undefined]> = []
  let administrationChecks = 0
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'admin-1' }
    },
    requireAdministration() {
      administrationChecks += 1
    },
    requireEntitlementAdministration() {},
    client: createClient(snapshot, ensureCalls),
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1', activeSeats: 4 }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      return Response.json({
        code: error instanceof Error ? error.name : 'UnknownError',
      }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/administration', {
    headers: { Authorization: 'Bearer token-1' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    schemaVersion: 2,
    usage: { activeSeats: 4 },
  })
  expect(ensureCalls).toEqual([['workspace-1', 'owner-1', 4]])
  expect(administrationChecks).toBe(1)
})

test('creates export operations without exposing the trusted advance boundary', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  const client = createClient(snapshot, [])
  let receivedIdempotencyKey: string | undefined
  client.requestExport = async (_workspaceId, _actorMemberKey, _input, idempotencyKey) => {
    receivedIdempotencyKey = idempotencyKey
    return createOperation()
  }
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'owner-1' }
    },
    requireAdministration() {},
    requireEntitlementAdministration() {},
    client,
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1', activeSeats: 1 }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      return Response.json({
        code: error instanceof Error ? error.name : 'UnknownError',
      }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/exports', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'tenant-export-1',
    },
    body: JSON.stringify({ format: 'jsonl' }),
  })
  const advanceResponse = await router.request(
    '/api/tenant/operations/operation-1/advance',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    },
  )

  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({
    operation: { operationId: 'operation-1', status: 'requested' },
  })
  expect(receivedIdempotencyKey).toBe('tenant-export-1')
  expect(advanceResponse.status).toBe(404)
})

test('rejects entitlement changes outside the trusted system control plane', async () => {
  const snapshot = createDefaultTenantAdministrationSnapshot(
    'workspace-1',
    'owner-1',
    '2026-08-02T00:00:00.000Z',
  )
  let updateCalls = 0
  const client = createClient(snapshot, [])
  client.updateEntitlement = async () => {
    updateCalls += 1
    return snapshot.entitlement
  }
  const router = createTenantAdministrationRouter({
    async authenticate() {
      return { directoryId: 'workspace-1', userKey: 'owner-1' }
    },
    requireAdministration() {},
    requireEntitlementAdministration() {
      throw new TenantAdministrationError(
        403,
        'TenantEntitlementAdministrationRequired',
        'System administrator access is required.',
      )
    },
    client,
    async resolveInitialization() {
      return { ownerMemberKey: 'owner-1', activeSeats: 1 }
    },
    async readJson(request) {
      return await request.json()
    },
    mapError(_context, error) {
      if (error instanceof TenantAdministrationError) {
        return Response.json({ code: error.code }, { status: error.status })
      }
      return Response.json({ code: 'UnknownError' }, { status: 500 })
    },
  })

  const response = await router.request('/api/tenant/entitlement', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      plan: 'enterprise',
      features: ['documents'],
      seatLimit: 1_000,
      usageQuota: 1_000_000,
      gracePeriodDays: 30,
      expectedRevision: 0,
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'TenantEntitlementAdministrationRequired',
  })
  expect(updateCalls).toBe(0)
})
