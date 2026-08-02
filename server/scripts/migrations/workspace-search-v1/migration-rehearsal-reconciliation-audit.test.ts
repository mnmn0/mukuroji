import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'
import {
  authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact,
  authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes,
  consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact,
  finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence,
  finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS,
  WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact,
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding,
  type WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
} from './migration-rehearsal-reconciliation-audit'

/** Fixed terminal publication instant used by all isolated test scenarios. */
const terminalAt = '2026-08-01T00:00:10.000Z'

/** Fixed full reconciliation completion instant used by test scenarios. */
const checkedAt = '2026-08-01T00:00:13.000Z'

/** Fixed canonical immutable-resource vector retained by result projections. */
const resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[] =
  Object.freeze(CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: (index + 1).toString(16).repeat(64),
    })
  ))

/** Creates one deterministic conventional digest for a test-only label. */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/** Creates one fresh copy of the permit-bound rehearsal runtime HMAC key. */
function key(): Uint8Array {
  return new Uint8Array(32).fill(73)
}

/** Creates one fresh copy of the parent-held publication HMAC key. */
function publicationKey(): Uint8Array {
  return new Uint8Array(32).fill(74)
}

/** Creates one canonical HMAC-authenticated empty rate-segment header. */
function createRateHeaderBytes(
  payload: object,
  authenticationKey: Uint8Array,
): Uint8Array {
  const mac = createHmac('sha256', authenticationKey)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(payload), 'utf8')
    .digest('hex')
  return new TextEncoder().encode(
    `${serializeCanonicalJson({ ...payload, mac })}\n`,
  )
}

/** Creates one fresh exact auxiliary rate proof for an audit fixture. */
function createRateInput(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  ordinal: number,
  authenticationKey: Uint8Array = key(),
  completedAt = '2026-08-01T00:00:15.000Z',
  predecessorAnchorUtc = '2026-08-01T00:00:13.000Z',
  successorAnchorUtc = '2026-08-01T00:00:14.000Z',
): FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput {
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      authenticationKey,
    )
  const policyVersion = digest('rate-policy')
  const predecessorOrdinal = (ordinal % 120) * 2
  const predecessorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(
      `rate-predecessor:${context.runLocatorDigest}:${ordinal}`,
    ),
    segmentOrdinal: predecessorOrdinal,
    previousSegmentDigest: predecessorOrdinal === 0
      ? null
      : digest(`rate-prior-segment:${ordinal}`),
    previousRecordMac: predecessorOrdinal === 0
      ? null
      : digest(`rate-prior-mac:${ordinal}`),
    firstEventSequence: 1,
    anchorUtc: predecessorAnchorUtc,
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest: context.configurationBindingDigest,
  })
  const predecessorSegmentBytes = createRateHeaderBytes(
    predecessorPayload,
    authenticationKey,
  )
  const predecessorRecord: unknown = JSON.parse(
    new TextDecoder().decode(predecessorSegmentBytes),
  )
  const predecessorMac = requireRecord(predecessorRecord).mac
  if (typeof predecessorMac !== 'string') {
    throw new Error('Missing predecessor fixture MAC.')
  }
  const successorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(
      `rate-successor:${context.runLocatorDigest}:${ordinal}`,
    ),
    segmentOrdinal: predecessorOrdinal + 1,
    previousSegmentDigest: createHash('sha256')
      .update(predecessorSegmentBytes)
      .digest('hex'),
    previousRecordMac: predecessorMac,
    firstEventSequence: 1,
    anchorUtc: successorAnchorUtc,
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest: context.configurationBindingDigest,
  })
  const successorSegmentBytes = createRateHeaderBytes(
    successorPayload,
    authenticationKey,
  )
  return Object.freeze({
    verifiedSuccessor:
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        predecessorSegmentBytes,
        successorSegmentBytes,
        authenticationKey,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest:
          context.configurationBindingDigest,
      }),
    durableEvidence: Object.freeze({
      version: 1,
      policyVersion,
      attemptCount: ordinal % 120 + 1,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    }),
    completedAt,
  })
}

/** Creates authenticated target summaries retained by one rollback audit. */
function createTargetAudits(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  sourceTarget:
    WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
  integrity:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult,
  ordinal: number,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null {
  if (isVerifiedScenario(context.scenario)) return null
  if (integrity.kind !== 'rollback-comparison') {
    throw new Error('Expected rollback integrity fixture.')
  }
  const purposePrefix = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : 'complete-rollback'
  const contextDigest = digest(`target-context:${context.scenario}:${ordinal}`)
  const preimageRate =
    finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
      createRateInput(
        context,
        ordinal * 3 + 1,
        key(),
        '2026-08-01T00:00:06.000Z',
        '2026-08-01T00:00:03.000Z',
        '2026-08-01T00:00:04.000Z',
      ),
    )
  const restoredRate =
    finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
      createRateInput(
        context,
        ordinal * 3 + 2,
        key(),
        '2026-08-01T00:00:12.000Z',
        '2026-08-01T00:00:09.000Z',
        '2026-08-01T00:00:10.000Z',
      ),
    )
  return Object.freeze({
    preimage: Object.freeze({
      purpose: `${purposePrefix}-preimage`,
      startedAt: '2026-08-01T00:00:04.000Z',
      contentDigest: digest(`target-preimage-content:${ordinal}`),
      byteLength: 2_048,
      observedAt: '2026-08-01T00:00:05.000Z',
      observationDigest: digest(`target-preimage-observation:${ordinal}`),
      aggregateDigest: sourceTarget.expectedAggregateDigest,
      contextDigest,
      integrityBefore: integrity.before,
      rate: preimageRate,
    }),
    restored: Object.freeze({
      purpose: `${purposePrefix}-restored`,
      startedAt: '2026-08-01T00:00:10.001Z',
      contentDigest: digest(`target-restored-content:${ordinal}`),
      byteLength: 2_048,
      observedAt: '2026-08-01T00:00:11.000Z',
      observationDigest: digest(`target-restored-observation:${ordinal}`),
      aggregateDigest: sourceTarget.observedAggregateDigest,
      contextDigest,
      integrityBefore: null,
      rate: restoredRate,
    }),
  })
}

