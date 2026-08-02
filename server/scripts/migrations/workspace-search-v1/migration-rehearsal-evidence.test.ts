import { describe, expect, test } from 'bun:test'
import { createMigrationDigest } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceIndex,
  parseWorkspaceSearchMigrationRehearsalEvidenceIndex,
  serializeWorkspaceSearchMigrationRehearsalEvidenceIndex,
  verifyWorkspaceSearchMigrationRehearsalEvidenceIndex,
  verifyWorkspaceSearchMigrationRehearsalReconciliationEvidence,
  WorkspaceSearchMigrationRehearsalEvidenceError,
} from './migration-rehearsal-evidence'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims,
} from './migration-rehearsal-evidence.test-fixture'

/** Creates one fresh dedicated evidence-index authentication key. */
function evidenceKey(): Uint8Array {
  return new Uint8Array(32).fill(0x71)
}

/** Narrows one plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Requires one plain JSON object. */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected evidence fixture record.')
  return value
}

/** Requires one plain JSON array. */
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected evidence fixture array.')
  return value
}

/** Creates a detached untyped JSON clone for negative-path mutation. */
function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

/** Calls index creation through its untrusted runtime boundary. */
function createIndexUnknown(evidence: unknown): unknown {
  return Reflect.apply(
    createWorkspaceSearchMigrationRehearsalEvidenceIndex,
    undefined,
    [{ evidence, signingKey: evidenceKey() }],
  )
}

/** Requires the stable raw-value-free evidence error. */
function expectEvidenceFailure(action: () => unknown): void {
  expect(action).toThrow(WorkspaceSearchMigrationRehearsalEvidenceError)
  expect(action).toThrow('INVALID_MIGRATION_REHEARSAL_EVIDENCE')
}

