import { describe, expect, test } from 'bun:test'
import type { TenantOperation, TenantOperationStepProof } from '@mukuroji/contracts'
import {
  TenantAdministrationError,
  advanceTenantOperation,
  createDefaultTenantAdministrationSnapshot,
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
    expect(snapshot.governance.legalHold).toBe(false)
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
    const paused = {
      ...running,
      status: 'paused' as const,
      revision: running.revision + 1,
    }
    const resumed = resumeTenantOperation(paused, '2026-08-02T00:02:00.000Z')
    const proofs: TenantOperationStepProof[] = [
      { step: 'export', evidenceReference: 'evidence-1' },
      { step: 'revoke-access', evidenceReference: 'evidence-2' },
      { step: 'anonymize-members', evidenceReference: 'evidence-3' },
      { step: 'delete-data', evidenceReference: 'evidence-4' },
      { step: 'delete-secrets', evidenceReference: 'evidence-5' },
      { step: 'verify', evidenceReference: 'evidence-6' },
    ]
    const completed = proofs.reduce(
      (operation, proof, index) => advanceTenantOperation(
        operation,
        proof,
        `2026-08-02T00:0${index + 3}:00.000Z`,
      ),
      resumed,
    )

    expect(completed.lastEvidenceReference).toBe('evidence-6')
    expect(verifyTenantClosure(completed, '2026-08-02T00:03:00.000Z').status).toBe('verified')
    expect(() => verifyTenantClosure(running, '2026-08-02T00:03:00.000Z')).toThrow(
      TenantAdministrationError,
    )
    expect(() => advanceTenantOperation(resumed, undefined, '2026-08-02T00:03:00.000Z')).toThrow(
      'Trusted execution evidence is required',
    )
  })
})
