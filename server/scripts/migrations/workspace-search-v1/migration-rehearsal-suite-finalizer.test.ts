import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { serializeCanonicalJson } from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS,
  type WorkspaceSearchMigrationRehearsalArtifactEvidence,
} from './migration-rehearsal-evidence'
import {
  finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence,
} from './migration-rehearsal-reconciliation-audit'
import {
  assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  WorkspaceSearchMigrationRehearsalSuiteFinalizerError,
} from './migration-rehearsal-suite-finalizer'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
  createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture,
  createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
} from './migration-rehearsal-suite-finalizer.test-fixture'
import {
  finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence,
} from './migration-rehearsal-target-audit'

/** Returns one conventional SHA-256 digest for a test-only label. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Narrows one parsed JSON object without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Requires one parsed JSON object. */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected fixture record.')
  return value
}

/** Narrows one parsed JSON array without a type assertion. */
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected fixture array.')
  return value
}

/** Calls the strict assembler with a deliberately untyped boundary value. */
function assembleUnknown(value: unknown): unknown {
  return Reflect.apply(
    assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
    undefined,
    [value],
  )
}

/** Requires the suite boundary to expose only its stable failure. */
function expectSuiteFailure(action: () => unknown): void {
  expect(action).toThrow(WorkspaceSearchMigrationRehearsalSuiteFinalizerError)
  expect(action).toThrow('INVALID_MIGRATION_REHEARSAL_SUITE_EVIDENCE')
}

/** Creates exact immutable references for all prepared child artifacts. */
function createImmutableReferences(
  artifacts: readonly {
    /** Canonical artifact purpose. */
    readonly kind: WorkspaceSearchMigrationRehearsalArtifactEvidence['kind']
    /** Exact canonical artifact digest. */
    readonly contentDigest: string
    /** Exact canonical artifact byte length. */
    readonly byteLength: number
  }[],
): readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[] {
  return Object.freeze(artifacts.map((artifact) => Object.freeze({
    kind: artifact.kind,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    immutableVersionDigest: digest(`version:${artifact.kind}`),
    retainedUntil: '2027-08-03T00:00:00.000Z',
  })))
}

/** Rewrites one nested alarm field while leaving every HMAC unchanged. */
function tamperAlarmArtifact(
  bytes: Uint8Array,
  path: readonly string[],
  replacement: unknown,
): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  let cursor = requireRecord(parsed)
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (key === undefined) throw new Error('Expected alarm path.')
    cursor = requireRecord(cursor[key])
  }
  const leaf = path.at(-1)
  if (leaf === undefined) throw new Error('Expected alarm leaf.')
  cursor[leaf] = replacement
  return new TextEncoder().encode(serializeCanonicalJson(parsed))
}