/** Returns whether one scenario closes on a verified root. */
function isVerifiedScenario(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): boolean {
  return scenario !== 'partial-apply-rollback' &&
    scenario !== 'complete-apply-rollback'
}

/** Creates exact terminal context before its #163 projection is attached. */
function createCoreContext(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  ordinal: number,
  rootDigest = digest(`terminal:${scenario}:${ordinal}`),
): WorkspaceSearchMigrationRehearsalReconciliationCoreContext {
  const partial = scenario === 'partial-apply-rollback'
  const verified = isVerifiedScenario(scenario)
  return Object.freeze({
    scenario,
    runLocatorDigest: digest(`run:${scenario}:${ordinal}`),
    configurationBindingDigest: digest(`configuration:${ordinal}`),
    sealedPlanningAuthorityDigest: digest(`authority:${scenario}:${ordinal}`),
    executionRunDigest: digest(`execution:${scenario}:${ordinal}`),
    planDigest: digest(`plan:${scenario}:${ordinal}`),
    applyBoundaryDigest: digest(`boundary:${scenario}:${ordinal}`),
    terminalRootKind: verified ? 'verified' : 'rolled-back',
    terminalRootVersion: partial ? 2 : 1,
    terminalRootDigest: rootDigest,
    sealedPlanOperationCount: 3,
    appliedOperationCount: partial ? 2 : 3,
    terminalAt,
    checkedAt,
  })
}

/** Creates one exact digest-only independently authenticated #163 result. */
function createIntegrityResult(
  label: string,
  startedAt: string,
  observedAt: string,
  integrityAggregateDigest: string,
  resourceIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  return Object.freeze({
    checkedAt: observedAt,
    contentDigest: digest(`integrity-content:${label}`),
    byteLength: 1_024,
    resultDigest: digest(`integrity-result:${label}`),
    resultMac: digest(`integrity-mac:${label}`),
    runtimeProvenance: Object.freeze({
      kind: 'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt,
      completedAt: observedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    integrityAggregateDigest,
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities,
    resourceIdentityDigest,
  })
}

/** Creates exact scenario-specific #163 material around a terminal root. */
function createIntegrity(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  sourceTarget:
    WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
  ordinal: number,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  const integrityAggregateDigest = digest(
    `integrity-aggregate:${context.scenario}:${ordinal}`,
  )
  const resourceIdentityDigest = digest(
    `integrity-resources:${context.scenario}:${ordinal}`,
  )
  if (isVerifiedScenario(context.scenario)) {
    const result = createIntegrityResult(
      `${context.scenario}:${ordinal}:after`,
      '2026-08-01T00:00:10.001Z',
      '2026-08-01T00:00:11.000Z',
      integrityAggregateDigest,
      resourceIdentityDigest,
    )
    return Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: '2026-08-01T00:00:12.000Z',
      result,
      terminalRootDigest: context.terminalRootDigest,
      integrityAggregateDigest,
    })
  }
  const purpose = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : 'complete-rollback'
  const startedAt = '2026-08-01T00:00:00.000Z'
  const applyStartedAt = '2026-08-01T00:00:07.000Z'
  const completedAt = '2026-08-01T00:00:12.000Z'
  const before = createIntegrityResult(
    `${context.scenario}:${ordinal}:before`,
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:00:01.000Z',
    integrityAggregateDigest,
    resourceIdentityDigest,
  )
  const after = createIntegrityResult(
    `${context.scenario}:${ordinal}:after`,
    '2026-08-01T00:00:10.001Z',
    '2026-08-01T00:00:11.000Z',
    integrityAggregateDigest,
    resourceIdentityDigest,
  )
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: before.resultDigest,
    afterResultDigest: after.resultDigest,
    comparison: {
      kind:
        'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
    },
  })
  return Object.freeze({
    kind: 'rollback-comparison',
    purpose,
    status: 'pass',
    failureCount: 0,
    startedAt,
    applyStartedAt,
    terminalAt: context.terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
    comparisonContextDigest: createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-integrity-context',
      version: 1,
      purpose,
      startedAt,
      applyStartedAt,
      terminalAt: context.terminalAt,
      completedAt,
      before,
      after,
      comparisonDigest,
    }),
    terminalRootDigest: context.terminalRootDigest,
    targetPreimageAggregateDigest:
      sourceTarget.expectedAggregateDigest,
    targetRestoredAggregateDigest:
      sourceTarget.observedAggregateDigest,
    targetPreimageStatus: 'equal',
  })
}

