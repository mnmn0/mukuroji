import { describe, expect, test } from 'bun:test'
import type { TenantOperation, TenantOperationStepProof } from '@mukuroji/contracts'
import {
  TenantAdministrationError,
  advanceTenantOperation,
  assertTenantGovernanceEnforced,
  createDefaultTenantAdministrationSnapshot,
  failTenantOperation,
  pauseTenantOperation,
  repairTenantClosureOperation,
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
    expect(snapshot).not.toHaveProperty('entitlement')
    expect(snapshot).not.toHaveProperty('usage')
    expect(snapshot).not.toHaveProperty('billingPeriods')
    expect(snapshot.governance.legalHold).toBe(false)
    expect(snapshot.governanceEnforcement).toEqual({
      dataResidency: 'ap-northeast-1',
      encryptionKeyPolicy: 'aws-managed',
    })
  })

  test('rejects governance controls that differ from deployed enforcement', () => {
    expect(() => assertTenantGovernanceEnforced(
      'eu-west-1',
      'customer-managed',
      { dataResidency: 'ap-northeast-1', encryptionKeyPolicy: 'aws-managed' },
    )).toThrow('requested tenant data residency is not available')
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
    expect(resumeTenantOperation(
      requested,
      '2026-08-02T00:00:30.000Z',
    )).toMatchObject({
      status: 'running',
      currentStep: 'export',
      revision: 1,
    })
    expect(() => pauseTenantOperation(requested, '2026-08-02T00:00:30.000Z')).toThrow(
      'Tenant operation cannot be paused.',
    )
    const paused = pauseTenantOperation(running, '2026-08-02T00:01:30.000Z')
    expect(() => pauseTenantOperation(paused, '2026-08-02T00:01:45.000Z')).toThrow(
      'Tenant operation cannot be paused.',
    )
    const resumed = resumeTenantOperation(paused, '2026-08-02T00:02:00.000Z')
    expect(failTenantOperation(
      {
        ...resumed,
        currentStep: 'revoke-access',
        completedSteps: ['export'],
      },
      'ACCESS_REVOKE_FAILED',
      '2026-08-02T00:02:30.000Z',
    )).toMatchObject({
      status: 'failed',
      failureCode: 'ACCESS_REVOKE_FAILED',
    })
    expect(() => failTenantOperation(
      {
        ...resumed,
        currentStep: 'delete-data',
        completedSteps: ['export', 'revoke-access', 'anonymize-members'],
      },
      'DATA_DELETE_FAILED',
      '2026-08-02T00:02:30.000Z',
    )).toThrow('must remain sealed for recovery')
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
    const verifying = proofs.slice(0, 5).reduce(
      (operation, proof, index) => advanceTenantOperation(
        operation,
        proof,
        `2026-08-02T00:0${index + 3}:00.000Z`,
      ),
      resumed,
    )
    expect(repairTenantClosureOperation(
      verifying,
      'delete-secrets',
      createEvidenceReference(4),
      '2026-08-02T00:09:00.000Z',
    )).toMatchObject({
      status: 'running',
      currentStep: 'delete-secrets',
      completedSteps: ['export', 'revoke-access', 'anonymize-members', 'delete-data'],
      lastEvidenceReference: createEvidenceReference(4),
    })

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