describe('migration rehearsal suite assembler', () => {
  test('creates genuine target and terminal special commit-gate inputs', () => {
    const target =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'target-preimage',
      )
    if (target.kind !== 'target-preimage') {
      throw new Error('Expected target-preimage fixture.')
    }
    expect(Object.isFrozen(
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        target.finalizationInput,
        target.runtimeAuthenticationKey,
        target.publicationAuthenticationKey,
      ),
    )).toBe(true)
    expect(target.receipt.stageReservationDigest).toBe(
      createHash('sha256')
        .update(serializeCanonicalJson(target.reservation), 'utf8')
        .digest('hex'),
    )

    const terminal =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'terminal-reconciliation',
      )
    if (terminal.kind !== 'terminal-reconciliation') {
      throw new Error('Expected terminal reconciliation fixture.')
    }
    expect(Object.isFrozen(
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        terminal.finalizationInput,
        terminal.runtimeAuthenticationKey,
        terminal.publicationAuthenticationKey,
      ),
    )).toBe(true)
    expect(terminal.receipt.stageReservationDigest).toBe(
      createHash('sha256')
        .update(serializeCanonicalJson(terminal.reservation), 'utf8')
        .digest('hex'),
    )
  })

  test('assembles all eight actual reconciliation artifacts and exact 49-segment rate stream', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const material =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
        fixture.suite,
      )

    expect(material.bindings).toEqual(fixture.expected)
    expect(material.artifacts.map(({ kind }) => kind))
      .toEqual([...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS])

    const rateArtifact = material.artifacts.find(
      ({ kind }) => kind === 'rate-observations',
    )
    if (rateArtifact === undefined) throw new Error('Expected rate artifact.')
    const rateDocument = requireRecord(JSON.parse(
      new TextDecoder().decode(rateArtifact.canonicalBytes),
    ))
    const segments = requireArray(rateDocument.segments)
    expect(segments).toHaveLength(49)
    expect(segments.map((segment) =>
      requireRecord(requireRecord(segment).header).segmentOrdinal
    )).toEqual(Array.from({ length: 49 }, (_, index) => index))
    const finalEvents = requireArray(
      requireRecord(segments[48]).events,
    )
    expect(requireRecord(finalEvents[0]).phase).toBe('measurement')

    const claims = material.finalize(
      createImmutableReferences(material.artifacts),
    )
    expect(claims.reconciliation).toHaveLength(8)
    expect(Object.hasOwn(claims, 'integrity')).toBe(false)
    expect(Object.hasOwn(claims, 'targetRollback')).toBe(false)
    const targetAudits = claims.reconciliation.flatMap((summary) =>
      summary.targetAudits === null
        ? []
        : [summary.targetAudits.preimage, summary.targetAudits.restored]
    )
    expect(targetAudits).toHaveLength(4)
    expect(new Set(targetAudits.map(({ contentDigest }) => contentDigest)).size)
      .toBe(4)
    const auxiliaryRateOrdinals = claims.reconciliation.flatMap((summary) => [
      ...(summary.targetAudits === null
        ? []
        : [
            summary.targetAudits.preimage.rate.successor.segmentOrdinal,
            summary.targetAudits.restored.rate.successor.segmentOrdinal,
          ]),
      summary.rateSegmentOrdinal,
    ])
    expect(auxiliaryRateOrdinals).toHaveLength(12)
    expect(new Set(auxiliaryRateOrdinals).size).toBe(12)
  })

  test('consumes the assembler and publication capabilities exactly once', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const suite = assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
      fixture.input,
    )
    expectSuiteFailure(() =>
      assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
        fixture.input,
      )
    )
    const material =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(suite)
    expectSuiteFailure(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(suite)
    )
    material.finalize(createImmutableReferences(material.artifacts))
    expectSuiteFailure(() =>
      material.finalize(createImmutableReferences(material.artifacts))
    )
  })

  test('rejects forged reconciliation capability and removed raw evidence fields', async () => {
    const forged =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expectSuiteFailure(() => assembleUnknown({
      ...forged.input,
      reconciliation: Object.freeze({
        kind: 'mukuroji-workspace-search-migration-rehearsal-reconciliation-evidence',
      }),
    }))

    const stale =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expectSuiteFailure(() => assembleUnknown({
      ...stale.input,
      integrity: Object.freeze({}),
      targetRollback: Object.freeze({}),
    }))
  })

  test('rejects a non-measurement final rate segment', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture({
        finalMeasurementPhase: 'checkpoint-page',
      })
    expectSuiteFailure(() =>
      assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
        fixture.input,
      )
    )
  })

  test('rejects wrong and child-equal alarm publication keys', async () => {
    const wrong =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expectSuiteFailure(() =>
      assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput({
        ...wrong.input,
        alarmPublicationVerificationKey: new Uint8Array(32).fill(0x7f),
      })
    )

    const equal =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const shared = new Uint8Array(equal.input.alarmSignalVerificationKey)
    expectSuiteFailure(() =>
      assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput({
        ...equal.input,
        alarmSignalVerificationKey: new Uint8Array(shared),
        alarmPublicationVerificationKey: new Uint8Array(shared),
      })
    )
  })

  const alarmTamperingCases = Object.freeze([
    Object.freeze({
      name: 'authorization shared-session binding',
      path: Object.freeze(['authorization', 'sharedSessionBindingDigest']),
      replacement: digest('foreign-shared-session'),
    }),
    Object.freeze({
      name: 'signal receipt chain',
      path: Object.freeze(['signalArtifact', 'receipts']),
      replacement: Object.freeze([]),
    }),
    Object.freeze({
      name: 'Logs ingestion chain',
      path: Object.freeze(['ingestionArtifact', 'receipts']),
      replacement: Object.freeze([]),
    }),
    Object.freeze({
      name: 'CloudWatch history chain',
      path: Object.freeze(['transitionArtifact', 'transitions']),
      replacement: Object.freeze([]),
    }),
    Object.freeze({
      name: 'dual-route receipt chain',
      path: Object.freeze(['receiptArtifact', 'receipts']),
      replacement: Object.freeze([]),
    }),
  ])

  for (const alarmCase of alarmTamperingCases) {
    test(`rejects parent-HMAC tampering in ${alarmCase.name}`, async () => {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
      expectSuiteFailure(() =>
        assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput({
          ...fixture.input,
          alarmArtifactBytes: tamperAlarmArtifact(
            fixture.input.alarmArtifactBytes,
            alarmCase.path,
            alarmCase.replacement,
          ),
        })
      )
    })
  }

  test('rejects immutable references that do not bind the prepared bytes', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const material =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
        fixture.suite,
      )
    const references = createImmutableReferences(material.artifacts)
    const first = references[0]
    if (first === undefined) throw new Error('Expected immutable reference.')
    expectSuiteFailure(() => material.finalize(Object.freeze([
      Object.freeze({ ...first, contentDigest: digest('foreign-content') }),
      ...references.slice(1),
    ])))
  })
})