/** Creates one internally consistent measured terminal collector result. */
function createCollector(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  ordinal: number,
  failures = false,
  rootDigest?: string,
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
  const context = createCoreContext(scenario, ordinal, rootDigest)
  const markerExpected = digest(`marker-expected:${scenario}:${ordinal}`)
  const authorityExpected = digest(
    `authority-expected:${scenario}:${ordinal}`,
  )
  const sourceExpected = digest(`source-expected:${scenario}:${ordinal}`)
  const sourceTarget = Object.freeze({
    expectedAggregateDigest: sourceExpected,
    observedAggregateDigest: failures
      ? digest(`source-observed:${scenario}:${ordinal}`)
      : sourceExpected,
    expectedCount: 5,
    observedCount: failures ? 4 : 5,
    matchedCount: failures ? 4 : 5,
    lostCount: failures ? 1 : 0,
    unexpectedCount: 0,
  })
  const integrity = createIntegrity(context, sourceTarget, ordinal)
  return Object.freeze({
    context,
    integrity,
    targetAudits: createTargetAudits(
      context,
      sourceTarget,
      integrity,
      ordinal,
    ),
    markerSummary: Object.freeze({
      expectedCount: context.appliedOperationCount,
      expectedAggregateDigest: markerExpected,
      observedCount: failures
        ? context.appliedOperationCount + 1
        : context.appliedOperationCount,
      observedAggregateDigest: failures
        ? digest(`marker-observed:${scenario}:${ordinal}`)
        : markerExpected,
      matchedCount: context.appliedOperationCount,
      duplicateCount: failures ? 1 : 0,
      missingCount: 0,
      unexpectedCount: 0,
    }),
    authoritySummary: Object.freeze({
      expectedChainDigest: authorityExpected,
      observedChainDigest: failures
        ? digest(`authority-observed:${scenario}:${ordinal}`)
        : authorityExpected,
      expectedCount: 4,
      observedCount: failures ? 4 : 4,
      matchedCount: failures ? 3 : 4,
      missingCount: failures ? 1 : 0,
      orphanCount: failures ? 1 : 0,
    }),
    sourceTargetSummary: sourceTarget,
  })
}

/** Creates one valid measured result with exactly one selected discrepancy. */
function createCollectorWithDiscrepancy(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  ordinal: number,
  discrepancy:
    | 'authority-missing'
    | 'authority-orphan'
    | 'marker-duplicate'
    | 'marker-missing'
    | 'marker-unexpected'
    | 'source-lost'
    | 'source-unexpected',
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
  const collector = createCollector(scenario, ordinal)
  let markerSummary = collector.markerSummary
  let authoritySummary = collector.authoritySummary
  let sourceTargetSummary = collector.sourceTargetSummary
  if (discrepancy === 'marker-duplicate') {
    markerSummary = Object.freeze({
      ...markerSummary,
      observedCount: markerSummary.observedCount + 1,
      observedAggregateDigest: digest(`marker-duplicate:${ordinal}`),
      duplicateCount: 1,
    })
  } else if (discrepancy === 'marker-missing') {
    markerSummary = Object.freeze({
      ...markerSummary,
      observedCount: markerSummary.observedCount - 1,
      observedAggregateDigest: digest(`marker-missing:${ordinal}`),
      matchedCount: markerSummary.matchedCount - 1,
      missingCount: 1,
    })
  } else if (discrepancy === 'marker-unexpected') {
    markerSummary = Object.freeze({
      ...markerSummary,
      observedCount: markerSummary.observedCount + 1,
      observedAggregateDigest: digest(`marker-unexpected:${ordinal}`),
      unexpectedCount: 1,
    })
  } else if (discrepancy === 'authority-missing') {
    authoritySummary = Object.freeze({
      ...authoritySummary,
      observedChainDigest: digest(`authority-missing:${ordinal}`),
      observedCount: authoritySummary.observedCount - 1,
      matchedCount: authoritySummary.matchedCount - 1,
      missingCount: 1,
    })
  } else if (discrepancy === 'authority-orphan') {
    authoritySummary = Object.freeze({
      ...authoritySummary,
      observedChainDigest: digest(`authority-orphan:${ordinal}`),
      observedCount: authoritySummary.observedCount + 1,
      orphanCount: 1,
    })
  } else if (discrepancy === 'source-lost') {
    sourceTargetSummary = Object.freeze({
      ...sourceTargetSummary,
      observedAggregateDigest: digest(`source-lost:${ordinal}`),
      observedCount: sourceTargetSummary.observedCount - 1,
      matchedCount: sourceTargetSummary.matchedCount - 1,
      lostCount: 1,
    })
  } else {
    sourceTargetSummary = Object.freeze({
      ...sourceTargetSummary,
      observedAggregateDigest: digest(`source-unexpected:${ordinal}`),
      observedCount: sourceTargetSummary.observedCount + 1,
      unexpectedCount: 1,
    })
  }
  return Object.freeze({
    ...collector,
    integrity: createIntegrity(
      collector.context,
      sourceTargetSummary,
      ordinal,
    ),
    markerSummary,
    authoritySummary,
    sourceTargetSummary,
  })
}