describe('migration rehearsal evidence index', () => {
  test('round-trips and authenticates canonical all-eight reconciliation claims', async () => {
    const claims =
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims()
    const index = createWorkspaceSearchMigrationRehearsalEvidenceIndex({
      evidence: claims,
      signingKey: evidenceKey(),
    })
    const bytes = serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(index)

    expect(parseWorkspaceSearchMigrationRehearsalEvidenceIndex(bytes))
      .toEqual(index)
    expect(verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
      bytes,
      evidenceKey(),
    )).toEqual(index)
    expect(index.reconciliation).toHaveLength(8)
    expect(Object.hasOwn(index, 'integrity')).toBe(false)
    expect(Object.hasOwn(index, 'targetRollback')).toBe(false)

    const verified =
      verifyWorkspaceSearchMigrationRehearsalReconciliationEvidence(
        claims.reconciliation,
      )
    expect(verified).toEqual(claims.reconciliation)
    const targetAudits = verified.flatMap((summary) =>
      summary.targetAudits === null
        ? []
        : [summary.targetAudits.preimage, summary.targetAudits.restored]
    )
    expect(targetAudits).toHaveLength(4)
    expect(new Set(targetAudits.map(({ contentDigest }) => contentDigest)).size)
      .toBe(4)
  })

  test('rejects wrong HMAC keys, modified MACs, and noncanonical bytes', async () => {
    const claims =
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims()
    const index = createWorkspaceSearchMigrationRehearsalEvidenceIndex({
      evidence: claims,
      signingKey: evidenceKey(),
    })
    const bytes = serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(index)
    expectEvidenceFailure(() =>
      verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
        bytes,
        new Uint8Array(32).fill(0x72),
      )
    )

    const modified = requireRecord(cloneJson(index))
    const authentication = requireRecord(modified.authentication)
    authentication.indexMac = '0'.repeat(64)
    const modifiedBytes = new TextEncoder().encode(JSON.stringify(modified))
    expectEvidenceFailure(() =>
      verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
        modifiedBytes,
        evidenceKey(),
      )
    )

    const noncanonical = new Uint8Array(bytes.byteLength + 1)
    noncanonical.set(bytes)
    noncanonical[bytes.byteLength] = 0x0a
    expectEvidenceFailure(() =>
      parseWorkspaceSearchMigrationRehearsalEvidenceIndex(noncanonical)
    )
  })

  test('rejects removed top-level raw integrity and target rollback claims', async () => {
    const claims =
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims()
    expectEvidenceFailure(() => createIndexUnknown({
      ...claims,
      integrity: Object.freeze({}),
    }))
    expectEvidenceFailure(() => createIndexUnknown({
      ...claims,
      targetRollback: Object.freeze({}),
    }))
  })

  test('rejects target audits on verified scenarios', async () => {
    const claims = requireRecord(cloneJson(
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims(),
    ))
    const reconciliation = requireArray(claims.reconciliation)
    const verified = requireRecord(reconciliation[0])
    const partial = requireRecord(reconciliation[6])
    verified.targetAudits = partial.targetAudits
    expectEvidenceFailure(() => createIndexUnknown(claims))
  })

  test('rejects duplicated reconciliation and target rate identities', async () => {
    const claims = requireRecord(cloneJson(
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims(),
    ))
    const reconciliation = requireArray(claims.reconciliation)
    const first = requireRecord(reconciliation[0])
    const second = requireRecord(reconciliation[1])
    second.rateSegmentLocatorDigest = first.rateSegmentLocatorDigest
    second.rateSegmentDigest = first.rateSegmentDigest
    expectEvidenceFailure(() => createIndexUnknown(claims))

    const targetClaims = requireRecord(cloneJson(
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims(),
    ))
    const targetReconciliation = requireArray(targetClaims.reconciliation)
    const partial = requireRecord(targetReconciliation[6])
    const targetAudits = requireRecord(partial.targetAudits)
    const preimage = requireRecord(targetAudits.preimage)
    const restored = requireRecord(targetAudits.restored)
    restored.contentDigest = preimage.contentDigest
    restored.observationDigest = preimage.observationDigest
    expectEvidenceFailure(() => createIndexUnknown(targetClaims))
  })

  test('rejects restored target-rate completion after reconciliation checkedAt', async () => {
    const claims = requireRecord(cloneJson(
      await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims(),
    ))
    const reconciliation = requireArray(claims.reconciliation)
    const partial = requireRecord(reconciliation[6])
    const targetAudits = requireRecord(partial.targetAudits)
    const restored = requireRecord(targetAudits.restored)
    const rate = requireRecord(restored.rate)
    rate.completedAt = '2099-01-01T00:00:00.000Z'
    expectEvidenceFailure(() => createIndexUnknown(claims))
  })

  test('rejects tampered live provenance, rollback windows, and preimage pins', async () => {
    const mutations = [
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const verified = requireRecord(reconciliation[0])
        const integrity = requireRecord(verified.integrity)
        const result = requireRecord(integrity.result)
        delete result.runtimeProvenance
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const verified = requireRecord(reconciliation[0])
        const integrity = requireRecord(verified.integrity)
        const result = requireRecord(integrity.result)
        const identities = requireArray(result.resourceIdentities)
        const auditEvents = requireRecord(identities[1])
        auditEvents.identityDigest = '0'.repeat(64)
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const partial = requireRecord(reconciliation[6])
        const integrity = requireRecord(partial.integrity)
        const before = requireRecord(integrity.before)
        integrity.applyStartedAt = before.checkedAt
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const partial = requireRecord(reconciliation[6])
        const integrity = requireRecord(partial.integrity)
        const after = requireRecord(integrity.after)
        after.resourceIdentityDigest = '0'.repeat(64)
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const partial = requireRecord(reconciliation[6])
        const integrity = requireRecord(partial.integrity)
        const targetAudits = requireRecord(partial.targetAudits)
        const preimage = requireRecord(targetAudits.preimage)
        preimage.integrityBefore = integrity.after
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const partial = requireRecord(reconciliation[6])
        const integrity = requireRecord(partial.integrity)
        const before = requireRecord(integrity.before)
        const after = requireRecord(integrity.after)
        integrity.comparisonDigest = createMigrationDigest({
          purpose: integrity.purpose,
          beforeResultDigest: before.resultDigest,
          afterResultDigest: after.resultDigest,
          comparison: {
            kind:
              'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
            contractVersion: 1,
            status: 'pass',
          },
        })
      },
      (claims: Record<string, unknown>): void => {
        const reconciliation = requireArray(claims.reconciliation)
        const partial = requireRecord(reconciliation[6])
        const targetAudits = requireRecord(partial.targetAudits)
        const restored = requireRecord(targetAudits.restored)
        restored.startedAt = partial.terminalAt
      },
    ]
    for (const mutate of mutations) {
      const claims = requireRecord(cloneJson(
        await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims(),
      ))
      mutate(claims)
      expectEvidenceFailure(() => createIndexUnknown(claims))
    }
  })
})
