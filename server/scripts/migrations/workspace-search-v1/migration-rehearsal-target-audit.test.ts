import { createHash, createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  runCrossDomainIntegrityCheck,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
} from './migration-rehearsal-evidence-aws'
import {
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  type WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
} from './migration-rehearsal-integrity-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  collectWorkspaceSearchMigrationRehearsalTargetAudit,
  consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding,
  WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
  type AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput,
  type CollectWorkspaceSearchMigrationRehearsalTargetAuditInput,
  type FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput,
  type WorkspaceSearchMigrationRehearsalCollectedTargetAudit,
  type WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding,
  type WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact,
  type WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding,
  type WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  type WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditSession,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

const targetAuditKey = new Uint8Array(32).fill(91)
const targetAuditPublicationKey = new Uint8Array(32).fill(93)
/** Dedicated #163 HMAC key used by live preimage fixtures. */
const integrityDigestKey = new Uint8Array(32).fill(73)
/** Fixed physical-resource identities carried by every live preimage fixture. */
const integrityResourceIdentities: readonly CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => Object.freeze({
    target,
    identityDigest: digest(`integrity-resource:${target}`),
  }))
/** Exact keyed resource identity expected by target-preimage fixtures. */
const integrityResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    integrityResourceIdentities,
    integrityDigestKey,
  )
const partialTerminal:
  WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding = {
    scenario: 'partial-apply-rollback',
    kind: 'rolled-back',
    version: 2,
    rootDigest: digest('partial-terminal-root'),
    applyStartedAt: '2026-08-01T00:30:00.000Z',
    terminalAt: '2026-08-01T00:45:00.000Z',
  }
const completeTerminal:
  WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding = {
    scenario: 'complete-apply-rollback',
    kind: 'rolled-back',
    version: 1,
    rootDigest: digest('complete-terminal-root'),
    applyStartedAt: '2026-08-01T02:30:00.000Z',
    terminalAt: '2026-08-01T03:00:00.000Z',
  }

/** Exact four authenticated artifacts used by rollback finalization tests. */
type TargetAuditArtifactSet = {
  /** Authenticated committed-prefix preimage artifact. */
  readonly partialPreimage:
    WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  /** Authenticated post-committed-prefix-rollback artifact. */
  readonly partialRestored:
    WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  /** Authenticated complete-plan preimage artifact. */
  readonly completePreimage:
    WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  /** Authenticated post-complete-plan-rollback artifact. */
  readonly completeRestored:
    WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
}

/** Complete parent expectation for one genuine preimage commit-gate test. */
type TargetPreimageGateFixture = {
  /** Canonical dual-key target-audit artifact. */
  readonly artifact:
    WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  /** Independently authenticated full artifact binding. */
  readonly authenticatedBinding:
    WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
  /** Exact public input accepted by the preimage gate finalizer. */
  readonly input:
    FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput
}

/** Creates one deterministic fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns whether one transferred key was entirely overwritten. */
function isZeroized(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0)
}

/**
 * Authenticates one passing live #163 result completed no later than a target scan.
 *
 * @param observedAt - Canonical completion time of the following target audit.
 * @returns Genuine one-shot #163 preimage capability.
 */
async function createIntegrityPreimageCapability(
  observedAt: string,
): Promise<WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability> {
  const startedAt = new Date(Date.parse(observedAt) - 1_000).toISOString()
  const result = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    deadline: createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds: 60_000,
      monotonicClock: () => 1_000,
    }),
    role: 'source',
    checkedAt: observedAt,
    observationMode: 'migration-rehearsal-live',
    liveRuntimeObservation: {
      startedAt,
      completedAt: observedAt,
    },
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    digestKey: integrityDigestKey,
    resourceBindingDigest:
      calculateCrossDomainIntegrityResourceBindingDigest(),
    resourceIdentities: integrityResourceIdentities,
    resourceIdentityDigest: integrityResourceIdentityDigest,
    limits: {
      pageSize: 100,
      maxPages: 10,
      maxItems: 1_000,
    },
    reader: {
      readPage: async () => ({ items: [] }),
    },
  })
  const resultBytes = new TextEncoder().encode(
    `${JSON.stringify(result, undefined, 2)}\n`,
  )
  return authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
    {
      resultBytes,
      expectedResourceIdentityDigest: integrityResourceIdentityDigest,
      clock: () => new Date(observedAt),
    },
    new Uint8Array(integrityDigestKey),
  )
}

