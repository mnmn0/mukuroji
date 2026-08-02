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
  assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite,
  assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  WorkspaceSearchMigrationRehearsalSuiteFinalizerError,
} from './migration-rehearsal-suite-finalizer'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
  createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture,
  createAuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalFixture,
  createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
  type AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalScenario,
  type AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions,
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

/** Calls the authenticated assembler with a deliberately untyped value. */
function assembleAuthenticatedUnknown(value: unknown): unknown {
  return Reflect.apply(
    assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite,
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
  test('exports genuine release predecessors and exact 50-segment roles', () => {
    const scenarios:
      readonly AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalScenario[] = [
      'happy-path-verified',
      'partial-apply-rollback',
      'complete-apply-rollback',
    ]
    for (const scenario of scenarios) {
      const fixture =
        createAuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalFixture(
          scenario,
        )
      if (fixture.terminalReceipt.evidence.kind !== 'terminal') {
        throw new Error('Expected terminal release predecessor.')
      }
      const reconciliationOrdinal =
        fixture.terminalReceipt.evidence.reconciliationRate.successor
          .segmentOrdinal
      expect(fixture.allRateSegmentBytes).toHaveLength(50)
      expect(fixture.rateSegmentRoles).toHaveLength(50)
      expect(createHash('sha256')
        .update(fixture.ratePolicyBytes)
        .digest('hex')).toBe(fixture.manifest.policyVersion)
      const ratePolicyText = new TextDecoder().decode(
        fixture.ratePolicyBytes,
      )
      expect(serializeCanonicalJson(JSON.parse(ratePolicyText))).toBe(
        ratePolicyText,
      )
      expect(fixture.rateSegmentRoles.map((role) => role.segmentOrdinal))
        .toEqual(Array.from({ length: 50 }, (_, index) => index))
      expect(createHash('sha256')
        .update(fixture.terminalRateSegmentBytes)
        .digest('hex')).toBe(fixture.terminalReceipt.rateSegment.segmentDigest)
      expect(createHash('sha256')
        .update(fixture.reconciliationSuccessorSegmentBytes)
        .digest('hex')).toBe(
          fixture.terminalReceipt.evidence.reconciliationRate.successor
            .segmentDigest,
        )
      expect(fixture.allRateSegmentBytes[
        fixture.terminalReceipt.rateSegment.segmentOrdinal
      ]).toEqual(fixture.terminalRateSegmentBytes)
      expect(fixture.allRateSegmentBytes[reconciliationOrdinal]).toEqual(
        fixture.reconciliationSuccessorSegmentBytes,
      )
      expect(fixture.rateSegmentRoles[reconciliationOrdinal]?.role).toBe(
        'terminal-reconciliation',
      )
      fixture.runtimeAuthenticationKey.fill(0)
    }
  })

  test('derives publication claims without an operator suite document', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expect(Object.hasOwn(fixture.authenticatedInput, 'document')).toBe(false)
    expect(Object.hasOwn(fixture.authenticatedInput, 'attestation')).toBe(false)
    expect(Object.hasOwn(fixture.authenticatedInput, 'alarm')).toBe(false)

    const suite =
      assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite(
        fixture.authenticatedInput,
      )
    const material =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(suite)

    expect(material.bindings).toEqual(fixture.expected)
    expect(fixture.authenticatedInput.alarmSignalVerificationKey).toEqual(
      new Uint8Array(32),
    )
    expect(fixture.authenticatedInput.alarmPublicationVerificationKey).toEqual(
      new Uint8Array(32),
    )
  })

  test('strictly rejects operator claims and inexact session bindings', async () => {
    const operatorClaims =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expectSuiteFailure(() => assembleAuthenticatedUnknown({
      ...operatorClaims.authenticatedInput,
      document: operatorClaims.input.document,
      attestation: operatorClaims.expected.attestation,
      alarm: requireRecord(operatorClaims.input.document).alarm,
    }))

    const inexactSession =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    expectSuiteFailure(() => assembleAuthenticatedUnknown({
      ...inexactSession.authenticatedInput,
      sessionBinding: {
        ...requireRecord(inexactSession.authenticatedInput.sessionBinding),
        operatorNote: 'trusted-by-operator',
      },
    }))
  })

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

  test('assembles the root, all eight scenarios, and exact 50-segment rate stream', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const material =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
        fixture.suite,
      )

    expect(material.bindings).toEqual(fixture.expected)
    expect(Date.parse(material.bindings.startedAt)).toBeLessThan(
      Date.parse(material.bindings.firstStageStartedAt),
    )
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
    expect(segments).toHaveLength(50)
    expect(segments.map((segment) =>
      requireRecord(requireRecord(segment).header).segmentOrdinal
    )).toEqual(Array.from({ length: 50 }, (_, index) => index))
    const finalEvents = requireArray(
      requireRecord(segments[49]).events,
    )
    expect(requireRecord(finalEvents[0]).phase).toBe('measurement')
    expect(finalEvents.map((event) => requireRecord(event).kind)).toEqual([
      'attempt-charged',
      'attempt-started',
      'attempt-throttled',
      'budget-stop',
    ])
    expect(requireRecord(finalEvents[2]).provenance).toBe(
      'rehearsal-after-success-injection',
    )
    expect(requireRecord(finalEvents[3]).provenance).toBe(
      'rehearsal-after-success-injection',
    )

    const claims = material.finalize(
      createImmutableReferences(material.artifacts),
    )
    expect(claims.rate.aggregate).toMatchObject({
      awsServiceThrottleCount: 0,
      rehearsalInjectedThrottleCount: 1,
      awsServiceThrottleBudgetStopCount: 0,
      rehearsalInjectedBudgetStopCount: 1,
    })
    expect(claims.startedAt).toBe(material.bindings.startedAt)
    expect(claims.scenarios[0]?.startedAt).toBe(
      material.bindings.firstStageStartedAt,
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

    const integritySegments = segments.flatMap((segment) => {
      const record = requireRecord(segment)
      const integrityEvents = requireArray(record.events).filter((event) =>
        requireRecord(event).phase === 'integrity-check'
      )
      if (integrityEvents.length === 0) return []
      return [Object.freeze({
        ordinal: requireRecord(record.header).segmentOrdinal,
        events: integrityEvents,
      })]
    })
    const expectedIntegrityOrdinals = [
      0,
      ...claims.reconciliation.slice(0, 6).map((summary) =>
        summary.rateSegmentOrdinal
      ),
      ...claims.reconciliation.slice(6).flatMap((summary) => {
        if (summary.targetAudits === null) {
          throw new Error('Expected rollback target audits.')
        }
        return [
          summary.targetAudits.preimage.rate.successor.segmentOrdinal,
          summary.targetAudits.restored.rate.successor.segmentOrdinal,
        ]
      }),
    ]
    expect(integritySegments.map(({ ordinal }) => ordinal)).toEqual(
      expectedIntegrityOrdinals,
    )
    const integrityEvents = integritySegments.flatMap(({ events }) => events)
    expect(integrityEvents).toHaveLength(252)
    expect(integrityEvents.filter((event) =>
      requireRecord(event).kind === 'attempt-charged'
    )).toHaveLength(126)
    expect(integrityEvents.filter((event) =>
      requireRecord(event).kind === 'attempt-started'
    )).toHaveLength(126)
    for (const summary of claims.reconciliation.slice(6)) {
      expect(expectedIntegrityOrdinals).not.toContain(
        summary.rateSegmentOrdinal,
      )
      const rollbackReconciliationSegment =
        segments[summary.rateSegmentOrdinal]
      if (rollbackReconciliationSegment === undefined) {
        throw new Error('Expected rollback reconciliation segment.')
      }
      expect(requireArray(
        requireRecord(rollbackReconciliationSegment).events,
      ).every((event) =>
        requireRecord(event).phase === 'checkpoint-page'
      )).toBe(true)
    }
    for (const summary of claims.reconciliation.slice(0, 6)) {
      if (summary.integrity.kind !== 'verified-result') {
        throw new Error('Expected verified public integrity result.')
      }
      expect(Object.hasOwn(summary.integrity.result, 'bindingMac')).toBe(false)
      expect(Object.hasOwn(summary.integrity.result, 'interval')).toBe(false)
    }
    for (const target of targetAudits) {
      expect(Object.hasOwn(target.integrity, 'bindingMac')).toBe(false)
      expect(Object.hasOwn(target.integrity, 'interval')).toBe(false)
    }
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

  test('rejects the legacy first-stage timestamp as the suite root start', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const document = Object.freeze({
      ...requireRecord(fixture.input.document),
      startedAt: fixture.expected.firstStageStartedAt,
    })

    expectSuiteFailure(() => assembleUnknown({
      ...fixture.input,
      document,
    }))
  })

  test('rejects authentic 49- and 51-segment streams', async () => {
    const offsets: readonly (-1 | 1)[] = [-1, 1]
    for (const rateSegmentCountOffset of offsets) {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture({
          rateSegmentCountOffset,
        })
      expectSuiteFailure(() =>
        assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
          fixture.input,
        )
      )
    }
  })

  const invalidIntegrityInventoryCases = Object.freeze([
    Object.freeze({
      name: 'an out-of-order unclaimed integrity operation',
      variant: 'unclaimed-integrity-operation',
    }),
    Object.freeze({
      name: 'an integrity-phase throttle',
      variant: 'integrity-throttle',
    }),
    Object.freeze({
      name: 'an integrity-phase budget stop',
      variant: 'integrity-budget-stop',
    }),
  ]) satisfies readonly {
    readonly name: string
    readonly variant: NonNullable<
      AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions[
        'integrityInventoryVariant'
      ]
    >
  }[]

  for (const inventoryCase of invalidIntegrityInventoryCases) {
    test(`rejects ${inventoryCase.name} in an otherwise authentic stream`, async () => {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture({
          integrityInventoryVariant: inventoryCase.variant,
        })
      expectSuiteFailure(() =>
        assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
          fixture.input,
        )
      )
    })
  }

  const invalidRateExerciseCases = Object.freeze([
    Object.freeze({
      name: 'an event after the injected budget stop',
      variant: 'after-stop-event',
    }),
    Object.freeze({
      name: 'an AWS-service throttle substituted for the exercise',
      variant: 'aws-service-substitution',
    }),
    Object.freeze({
      name: 'a throttle and stop backoff mismatch',
      variant: 'backoff-mismatch',
    }),
    Object.freeze({
      name: 'an injection before ordinal 49',
      variant: 'early-injection',
    }),
    Object.freeze({
      name: 'a nonconsecutive final exercise',
      variant: 'nonconsecutive',
    }),
    Object.freeze({
      name: 'two deterministic injections',
      variant: 'two-injections',
    }),
    Object.freeze({
      name: 'no deterministic injection',
      variant: 'zero-injection',
    }),
  ]) satisfies readonly {
    readonly name: string
    readonly variant: NonNullable<
      AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions[
        'rateExerciseVariant'
      ]
    >
  }[]

  for (const rateCase of invalidRateExerciseCases) {
    test(`rejects ${rateCase.name} in an authenticated rate stream`, async () => {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture({
          rateExerciseVariant: rateCase.variant,
        })
      expectSuiteFailure(() =>
        assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
          fixture.input,
        )
      )
    })
  }

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
