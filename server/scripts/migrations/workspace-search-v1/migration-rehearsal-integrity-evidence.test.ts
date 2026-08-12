import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  authenticateCrossDomainIntegrityResult,
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  runCrossDomainIntegrityCheck,
  type CrossDomainIntegrityItem,
  type CrossDomainIntegrityObservationMode,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResult,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPair,
  authenticateWorkspaceSearchMigrationRehearsalIntegrityResult,
  consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  readWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES,
  WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
  type AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPairInput,
  type WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose,
} from './migration-rehearsal-integrity-evidence'

/** Common result-authentication key copied before every consuming call. */
const fixtureDigestKey = new Uint8Array(32).fill(73)

/** Different valid-length key used to prove HMAC substitution rejection. */
const foreignDigestKey = new Uint8Array(32).fill(74)

/** Fixed live source resources required by the permit/manifest fixture. */
const fixtureResourceIdentities: CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => ({
    target,
    identityDigest: digest(`resource:${target}`),
  }))

/** Exact keyed resource identity expected by every admitted result. */
const fixtureResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    fixtureResourceIdentities,
    fixtureDigestKey,
  )

/** Fixed rollback comparison start used by deterministic fixtures. */
const startedAt = '2026-08-01T00:00:00.000Z'

/** Trusted apply start that the complete before check must precede. */
const applyStartedAt = '2026-08-01T01:30:00.000Z'

/** Authoritative rollback terminal that the after check must follow. */
const terminalAt = '2026-08-01T01:45:00.000Z'

/** Fixed rollback comparison completion used by deterministic fixtures. */
const completedAt = '2026-08-01T12:00:00.000Z'

/** Returns the deterministic trusted completion clock used by fixtures. */
function completionClock(value: string = completedAt): () => Date {
  return () => new Date(value)
}

/** Creates one deterministic lowercase digest for fixture-only identities. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Runs one authenticated passing #163 check over fixed physical resources. */
async function createResult(
  checkedAt: string,
  items: readonly CrossDomainIntegrityItem[] = [],
  observationMode: CrossDomainIntegrityObservationMode =
    'migration-rehearsal-live',
  role: 'restore' | 'source' = 'source',
  resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[] =
    fixtureResourceIdentities,
  liveStartedAt?: string,
): Promise<CrossDomainIntegrityResult> {
  return await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    deadline: createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds: 60_000,
      monotonicClock: () => 1_000,
    }),
    role,
    checkedAt,
    observationMode,
    ...(observationMode === 'migration-rehearsal-live'
      ? {
          liveRuntimeObservation: {
            startedAt: liveStartedAt ??
              new Date(Date.parse(checkedAt) - 1_000).toISOString(),
            completedAt: checkedAt,
          },
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        }
      : {}),
    digestKey: fixtureDigestKey,
    resourceBindingDigest:
      calculateCrossDomainIntegrityResourceBindingDigest(),
    resourceIdentities,
    resourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        fixtureDigestKey,
      ),
    limits: {
      pageSize: 100,
      maxPages: 10,
      maxItems: 1_000,
    },
    reader: {
      readPage: async () => ({ items }),
    },
  })
}

/** Re-authenticates one valid fixture as a well-formed failing result. */
function createFailedResult(
  result: CrossDomainIntegrityResult,
): CrossDomainIntegrityResult {
  return authenticateCrossDomainIntegrityResult({
    kind: result.kind,
    contractVersion: result.contractVersion,
    role: result.role,
    checkedAt: result.checkedAt,
    ...(result.runtimeProvenance === undefined
      ? {}
      : { runtimeProvenance: result.runtimeProvenance }),
    limits: result.limits,
    status: 'fail',
    failureCodes: ['DUPLICATE_RECORD'],
    scope: result.scope,
    evidence: result.evidence,
  }, fixtureDigestKey)
}