describe('Workspace Search migration rehearsal target audit', () => {
  test('collects a real complete scan and emits only contextual authenticated canonical bytes', async () => {
    const firstItem = createOwnedDocumentItem('owned')
    const secondItem = createIgnoredItem('ignored')
    const audit = await collectWithPages(
      [
        {
          items: [firstItem],
          lastEvaluatedKey: createItemCursor(firstItem),
        },
        { items: [secondItem] },
      ],
      '2026-08-01T00:00:00.000Z',
      'first',
    )

    expect(Object.isFrozen(audit)).toBe(true)
    expect(JSON.stringify(audit)).toBe('{}')
    const context = createTargetContext('partial-apply-rollback', 'first')
    const ownedKey = new Uint8Array(targetAuditKey)
    const ownedPublicationKey = new Uint8Array(targetAuditPublicationKey)
    const integrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )
    const artifact =
      finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          audit,
          context,
          integrityBefore,
          purpose: 'partial-rollback-preimage',
          rate: createRateInput(context, 'first'),
          terminal: null,
        },
        ownedKey,
        ownedPublicationKey,
      )
    expect(isZeroized(ownedKey)).toBe(true)
    expect(isZeroized(ownedPublicationKey)).toBe(true)
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(artifact.byteLength).toBe(artifact.canonicalBytes.byteLength)
    expect(artifact.contentDigest).toBe(
      createHash('sha256').update(artifact.canonicalBytes).digest('hex'),
    )
    const text = new TextDecoder().decode(artifact.canonicalBytes)
    const parsed: unknown = JSON.parse(text)
    expect(serializeCanonicalJson(parsed)).toBe(text)
    expect(parsed).toMatchObject({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
      purpose: 'partial-rollback-preimage',
      observedAt: '2026-08-01T00:00:00.000Z',
      commit: 'a'.repeat(40),
      evidenceKeyDigest:
        createHash('sha256').update(targetAuditKey).digest('hex'),
      terminal: null,
      aggregate: {
        scanned: 2,
        owned: 1,
        ignored: 1,
        pageCount: 2,
      },
      authentication: {
        algorithm: 'HMAC-SHA-256',
      },
    })
    for (const forbidden of [
      'workspace-1',
      'table-workspace-search',
      'runId',
      'cursor',
    ]) {
      expect(text).not.toContain(forbidden)
    }
    const replayKey = new Uint8Array(targetAuditKey)
    const replayPublicationKey = new Uint8Array(targetAuditPublicationKey)
    const replayIntegrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )
    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit,
        context,
        integrityBefore: replayIntegrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(context, 'first-replay'),
        terminal: null,
      },
      replayKey,
      replayPublicationKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(replayKey)).toBe(true)
    expect(isZeroized(replayPublicationKey)).toBe(true)
  })

  test('authenticates one canonical artifact into an immutable exact binding', async () => {
    const artifact = await createArtifact(
      [{ items: [createIgnoredItem('authenticated')] }],
      '2026-08-01T01:00:00.000Z',
      'shared-session',
      'partial-rollback-restored',
      partialTerminal,
    )
    const context = createTargetContext(
      'partial-apply-rollback',
      'shared-session',
    )
    const verificationKey = new Uint8Array(targetAuditKey)
    const publicationVerificationKey =
      new Uint8Array(targetAuditPublicationKey)

    const binding =
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes: artifact.canonicalBytes,
          expectedContext: context,
          purpose: 'partial-rollback-restored',
          terminal: partialTerminal,
        },
        verificationKey,
        publicationVerificationKey,
      )

    expect(isZeroized(verificationKey)).toBe(true)
    expect(isZeroized(publicationVerificationKey)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.terminal)).toBe(true)
    expect(Object.isFrozen(binding.aggregate)).toBe(true)
    expect(binding).toMatchObject({
      contentDigest: artifact.contentDigest,
      byteLength: artifact.byteLength,
      purpose: 'partial-rollback-restored',
      startedAt: '2026-08-01T01:00:00.000Z',
      observedAt: '2026-08-01T01:00:00.000Z',
      commit: 'a'.repeat(40),
      evidenceKeyDigest:
        createHash('sha256').update(targetAuditKey).digest('hex'),
      terminal: partialTerminal,
      aggregate: {
        scanned: 1,
        owned: 0,
        ignored: 1,
        pageCount: 1,
      },
    })
    expect(Reflect.set(binding.aggregate, 'scanned', 999)).toBe(false)
    expect(binding.aggregate.scanned).toBe(1)
    const secondBinding =
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes: artifact.canonicalBytes,
          expectedContext: context,
          purpose: 'partial-rollback-restored',
          terminal: partialTerminal,
        },
        new Uint8Array(targetAuditKey),
        new Uint8Array(targetAuditPublicationKey),
      )
    expect(secondBinding.aggregate).toEqual(binding.aggregate)
    expect(secondBinding.aggregate).not.toBe(binding.aggregate)
    expect(Object.keys(binding).sort()).toEqual([
      'aggregate',
      'aggregateDigest',
      'byteLength',
      'commit',
      'configurationHash',
      'contentDigest',
      'context',
      'evidenceKeyDigest',
      'integrityBefore',
      'observationDigest',
      'observedAt',
      'purpose',
      'rate',
      'sourceResourceBindingDigest',
      'sourceSessionBindingDigest',
      'startedAt',
      'terminal',
    ])
  })

  test('rejects target reads that cross a terminal or begin before their integrity preimage', async () => {
    for (const targetStartedAt of [
      partialTerminal.terminalAt,
      '2026-08-01T00:44:59.000Z',
    ]) {
      const audit = await collectWithPagesBetween(
        [{ items: [] }],
        targetStartedAt,
        '2026-08-01T00:45:01.000Z',
        `restored-window:${targetStartedAt}`,
      )
      const context = createTargetContext(
        'partial-apply-rollback',
        `restored-window:${targetStartedAt}`,
      )
      const runtimeKey = new Uint8Array(targetAuditKey)
      const publicationKey = new Uint8Array(targetAuditPublicationKey)
      expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          audit,
          context,
          integrityBefore: null,
          purpose: 'partial-rollback-restored',
          rate: createRateInput(context, `restored-window:${targetStartedAt}`),
          terminal: partialTerminal,
        },
        runtimeKey,
        publicationKey,
      )).toThrow('Workspace Search migration rehearsal target audit failed.')
      expect(isZeroized(runtimeKey)).toBe(true)
      expect(isZeroized(publicationKey)).toBe(true)
    }

    const preimageAudit = await collectWithPagesBetween(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:10.000Z',
      'integrity-target-window',
    )
    const preimageContext = createTargetContext(
      'partial-apply-rollback',
      'integrity-target-window',
    )
    const lateIntegrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:05.000Z',
    )
    const runtimeKey = new Uint8Array(targetAuditKey)
    const publicationKey = new Uint8Array(targetAuditPublicationKey)
    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit: preimageAudit,
        context: preimageContext,
        integrityBefore: lateIntegrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(preimageContext, 'integrity-target-window'),
        terminal: null,
      },
      runtimeKey,
      publicationKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(runtimeKey)).toBe(true)
    expect(isZeroized(publicationKey)).toBe(true)
  })

  test('rejects artifact tampering, wrong keys, purpose or terminal replay, and extras while zeroizing keys', async () => {
    const artifacts = await createArtifactSet(
      [{ items: [createIgnoredItem('same')] }],
      [{ items: [createIgnoredItem('same')] }],
      [{ items: [createIgnoredItem('same')] }],
    )
    const preimageText = new TextDecoder().decode(
      artifacts.partialPreimage.canonicalBytes,
    )
    const tamperedBytes = new TextEncoder().encode(
      preimageText.replace(
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.001Z',
      ),
    )
    const candidates: unknown[] = [
      {
        artifactBytes: tamperedBytes,
        purpose: 'preimage',
        terminal: null,
      },
      {
        artifactBytes: artifacts.partialPreimage.canonicalBytes,
        purpose: 'partial-rollback-restored',
        terminal: partialTerminal,
      },
      {
        artifactBytes: artifacts.partialRestored.canonicalBytes,
        purpose: 'partial-rollback-restored',
        terminal: {
          ...partialTerminal,
          rootDigest: digest('replayed-terminal-root'),
        },
      },
      {
        artifactBytes: artifacts.completeRestored.canonicalBytes,
        purpose: 'partial-rollback-restored',
        terminal: partialTerminal,
      },
      {
        artifactBytes: artifacts.partialPreimage.canonicalBytes,
        purpose: 'partial-rollback-preimage',
        terminal: null,
        extra: true,
      },
    ]
    for (const candidate of candidates) {
      const verificationKey = new Uint8Array(targetAuditKey)
      const publicationVerificationKey =
        new Uint8Array(targetAuditPublicationKey)
      expect(() =>
        authenticateArtifactUnknown(
          candidate,
          verificationKey,
          publicationVerificationKey,
        )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
      expect(isZeroized(verificationKey)).toBe(true)
      expect(isZeroized(publicationVerificationKey)).toBe(true)
    }

    const foreignKey = new Uint8Array(32).fill(92)
    const validPublicationKey = new Uint8Array(targetAuditPublicationKey)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes: artifacts.partialPreimage.canonicalBytes,
          expectedContext: createTargetContext(
            'partial-apply-rollback',
            'shared-session',
          ),
          purpose: 'partial-rollback-preimage',
          terminal: null,
        },
        foreignKey,
        validPublicationKey,
      )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
    expect(isZeroized(foreignKey)).toBe(true)
    expect(isZeroized(validPublicationKey)).toBe(true)
  })

  test('issues full one-shot planning gates for both rollback preimages', async () => {
    const scenarios: readonly (
      | 'complete-apply-rollback'
      | 'partial-apply-rollback'
    )[] = [
      'partial-apply-rollback',
      'complete-apply-rollback',
    ]
    for (const scenario of scenarios) {
      const fixture = await createTargetPreimageGateFixture(
        scenario,
        `valid-gate:${scenario}`,
      )
      const runtimeKey = new Uint8Array(targetAuditKey)
      const publicationKey = new Uint8Array(targetAuditPublicationKey)
      const capability =
        finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
          fixture.input,
          runtimeKey,
          publicationKey,
        )

      expect(isZeroized(runtimeKey)).toBe(true)
      expect(isZeroized(publicationKey)).toBe(true)
      expect(Object.isFrozen(capability)).toBe(true)
      expect(JSON.stringify(capability)).toBe('{}')
      const binding =
        readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
          capability,
        )
      expect(Object.isFrozen(binding)).toBe(true)
      expect(binding).toMatchObject({
        contentDigest: fixture.artifact.contentDigest,
        byteLength: fixture.artifact.byteLength,
        purpose: scenario === 'partial-apply-rollback'
          ? 'partial-rollback-preimage'
          : 'complete-rollback-preimage',
        terminal: null,
        observedAt: fixture.authenticatedBinding.observedAt,
        commit: fixture.authenticatedBinding.commit,
        configurationHash: fixture.authenticatedBinding.configurationHash,
        evidenceKeyDigest: fixture.authenticatedBinding.evidenceKeyDigest,
        sourceSessionBindingDigest:
          fixture.authenticatedBinding.sourceSessionBindingDigest,
        sourceResourceBindingDigest:
          fixture.authenticatedBinding.sourceResourceBindingDigest,
        aggregateDigest: fixture.authenticatedBinding.aggregateDigest,
        observationDigest: fixture.authenticatedBinding.observationDigest,
        prospectivePlanningReceiptDigest:
          fixture.input.expectedProspectivePlanningReceiptDigest,
        expectedPlanningReceiptCompletedAt:
          fixture.input.expectedPlanningReceiptCompletedAt,
        commitGateObservedAt: fixture.input.commitGateObservedAt,
      })
      expect(binding.context).toEqual(
        fixture.authenticatedBinding.context,
      )
      expect(binding.aggregate).toEqual(
        fixture.authenticatedBinding.aggregate,
      )
      expect(binding.rate).toEqual(fixture.authenticatedBinding.rate)
      expect(binding.contextDigest).toBe(createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-target-preimage-context',
        version: 1,
        context: fixture.authenticatedBinding.context,
      }))
      const { bindingDigest, ...bindingWithoutDigest } = binding
      expect(bindingDigest).toBe(createMigrationDigest({
        kind:
          'workspace-search-migration-rehearsal-target-preimage-evidence-binding',
        version: 1,
        binding: bindingWithoutDigest,
      }))
      expect(
        consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
          capability,
        ),
      ).toBe(binding)
      expect(() =>
        readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
          capability,
        )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
      expect(() =>
        consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
          capability,
        )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
    }
  })

  test('rejects restored purpose, terminal, scenario, context, and prospective receipt substitution', async () => {
    const fixture = await createTargetPreimageGateFixture(
      'partial-apply-rollback',
      'context-gate',
    )
    const context = fixture.input.artifact.expectedContext
    const contextCandidates = [
      { ...context, scenario: 'complete-apply-rollback' },
      { ...context, runLocatorDigest: digest('foreign-run') },
      { ...context, manifestDigest: digest('foreign-manifest') },
      { ...context, permitDigest: digest('foreign-permit') },
      {
        ...context,
        requestedResourcesBinding: digest('foreign-resources'),
      },
      {
        ...context,
        configurationBindingDigest: digest('foreign-configuration'),
      },
      {
        ...context,
        planningReceiptDigest: digest('foreign-planning-receipt'),
      },
      {
        ...context,
        executionBoundaryDigest: digest('foreign-execution-boundary'),
      },
      {
        ...context,
        sealedPlanningAuthorityDigest: digest('foreign-sealed-authority'),
      },
      { ...context, planDigest: digest('foreign-plan') },
      { ...context, writerFenceDigest: digest('foreign-writer-fence') },
    ]
    for (const expectedContext of contextCandidates) {
      expectTargetPreimageGateFailure({
        ...fixture.input,
        artifact: {
          ...fixture.input.artifact,
          expectedContext,
        },
        expectedProspectivePlanningReceiptDigest:
          expectedContext.planningReceiptDigest,
      })
    }
    for (const candidate of [
      {
        ...fixture.input,
        artifact: {
          ...fixture.input.artifact,
          purpose: 'partial-rollback-restored',
          terminal: partialTerminal,
        },
      },
      {
        ...fixture.input,
        artifact: {
          ...fixture.input.artifact,
          terminal: partialTerminal,
        },
      },
      {
        ...fixture.input,
        artifact: {
          ...fixture.input.artifact,
          purpose: 'complete-rollback-preimage',
        },
      },
      {
        ...fixture.input,
        expectedProspectivePlanningReceiptDigest:
          digest('substituted-prospective-receipt'),
      },
      { ...fixture.input, extra: true },
    ]) expectTargetPreimageGateFailure(candidate)
  })

  test('requires every exact field of the planning-child rate predecessor', async () => {
    const fixture = await createTargetPreimageGateFixture(
      'complete-apply-rollback',
      'rate-predecessor-gate',
    )
    const predecessor = fixture.input.expectedRatePredecessor
    if (
      predecessor.firstCommittedEventSequence === null ||
      predecessor.lastCommittedEventSequence === null
    ) throw new Error('Expected a nonempty predecessor fixture.')
    const candidates = [
      {
        ...predecessor,
        authenticationKeyFingerprint: digest('foreign-rate-key'),
      },
      {
        ...predecessor,
        segmentLocatorDigest: digest('foreign-rate-locator'),
      },
      { ...predecessor, segmentOrdinal: predecessor.segmentOrdinal + 2 },
      { ...predecessor, eventCount: predecessor.eventCount + 1 },
      {
        ...predecessor,
        firstCommittedEventSequence:
          predecessor.firstCommittedEventSequence + 1,
      },
      {
        ...predecessor,
        lastCommittedEventSequence:
          predecessor.lastCommittedEventSequence + 1,
      },
      {
        ...predecessor,
        terminalRecordMac: digest('foreign-terminal-record-mac'),
      },
      { ...predecessor, segmentDigest: digest('foreign-segment') },
    ]
    for (const expectedRatePredecessor of candidates) {
      expectTargetPreimageGateFailure({
        ...fixture.input,
        expectedRatePredecessor,
      })
    }
  })

  test('enforces planning, observation, rate-close, and commit-gate time order', async () => {
    const fixture = await createTargetPreimageGateFixture(
      'partial-apply-rollback',
      'time-gate',
    )
    expectTargetPreimageGateFailure({
      ...fixture.input,
      expectedPlanningReceiptCompletedAt: '2026-08-01T00:00:00.001Z',
    })
    expectTargetPreimageGateFailure({
      ...fixture.input,
      commitGateObservedAt: '2026-08-02T23:59:59.999Z',
    })
    expectTargetPreimageGateFailure({
      ...fixture.input,
      artifact: {
        ...fixture.input.artifact,
        artifactBytes: rewrapTargetAuditWithRate(
          fixture.artifact.canonicalBytes,
          {
            ...fixture.authenticatedBinding.rate,
            completedAt: '2026-07-31T23:59:59.999Z',
          },
        ),
      },
    })

    const integrityBefore = fixture.authenticatedBinding.integrityBefore
    if (integrityBefore === null) {
      throw new Error('Expected a live target-preimage integrity result.')
    }
    const equalityCapability =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        {
          ...fixture.input,
          expectedPlanningReceiptCompletedAt:
            integrityBefore.runtimeProvenance.startedAt,
          commitGateObservedAt:
            fixture.authenticatedBinding.rate.completedAt,
        },
        new Uint8Array(targetAuditKey),
        new Uint8Array(targetAuditPublicationKey),
      )
    expect(
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        equalityCapability,
      ).commitGateObservedAt,
    ).toBe(fixture.authenticatedBinding.rate.completedAt)
  })

  test('rejects tampered artifacts, foreign keys, clones, proxies, and reuse', async () => {
    const fixture = await createTargetPreimageGateFixture(
      'complete-apply-rollback',
      'authenticity-gate',
    )
    const text = new TextDecoder().decode(fixture.artifact.canonicalBytes)
    expectTargetPreimageGateFailure({
      ...fixture.input,
      artifact: {
        ...fixture.input.artifact,
        artifactBytes: new TextEncoder().encode(
          text.replace(
            fixture.authenticatedBinding.observedAt,
            '2026-08-01T02:00:00.001Z',
          ),
        ),
      },
    })
    expectTargetPreimageGateFailure(
      fixture.input,
      new Uint8Array(32).fill(92),
      new Uint8Array(targetAuditPublicationKey),
    )
    expectTargetPreimageGateFailure(
      fixture.input,
      new Uint8Array(targetAuditKey),
      new Uint8Array(32).fill(92),
    )
    expectTargetPreimageGateFailure({
      ...fixture.input,
      artifact: {
        ...fixture.input.artifact,
        artifactBytes: new Proxy(fixture.artifact.canonicalBytes, {}),
      },
    })
    const aliasedKey = new Uint8Array(targetAuditKey)
    expect(() => finalizeTargetPreimageUnknown(
      fixture.input,
      aliasedKey,
      aliasedKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(aliasedKey)).toBe(true)

    const capability =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        fixture.input,
        new Uint8Array(targetAuditKey),
        new Uint8Array(targetAuditPublicationKey),
      )
    const proxied = new Proxy(capability, {})
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        proxied,
      )).toThrow(
      'Workspace Search migration rehearsal target audit failed.',
    )
    const cloned = structuredClone(capability)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        cloned,
      )).toThrow(
      'Workspace Search migration rehearsal target audit failed.',
    )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        {},
      )).toThrow(
      'Workspace Search migration rehearsal target audit failed.',
    )
    expect(() =>
      new WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        Symbol('foreign-target-preimage'),
      )).toThrow(
      'Workspace Search migration rehearsal target audit failed.',
    )
    expect(
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        capability,
      ).bindingDigest,
    ).toMatch(/^[0-9a-f]{64}$/u)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        capability,
      )).toThrow(
      'Workspace Search migration rehearsal target audit failed.',
    )
  })

  test('rejects wrong artifact signing keys and zeroizes them', async () => {
    const audit = await collectWithPages(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
    )
    const foreignKey = new Uint8Array(32).fill(92)
    const publicationSigningKey = new Uint8Array(targetAuditPublicationKey)
    const context = createTargetContext(
      'partial-apply-rollback',
      'shared-session',
    )
    const integrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )

    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit,
        context,
        integrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(context, 'wrong-runtime-key'),
        terminal: null,
      },
      foreignKey,
      publicationSigningKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(foreignKey)).toBe(true)
    expect(isZeroized(publicationSigningKey)).toBe(true)
  })

  test('rejects rate evidence authenticated by a foreign runtime key', async () => {
    const audit = await collectWithPages(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
      'foreign-rate-key',
    )
    const context = createTargetContext(
      'partial-apply-rollback',
      'foreign-rate-key',
    )
    const runtimeSigningKey = new Uint8Array(targetAuditKey)
    const publicationSigningKey =
      new Uint8Array(targetAuditPublicationKey)
    const integrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )
    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit,
        context,
        integrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(
          context,
          'foreign-rate-key',
          new Uint8Array(32).fill(92),
        ),
        terminal: null,
      },
      runtimeSigningKey,
      publicationSigningKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(runtimeSigningKey)).toBe(true)
    expect(isZeroized(publicationSigningKey)).toBe(true)

    const validArtifact = await createArtifact(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
      'foreign-rate-wrapper',
      'partial-rollback-preimage',
      null,
    )
    const validContext = createTargetContext(
      'partial-apply-rollback',
      'foreign-rate-wrapper',
    )
    const foreignRate =
      finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
        createRateInput(
          validContext,
          'foreign-rate-wrapper:foreign',
          new Uint8Array(32).fill(92),
        ),
      )
    const maliciousArtifact = rewrapTargetAuditWithRate(
      validArtifact.canonicalBytes,
      foreignRate,
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes: maliciousArtifact,
          expectedContext: validContext,
          purpose: 'partial-rollback-preimage',
          terminal: null,
        },
        new Uint8Array(targetAuditKey),
        new Uint8Array(targetAuditPublicationKey),
      )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
  })

  test('rejects aliased or equal runtime and publication keys at every boundary', async () => {
    const audit = await collectWithPages(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
    )
    const context = createTargetContext(
      'partial-apply-rollback',
      'shared-session',
    )
    const aliasedSigningKey = new Uint8Array(targetAuditKey)
    const aliasedIntegrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )
    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit,
        context,
        integrityBefore: aliasedIntegrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(context, 'aliased-signing-key'),
        terminal: null,
      },
      aliasedSigningKey,
      aliasedSigningKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(aliasedSigningKey)).toBe(true)

    const equalRuntimeSigningKey = new Uint8Array(targetAuditKey)
    const equalPublicationSigningKey = new Uint8Array(targetAuditKey)
    const equalIntegrityBefore = await createIntegrityPreimageCapability(
      '2026-08-01T00:00:00.000Z',
    )
    expect(() => finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        audit,
        context,
        integrityBefore: equalIntegrityBefore,
        purpose: 'partial-rollback-preimage',
        rate: createRateInput(context, 'equal-signing-keys'),
        terminal: null,
      },
      equalRuntimeSigningKey,
      equalPublicationSigningKey,
    )).toThrow('Workspace Search migration rehearsal target audit failed.')
    expect(isZeroized(equalRuntimeSigningKey)).toBe(true)
    expect(isZeroized(equalPublicationSigningKey)).toBe(true)

    const artifacts = await createArtifactSet(
      [{ items: [] }],
      [{ items: [] }],
      [{ items: [] }],
    )
    const authenticateInput:
      AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput = {
      artifactBytes: artifacts.partialPreimage.canonicalBytes,
      expectedContext: createTargetContext(
        'partial-apply-rollback',
        'partial-session',
      ),
      purpose: 'partial-rollback-preimage',
      terminal: null,
    }
    const aliasedVerificationKey = new Uint8Array(targetAuditKey)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        authenticateInput,
        aliasedVerificationKey,
        aliasedVerificationKey,
      )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
    expect(isZeroized(aliasedVerificationKey)).toBe(true)

    const equalRuntimeVerificationKey = new Uint8Array(targetAuditKey)
    const equalPublicationVerificationKey = new Uint8Array(targetAuditKey)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        authenticateInput,
        equalRuntimeVerificationKey,
        equalPublicationVerificationKey,
      )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
    expect(isZeroized(equalRuntimeVerificationKey)).toBe(true)
    expect(isZeroized(equalPublicationVerificationKey)).toBe(true)

  })

  test('rejects parent permit or requested-resource attribution drift before signing', async () => {
    const audit = await collectWithPages(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
    )
    const context = createTargetContext(
      'partial-apply-rollback',
      'shared-session',
    )
    const candidates = [
      Object.freeze({
        ...context,
        permitDigest: digest('foreign-parent-permit'),
      }),
      Object.freeze({
        ...context,
        requestedResourcesBinding: digest('foreign-parent-resources'),
      }),
    ]
    for (const [index, candidate] of candidates.entries()) {
      const runtimeSigningKey = new Uint8Array(targetAuditKey)
      const publicationSigningKey =
        new Uint8Array(targetAuditPublicationKey)
      const integrityBefore = await createIntegrityPreimageCapability(
        '2026-08-01T00:00:00.000Z',
      )
      expect(() =>
        finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
          {
            audit,
            context: candidate,
            integrityBefore,
            purpose: 'partial-rollback-preimage',
            rate: createRateInput(candidate, `attribution-drift:${index}`),
            terminal: null,
          },
          runtimeSigningKey,
          publicationSigningKey,
        )).toThrow(
          'Workspace Search migration rehearsal target audit failed.',
        )
      expect(isZeroized(runtimeSigningKey)).toBe(true)
      expect(isZeroized(publicationSigningKey)).toBe(true)
    }

    const validArtifact = await createArtifact(
      [{ items: [] }],
      '2026-08-01T00:00:00.000Z',
      'raw-resource-drift',
      'partial-rollback-preimage',
      null,
    )
    const expectedContext = createTargetContext(
      'partial-apply-rollback',
      'raw-resource-drift',
    )
    const maliciousArtifact = rewrapTargetAuditWithResourceBinding(
      validArtifact.canonicalBytes,
      digest('rewrapped-foreign-source-resource'),
    )
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes: maliciousArtifact,
          expectedContext,
          purpose: 'partial-rollback-preimage',
          terminal: null,
        },
        new Uint8Array(targetAuditKey),
        new Uint8Array(targetAuditPublicationKey),
      )).toThrow(
        'Workspace Search migration rehearsal target audit failed.',
      )
  })

  test('fails closed on invalid rows, configuration substitution, and session-binding drift', async () => {
    const invalidRows = await captureFailure(() => collectWithPages(
      [{ items: [createInvalidItem('invalid')] }],
      '2026-08-01T00:00:00.000Z',
    ))
    expect(invalidRows.code).toBe('DRY_RUN_INVALID_ROWS')

    const configuration = createConfiguration()
    let scanCount = 0
    const session = createPageSession([{ items: [] }])
    const countingSession: WorkspaceSearchMigrationRehearsalTargetAuditSession = {
      /** Returns the stable requested-resource binding. */
      readRequestedResourcesBinding: () =>
        session.readRequestedResourcesBinding(),
      /** Returns the stable authenticated evidence-session binding. */
      readRehearsalEvidenceSessionBinding: () =>
        session.readRehearsalEvidenceSessionBinding(),
      /** Records a target scan attempt. */
      scanTargetPage: async (input) => {
        scanCount += 1
        return session.scanTargetPage(input)
      },
    }
    const mismatch = await captureFailure(() =>
      collectWorkspaceSearchMigrationRehearsalTargetAudit({
        session: countingSession,
        configuration,
        configurationHash: 'f'.repeat(64),
        maximumDurationMilliseconds: 60_000,
        maximumPages: 1,
        clock: () => new Date('2026-08-01T00:00:00.000Z'),
        monotonicClock: () => 1_000,
      }),
    )
    expect(mismatch.code).toBe('CONFIGURATION_HASH_MISMATCH')
    expect(scanCount).toBe(0)

    const driftSession = createPageSession(
      [{ items: [] }],
      'shared-session',
      true,
    )
    const drift = await captureFailure(() => collectWithSession(
      driftSession,
      1,
      '2026-08-01T00:00:00.000Z',
    ))
    expect(drift.code).toBe('IDENTITY_MISMATCH')
  })

  test('rejects no-progress pages, cursor cycles, and exhausted page bounds', async () => {
    const firstItem = createIgnoredItem('first')
    const noProgressBase = createPageSession([{
      items: [firstItem],
      lastEvaluatedKey: createItemCursor(firstItem),
    }])
    const noProgressSession: WorkspaceSearchMigrationRehearsalTargetAuditSession = {
      /** Returns the stable requested-resource binding. */
      readRequestedResourcesBinding: () =>
        noProgressBase.readRequestedResourcesBinding(),
      /** Returns the stable authenticated evidence-session binding. */
      readRehearsalEvidenceSessionBinding: () =>
        noProgressBase.readRehearsalEvidenceSessionBinding(),
      /** Returns one valid page followed by a forged no-progress page. */
      scanTargetPage: async (input) => {
        if (input.previousCheckpoint.aggregate.pageCount === 0) {
          return noProgressBase.scanTargetPage(input)
        }
        return {
          checkpoint: {
            ...input.previousCheckpoint,
            cursor: createCursor('different'),
            aggregate: {
              ...input.previousCheckpoint.aggregate,
              pageCount:
                input.previousCheckpoint.aggregate.pageCount + 1,
            },
          },
          targetRows: [],
          invalidRows: [],
          observedTargetBindings: [],
        }
      },
    }
    const noProgress = await captureFailure(() => collectWithSession(
      noProgressSession,
      3,
      '2026-08-01T00:00:00.000Z',
    ))
    expect(noProgress.code).toBe('INVALID_STATE')

    const secondItem = createIgnoredItem('second')
    const cycle = await captureFailure(() => collectWithPages(
      [
        {
          items: [firstItem],
          lastEvaluatedKey: createItemCursor(firstItem),
        },
        {
          items: [secondItem],
          lastEvaluatedKey: createItemCursor(secondItem),
        },
        {
          items: [firstItem],
          lastEvaluatedKey: createItemCursor(firstItem),
        },
      ],
      '2026-08-01T00:00:00.000Z',
    ))
    expect(cycle.code).toBe('INVALID_STATE')

    let scanCount = 0
    const boundedBase = createPageSession([
      {
        items: [firstItem],
        lastEvaluatedKey: createItemCursor(firstItem),
      },
      { items: [secondItem] },
    ])
    const boundedSession: WorkspaceSearchMigrationRehearsalTargetAuditSession = {
      /** Returns the stable requested-resource binding. */
      readRequestedResourcesBinding: () =>
        boundedBase.readRequestedResourcesBinding(),
      /** Returns the stable authenticated evidence-session binding. */
      readRehearsalEvidenceSessionBinding: () =>
        boundedBase.readRehearsalEvidenceSessionBinding(),
      /** Counts reads before delegating to the bounded fixture. */
      scanTargetPage: async (input) => {
        scanCount += 1
        return boundedBase.scanTargetPage(input)
      },
    }
    const exhausted = await captureFailure(() => collectWithSession(
      boundedSession,
      1,
      '2026-08-01T00:00:00.000Z',
    ))
    expect(exhausted.code).toBe('INVALID_STATE')
    expect(scanCount).toBe(1)
  })

  test('enforces the total deadline, aborts a pending page, and rejects clock regression', async () => {
    const base = createPageSession([{ items: [] }])
    let abortObserved = false
    const pendingSession: WorkspaceSearchMigrationRehearsalTargetAuditSession = {
      /** Returns the stable requested-resource binding. */
      readRequestedResourcesBinding: () =>
        base.readRequestedResourcesBinding(),
      /** Returns the stable authenticated evidence-session binding. */
      readRehearsalEvidenceSessionBinding: () =>
        base.readRehearsalEvidenceSessionBinding(),
      /** Waits until the collector's total deadline aborts the page. */
      scanTargetPage: async (_input, signal) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            abortObserved = true
            reject(new Error('untrusted aborted request detail'))
          }, { once: true })
        }),
    }
    const pendingInput = createAuditInput(
      pendingSession,
      1,
      '2026-08-01T00:00:00.000Z',
    )
    const timedOut = await captureFailure(() =>
      collectWorkspaceSearchMigrationRehearsalTargetAudit({
        ...pendingInput,
        maximumDurationMilliseconds: 5,
      }),
    )
    expect(timedOut.code).toBe('INVALID_STATE')
    expect(abortObserved).toBe(true)

    const callerAbortController = new AbortController()
    let callerAbortObserved = false
    const callerAbortSession:
      WorkspaceSearchMigrationRehearsalTargetAuditSession = {
        /** Returns the stable requested-resource binding. */
        readRequestedResourcesBinding: () =>
          base.readRequestedResourcesBinding(),
        /** Returns the stable authenticated evidence-session binding. */
        readRehearsalEvidenceSessionBinding: () =>
          base.readRehearsalEvidenceSessionBinding(),
        /** Deliberately ignores abort completion to exercise the local race. */
        scanTargetPage: async (_input, signal) =>
          await new Promise(() => {
            signal?.addEventListener('abort', () => {
              callerAbortObserved = true
            }, { once: true })
          }),
      }
    const callerAbortInput = createAuditInput(
      callerAbortSession,
      1,
      '2026-08-01T00:00:00.000Z',
    )
    const callerAbortedCollection =
      collectWorkspaceSearchMigrationRehearsalTargetAudit({
        ...callerAbortInput,
        signal: callerAbortController.signal,
      })
    callerAbortController.abort()
    const callerAborted = await captureFailure(
      () => callerAbortedCollection,
    )
    expect(callerAborted.code).toBe('INVALID_STATE')
    expect(callerAbortObserved).toBe(true)

    let oversizedScanCount = 0
    const oversizedSession: WorkspaceSearchMigrationRehearsalTargetAuditSession = {
      ...base,
      /** Counts any page that escaped invalid deadline preflight. */
      scanTargetPage: async (input, signal) => {
        oversizedScanCount += 1
        return await base.scanTargetPage(input, signal)
      },
    }
    const oversizedInput = createAuditInput(
      oversizedSession,
      1,
      '2026-08-01T00:00:00.000Z',
    )
    const oversized = await captureFailure(() =>
      collectWorkspaceSearchMigrationRehearsalTargetAudit({
        ...oversizedInput,
        maximumDurationMilliseconds:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS +
            1,
      }),
    )
    expect(oversized.code).toBe('INVALID_ARGUMENT')
    expect(oversizedScanCount).toBe(0)

    const monotonicSamples = [1_000, 1_001, 999]
    let monotonicSampleIndex = 0
    const regressionInput = createAuditInput(
      base,
      1,
      '2026-08-01T00:00:00.000Z',
    )
    const regression = await captureFailure(() =>
      collectWorkspaceSearchMigrationRehearsalTargetAudit({
        ...regressionInput,
        monotonicClock: () => {
          const sample = monotonicSamples[monotonicSampleIndex]
          monotonicSampleIndex += 1
          return sample ?? 999
        },
      }),
    )
    expect(regression.code).toBe('INVALID_STATE')
  })
})