/** Finalizes one fixture under a fresh copy of the common test key. */
function finalizeCollector(
  collector: WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
): WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact {
  return finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
    {
      collectorResult: collector,
      rate: createRateInput(
        collector.context,
        Number.parseInt(collector.context.runLocatorDigest.slice(0, 2), 16),
      ),
    },
    key(),
    publicationKey(),
  )
}

/** Finalizes one artifact while retaining its exact authenticated predecessor. */
function finalizeTerminalCollector(
  collector: WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  ordinal: number,
) {
  const rate = createRateInput(collector.context, ordinal)
  const expectedRatePredecessor = rate.verifiedSuccessor.predecessor
  const artifact =
    finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
      { collectorResult: collector, rate },
      key(),
      publicationKey(),
    )
  return Object.freeze({ artifact, expectedRatePredecessor })
}

/** Requires one mutable ordinary parsed JSON record for attack fixtures. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
}

/** Requires one mutable ordinary parsed JSON record for attack fixtures. */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected test record.')
  }
  return value
}

/** Creates exact canonical bytes after one test-only document mutation. */
function mutateCanonicalArtifact(
  bytes: Uint8Array,
  mutate: (record: Record<string, unknown>) => void,
): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const record = requireRecord(parsed)
  mutate(record)
  return new TextEncoder().encode(serializeCanonicalJson(record))
}

/** Requires one string field from a parsed reconciliation fixture. */
function requireFixtureString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected reconciliation fixture string.')
  }
  return value
}

/** Rewraps foreign rate evidence with otherwise valid parent audit HMACs. */
function rewrapReconciliationAuditWithRate(
  artifactBytes: Uint8Array,
  rate: unknown,
): Uint8Array {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(artifactBytes),
  )
  const document = requireRecord(parsed)
  const authentication = requireRecord(document.authentication)
  const algorithm = requireFixtureString(authentication.algorithm)
  const runtimeKeyFingerprint = requireFixtureString(
    authentication.runtimeKeyFingerprint,
  )
  const publicationKeyFingerprint = requireFixtureString(
    authentication.publicationKeyFingerprint,
  )
  const {
    authentication: _authentication,
    auditDigest: _auditDigest,
    ...semanticWithoutRateReplacement
  } = document
  const semantic = {
    ...semanticWithoutRateReplacement,
    rate,
  }
  const auditDigest = createMigrationDigest(semantic)
  const runtimeUnsigned = {
    ...semantic,
    auditDigest,
    authentication: {
      algorithm,
      runtimeKeyFingerprint,
    },
  }
  const runtimeMac = createHmac('sha256', key())
    .update(
      'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-runtime-mac/v2\n',
      'utf8',
    )
    .update(serializeCanonicalJson(runtimeUnsigned), 'utf8')
    .digest('hex')
  const publicationUnsigned = {
    ...semantic,
    auditDigest,
    authentication: {
      algorithm,
      runtimeKeyFingerprint,
      runtimeMac,
      publicationKeyFingerprint,
    },
  }
  const publicationMac = createHmac('sha256', publicationKey())
    .update(
      'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-publication-mac/v2\n',
      'utf8',
    )
    .update(serializeCanonicalJson(publicationUnsigned), 'utf8')
    .digest('hex')
  return new TextEncoder().encode(serializeCanonicalJson({
    ...publicationUnsigned,
    authentication: {
      ...publicationUnsigned.authentication,
      publicationMac,
    },
  }))
}