/** Serializes one complete result into the required canonical file bytes. */
function resultBytes(result: CrossDomainIntegrityResult): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(result, undefined, 2)}\n`,
  )
}

/** Creates one valid rollback pair with distinct ordered observations. */
async function createPair(
  purpose: 'complete-rollback' | 'partial-rollback',
): Promise<AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPairInput> {
  return {
    purpose,
    startedAt,
    applyStartedAt,
    terminalAt,
    expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
    beforeResultBytes: resultBytes(
      await createResult('2026-08-01T01:00:00.000Z'),
    ),
    afterResultBytes: resultBytes(
      await createResult('2026-08-01T02:00:00.000Z'),
    ),
    clock: completionClock(),
  }
}

/** Returns whether one consumed key buffer is entirely overwritten. */
function isZeroized(key: Uint8Array): boolean {
  return key.every((value) => value === 0)
}

/** Invokes the single-result authenticator with an unknown boundary value. */
function authenticateResultUnknown(
  value: unknown,
  key: Uint8Array,
): unknown {
  return Reflect.apply(
    authenticateWorkspaceSearchMigrationRehearsalIntegrityResult,
    undefined,
    [value, key],
  )
}

/** Invokes the rollback-pair authenticator with an unknown boundary value. */
function authenticatePairUnknown(
  value: unknown,
  key: Uint8Array,
): unknown {
  return Reflect.apply(
    authenticateWorkspaceSearchMigrationRehearsalIntegrityPair,
    undefined,
    [value, key],
  )
}

describe('Workspace Search migration rehearsal #163 integrity evidence', () => {
  test('mints one opaque one-shot live preimage capability', async () => {
    const result = await createResult('2026-08-01T01:00:00.000Z')
    const bytes = resultBytes(result)
    const key = new Uint8Array(fixtureDigestKey)
    const capability =
      authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult({
        resultBytes: bytes,
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        clock: completionClock('2026-08-01T01:01:00.000Z'),
      }, key)

    expect(isZeroized(key)).toBe(true)
    const inspected =
      readWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(capability)
    expect(inspected).toMatchObject({
      checkedAt: result.checkedAt,
      contentDigest: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      resultDigest: createMigrationDigest(result),
      resultMac: result.resultMac,
      integrityAggregateDigest: result.evidence.aggregateDigest,
      resourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      resourceIdentities: fixtureResourceIdentities,
      resourceIdentityDigest: fixtureResourceIdentityDigest,
    })
    expect(Object.isFrozen(inspected)).toBe(true)
    expect(Object.isFrozen(inspected.runtimeProvenance)).toBe(true)
    expect(
      consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
        capability,
      ),
    ).toEqual(inspected)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
        capability,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
    expect(() =>
      readWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
        capability,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')

    const forged = Reflect.construct(
      class {},
      [],
      WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
    )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
        forged,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
    expect(() => Reflect.construct(
      WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
      [Symbol('forged')],
    )).toThrow('Invalid integrity preimage capability')
  })

  test('rejects unsafe live preimage candidates and zeroizes every key', async () => {
    const live = await createResult('2026-08-01T01:00:00.000Z')
    const logical = await createResult(
      '2026-08-01T01:00:00.000Z',
      [],
      'logical',
    )
    const restore = await createResult(
      '2026-08-01T01:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'restore',
    )
    const foreignResources = fixtureResourceIdentities.map(
      (identity, index) => index === 0
        ? { ...identity, identityDigest: digest('foreign-preimage-resource') }
        : identity,
    )
    const wrongResource = await createResult(
      '2026-08-01T01:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      foreignResources,
    )
    const candidates = [
      {
        result: logical,
        clock: completionClock('2026-08-01T01:01:00.000Z'),
      },
      {
        result: restore,
        clock: completionClock('2026-08-01T01:01:00.000Z'),
      },
      {
        result: wrongResource,
        clock: completionClock('2026-08-01T01:01:00.000Z'),
      },
      {
        result: live,
        clock: completionClock('2026-08-01T00:59:59.000Z'),
      },
    ]
    for (const candidate of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() =>
        authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult({
          resultBytes: resultBytes(candidate.result),
          expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
          clock: candidate.clock,
        }, key)).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(key)).toBe(true)
    }
  })

  test('authenticates one passing post-terminal result into a rich binding', async () => {
    const result = await createResult('2026-08-01T02:00:00.000Z')
    const bytes = resultBytes(result)
    const key = new Uint8Array(fixtureDigestKey)
    const authenticated =
      authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: bytes,
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      }, key)

    expect(isZeroized(key)).toBe(true)
    expect(authenticated).toEqual({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: '2026-08-01T03:00:00.000Z',
      result: {
        checkedAt: result.checkedAt,
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        resultDigest: createMigrationDigest(result),
        resultMac: result.resultMac,
        runtimeProvenance: {
          kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
          version: 1,
          mode: 'migration-rehearsal-live',
          startedAt: '2026-08-01T01:59:59.000Z',
          completedAt: result.checkedAt,
          checkedAtSource: 'trusted-wall-clock-after-external-reads',
        },
        integrityAggregateDigest: result.evidence.aggregateDigest,
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        resourceIdentities: fixtureResourceIdentities,
        resourceIdentityDigest: result.evidence.resourceIdentityDigest,
      },
      integrityAggregateDigest: result.evidence.aggregateDigest,
    })
    expect(Object.isFrozen(authenticated)).toBe(true)
    expect(Object.isFrozen(authenticated.result)).toBe(true)
  })

  test('rejects checks that straddle or start exactly at the verified terminal', async () => {
    const terminal = '2026-08-01T01:00:00.000Z'
    const candidates = [
      await createResult(
        '2026-08-01T02:00:00.000Z',
        [],
        'migration-rehearsal-live',
        'source',
        fixtureResourceIdentities,
        terminal,
      ),
      await createResult(
        '2026-08-01T02:00:00.000Z',
        [],
        'migration-rehearsal-live',
        'source',
        fixtureResourceIdentities,
        '2026-08-01T00:59:59.000Z',
      ),
    ]
    for (const result of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() =>
        authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
          terminalAt: terminal,
          expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
          resultBytes: resultBytes(result),
          clock: completionClock('2026-08-01T03:00:00.000Z'),
        }, key)).toThrow(
          'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
        )
      expect(isZeroized(key)).toBe(true)
    }
  })

  test('samples completion only after authentication and rejects hostile clocks', async () => {
    const passing = await createResult('2026-08-01T02:00:00.000Z')
    let clockCallCount = 0
    const foreignKey = new Uint8Array(foreignDigestKey)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: () => {
          clockCallCount += 1
          return new Date('2026-08-01T03:00:00.000Z')
        },
      }, foreignKey)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
      )
    expect(clockCallCount).toBe(0)

    for (const clock of [
      new Proxy(completionClock('2026-08-01T03:00:00.000Z'), {}),
      () => new Date(Number.NaN),
      () => new Proxy(new Date('2026-08-01T03:00:00.000Z'), {}),
    ]) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticateResultUnknown({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock,
      }, key)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
      )
      expect(isZeroized(key)).toBe(true)
    }

    const key = new Uint8Array(fixtureDigestKey)
    const authenticated =
      authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: () => {
          clockCallCount += 1
          return new Date('2026-08-01T03:00:00.000Z')
        },
      }, key)
    expect(authenticated.completedAt).toBe('2026-08-01T03:00:00.000Z')
    expect(clockCallCount).toBe(1)
  })

  test('rejects failed, stale, future, noncanonical, and foreign-key results', async () => {
    const passing = await createResult('2026-08-01T02:00:00.000Z')
    const failed = createFailedResult(passing)
    const candidates: unknown[] = [
      {
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(failed),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      },
      {
        terminalAt: passing.checkedAt,
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      },
      {
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: completionClock('2026-08-01T01:30:00.000Z'),
      },
      {
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: new TextEncoder().encode(
          serializeCanonicalJson(passing),
        ),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      },
      {
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
        extra: true,
      },
    ]
    for (const candidate of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticateResultUnknown(candidate, key)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
      )
      expect(isZeroized(key)).toBe(true)
    }
    const foreignKey = new Uint8Array(foreignDigestKey)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(passing),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      }, foreignKey)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
      )
    expect(isZeroized(foreignKey)).toBe(true)
  })

  test('rejects logical, forged, wrong-resource, and restore-role results', async () => {
    const live = await createResult('2026-08-01T02:00:00.000Z')
    const logical = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'logical',
    )
    const restore = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'restore',
    )
    const foreignResources = fixtureResourceIdentities.map(
      (identity, index) => index === 0
        ? { ...identity, identityDigest: digest('foreign-resource') }
        : identity,
    )
    const wrongResource = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      foreignResources,
    )
    const forged = {
      ...logical,
      runtimeProvenance: live.runtimeProvenance,
    }
    const { runtimeProvenance: removed, ...missing } = live
    expect(removed).toEqual(live.runtimeProvenance)

    for (const result of [logical, forged, missing, wrongResource, restore]) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticateWorkspaceSearchMigrationRehearsalIntegrityResult({
        terminalAt: '2026-08-01T01:00:00.000Z',
        expectedResourceIdentityDigest: fixtureResourceIdentityDigest,
        resultBytes: resultBytes(result),
        clock: completionClock('2026-08-01T03:00:00.000Z'),
      }, key)).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(key)).toBe(true)
    }
  })

  test('authenticates rollback pairs into the reconciliation projection', async () => {
    const purposes:
      readonly WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose[] = [
      'partial-rollback',
      'complete-rollback',
    ]
    for (const purpose of purposes) {
      const pair = await createPair(purpose)
      const key = new Uint8Array(fixtureDigestKey)
      const authenticated =
        authenticateWorkspaceSearchMigrationRehearsalIntegrityPair(
          pair,
          key,
        )
      const binding = authenticated.binding
      expect(isZeroized(key)).toBe(true)
      expect(binding).toMatchObject({
        kind: 'rollback-comparison',
        purpose,
        status: 'pass',
        failureCount: 0,
        startedAt,
        applyStartedAt,
        terminalAt,
        completedAt,
      })
      expect(binding.comparisonDigest).toBe(createMigrationDigest({
        purpose,
        beforeResultDigest: binding.before.resultDigest,
        afterResultDigest: binding.after.resultDigest,
        comparison: {
          kind:
            'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
          contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
          status: 'pass',
        },
      }))
      expect(binding.comparisonContextDigest).toBe(createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-integrity-context',
        version: 1,
        purpose,
        startedAt,
        applyStartedAt,
        terminalAt,
        completedAt,
        before: binding.before,
        after: binding.after,
        comparisonDigest: binding.comparisonDigest,
      }))
      expect(Object.isFrozen(binding)).toBe(true)
      expect(Object.isFrozen(binding.before)).toBe(true)
    }
  })

  test('rejects verified pairs, replay, drift, malformed bytes, and invalid keys', async () => {
    const pair = await createPair('partial-rollback')
    const differentAfter = await createResult(
      '2026-08-01T02:00:00.000Z',
      [{
        kind: 'team',
        workspaceId: 'raw-workspace-id',
        teamId: 'raw-team-id',
      }],
    )
    const candidates: unknown[] = [
      { ...pair, purpose: 'verified' },
      { ...pair, afterResultBytes: pair.beforeResultBytes },
      { ...pair, startedAt: '2026-08-01T01:30:00.000Z' },
      { ...pair, afterResultBytes: resultBytes(differentAfter) },
      { ...pair, beforeResultBytes: new Proxy(pair.beforeResultBytes, {}) },
      { ...pair, extra: true },
    ]
    for (const candidate of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticatePairUnknown(candidate, key)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE',
      )
      expect(isZeroized(key)).toBe(true)
    }
    for (const invalidKey of [
      new Uint8Array(foreignDigestKey),
      new Uint8Array(31).fill(75),
    ]) {
      expect(() =>
        authenticateWorkspaceSearchMigrationRehearsalIntegrityPair(
          pair,
          invalidKey,
        )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(invalidKey)).toBe(true)
    }
  })

  test('rejects a logical or wrong-resource result in either rollback position', async () => {
    const pair = await createPair('complete-rollback')
    const logical = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'logical',
    )
    const foreignResources = fixtureResourceIdentities.map(
      (identity, index) => index === 0
        ? { ...identity, identityDigest: digest('foreign-pair-resource') }
        : identity,
    )
    const wrongResource = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      foreignResources,
    )
    const crossedApplyBoundary = await createResult(
      '2026-08-01T01:31:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      fixtureResourceIdentities,
      '2026-08-01T01:29:00.000Z',
    )
    const candidates = [
      { ...pair, beforeResultBytes: resultBytes(logical) },
      { ...pair, afterResultBytes: resultBytes(logical) },
      { ...pair, beforeResultBytes: resultBytes(wrongResource) },
      { ...pair, afterResultBytes: resultBytes(wrongResource) },
      { ...pair, beforeResultBytes: resultBytes(crossedApplyBoundary) },
      { ...pair, expectedResourceIdentityDigest: digest('wrong-expected') },
    ]
    for (const candidate of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticateWorkspaceSearchMigrationRehearsalIntegrityPair(
        candidate,
        key,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(key)).toBe(true)
    }
  })

  test('rejects rollback checks whose live reads cross either state boundary', async () => {
    const pair = await createPair('complete-rollback')
    const beforeStartedBeforeWindow = await createResult(
      '2026-08-01T01:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      fixtureResourceIdentities,
      '2026-07-31T23:59:59.000Z',
    )
    const afterStartedAtTerminal = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      fixtureResourceIdentities,
      terminalAt,
    )
    const afterStartedBeforeTerminal = await createResult(
      '2026-08-01T02:00:00.000Z',
      [],
      'migration-rehearsal-live',
      'source',
      fixtureResourceIdentities,
      '2026-08-01T01:44:59.000Z',
    )
    const candidates = [
      {
        ...pair,
        beforeResultBytes: resultBytes(beforeStartedBeforeWindow),
      },
      {
        ...pair,
        afterResultBytes: resultBytes(afterStartedAtTerminal),
      },
      {
        ...pair,
        afterResultBytes: resultBytes(afterStartedBeforeTerminal),
      },
    ]
    for (const candidate of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticateWorkspaceSearchMigrationRehearsalIntegrityPair(
        candidate,
        key,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(key)).toBe(true)
    }
  })

  test('rejects shared, empty, and oversized result byte buffers', async () => {
    const pair = await createPair('complete-rollback')
    const candidates: unknown[] = [
      new Uint8Array(new SharedArrayBuffer(64)),
      new Uint8Array(),
      new Uint8Array(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES + 1,
      ),
    ]
    for (const beforeResultBytes of candidates) {
      const key = new Uint8Array(fixtureDigestKey)
      expect(() => authenticatePairUnknown({
        ...pair,
        beforeResultBytes,
      }, key)).toThrow('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
      expect(isZeroized(key)).toBe(true)
    }
  })
})