/** Creates one valid dual-key preimage and its exact parent commit input. */
async function createTargetPreimageGateFixture(
  scenario:
    | 'complete-apply-rollback'
    | 'partial-apply-rollback',
  label: string,
): Promise<TargetPreimageGateFixture> {
  const purpose = scenario === 'partial-apply-rollback'
    ? 'partial-rollback-preimage'
    : 'complete-rollback-preimage'
  const observedAt = scenario === 'partial-apply-rollback'
    ? '2026-08-01T00:00:00.000Z'
    : '2026-08-01T02:00:00.000Z'
  const artifact = await createArtifact(
    [{ items: [createIgnoredItem(`preimage:${label}`)] }],
    observedAt,
    label,
    purpose,
    null,
  )
  const expectedContext = createTargetContext(scenario, label)
  const runtimeKey = new Uint8Array(targetAuditKey)
  const publicationKey = new Uint8Array(targetAuditPublicationKey)
  const authenticatedBinding =
    authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      {
        artifactBytes: artifact.canonicalBytes,
        expectedContext,
        purpose,
        terminal: null,
      },
      runtimeKey,
      publicationKey,
    )
  if (!isZeroized(runtimeKey) || !isZeroized(publicationKey)) {
    throw new Error('Expected target preimage fixture key zeroization.')
  }
  return Object.freeze({
    artifact,
    authenticatedBinding,
    input: Object.freeze({
      artifact: Object.freeze({
        artifactBytes: artifact.canonicalBytes,
        expectedContext,
        purpose,
        terminal: null,
      }),
      expectedProspectivePlanningReceiptDigest:
        expectedContext.planningReceiptDigest,
      expectedPlanningReceiptCompletedAt:
        '2026-07-31T23:59:59.000Z',
      expectedRatePredecessor: authenticatedBinding.rate.predecessor,
      commitGateObservedAt: '2026-08-04T00:00:00.000Z',
    }),
  })
}

