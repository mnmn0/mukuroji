import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'bun:test'
import type {
  WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationRehearsalArtifactKind,
} from './migration-rehearsal-evidence'
import {
  verifyWorkspaceSearchMigrationRehearsalEvidenceIndex,
} from './migration-rehearsal-evidence'
import {
  publishWorkspaceSearchMigrationRehearsalSuite,
  type PublishWorkspaceSearchMigrationRehearsalSuiteInput,
  type WorkspaceSearchMigrationRehearsalPublicationSession,
} from './migration-rehearsal-publication'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND,
  type WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  type WorkspaceSearchMigrationRehearsalSuitePublicationBindings,
} from './migration-rehearsal-suite-finalizer'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
  type AuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
} from './migration-rehearsal-suite-finalizer.test-fixture'

/** Dedicated evidence key used only by the isolated fixture. */
const signingKeyBytes = new Uint8Array(32).fill(17)

/** Mutable isolated call ledger reset before every publication test. */
const calls: string[] = []

/** Retention deadlines observed by fake immutable Put boundaries. */
const observedRetentions: string[] = []

/** Creates one lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Behavior toggles retained by one fake transferred session. */
type SessionOptions = {
  /** Optional child kind whose immutable publication fails. */
  readonly failArtifactKind?: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Whether the evidence-index publication fails. */
  readonly failEvidencePublication?: boolean
  /** Whether every close callback raises after recording its attempt. */
  readonly failClose?: boolean
  /** Milliseconds added to the suite start for the permit issue boundary. */
  readonly issuedAtOffsetMilliseconds?: number
  /** Milliseconds added to suite completion for the permit expiry boundary. */
  readonly expiresAtOffsetMilliseconds?: number
  /** Delay between suite completion and the trusted publication clock. */
  readonly publicationDelayMilliseconds?: number
  /** Optional exact clock offsets consumed by preparation and each publisher. */
  readonly clockOffsetsMilliseconds?: readonly number[]
  /** Whether the trusted clock returns a non-finite Date. */
  readonly invalidClock?: boolean
  /** Whether the runtime-key digest is forged to equal the publication key. */
  readonly reusePublicationKeyAsRuntime?: boolean
  /** Optional live aggregate field changed to simulate another run. */
  readonly rateFieldToTamper?:
    keyof WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Creates one narrow measured session without constructing any AWS client. */
function createSession(
  suite: WorkspaceSearchMigrationRehearsalSuitePublicationBindings,
  options: SessionOptions = {},
): WorkspaceSearchMigrationRehearsalPublicationSession {
  return {
    createRehearsalArtifactPublisher: (publisherInput) => {
      calls.push('create-artifact-publisher')
      return {
        publishArtifact: async (input) => {
          publisherInput.clock()
          calls.push(`publish-artifact:${input.kind}`)
          observedRetentions.push(input.retainedUntil)
          if (input.kind === options.failArtifactKind) {
            throw new Error('raw-artifact-failure-with-resource')
          }
          return {
            kind: input.kind,
            contentDigest: createHash('sha256')
              .update(input.artifactBytes)
              .digest('hex'),
            byteLength: input.artifactBytes.byteLength,
            immutableVersionDigest: digest(`version:${input.kind}`),
            retainedUntil: input.retainedUntil,
          }
        },
        close: () => {
          calls.push('close-artifact-publisher')
          if (options.failClose === true) throw new Error('raw-close')
        },
      }
    },
    createRehearsalEvidencePublisher: (publisherInput) => {
      calls.push('create-evidence-publisher')
      return {
        publishEvidence: async (input) => {
          publisherInput.clock()
          calls.push('publish-evidence')
          observedRetentions.push(input.retainedUntil)
          if (options.failEvidencePublication === true) {
            throw new Error('raw-index-failure-with-bucket')
          }
          const verified =
            verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
              input.evidenceBytes,
              input.verificationKey,
            )
          expect(verified.commit).toBe(suite.commit)
          expect(verified.configurationHash).toBe(suite.configurationHash)
          expect(verified.artifacts).toHaveLength(10)
          input.verificationKey.fill(0)
          return {
            byteLength: input.evidenceBytes.byteLength,
            contentDigest: createHash('sha256')
              .update(input.evidenceBytes)
              .digest('hex'),
            immutableVersionDigest: digest('index-version'),
            storageLocatorDigest: digest('index-locator'),
            retainedUntil: input.retainedUntil,
          }
        },
        close: () => {
          calls.push('close-evidence-publisher')
          if (options.failClose === true) throw new Error('raw-close')
        },
      }
    },
    readRehearsalEvidenceSessionBinding: () => {
      calls.push('read-binding')
      return {
        commit: suite.commit,
        configurationHash: suite.configurationHash,
        evidenceKeyDigest: options.reusePublicationKeyAsRuntime === true
          ? createHash('sha256').update(signingKeyBytes).digest('hex')
          : digest('runtime-evidence-key'),
        publicationKeyDigest: createHash('sha256')
          .update(signingKeyBytes)
          .digest('hex'),
        attestation: suite.attestation,
      }
    },
    readDescribeTableRateEvidence: () => {
      calls.push('read-rate')
      const aggregate = suite.rateAggregate
      const evidence: WorkspaceSearchMigrationDescribeTableRateEvidence = {
        version: aggregate.version,
        policyVersion: aggregate.policyVersion,
        attemptCount: aggregate.attemptCount,
        forfeitedAttemptCount: aggregate.forfeitedAttemptCount,
        throttleCount: aggregate.throttleCount,
        budgetStopCount: aggregate.budgetStopCount,
        cadenceWaitCount: aggregate.cadenceWaitCount,
        cadenceWaitMilliseconds: aggregate.cadenceWaitMilliseconds,
        maximumInFlight: aggregate.maximumInFlight,
      }
      tamperLiveRateEvidence(evidence, options.rateFieldToTamper)
      return evidence
    },
    readRehearsalPermitValidity: () => {
      calls.push('read-validity')
      return Object.freeze({
        issuedAt: new Date(
          Date.parse(suite.startedAt) +
            (options.issuedAtOffsetMilliseconds ?? 0),
        ).toISOString(),
        expiresAt: new Date(
          Date.parse(suite.completedAt) +
            (options.expiresAtOffsetMilliseconds ?? 60 * 60 * 1_000),
        ).toISOString(),
      })
    },
    close: async () => {
      calls.push('close-session')
      if (options.failClose === true) throw new Error('raw-close')
    },
  }
}

