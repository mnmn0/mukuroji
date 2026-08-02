import { afterEach, expect, test } from 'bun:test'
import { getTenantAdministration, WorkspaceAccessApiError } from '../src/workspace/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: originalFetch,
  })
})

test('validates invoice-ready tenant billing history at the API boundary', async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify(createSnapshot()), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }),
  })

  const snapshot = await getTenantAdministration('access-token')

  expect(snapshot.billingPeriods).toEqual([
    expect.objectContaining({
      periodStart: '2026-08-01T00:00:00.000Z',
      meteredUnits: 12,
      activeSeatHighWaterMark: 3,
    }),
  ])
})

test('rejects a tenant snapshot that omits billing aggregates', async () => {
  const invalidSnapshot: Record<string, unknown> = { ...createSnapshot() }
  delete invalidSnapshot.billingPeriods
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify(invalidSnapshot), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }),
  })

  const error = await getTenantAdministration('access-token')
    .catch((reason: unknown) => reason)

  expect(error).toBeInstanceOf(WorkspaceAccessApiError)
  expect(error).toMatchObject({ status: 502 })
})

/** Creates one complete tenant administration API fixture. */
function createSnapshot() {
  return {
    schemaVersion: 2,
    profile: {
      workspaceId: 'workspace-1',
      ownerMemberKey: 'owner-1',
      region: 'ap-northeast-1',
      locale: 'ja',
      defaultPolicy: {
        defaultMemberRole: 'member',
      },
      status: 'active',
      revision: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    entitlement: {
      workspaceId: 'workspace-1',
      plan: 'starter',
      features: ['documents'],
      seatLimit: 5,
      usageQuota: 10_000,
      gracePeriodDays: 7,
      revision: 1,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    usage: {
      workspaceId: 'workspace-1',
      activeSeats: 2,
      periodUsage: 12,
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z',
      revision: 2,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    billingPeriods: [{
      workspaceId: 'workspace-1',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z',
      meteredUnits: 12,
      activeSeatHighWaterMark: 3,
      revision: 2,
      updatedAt: '2026-08-02T00:00:00.000Z',
    }],
    recentOperations: [],
    governance: {
      workspaceId: 'workspace-1',
      auditRetentionDays: 365,
      legalHold: false,
      dataResidency: 'ap-northeast-1',
      encryptionKeyPolicy: 'aws-managed',
      revision: 1,
      updatedAt: '2026-08-02T00:00:00.000Z',
      updatedBy: 'owner-1',
    },
    governanceEnforcement: {
      dataResidency: 'ap-northeast-1',
      encryptionKeyPolicy: 'aws-managed',
    },
  }
}