/** Requires one candidate preimage gate failure and both key transfers. */
function expectTargetPreimageGateFailure(
  value: unknown,
  runtimeKey: Uint8Array = new Uint8Array(targetAuditKey),
  publicationKey: Uint8Array = new Uint8Array(targetAuditPublicationKey),
): void {
  expect(() => finalizeTargetPreimageUnknown(
    value,
    runtimeKey,
    publicationKey,
  )).toThrow('Workspace Search migration rehearsal target audit failed.')
  expect(isZeroized(runtimeKey)).toBe(true)
  expect(isZeroized(publicationKey)).toBe(true)
}

/** Invokes the typed preimage finalizer with deliberately unknown input. */
function finalizeTargetPreimageUnknown(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): unknown {
  return Reflect.apply(
    finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence,
    undefined,
    [value, runtimeKey, publicationKey],
  )
}

/** Creates exact parent-authenticated close-replan provenance for one pair. */
function createTargetContext(
  scenario:
    | 'complete-apply-rollback'
    | 'partial-apply-rollback',
  label: string,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  const configuration = createConfiguration()
  return Object.freeze({
    scenario,
    runLocatorDigest: digest(`run:${label}`),
    manifestDigest: digest(`manifest:${label}`),
    permitDigest: digest(`permit:${label}`),
    requestedResourcesBinding: digest(`requested-resources:${label}`),
    configurationBindingDigest:
      createWorkspaceSearchConfigurationHash(configuration),
    planningReceiptDigest: digest(`planning-receipt:${label}`),
    executionBoundaryDigest: digest(`execution-boundary:${label}`),
    sealedPlanningAuthorityDigest: digest(`sealed-authority:${label}`),
    planDigest: digest(`plan:${label}`),
    writerFenceDigest: digest(`writer-fence:${label}`),
  })
}