/** Fresh publication input paired with independently known suite bindings. */
type PublicationInputFixture = {
  /** Exact transferred input accepted by the publication orchestrator. */
  readonly input: PublishWorkspaceSearchMigrationRehearsalSuiteInput
  /** Independently known identity, timing, and rate expectations. */
  readonly expected: WorkspaceSearchMigrationRehearsalSuitePublicationBindings
}

/** Mutates one fake live field without weakening the production type boundary. */
function tamperLiveRateEvidence(
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  field: keyof WorkspaceSearchMigrationDescribeTableRateEvidence | undefined,
): void {
  if (field === undefined) return
  const current = Reflect.get(evidence, field)
  const replacement: unknown = field === 'policyVersion'
    ? digest('foreign-rate-policy')
    : field === 'maximumInFlight'
      ? current === 1 ? 0 : 1
      : typeof current === 'number'
        ? current + 1
        : current
  if (!Reflect.set(evidence, field, replacement)) {
    throw new Error('Expected mutable fake rate evidence.')
  }
}

/** Creates one complete real semantic suite and transferred publication input. */
async function createInput(
  options: SessionOptions = {},
  fixture?: AuthenticWorkspaceSearchMigrationRehearsalSuiteFixture,
): Promise<PublicationInputFixture> {
  const authentic = fixture ??
    await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
  let clockCall = 0
  return Object.freeze({
    input: {
      suite: authentic.suite,
      session: createSession(authentic.expected, options),
      evidenceSigningKey: new Uint8Array(signingKeyBytes),
      clock: () => {
        if (options.invalidClock === true) return new Date(Number.NaN)
        const offsets = options.clockOffsetsMilliseconds
        const offset = offsets?.[clockCall] ??
          offsets?.[offsets.length - 1] ??
          options.publicationDelayMilliseconds ??
          60_000
        clockCall += 1
        return new Date(Date.parse(authentic.expected.completedAt) + offset)
      },
      requestTimeoutMilliseconds: 1_000,
    },
    expected: authentic.expected,
  })
}

beforeEach(() => {
  calls.length = 0
  observedRetentions.length = 0
})

