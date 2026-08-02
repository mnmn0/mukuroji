import { describe, expect, test } from 'bun:test'
import type { TenantOperation, TenantOperationStepProof } from '@mukuroji/contracts'
import {
  TenantAdministrationError,
  advanceTenantOperation,
  assertTenantGovernanceEnforced,
  beginTenantUsageMutation,
  createDefaultTenantAdministrationSnapshot,
  pauseTenantOperation,
  recordTenantBillingPeriod,
  reserveTenantUsage,
  resumeTenantOperation,
  verifyTenantClosure,
} from './tenant-administration'

describe('tenant administration domain', () => {
  test('creates a tenant-scoped default aggregate', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
    )

    expect(snapshot.profile.workspaceId).toBe('workspace-1')
    expect(snapshot.profile.ownerMemberKey).toBe('member-1')
    expect(snapshot.entitlement.seatLimit).toBe(5)
    expect(snapshot.usage.activeSeats).toBe(1)
    expect(snapshot.billingPeriods).toEqual([
      expect.objectContaining({
        meteredUnits: 0,
        activeSeatHighWaterMark: 1,
      }),
    ])
    expect(snapshot.governance.legalHold).toBe(false)
    expect(snapshot.governanceEnforcement).toEqual({
      dataResidency: 'ap-northeast-1',
      encryptionKeyPolicy: 'aws-managed',
    })
  })

  test('grandfathers authoritative active seats into the initial seat limit', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
      undefined,
      18,
    )

    expect(snapshot.usage.activeSeats).toBe(18)
    expect(snapshot.entitlement.seatLimit).toBe(18)
    expect(snapshot.billingPeriods[0]?.activeSeatHighWaterMark).toBe(18)
  })

  test('retains invoice usage and the active-seat high-water mark by billing period', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
      undefined,
      3,
    )
    const first = recordTenantBillingPeriod({
      ...snapshot.usage,
      periodUsage: 25,
    })
    const updated = recordTenantBillingPeriod({
      ...snapshot.usage,
      activeSeats: 2,
      periodUsage: 40,
      updatedAt: '2026-08-03T00:00:00.000Z',
    }, first)

    expect(updated).toMatchObject({
      meteredUnits: 40,
      activeSeatHighWaterMark: 3,
      revision: 1,
    })
  })

  test('rejects governance controls that differ from deployed enforcement', () => {
    expect(() => assertTenantGovernanceEnforced(
      'eu-west-1',
      'customer-managed',
      { dataResidency: 'ap-northeast-1', encryptionKeyPolicy: 'aws-managed' },
    )).toThrow('requested tenant data residency is not available')
  })

  test('allows quota overage only during the server-created grace period', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
    )
    const usage = reserveTenantUsage(
      snapshot.entitlement,
      { ...snapshot.usage, periodUsage: snapshot.entitlement.usageQuota },
      1,
      '2026-08-02T00:00:00.000Z',
    )

    expect(usage.periodUsage).toBe(snapshot.entitlement.usageQuota + 1)
    expect(() => reserveTenantUsage(
      snapshot.entitlement,
      usage,
      1,
      '2026-08-10T00:00:00.000Z',
    )).toThrow('Tenant usage quota has been exceeded.')
  })

  test('starts a fresh usage period at the UTC month boundary', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
    )
    const usage = reserveTenantUsage(
      snapshot.entitlement,
      {
        ...snapshot.usage,
        periodUsage: snapshot.entitlement.usageQuota,
      },
      1,
      '2026-09-01T00:00:00.000Z',
    )

    expect(usage.periodUsage).toBe(1)
    expect(usage.periodStart).toBe('2026-09-01T00:00:00.000Z')
    expect(usage.periodEnd).toBe('2026-10-01T00:00:00.000Z')
    expect(usage.gracePeriodEndsAt).toBeUndefined()
  })

  test('keeps authoritative seat releases available after quota grace expires', () => {
    const snapshot = createDefaultTenantAdministrationSnapshot(
      'workspace-1',
      'member-1',
      '2026-08-02T00:00:00.000Z',
    )

    const candidate = beginTenantUsageMutation({
      ...snapshot.usage,
      periodUsage: snapshot.entitlement.usageQuota + 10,
      gracePeriodEndsAt: '2026-08-03T00:00:00.000Z',
    }, '2026-08-10T00:00:00.000Z')

    expect(candidate).toMatchObject({
      periodUsage: snapshot.entitlement.usageQuota + 10,
      revision: 1,
    })
  })

  test('supports pause, resume, and verification of a closure workflow', () => {
    const requested: TenantOperation = {
      operationId: 'operation-1',
      workspaceId: 'workspace-1',
      kind: 'closure',
      status: 'requested',
      requestedBy: 'member-1',
      requestedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      updatedBy: 'member-1',
      completedSteps: [],
      revision: 0,
    }
    const running = advanceTenantOperation(requested, undefined, '2026-08-02T00:01:00.000Z')
    expect(() => pauseTenantOperation(requested, '2026-08-02T00:00:30.000Z')).toThrow(
      'Tenant operation cannot be paused.',
    )
    const paused = pauseTenantOperation(running, '2026-08-02T00:01:30.000Z')
    expect(() => pauseTenantOperation(paused, '2026-08-02T00:01:45.000Z')).toThrow(
      'Tenant operation cannot be paused.',
    )
    const resumed = resumeTenantOperation(paused, '2026-08-02T00:02:00.000Z')
    const proofs: TenantOperationStepProof[] = [
      { step: 'export', evidenceReference: createEvidenceReference(1) },
      { step: 'revoke-access', evidenceReference: createEvidenceReference(2) },
      { step: 'anonymize-members', evidenceReference: createEvidenceReference(3) },
      { step: 'delete-data', evidenceReference: createEvidenceReference(4) },
      { step: 'delete-secrets', evidenceReference: createEvidenceReference(5) },
      { step: 'verify', evidenceReference: createEvidenceReference(6) },
    ]
    const completed = proofs.reduce(
      (operation, proof, index) => advanceTenantOperation(
        operation,
        proof,
        `2026-08-02T00:0${index + 3}:00.000Z`,
      ),
      resumed,
    )

    expect(completed.lastEvidenceReference).toBe(createEvidenceReference(6))
    expect(verifyTenantClosure(completed, '2026-08-02T00:03:00.000Z').status).toBe('verified')
    expect(() => verifyTenantClosure(running, '2026-08-02T00:03:00.000Z')).toThrow(
      TenantAdministrationError,
    )
    expect(() => advanceTenantOperation(resumed, undefined, '2026-08-02T00:03:00.000Z')).toThrow(
      'Trusted execution evidence is required',
    )
  })
})

/** Creates one deterministic immutable evidence digest for domain tests. */
function createEvidenceReference(value: number): string {
  return `evidence:sha256:${value.toString(16).padStart(64, '0')}`
}