/** Returns whether a value is one ordinary parsed JSON fixture record. */
function isTargetAuditFixtureRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
}

/** Requires one ordinary parsed JSON record for a malicious wrapper fixture. */
function requireTargetAuditFixtureRecord(
  value: unknown,
): Record<string, unknown> {
  if (!isTargetAuditFixtureRecord(value)) {
    throw new Error('Expected a target-audit fixture record.')
  }
  return value
}

/** Requires one string field from a parsed authentication fixture. */
function requireTargetAuditFixtureString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a target-audit fixture string.')
  }
  return value
}

/** Rewraps foreign rate evidence with otherwise valid parent audit HMACs. */
function rewrapTargetAuditWithRate(
  artifactBytes: Uint8Array,
  rate: unknown,
): Uint8Array {
  return rewrapTargetAuditFixture(
    artifactBytes,
    (document) => ({ ...document, rate }),
  )
}

/** Rewraps a substituted observed resource with valid parent audit HMACs. */
function rewrapTargetAuditWithResourceBinding(
  artifactBytes: Uint8Array,
  sourceResourceBindingDigest: string,
): Uint8Array {
  return rewrapTargetAuditFixture(artifactBytes, (document) => {
    const context = requireTargetAuditFixtureRecord(document.context)
    return {
      ...document,
      sourceResourceBindingDigest,
      observationDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-target-observation',
        version: 2,
        startedAt: document.startedAt,
        observedAt: document.observedAt,
        commit: document.commit,
        configurationHash: document.configurationHash,
        evidenceKeyDigest: document.evidenceKeyDigest,
        sourceSessionBindingDigest: document.sourceSessionBindingDigest,
        sourcePermitDigest: context.permitDigest,
        sourceResourceBindingDigest,
        aggregate: document.aggregate,
        aggregateDigest: document.aggregateDigest,
      }),
    }
  })
}

