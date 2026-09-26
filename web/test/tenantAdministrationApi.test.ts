import { afterEach, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TenantOperation } from '@mukuroji/contracts'
import { getTenantAdministration, WorkspaceAccessApiError } from '../src/workspace/api'
import { useTenantAdministrationMutations } from '../src/workspace/mutations/useTenantAdministrationMutations'

const originalFetch = globalThis.fetch

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: originalFetch,
  })
})

test('does not refresh tenant state after verification removes requester access', async () => {
  const operation: TenantOperation = {
    operationId: 'closure-1',
    workspaceId: 'workspace-1',
    kind: 'closure',
    status: 'completed',
    requestedBy: 'admin-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:10:00.000Z',
    updatedBy: 'executor:tenant-closure-verification',
    completedSteps: [
      'export',
      'revoke-access',
      'anonymize-members',
      'delete-data',
      'delete-secrets',
      'verify',
    ],
    revision: 7,
  }
  let refreshCalls = 0
  let controls: ReturnType<typeof useTenantAdministrationMutations> | undefined
  const requestedUrls: string[] = []
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string | URL | Request) => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({
        operation: { ...operation, status: 'verified', revision: 8 },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    },
  })

  /** Captures the hook commands from one server-rendered test component. */
  function MutationHarness() {
    controls = useTenantAdministrationMutations({
      accessToken: 'access-token',
      async refresh() {
        refreshCalls += 1
      },
    })
    return null
  }

  renderToStaticMarkup(createElement(MutationHarness))
  if (!controls) throw new Error('Tenant mutation controls were not rendered.')

  expect(await controls.runOperation(operation, 'verify')).toBe(true)
  expect(refreshCalls).toBe(0)
  expect(requestedUrls).toEqual([
    '/api/tenant/operations/closure-1/verify',
  ])
})

test('validates self-hosted workspace administration without commercial fields', async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify(createSnapshot()), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }),
  })

  const snapshot = await getTenantAdministration('access-token')

  expect(snapshot.schemaVersion).toBe(3)
  expect(snapshot.profile.workspaceId).toBe('workspace-1')
  expect(snapshot).not.toHaveProperty('entitlement')
  expect(snapshot).not.toHaveProperty('usage')
  expect(snapshot).not.toHaveProperty('billingPeriods')
})

test('rejects a tenant snapshot that omits governance', async () => {
  const invalidSnapshot: Record<string, unknown> = { ...createSnapshot() }
  delete invalidSnapshot.governance
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
    schemaVersion: 3,
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