describe('workspace search migration rehearsal reconciliation audit', () => {
  test('finalizes and authenticates one all-safe canonical artifact', () => {
    const signingKey = key()
    const publicationSigningKey = publicationKey()
    const collector = createCollector('happy-path-verified', 1)
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: collector,
          rate: createRateInput(collector.context, 1),
        },
        signingKey,
        publicationSigningKey,
      )
    expect(signingKey.every((byte) => byte === 0)).toBe(true)
    expect(publicationSigningKey.every((byte) => byte === 0)).toBe(true)
    expect(finalized.byteLength).toBe(finalized.canonicalBytes.byteLength)
    expect(finalized.contentDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect([...new TextEncoder().encode(
      serializeCanonicalJson(JSON.parse(
        new TextDecoder().decode(finalized.canonicalBytes),
      )),
    )]).toEqual([...finalized.canonicalBytes])

    const verificationKey = key()
    const publicationVerificationKey = publicationKey()
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        verificationKey,
        publicationVerificationKey,
      )
    expect(verificationKey.every((byte) => byte === 0)).toBe(true)
    expect(publicationVerificationKey.every((byte) => byte === 0)).toBe(
      true,
    )
    expect(binding).toMatchObject({
      scenario: 'happy-path-verified',
      contentDigest: finalized.contentDigest,
      byteLength: finalized.byteLength,
      duplicateApplyCount: 0,
      lostItemCount: 0,
      orphanAuthorityCount: 0,
    })
    expect(binding.integrity.kind).toBe('verified-result')
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.markerSummary)).toBe(true)
    expect(Object.isFrozen(binding.integrity)).toBe(true)

    const actualArtifactRuntimeKey = key()
    const actualArtifactPublicationKey = publicationKey()
    const actualArtifactBinding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        finalized.canonicalBytes,
        actualArtifactRuntimeKey,
        actualArtifactPublicationKey,
      )
    expect(actualArtifactRuntimeKey.every((byte) => byte === 0)).toBe(true)
    expect(actualArtifactPublicationKey.every((byte) => byte === 0)).toBe(
      true,
    )
    expect(actualArtifactBinding).toEqual(binding)
  })

  test('fails closed while authenticating untrusted actual artifact bytes', () => {
    const artifact = finalizeCollector(
      createCollector('cursor-after-commit-kill', 79),
    )
    const tampered = mutateCanonicalArtifact(
      artifact.canonicalBytes,
      (record) => {
        record.checkedAt = '2026-08-01T00:00:12.999Z'
      },
    )
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(artifact.canonicalBytes)}`,
    )
    const proxied = new Proxy(artifact.canonicalBytes, Object.freeze({}))
    const aliasedKey = key()
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        artifact.canonicalBytes,
        aliasedKey,
        aliasedKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(aliasedKey.every((byte) => byte === 0)).toBe(true)
    for (const bytes of [tampered, noncanonical, proxied]) {
      expect(() =>
        authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
          bytes,
          key(),
          publicationKey(),
        )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    }
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        artifact.canonicalBytes,
        new Uint8Array(32).fill(12),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        artifact.canonicalBytes,
        key(),
        new Uint8Array(32).fill(12),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('issues one terminal capability from the exact dual-key artifact binding', () => {
    const collector = createCollector('happy-path-verified', 80)
    const { artifact, expectedRatePredecessor } =
      finalizeTerminalCollector(collector, 80)
    const runtimeVerificationKey = key()
    const publicationVerificationKey = publicationKey()
    const capability =
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        {
          artifact: {
            artifactBytes: artifact.canonicalBytes,
            expectedContext: artifact.context,
          },
          expectedRatePredecessor,
        },
        runtimeVerificationKey,
        publicationVerificationKey,
      )

    expect(runtimeVerificationKey.every((byte) => byte === 0)).toBe(true)
    expect(publicationVerificationKey.every((byte) => byte === 0)).toBe(true)
    const binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        capability,
      )
    expect(binding.contentDigest).toBe(artifact.contentDigest)
    expect(binding.scenario).toBe(collector.context.scenario)
    expect(binding.runLocatorDigest).toBe(collector.context.runLocatorDigest)
    expect(binding.targetAudits).toBeNull()
    expect(binding.rate.predecessor).toEqual(expectedRatePredecessor)
    expect(binding.auditDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        capability,
      ),
    ).toBe(binding)
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        capability,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        capability,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('issues no terminal capability for any nonzero safety discrepancy', () => {
    const discrepancies = [
      'authority-missing',
      'authority-orphan',
      'marker-duplicate',
      'marker-missing',
      'marker-unexpected',
      'source-lost',
      'source-unexpected',
    ] satisfies readonly Parameters<typeof createCollectorWithDiscrepancy>[2][]
    for (const [index, discrepancy] of discrepancies.entries()) {
      const collector = createCollectorWithDiscrepancy(
        'happy-path-verified',
        90 + index,
        discrepancy,
      )
      const { artifact, expectedRatePredecessor } =
        finalizeTerminalCollector(collector, 90 + index)
      expect(() =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          key(),
          publicationKey(),
        )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    }
  })

  test('binds both rollback target audits and their terminal timing exactly', () => {
    const scenarios:
      readonly WorkspaceSearchMigrationRehearsalScenarioName[] = [
      'partial-apply-rollback',
      'complete-apply-rollback',
    ]
    for (const [index, scenario] of scenarios.entries()) {
      const collector = createCollector(scenario, 81 + index)
      const { artifact, expectedRatePredecessor } =
        finalizeTerminalCollector(collector, 81 + index)
      const capability =
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          key(),
          publicationKey(),
        )
      const binding =
        consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
          capability,
        )
      const targetAudits = binding.targetAudits
      if (targetAudits === null || collector.targetAudits === null) {
        throw new Error('Expected exact rollback target-audit pair.')
      }
      expect(targetAudits).toEqual(collector.targetAudits)
      expect(targetAudits.preimage.aggregateDigest).toBe(
        targetAudits.restored.aggregateDigest,
      )
      expect(
        Date.parse(targetAudits.restored.rate.completedAt),
      ).toBeLessThanOrEqual(Date.parse(binding.checkedAt))
      expect(Date.parse(binding.checkedAt)).toBeLessThanOrEqual(
        Date.parse(binding.rate.completedAt),
      )
      expect(Date.parse(targetAudits.preimage.observedAt)).toBeLessThan(
        Date.parse(binding.terminalAt),
      )
      expect(Date.parse(targetAudits.restored.observedAt)).toBeGreaterThan(
        Date.parse(binding.terminalAt),
      )
    }
  })

  test('rejects rollback target-pair substitution and either rate-time inversion', () => {
    const collector = createCollector('partial-apply-rollback', 86)
    const targetAudits = collector.targetAudits
    if (targetAudits === null) {
      throw new Error('Expected rollback target-audit fixture.')
    }
    const verifiedCollector = createCollector('happy-path-verified', 86)
    expect(verifiedCollector.targetAudits).toBeNull()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: Object.freeze({
            ...verifiedCollector,
            targetAudits,
          }),
          rate: createRateInput(verifiedCollector.context, 86),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: Object.freeze({
            ...collector,
            targetAudits: null,
          }),
          rate: createRateInput(collector.context, 86),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    const substitutedPair = Object.freeze({
      ...collector,
      targetAudits: Object.freeze({
        preimage: targetAudits.preimage,
        restored: Object.freeze({
          ...targetAudits.restored,
          contextDigest: digest('substituted-restored-context'),
        }),
      }),
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: substitutedPair,
          rate: createRateInput(collector.context, 86),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')

    const lateRestoredRate =
      finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
        createRateInput(
          collector.context,
          86 * 3 + 2,
          key(),
          '2026-08-01T00:00:14.000Z',
          '2026-08-01T00:00:09.000Z',
          '2026-08-01T00:00:10.000Z',
        ),
      )
    const lateRestored = Object.freeze({
      ...collector,
      targetAudits: Object.freeze({
        preimage: targetAudits.preimage,
        restored: Object.freeze({
          ...targetAudits.restored,
          rate: lateRestoredRate,
        }),
      }),
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: lateRestored,
          rate: createRateInput(collector.context, 87),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')

    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: collector,
          rate: createRateInput(
            collector.context,
            88,
            key(),
            '2026-08-01T00:00:12.999Z',
          ),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('rejects a wrong context, content, key, predecessor, or nonterminal file', () => {
    const collector = createCollector('happy-path-verified', 83)
    const { artifact, expectedRatePredecessor } =
      finalizeTerminalCollector(collector, 83)
    const foreignRate = createRateInput(collector.context, 84)
    const tamperedArtifact = mutateCanonicalArtifact(
      artifact.canonicalBytes,
      (record) => {
        record.auditDigest = digest('tampered-terminal-audit')
      },
    )
    const wrongContext = Object.freeze({
      ...artifact.context,
      runLocatorDigest: digest('foreign-terminal-run'),
    })
    const nonterminalArtifact = new TextEncoder().encode(
      serializeCanonicalJson({
        kind: 'mukuroji-workspace-search-migration-rehearsal-stage-receipt',
        command: 'apply',
        terminal: false,
      }),
    )
    const attempts = [
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: wrongContext,
            },
            expectedRatePredecessor,
          },
          key(),
          publicationKey(),
        ),
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: tamperedArtifact,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          key(),
          publicationKey(),
        ),
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor:
              foreignRate.verifiedSuccessor.predecessor,
          },
          key(),
          publicationKey(),
        ),
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: nonterminalArtifact,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          key(),
          publicationKey(),
        ),
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          new Uint8Array(32).fill(12),
          publicationKey(),
        ),
      () =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor,
          },
          key(),
          new Uint8Array(32).fill(12),
        ),
    ]
    for (const attempt of attempts) {
      expect(attempt).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )
    }
  })

  test('rejects every terminal rate-predecessor binding field mismatch', () => {
    const collector = createCollector('lease-expiry-takeover', 87)
    const { artifact, expectedRatePredecessor } =
      finalizeTerminalCollector(collector, 87)
    const mismatches = [
      Object.freeze({
        ...expectedRatePredecessor,
        authenticationKeyFingerprint: digest('foreign-rate-key'),
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        segmentLocatorDigest: digest('foreign-rate-locator'),
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        segmentOrdinal: expectedRatePredecessor.segmentOrdinal + 1,
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        eventCount: 1,
        firstCommittedEventSequence: 1,
        lastCommittedEventSequence: 1,
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        firstCommittedEventSequence: 1,
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        lastCommittedEventSequence: 1,
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        terminalRecordMac: digest('foreign-rate-terminal-mac'),
      }),
      Object.freeze({
        ...expectedRatePredecessor,
        segmentDigest: digest('foreign-rate-segment'),
      }),
    ] satisfies readonly WorkspaceSearchMigrationRehearsalVerifiedRateSegment[]
    for (const expectedRatePredecessorMismatch of mismatches) {
      expect(() =>
        finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
          {
            artifact: {
              artifactBytes: artifact.canonicalBytes,
              expectedContext: artifact.context,
            },
            expectedRatePredecessor: expectedRatePredecessorMismatch,
          },
          key(),
          publicationKey(),
        )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    }
  })

  test('rejects cloned, proxied, forged, and reused terminal capabilities', () => {
    const collector = createCollector('transaction-response-loss', 85)
    const { artifact, expectedRatePredecessor } =
      finalizeTerminalCollector(collector, 85)
    const capability =
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        {
          artifact: {
            artifactBytes: artifact.canonicalBytes,
            expectedContext: artifact.context,
          },
          expectedRatePredecessor,
        },
        key(),
        publicationKey(),
      )
    const structuralClone = Object.freeze({ ...capability })
    const proxied = new Proxy(capability, Object.freeze({}))

    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        structuralClone,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        proxied,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      new WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        Symbol('forged-terminal-capability'),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
      capability,
    )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        capability,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('returns nonzero measured terminal failures without overwriting them', () => {
    const finalized = finalizeCollector(
      createCollector('transaction-response-loss', 2, true),
    )
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        key(),
        publicationKey(),
      )
    expect(binding.duplicateApplyCount).toBe(1)
    expect(binding.lostItemCount).toBe(1)
    expect(binding.orphanAuthorityCount).toBe(1)
    expect(binding.markerSummary.duplicateCount).toBe(1)
    expect(binding.sourceTargetSummary.lostCount).toBe(1)
    expect(binding.authoritySummary.orphanCount).toBe(1)
  })

  test('rejects wrong keys, noncanonical bytes, extra keys, and tampering', () => {
    const finalized = finalizeCollector(
      createCollector('cursor-before-commit-kill', 3),
    )
    const wrongKey = new Uint8Array(32).fill(12)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        wrongKey,
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(wrongKey.every((byte) => byte === 0)).toBe(true)

    const wrongPublicationKey = new Uint8Array(32).fill(12)
    const runtimeVerificationKey = key()
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        runtimeVerificationKey,
        wrongPublicationKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(runtimeVerificationKey.every((byte) => byte === 0)).toBe(true)
    expect(wrongPublicationKey.every((byte) => byte === 0)).toBe(true)

    const text = new TextDecoder().decode(finalized.canonicalBytes)
    const noncanonical = new TextEncoder().encode(` ${text}`)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: noncanonical,
          expectedContext: finalized.context,
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')

    const extra = mutateCanonicalArtifact(
      finalized.canonicalBytes,
      (record) => {
        record.unexpected = true
      },
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        { artifactBytes: extra, expectedContext: finalized.context },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')

    const tampered = new TextEncoder().encode(
      text.replace(finalized.context.planDigest, digest('tampered-plan')),
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        { artifactBytes: tampered, expectedContext: finalized.context },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('rejects aliased or equal runtime and publication keys at every boundary', () => {
    const collector = createCollector('happy-path-verified', 33)
    const aliasedSigningKey = key()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: collector,
          rate: createRateInput(collector.context, 33),
        },
        aliasedSigningKey,
        aliasedSigningKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(aliasedSigningKey.every((byte) => byte === 0)).toBe(true)

    const equalRuntimeSigningKey = key()
    const equalPublicationSigningKey = key()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: collector,
          rate: createRateInput(collector.context, 34),
        },
        equalRuntimeSigningKey,
        equalPublicationSigningKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(equalRuntimeSigningKey.every((byte) => byte === 0)).toBe(true)
    expect(equalPublicationSigningKey.every((byte) => byte === 0)).toBe(true)

    const finalized = finalizeCollector(collector)
    const aliasedVerificationKey = key()
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        aliasedVerificationKey,
        aliasedVerificationKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(aliasedVerificationKey.every((byte) => byte === 0)).toBe(true)

    const equalRuntimeVerificationKey = key()
    const equalPublicationVerificationKey = key()
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: finalized.canonicalBytes,
          expectedContext: finalized.context,
        },
        equalRuntimeVerificationKey,
        equalPublicationVerificationKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(equalRuntimeVerificationKey.every((byte) => byte === 0)).toBe(true)
    expect(equalPublicationVerificationKey.every((byte) => byte === 0)).toBe(
      true,
    )

    const batch = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS
      .map((scenario, index) =>
        finalizeCollector(createCollector(scenario, index + 100)))
      .map((artifact) => Object.freeze({
        artifactBytes: artifact.canonicalBytes,
        expectedContext: artifact.context,
      }))
    const aliasedBatchKey = key()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence(
        { artifacts: batch },
        aliasedBatchKey,
        aliasedBatchKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(aliasedBatchKey.every((byte) => byte === 0)).toBe(true)

    const equalBatchRuntimeKey = key()
    const equalBatchPublicationKey = key()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence(
        { artifacts: batch },
        equalBatchRuntimeKey,
        equalBatchPublicationKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(equalBatchRuntimeKey.every((byte) => byte === 0)).toBe(true)
    expect(equalBatchPublicationKey.every((byte) => byte === 0)).toBe(true)
  })

  test('rejects rate evidence authenticated by a foreign runtime key', () => {
    const collector = createCollector('happy-path-verified', 35)
    const runtimeSigningKey = key()
    const publicationSigningKey = publicationKey()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: collector,
          rate: createRateInput(
            collector.context,
            35,
            new Uint8Array(32).fill(75),
          ),
        },
        runtimeSigningKey,
        publicationSigningKey,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(runtimeSigningKey.every((byte) => byte === 0)).toBe(true)
    expect(publicationSigningKey.every((byte) => byte === 0)).toBe(true)

    const validArtifact = finalizeCollector(
      createCollector('happy-path-verified', 36),
    )
    const foreignRate =
      finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
        createRateInput(
          validArtifact.context,
          36,
          new Uint8Array(32).fill(75),
        ),
      )
    const maliciousArtifact = rewrapReconciliationAuditWithRate(
      validArtifact.canonicalBytes,
      foreignRate,
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: maliciousArtifact,
          expectedContext: validArtifact.context,
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('rejects malformed collector arithmetic and aggregate equality', () => {
    const collector = createCollector('happy-path-verified', 4)
    const badArithmetic = Object.freeze({
      ...collector,
      markerSummary: Object.freeze({
        ...collector.markerSummary,
        observedCount: collector.markerSummary.observedCount + 1,
      }),
    })
    const arithmeticKey = key()
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: badArithmetic,
          rate: createRateInput(badArithmetic.context, 4),
        },
        arithmeticKey,
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(arithmeticKey.every((byte) => byte === 0)).toBe(true)

    const badAggregate = Object.freeze({
      ...collector,
      sourceTargetSummary: Object.freeze({
        ...collector.sourceTargetSummary,
        observedAggregateDigest: digest('different-with-zero-failures'),
      }),
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          collectorResult: badAggregate,
          rate: createRateInput(badAggregate.context, 5),
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('rejects cross-scenario and cross-run-root context replay', () => {
    const happy = finalizeCollector(
      createCollector('happy-path-verified', 5),
    )
    const cursor = finalizeCollector(
      createCollector('cursor-after-commit-kill', 6),
    )
    const otherHappy = finalizeCollector(
      createCollector('happy-path-verified', 7),
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: happy.canonicalBytes,
          expectedContext: cursor.context,
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        {
          artifactBytes: happy.canonicalBytes,
          expectedContext: otherHappy.context,
        },
        key(),
        publicationKey(),
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('authenticates the exact ordered eight-scenario batch and consumes once', () => {
    const finalized = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS
      .map((scenario, index) =>
        finalizeCollector(createCollector(scenario, index + 20)))
    const batchKey = key()
    const batchPublicationKey = publicationKey()
    const capability =
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
        artifacts: finalized.map((artifact) => Object.freeze({
          artifactBytes: artifact.canonicalBytes,
          expectedContext: artifact.context,
        })),
      }, batchKey, batchPublicationKey)
    expect(batchKey.every((byte) => byte === 0)).toBe(true)
    expect(batchPublicationKey.every((byte) => byte === 0)).toBe(true)
    const bindings =
      consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence(
        capability,
      )
    expect(bindings.map((binding) => binding.scenario)).toEqual(
      [...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS],
    )
    expect(Object.isFrozen(bindings)).toBe(true)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence(
        capability,
      )).toThrow('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
  })

  test('rejects every nonzero discrepancy from an authenticated batch', () => {
    const failedCollectors = Object.freeze([
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        80,
        'marker-duplicate',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        81,
        'marker-missing',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        82,
        'marker-unexpected',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        83,
        'authority-missing',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        84,
        'authority-orphan',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        85,
        'source-lost',
      ),
      createCollectorWithDiscrepancy(
        'happy-path-verified',
        86,
        'source-unexpected',
      ),
    ])
    for (let failedIndex = 0; failedIndex < failedCollectors.length;
      failedIndex += 1) {
      const failedCollector = failedCollectors[failedIndex]
      if (failedCollector === undefined) {
        throw new Error('Expected failed collector fixture.')
      }
      const finalized =
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS
          .map((scenario, scenarioIndex) => finalizeCollector(
            scenarioIndex === 0
              ? failedCollector
              : createCollector(
                scenario,
                100 + failedIndex * 10 + scenarioIndex,
              ),
          ))
      expect(() =>
        finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
          artifacts: finalized.map((artifact) => Object.freeze({
            artifactBytes: artifact.canonicalBytes,
            expectedContext: artifact.context,
          })),
        }, key(), publicationKey())).toThrow(
          'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
        )
    }
  })

  test('rejects missing, duplicate, reordered, and terminal-root replay batches', () => {
    const finalized = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS
      .map((scenario, index) =>
        finalizeCollector(createCollector(scenario, index + 40)))
    const expectations = finalized.map((artifact) => Object.freeze({
      artifactBytes: artifact.canonicalBytes,
      expectedContext: artifact.context,
    }))
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
        artifacts: expectations.slice(0, 7),
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
        artifacts: [expectations[1], expectations[0], ...expectations.slice(2)],
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
        artifacts: [expectations[0], expectations[0], ...expectations.slice(2)],
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )

    const replayRoot = finalized[0]?.context.terminalRootDigest
    if (replayRoot === undefined) throw new Error('Expected first root.')
    const replayedSecond = finalizeCollector(createCollector(
      'cursor-before-commit-kill',
      99,
      false,
      replayRoot,
    ))
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
        artifacts: [
          expectations[0],
          Object.freeze({
            artifactBytes: replayedSecond.canonicalBytes,
            expectedContext: replayedSecond.context,
          }),
          ...expectations.slice(2),
        ],
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )
  })

  test('rejects #163 bindings that predate the terminal or lose preimage equality', () => {
    const collector = createCollector('happy-path-verified', 70)
    if (collector.integrity.kind !== 'verified-result') {
      throw new Error('Expected verified integrity fixture.')
    }
    const staleIntegrity = Object.freeze({
      ...collector.integrity,
      completedAt: terminalAt,
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact({
        collectorResult: Object.freeze({
          ...collector,
          integrity: staleIntegrity,
        }),
        rate: createRateInput(collector.context, 70),
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )

    const rollback = createCollector('partial-apply-rollback', 71)
    if (rollback.integrity.kind !== 'rollback-comparison') {
      throw new Error('Expected rollback integrity fixture.')
    }
    const unequal = Object.freeze({
      ...rollback.integrity,
      targetRestoredAggregateDigest: digest('not-the-preimage'),
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact({
        collectorResult: Object.freeze({
          ...rollback,
          integrity: unequal,
        }),
        rate: createRateInput(rollback.context, 71),
      }, key(), publicationKey())).toThrow(
        'REHEARSAL_RECONCILIATION_AUDIT_INVALID',
      )
  })
})