/** Applies a malicious semantic rewrite and recreates both audit HMACs. */
function rewrapTargetAuditFixture(
  artifactBytes: Uint8Array,
  rewrite: (
    document: Record<string, unknown>,
  ) => Record<string, unknown>,
): Uint8Array {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(artifactBytes),
  )
  const document = requireTargetAuditFixtureRecord(parsed)
  const authentication = requireTargetAuditFixtureRecord(
    document.authentication,
  )
  const algorithm = requireTargetAuditFixtureString(
    authentication.algorithm,
  )
  const runtimeKeyFingerprint = requireTargetAuditFixtureString(
    authentication.runtimeKeyFingerprint,
  )
  const publicationKeyFingerprint = requireTargetAuditFixtureString(
    authentication.publicationKeyFingerprint,
  )
  const {
    authentication: _authentication,
    ...documentWithoutAuthentication
  } = document
  const rewrittenDocument = rewrite(documentWithoutAuthentication)
  const runtimeUnsigned = {
    ...rewrittenDocument,
    authentication: {
      algorithm,
      runtimeKeyFingerprint,
    },
  }
  const runtimeMac = createHmac('sha256', targetAuditKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v3\n',
      'utf8',
    )
    .update(serializeCanonicalJson(runtimeUnsigned), 'utf8')
    .digest('hex')
  const publicationUnsigned = {
    ...rewrittenDocument,
    authentication: {
      algorithm,
      runtimeKeyFingerprint,
      runtimeMac,
      publicationKeyFingerprint,
    },
  }
  const publicationMac = createHmac(
    'sha256',
    targetAuditPublicationKey,
  )
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-mac/v3\n',
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