describe('Workspace Search migration rehearsal publication', () => {
  test('rejects a forged suite capability before any immutable write', async () => {
    const authentic =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const suite: WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation =
      Object.freeze({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND,
      })
    const evidenceSigningKey = new Uint8Array(signingKeyBytes)

    await expect(publishWorkspaceSearchMigrationRehearsalSuite({
      suite,
      session: createSession(authentic.expected),
      evidenceSigningKey,
      clock: () => new Date(
        Date.parse(authentic.expected.completedAt) + 60_000,
      ),
      requestTimeoutMilliseconds: 1_000,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(evidenceSigningKey).toEqual(new Uint8Array(32))
    expect(calls).toEqual(['close-session'])
  })

  test('rejects a structured clone before any immutable write', async () => {
    const authentic =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const cloned = structuredClone(authentic.suite)
    const { input } = await createInput({}, Object.freeze({
      suite: cloned,
      expected: authentic.expected,
    }))

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(input.evidenceSigningKey).toEqual(new Uint8Array(32))
    expect(calls).toEqual(['close-session'])
  })

  test('rejects replay of an already consumed suite before any new write', async () => {
    const authentic =
      await createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture()
    const { input: first } = await createInput({}, authentic)
    await publishWorkspaceSearchMigrationRehearsalSuite(first)
    calls.length = 0
    observedRetentions.length = 0
    const { input: replay } = await createInput({}, authentic)

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(replay),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(replay.evidenceSigningKey).toEqual(new Uint8Array(32))
    expect(observedRetentions).toHaveLength(0)
    expect(calls).toEqual(['close-session'])
  })

  test('prepares all children, publishes, finalizes, signs, and closes', async () => {
    const { input, expected } = await createInput()
    const expectedRetention = new Date(
      Date.parse(expected.completedAt) + 60_000 +
        (365 * 24 + 12) * 60 * 60 * 1_000,
    ).toISOString()

    const result = await publishWorkspaceSearchMigrationRehearsalSuite(input)

    expect(result).toEqual({
      kind: 'mukuroji-workspace-search-migration-rehearsal-publication-result',
      publicationVersion: 1,
      artifactCount: 10,
      artifactManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      byteLength: expect.any(Number),
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      immutableVersionDigest: digest('index-version'),
      storageLocatorDigest: digest('index-locator'),
      retainedUntil: expectedRetention,
    })
    expect(Object.keys(result).sort()).toEqual([
      'artifactCount',
      'artifactManifestDigest',
      'byteLength',
      'contentDigest',
      'immutableVersionDigest',
      'kind',
      'publicationVersion',
      'retainedUntil',
      'storageLocatorDigest',
    ])
    expect(input.evidenceSigningKey).toEqual(new Uint8Array(32))
    expect(new Set(observedRetentions)).toEqual(new Set([expectedRetention]))
    expect(calls).toEqual([
      'read-binding',
      'read-validity',
      'read-rate',
      'create-artifact-publisher',
      'publish-artifact:scenario-results',
      'publish-artifact:integrity-before',
      'publish-artifact:integrity-after',
      'publish-artifact:integrity-comparison',
      'publish-artifact:target-preimage',
      'publish-artifact:target-rollback-comparison',
      'publish-artifact:rate-observations',
      'publish-artifact:alarm-delivery',
      'publish-artifact:lifecycle-ledger',
      'publish-artifact:non-production-attestation',
      'create-evidence-publisher',
      'publish-evidence',
      'close-evidence-publisher',
      'close-artifact-publisher',
      'close-session',
    ])
  })

  test('rejects a suite outside the permit before creating a publisher', async () => {
    const { input } = await createInput({
      issuedAtOffsetMilliseconds: 1,
    })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({
      code: 'SESSION_BINDING_MISMATCH',
      message: 'SESSION_BINDING_MISMATCH',
    })

    expect(input.evidenceSigningKey).toEqual(new Uint8Array(32))
    expect(calls).toEqual([
      'read-binding',
      'read-validity',
      'read-rate',
      'close-session',
    ])
  })

  test('rejects reuse of one key for runtime and final publication', async () => {
    const { input } = await createInput({
      reusePublicationKeyAsRuntime: true,
    })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' })
    expect(calls).not.toContain('create-artifact-publisher')
    expect(calls.at(-1)).toBe('close-session')
  })

  test('rejects every live actual-rate field changed from final artifacts', async () => {
    const fields: readonly (
      keyof WorkspaceSearchMigrationDescribeTableRateEvidence
    )[] = [
      'version',
      'policyVersion',
      'attemptCount',
      'forfeitedAttemptCount',
      'throttleCount',
      'budgetStopCount',
      'cadenceWaitCount',
      'cadenceWaitMilliseconds',
      'maximumInFlight',
    ]
    for (const field of fields) {
      calls.length = 0
      const { input } = await createInput({ rateFieldToTamper: field })
      await expect(
        publishWorkspaceSearchMigrationRehearsalSuite(input),
      ).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' })
      expect(calls).not.toContain('create-artifact-publisher')
      expect(calls.at(-1)).toBe('close-session')
    }
  })

  test('treats the permit expiry boundary as exclusive', async () => {
    const { input } = await createInput({
      expiresAtOffsetMilliseconds: 0,
    })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' })

    expect(calls).not.toContain('create-artifact-publisher')
    expect(calls.at(-1)).toBe('close-session')
  })

  test('keeps a full 365-day IAM remainder after publication delay', async () => {
    const { input, expected } = await createInput({
      publicationDelayMilliseconds: 5 * 60 * 60 * 1_000,
      expiresAtOffsetMilliseconds: 6 * 60 * 60 * 1_000,
    })
    const expectedRetention = new Date(
      Date.parse(expected.completedAt) + 5 * 60 * 60 * 1_000 +
        (365 * 24 + 12) * 60 * 60 * 1_000,
    ).toISOString()

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).resolves.toMatchObject({ retainedUntil: expectedRetention })
  })

  test('fixes one deadline while the ten child Put clocks advance', async () => {
    const clockOffsetsMilliseconds = [
      60_000,
      ...Array.from(
        { length: 11 },
        (_, index) => (index + 2) * 25 * 60_000,
      ),
    ]
    const { input, expected } = await createInput({
      clockOffsetsMilliseconds,
      expiresAtOffsetMilliseconds: 6 * 60 * 60 * 1_000,
    })
    const expectedRetention = new Date(
      Date.parse(expected.completedAt) +
        60_000 + (365 * 24 + 12) * 60 * 60 * 1_000,
    ).toISOString()

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).resolves.toMatchObject({ retainedUntil: expectedRetention })
    expect(observedRetentions).toHaveLength(11)
    expect(new Set(observedRetentions)).toEqual(new Set([expectedRetention]))
  })

  test('rejects non-finite, reversed, or permit-external clocks', async () => {
    const { input: invalid } = await createInput({ invalidClock: true })
    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(invalid),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).not.toContain('create-artifact-publisher')

    calls.length = 0
    const { input: reversed } = await createInput({
      clockOffsetsMilliseconds: [60_000, 59_999],
    })
    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(reversed),
    ).rejects.toMatchObject({ code: 'PUBLICATION_FAILED' })
    expect(calls).not.toContain('publish-artifact:scenario-results')

    calls.length = 0
    const { input: expired } = await createInput({
      publicationDelayMilliseconds: 2 * 60 * 60 * 1_000,
      expiresAtOffsetMilliseconds: 60 * 60 * 1_000,
    })
    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(expired),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).not.toContain('create-artifact-publisher')
  })

  test('rejects publication before completion or beyond the 366-day cap', async () => {
    const { input: early } = await createInput({
      publicationDelayMilliseconds: -1,
    })
    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(early),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).not.toContain('create-artifact-publisher')

    calls.length = 0
    const { input: late } = await createInput({
      publicationDelayMilliseconds: 12 * 60 * 60 * 1_000 + 1,
      expiresAtOffsetMilliseconds: 13 * 60 * 60 * 1_000,
    })
    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(late),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).not.toContain('create-artifact-publisher')
  })

  test('does not finalize an incomplete child publication', async () => {
    const { input } = await createInput({
      failArtifactKind: 'target-preimage',
    })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({
      code: 'PUBLICATION_FAILED',
      message: 'PUBLICATION_FAILED',
    })

    expect(calls).not.toContain('create-evidence-publisher')
    expect(calls.slice(-2)).toEqual([
      'close-artifact-publisher',
      'close-session',
    ])
    expect(input.evidenceSigningKey).toEqual(new Uint8Array(32))
  })

  test('attempts every close and fails a completed but unclosed flow', async () => {
    const { input } = await createInput({ failClose: true })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_CLOSE_FAILED',
      message: 'CAPABILITY_CLOSE_FAILED',
    })

    expect(calls.slice(-3)).toEqual([
      'close-evidence-publisher',
      'close-artifact-publisher',
      'close-session',
    ])
  })

  test('preserves the primary redacted failure while still closing all', async () => {
    const { input } = await createInput({
      failEvidencePublication: true,
      failClose: true,
    })

    await expect(
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    ).rejects.toMatchObject({
      code: 'PUBLICATION_FAILED',
      message: 'PUBLICATION_FAILED',
    })

    expect(calls.slice(-3)).toEqual([
      'close-evidence-publisher',
      'close-artifact-publisher',
      'close-session',
    ])
    expect(input.evidenceSigningKey).toEqual(new Uint8Array(32))
  })
})