/** Concatenates canonical LF-terminated rate records without aliases. */
function concatenateRateRecords(
  first: Uint8Array,
  second: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(first.byteLength + second.byteLength)
  combined.set(first, 0)
  combined.set(second, first.byteLength)
  return combined
}

/** Reads the exact MAC from one test-only canonical header record. */
function readRateHeaderMac(bytes: Uint8Array): string {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid rate header fixture.')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'mac')
  if (descriptor === undefined || typeof descriptor.value !== 'string') {
    throw new Error('Missing rate header fixture MAC.')
  }
  return descriptor.value
}

/** Creates one fresh auxiliary rate proof bound to the target context. */
function createRateInput(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  label: string,
  authenticationKey: Uint8Array = new Uint8Array(targetAuditKey),
): FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput {
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      authenticationKey,
    )
  const policyVersion = digest(`rate-policy:${label}`)
  const predecessorOrdinal =
    (Number.parseInt(digest(label).slice(0, 2), 16) % 120) * 2
  const predecessorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(`rate-predecessor:${label}`),
    segmentOrdinal: predecessorOrdinal,
    previousSegmentDigest: predecessorOrdinal === 0
      ? null
      : digest(`rate-prior-segment:${label}`),
    previousRecordMac: predecessorOrdinal === 0
      ? null
      : digest(`rate-prior-mac:${label}`),
    firstEventSequence: 1,
    anchorUtc: '2026-08-01T00:00:00.000Z',
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest: context.configurationBindingDigest,
  })
  const predecessorHeaderBytes = createRateHeaderBytes(
    predecessorPayload,
    authenticationKey,
  )
  const predecessorEventBytes = createRateHeaderBytes(
    Object.freeze({
      kind: 'cadence-wait',
      version: 1,
      eventSequence: 1,
      offsetMilliseconds: 1,
      previousRecordMac: readRateHeaderMac(predecessorHeaderBytes),
      phase: 'reconciliation',
      delayMilliseconds: 1,
    }),
    authenticationKey,
  )
  const predecessorSegmentBytes = concatenateRateRecords(
    predecessorHeaderBytes,
    predecessorEventBytes,
  )
  const successorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(`rate-successor:${label}`),
    segmentOrdinal: predecessorOrdinal + 1,
    previousSegmentDigest: createHash('sha256')
      .update(predecessorSegmentBytes)
      .digest('hex'),
    previousRecordMac: readRateHeaderMac(predecessorEventBytes),
    firstEventSequence: 2,
    anchorUtc: '2026-08-02T00:00:00.000Z',
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
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    }),
    completedAt: '2026-08-03T00:00:00.000Z',
  })
}

/** Creates all four correctly bound authenticated target-audit artifacts. */
async function createArtifactSet(
  preimagePages: readonly WorkspaceSearchMigrationTargetScanPage[],
  partialPages: readonly WorkspaceSearchMigrationTargetScanPage[],
  completePages: readonly WorkspaceSearchMigrationTargetScanPage[],
  completePreimagePages: readonly WorkspaceSearchMigrationTargetScanPage[] =
    preimagePages,
): Promise<TargetAuditArtifactSet> {
  return {
    partialPreimage: await createArtifact(
      preimagePages,
      '2026-08-01T00:00:00.000Z',
      'partial-session',
      'partial-rollback-preimage',
      null,
    ),
    partialRestored: await createArtifact(
      partialPages,
      '2026-08-01T01:00:00.000Z',
      'partial-session',
      'partial-rollback-restored',
      partialTerminal,
    ),
    completePreimage: await createArtifact(
      completePreimagePages,
      '2026-08-01T02:00:00.000Z',
      'complete-session',
      'complete-rollback-preimage',
      null,
    ),
    completeRestored: await createArtifact(
      completePages,
      '2026-08-01T04:00:00.000Z',
      'complete-session',
      'complete-rollback-restored',
      completeTerminal,
    ),
  }
}

/** Collects and authenticates one complete target-audit artifact. */
async function createArtifact(
  pages: readonly WorkspaceSearchMigrationTargetScanPage[],
  observedAt: string,
  sessionLabel: string,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): Promise<WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact> {
  const audit = await collectWithPages(pages, observedAt, sessionLabel)
  const signingKey = new Uint8Array(targetAuditKey)
  const publicationSigningKey = new Uint8Array(targetAuditPublicationKey)
  const scenario = purpose.startsWith('partial-rollback-')
    ? 'partial-apply-rollback'
    : 'complete-apply-rollback'
  const context = createTargetContext(scenario, sessionLabel)
  const rate = createRateInput(
    context,
    `${sessionLabel}:${purpose}:${observedAt}`,
  )
  let artifact: WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  if (purpose === 'partial-rollback-preimage') {
    if (terminal !== null) throw new Error('Invalid preimage fixture terminal.')
    const integrityBefore = await createIntegrityPreimageCapability(observedAt)
    artifact = finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      { audit, context, integrityBefore, purpose, rate, terminal },
      signingKey,
      publicationSigningKey,
    )
  } else if (purpose === 'partial-rollback-restored') {
    if (terminal?.scenario !== 'partial-apply-rollback') {
      throw new Error('Invalid partial-rollback fixture terminal.')
    }
    artifact = finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      { audit, context, integrityBefore: null, purpose, rate, terminal },
      signingKey,
      publicationSigningKey,
    )
  } else if (purpose === 'complete-rollback-preimage') {
    if (terminal !== null) throw new Error('Invalid preimage fixture terminal.')
    const integrityBefore = await createIntegrityPreimageCapability(observedAt)
    artifact = finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      { audit, context, integrityBefore, purpose, rate, terminal },
      signingKey,
      publicationSigningKey,
    )
  } else {
    if (terminal?.scenario !== 'complete-apply-rollback') {
      throw new Error('Invalid complete-rollback fixture terminal.')
    }
    artifact = finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
      { audit, context, integrityBefore: null, purpose, rate, terminal },
      signingKey,
      publicationSigningKey,
    )
  }
  if (!isZeroized(signingKey)) {
    throw new Error('Expected target-audit signing key zeroization.')
  }
  if (!isZeroized(publicationSigningKey)) {
    throw new Error('Expected publication signing key zeroization.')
  }
  return artifact
}

/** Invokes the one-artifact authenticator with an unknown input value. */
function authenticateArtifactUnknown(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): unknown {
  return Reflect.apply(
    authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
    undefined,
    [value, runtimeKey, publicationKey],
  )
}

/** Collects one actual audit from ordered raw target pages. */
function collectWithPages(
  pages: readonly WorkspaceSearchMigrationTargetScanPage[],
  observedAt: string,
  sessionLabel = 'shared-session',
): Promise<WorkspaceSearchMigrationRehearsalCollectedTargetAudit> {
  return collectWithSession(
    createPageSession(pages, sessionLabel),
    pages.length + 1,
    observedAt,
  )
}

/** Collects a scan with distinct trusted samples around all external reads. */
function collectWithPagesBetween(
  pages: readonly WorkspaceSearchMigrationTargetScanPage[],
  startedAt: string,
  observedAt: string,
  sessionLabel: string,
): Promise<WorkspaceSearchMigrationRehearsalCollectedTargetAudit> {
  let clockCallCount = 0
  const input = createAuditInput(
    createPageSession(pages, sessionLabel),
    pages.length + 1,
    observedAt,
  )
  return collectWorkspaceSearchMigrationRehearsalTargetAudit({
    ...input,
    clock: () => {
      clockCallCount += 1
      return new Date(clockCallCount === 1 ? startedAt : observedAt)
    },
  })
}

/** Collects one actual audit with a supplied measured-session fixture. */
function collectWithSession(
  session: WorkspaceSearchMigrationRehearsalTargetAuditSession,
  maximumPages: number,
  observedAt: string,
): Promise<WorkspaceSearchMigrationRehearsalCollectedTargetAudit> {
  return collectWorkspaceSearchMigrationRehearsalTargetAudit(
    createAuditInput(session, maximumPages, observedAt),
  )
}

/** Creates complete measured inputs for one collector invocation. */
function createAuditInput(
  session: WorkspaceSearchMigrationRehearsalTargetAuditSession,
  maximumPages: number,
  observedAt: string,
): CollectWorkspaceSearchMigrationRehearsalTargetAuditInput {
  const configuration = createConfiguration()
  return {
    session,
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    maximumDurationMilliseconds: 60_000,
    maximumPages,
    clock: () => new Date(observedAt),
    monotonicClock: () => 1_000,
  }
}

/** Creates a measured-session fixture reducing successive raw pages. */
function createPageSession(
  pages: readonly WorkspaceSearchMigrationTargetScanPage[],
  sessionLabel = 'shared-session',
  driftAfterScan = false,
): WorkspaceSearchMigrationRehearsalTargetAuditSession {
  let pageIndex = 0
  let bindingReadCount = 0
  return {
    /** Returns the exact requested-resource fixture binding. */
    readRequestedResourcesBinding: () =>
      digest(`requested-resources:${sessionLabel}`),
    /** Returns the exact authenticated evidence-session fixture binding. */
    readRehearsalEvidenceSessionBinding: () => {
      bindingReadCount += 1
      return createSessionBinding(
        driftAfterScan && bindingReadCount > 1
          ? `${sessionLabel}:drifted`
          : sessionLabel,
      )
    },
    /** Reduces and returns the next exact fixture page. */
    scanTargetPage: async (input) => {
      const page = pages[pageIndex]
      if (page === undefined) {
        throw new Error('Expected another target page fixture.')
      }
      pageIndex += 1
      return reduceWorkspaceSearchMigrationTargetScanPage({
        ...input,
        page,
      })
    },
  }
}

/** Creates one strict digest-only evidence-session binding fixture. */
function createSessionBinding(
  label: string,
): WorkspaceSearchMigrationRehearsalEvidenceSessionBinding {
  const configuration = createConfiguration()
  return {
    commit: configuration.commit,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    evidenceKeyDigest:
      createHash('sha256').update(targetAuditKey).digest('hex'),
    publicationKeyDigest:
      createHash('sha256').update(targetAuditPublicationKey).digest('hex'),
    attestation: {
      stage: 'non-production',
      permitDigest: digest(`permit:${label}`),
      callerAttestationDigest: digest(`caller:${label}`),
      resourceAttestationDigest: digest(`resources:${label}`),
      productionIsolationDigest: digest(`isolation:${label}`),
    },
  }
}

/** Creates one migration-owned canonical Search document row. */
function createOwnedDocumentItem(identifier: string): DynamoAttributeMap {
  return encodeWorkspaceSearchMigrationDocument(
    createWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      entityType: 'document',
      entityId: identifier,
      title: `Document ${identifier}`,
      url: `/documents/${identifier}`,
    }),
  )
}

/** Creates one recognized saved-view target row. */
function createIgnoredItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'fixture' },
  }
}

/** Creates one key-valid row with a conflicting family discriminator. */
function createInvalidItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'search-document' },
  }
}

/** Creates one exact target pagination key. */
function createCursor(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
  }
}

/** Extracts one exact physical key from a target fixture. */
function createItemCursor(item: DynamoAttributeMap): DynamoAttributeMap {
  const workspaceId = item.workspaceId
  const recordKey = item.recordKey
  if (workspaceId === undefined || recordKey === undefined) {
    throw new Error('Expected a complete target fixture key.')
  }
  return structuredClone({ workspaceId, recordKey })
}

/** Captures one public collector failure. */
async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected Workspace Search migration failure.')
}

/** Creates the complete measured migration configuration for fixtures. */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/** Creates one complete measured source table identity. */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role))
}

/** Creates one complete target or state table identity. */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
  )
}

/** Creates one stable measured table identity. */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/** Returns the exact measured key schema for one source role. */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}
