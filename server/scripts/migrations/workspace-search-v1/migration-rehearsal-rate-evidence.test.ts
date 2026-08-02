import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
  WorkspaceSearchMigrationDescribeTableRateObservation,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
  consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  finalizeWorkspaceSearchMigrationRehearsalRateEvidence,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  readWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  recoverWorkspaceSearchMigrationRehearsalRateContinuation,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'

const key = new Uint8Array(32).fill(37)
const authenticationKeyFingerprint =
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(key)
const policyVersion = digest('reviewed-rate-policy')
const configurationBindingDigest = digest('non-production-configuration')

/** Process segment fixture and its exact durably appended chunks. */
type StoredSegment = {
  /** Recorder returned after the header append resolves. */
  readonly recorder: WorkspaceSearchMigrationRehearsalRateRecorder
  /** Exact chunks accepted by the deterministic durable append callback. */
  readonly chunks: Uint8Array[]
}

/** Options for one deterministic process segment fixture. */
type CreateStoredSegmentOptions = {
  /** Strict process segment ordinal. */
  readonly segmentOrdinal: number
  /** First global event sequence for the segment. */
  readonly firstEventSequence: number
  /** Digest of the preceding segment bytes. */
  readonly previousSegmentDigest: string | null
  /** Terminal record MAC of the preceding segment. */
  readonly previousRecordMac: string | null
  /** Canonical UTC anchor for this process. */
  readonly anchorUtc: string
  /** Matching process-monotonic clock anchor. */
  readonly monotonicAnchorMilliseconds: number
  /** Optional policy digest used to exercise drift rejection. */
  readonly policyVersion?: string
  /** Optional configuration digest used to exercise drift rejection. */
  readonly configurationBindingDigest?: string
  /** Optional one-based append invocation that rejects instead of persisting. */
  readonly failAtAppend?: number
}

/** Chain metadata derived from exact preceding segment bytes. */
type SegmentChain = {
  /** SHA-256 digest of the exact preceding segment bytes. */
  readonly segmentDigest: string
  /** HMAC carried by the exact final preceding record. */
  readonly terminalRecordMac: string
}

/** Creates a conventional lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates one sanitized physical-attempt observation. */
function attemptObservation(
  sequence: number,
  observedAtMilliseconds: number,
  phase: WorkspaceSearchMigrationDescribeTablePhase = 'checkpoint-page',
): WorkspaceSearchMigrationDescribeTableRateObservation {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'attempt',
    phase,
    sequence,
    observedAtMilliseconds,
    remainingNormalAdmissionAttempts: 100 - sequence,
    remainingWindowAttempts: 9,
    remainingPageAttempts: 5,
    inFlight: 1,
  }
}

/** Creates one sanitized throttle observation for a started attempt. */
function throttleObservation(
  sequence: number,
  observedAtMilliseconds: number,
  provenance: 'aws-service' | 'rehearsal-after-success-injection' =
    'aws-service',
): WorkspaceSearchMigrationDescribeTableRateObservation {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'throttle',
    phase: 'checkpoint-page',
    sequence,
    observedAtMilliseconds,
    backoffMilliseconds: 125,
    provenance,
  }
}

/** Creates one sanitized fail-closed budget observation. */
function budgetStopObservation(
  observedAtMilliseconds: number,
  provenance:
    | 'aws-service-throttle'
    | 'operational'
    | 'rehearsal-after-success-injection' = 'aws-service-throttle',
): WorkspaceSearchMigrationDescribeTableRateObservation {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'budget-stop',
    phase: 'checkpoint-page',
    reason: provenance === 'operational' ? 'budget-capacity' : 'throttled',
    observedAtMilliseconds,
    requiredAttempts: 1,
    remainingNormalAdmissionAttempts: 0,
    remainingWindowAttempts: 0,
    retryAfterMilliseconds: 500,
    provenance,
  }
}

/** Creates one sanitized cadence-wait observation. */
function cadenceObservation(
  observedAtMilliseconds: number,
  delayMilliseconds = 50,
): WorkspaceSearchMigrationDescribeTableRateObservation {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'cadence-wait',
    phase: 'checkpoint-page',
    observedAtMilliseconds,
    delayMilliseconds,
  }
}

/** Creates and durably initializes one deterministic process segment. */
async function createStoredSegment(
  options: CreateStoredSegmentOptions,
): Promise<StoredSegment> {
  const chunks: Uint8Array[] = []
  let appendCount = 0
  const recorder = await createWorkspaceSearchMigrationRehearsalRateRecorder({
    segmentLocatorDigest: digest(`segment-${options.segmentOrdinal}`),
    segmentOrdinal: options.segmentOrdinal,
    previousSegmentDigest: options.previousSegmentDigest,
    previousRecordMac: options.previousRecordMac,
    firstEventSequence: options.firstEventSequence,
    anchorUtc: options.anchorUtc,
    monotonicAnchorMilliseconds: options.monotonicAnchorMilliseconds,
    policyVersion: options.policyVersion ?? policyVersion,
    configurationBindingDigest:
      options.configurationBindingDigest ?? configurationBindingDigest,
    authenticationKey: key,
    appendDurably: async (bytes) => {
      appendCount += 1
      if (appendCount === options.failAtAppend) {
        throw new Error('untrusted durable sink detail')
      }
      chunks.push(bytes.slice())
    },
  })
  return { recorder, chunks }
}

/** Concatenates exact canonical chunks as one append-only segment stream. */
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Reads safe chain metadata from exact canonical segment bytes. */
function readSegmentChain(bytes: Uint8Array): SegmentChain {
  const text = new TextDecoder().decode(bytes)
  const lines = text.slice(0, -1).split('\n')
  const lastLine = lines.at(-1)
  if (lastLine === undefined) throw new Error('Missing fixture record.')
  let value: unknown = JSON.parse(lastLine)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid fixture record.')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'mac')
  if (descriptor === undefined || typeof descriptor.value !== 'string') {
    throw new Error('Missing fixture MAC.')
  }
  return {
    segmentDigest: createHash('sha256').update(bytes).digest('hex'),
    terminalRecordMac: descriptor.value,
  }
}

/** Creates the independent durable-ledger aggregate expected by finalization. */
function durableEvidence(
  overrides: Partial<WorkspaceSearchMigrationDescribeTableRateEvidence> = {},
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const throttleCount = overrides.throttleCount ?? 0
  const rehearsalInjectedThrottleCount =
    overrides.rehearsalInjectedThrottleCount ?? 0
  const awsServiceThrottleCount = overrides.awsServiceThrottleCount ??
    throttleCount - rehearsalInjectedThrottleCount
  const budgetStopCount = overrides.budgetStopCount ?? 0
  const rehearsalInjectedBudgetStopCount =
    overrides.rehearsalInjectedBudgetStopCount ?? 0
  const awsServiceThrottleBudgetStopCount =
    overrides.awsServiceThrottleBudgetStopCount ??
      (awsServiceThrottleCount > 0
        ? budgetStopCount - rehearsalInjectedBudgetStopCount
        : 0)
  const operationalBudgetStopCount =
    overrides.operationalBudgetStopCount ??
      budgetStopCount -
        rehearsalInjectedBudgetStopCount -
        awsServiceThrottleBudgetStopCount
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount: 1,
    forfeitedAttemptCount: 0,
    throttleCount,
    awsServiceThrottleCount,
    rehearsalInjectedThrottleCount,
    budgetStopCount,
    operationalBudgetStopCount,
    awsServiceThrottleBudgetStopCount,
    rehearsalInjectedBudgetStopCount,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
    ...overrides,
  }
}

/** Finalizes exact stored segment chunks with the shared reviewed bindings. */
function finalize(
  segments: readonly Uint8Array[],
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
) {
  return finalizeWorkspaceSearchMigrationRehearsalRateEvidence({
    segments,
    authenticationKey: key,
    expectedPolicyVersion: policyVersion,
    expectedConfigurationBindingDigest: configurationBindingDigest,
    durableEvidence: evidence,
  })
}

describe('migration rehearsal actual DescribeTable rate evidence', () => {
  test('authenticates an exact immediate successor as a one-shot proof', async () => {
    const predecessor = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    predecessor.recorder.record(attemptObservation(1, 1_000))
    const predecessorCommitted = await predecessor.recorder.flush()
    const successor = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 3,
      previousSegmentDigest: predecessorCommitted.segmentDigest,
      previousRecordMac: predecessorCommitted.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
    })
    successor.recorder.record(
      attemptObservation(2, 2_000, 'integrity-check'),
    )
    const successorCommitted = await successor.recorder.flush()

    expect(predecessorCommitted.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    expect(successorCommitted.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    expect(new TextDecoder().decode(successorCommitted.canonicalBytes))
      .toContain('"phase":"integrity-check"')

    const verified =
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        predecessorSegmentBytes: predecessorCommitted.canonicalBytes,
        successorSegmentBytes: successorCommitted.canonicalBytes,
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      })

    expect(verified.predecessor.segmentDigest).toBe(
      predecessorCommitted.segmentDigest,
    )
    expect(verified.predecessor.terminalRecordMac).toBe(
      predecessorCommitted.terminalRecordMac,
    )
    expect(verified.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    expect(verified.predecessor.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    expect(verified.successor).toEqual({
      authenticationKeyFingerprint,
      segmentLocatorDigest: successorCommitted.segmentLocatorDigest,
      segmentOrdinal: successorCommitted.segmentOrdinal,
      firstEventSequence: successorCommitted.firstEventSequence,
      eventCount: successorCommitted.eventCount,
      firstCommittedEventSequence:
        successorCommitted.firstCommittedEventSequence,
      lastCommittedEventSequence:
        successorCommitted.lastCommittedEventSequence,
      terminalRecordMac: successorCommitted.terminalRecordMac,
      segmentDigest: successorCommitted.segmentDigest,
    })
    expect(verified.link).toEqual({
      previousSegmentDigest: predecessorCommitted.segmentDigest,
      previousRecordMac: predecessorCommitted.terminalRecordMac,
      firstEventSequence: 3,
      policyVersion,
      configurationBindingDigest,
    })
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.predecessor)).toBe(true)
    expect(Object.isFrozen(verified.successor)).toBe(true)
    expect(Object.isFrozen(verified.link)).toBe(true)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
        structuredClone(verified),
      )
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
        verified,
      )
    ).not.toThrow()
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
        verified,
      )
    ).toThrow('Invalid migration rehearsal rate evidence.')
    const evidenceProof =
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        predecessorSegmentBytes: predecessorCommitted.canonicalBytes,
        successorSegmentBytes: successorCommitted.canonicalBytes,
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      })
    const finalAggregate = durableEvidence({ attemptCount: 2 })
    const segmentEvidence =
      finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence({
        verifiedSuccessor: evidenceProof,
        durableEvidence: finalAggregate,
        completedAt: '2026-08-02T00:00:02.000Z',
      })
    expect(segmentEvidence.successor.segmentDigest).toBe(
      successorCommitted.segmentDigest,
    )
    expect(segmentEvidence.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    expect(segmentEvidence.aggregate).toEqual(finalAggregate)
    expect(segmentEvidence.aggregateDigest).toBe(
      createMigrationDigest(finalAggregate),
    )
    expect(segmentEvidence.completedAt).toBe('2026-08-02T00:00:02.000Z')
    expect(Object.isFrozen(segmentEvidence)).toBe(true)
    expect(
      readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
        structuredClone(segmentEvidence),
      ),
    ).toEqual(segmentEvidence)
    expect(() =>
      readWorkspaceSearchMigrationRehearsalRateSegmentEvidence({
        ...structuredClone(segmentEvidence),
        aggregateDigest: digest('forged-final-rate-aggregate'),
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    const {
      authenticationKeyFingerprint: _omittedAuthenticationKeyFingerprint,
      ...legacySegmentEvidence
    } = structuredClone(segmentEvidence)
    expect(() =>
      readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
        legacySegmentEvidence,
      )
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      readWorkspaceSearchMigrationRehearsalRateSegmentEvidence({
        ...structuredClone(segmentEvidence),
        predecessor: {
          ...structuredClone(segmentEvidence.predecessor),
          authenticationKeyFingerprint: digest('foreign-rate-key'),
        },
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence({
        verifiedSuccessor: evidenceProof,
        durableEvidence: finalAggregate,
        completedAt: '2026-08-02T00:00:02.000Z',
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    await predecessor.recorder.close()
    await successor.recorder.close()
  })

  test('rejects flush after close zeroizes the authentication key', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    const committed = await stored.recorder.flush()
    expect(committed.authenticationKeyFingerprint).toBe(
      authenticationKeyFingerprint,
    )
    await stored.recorder.close()
    await expect(stored.recorder.flush()).rejects.toThrow(
      'Invalid migration rehearsal rate evidence.',
    )
  })

  test('rejects authenticated but non-adjacent successor headers', async () => {
    const predecessor = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    predecessor.recorder.record(attemptObservation(1, 1_000))
    const predecessorCommitted = await predecessor.recorder.flush()

    /** Creates, authenticates, and closes one deliberately invalid successor. */
    async function expectInvalidSuccessor(
      overrides: Partial<CreateStoredSegmentOptions>,
    ): Promise<void> {
      const successor = await createStoredSegment({
        segmentOrdinal: 1,
        firstEventSequence: 3,
        previousSegmentDigest: predecessorCommitted.segmentDigest,
        previousRecordMac: predecessorCommitted.terminalRecordMac,
        anchorUtc: '2026-08-02T00:00:01.000Z',
        monotonicAnchorMilliseconds: 2_000,
        ...overrides,
      })
      successor.recorder.record(attemptObservation(2, 2_000))
      const successorCommitted = await successor.recorder.flush()
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
          predecessorSegmentBytes: predecessorCommitted.canonicalBytes,
          successorSegmentBytes: successorCommitted.canonicalBytes,
          authenticationKey: key,
          expectedPolicyVersion: policyVersion,
          expectedConfigurationBindingDigest: configurationBindingDigest,
        })
      ).toThrow('Invalid migration rehearsal rate evidence.')
      await successor.recorder.close()
    }

    await expectInvalidSuccessor({
      previousSegmentDigest: digest('foreign-predecessor-segment'),
    })
    await expectInvalidSuccessor({
      previousRecordMac: digest('foreign-predecessor-terminal-record'),
    })
    await expectInvalidSuccessor({ segmentOrdinal: 2 })
    await expectInvalidSuccessor({ firstEventSequence: 4 })
    await expectInvalidSuccessor({
      policyVersion: digest('foreign-rate-policy'),
    })
    await expectInvalidSuccessor({
      configurationBindingDigest: digest('foreign-configuration'),
    })
    await expectInvalidSuccessor({
      anchorUtc: '2026-08-01T23:59:59.999Z',
    })
    await predecessor.recorder.close()
  })

  test('rejects tampered successor bytes and a foreign runtime key', async () => {
    const predecessor = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    predecessor.recorder.record(attemptObservation(1, 1_000))
    const predecessorCommitted = await predecessor.recorder.flush()
    const successor = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 3,
      previousSegmentDigest: predecessorCommitted.segmentDigest,
      previousRecordMac: predecessorCommitted.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
    })
    successor.recorder.record(attemptObservation(2, 2_000))
    const successorCommitted = await successor.recorder.flush()
    const tampered = successorCommitted.canonicalBytes.slice()
    const replacement = new TextEncoder().encode('9')[0]
    if (replacement === undefined) throw new Error('Missing fixture byte.')
    tampered[tampered.byteLength - 3] = replacement
    const commonInput = {
      predecessorSegmentBytes: predecessorCommitted.canonicalBytes,
      expectedPolicyVersion: policyVersion,
      expectedConfigurationBindingDigest: configurationBindingDigest,
    }
    const successorText = new TextDecoder().decode(
      successorCommitted.canonicalBytes,
    )
    const legacySuccessorText = successorText.replace(
      `"authenticationKeyFingerprint":"${authenticationKeyFingerprint}",`,
      '',
    )
    if (legacySuccessorText === successorText) {
      throw new Error('Expected to remove the header key fingerprint fixture.')
    }

    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        ...commonInput,
        successorSegmentBytes: tampered,
        authenticationKey: key,
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        ...commonInput,
        successorSegmentBytes: new TextEncoder().encode(legacySuccessorText),
        authenticationKey: key,
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        ...commonInput,
        successorSegmentBytes: successorCommitted.canonicalBytes,
        authenticationKey: new Uint8Array(32).fill(99),
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
    await predecessor.recorder.close()
    await successor.recorder.close()
  })

  test('rejects an authenticated unpublished v1 segment contract', () => {
    const legacyFingerprint = createHmac('sha256', key)
      .update(
        'mukuroji:workspace-search-migration:rehearsal-rate-authentication-key-fingerprint:v1',
        'utf8',
      )
      .digest('hex')
    const legacyHeaderPayload = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
      version: 1,
      authenticationKeyFingerprint: legacyFingerprint,
      segmentLocatorDigest: digest('legacy-v1-rate-segment'),
      segmentOrdinal: 0,
      previousSegmentDigest: null,
      previousRecordMac: null,
      firstEventSequence: 1,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      policyVersion,
      configurationBindingDigest,
    })
    const legacyHeaderMac = createHmac('sha256', key)
      .update(
        'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
        'utf8',
      )
      .update('\0', 'utf8')
      .update(serializeCanonicalJson(legacyHeaderPayload), 'utf8')
      .digest('hex')
    const legacyBytes = new TextEncoder().encode(
      `${serializeCanonicalJson({
        ...legacyHeaderPayload,
        mac: legacyHeaderMac,
      })}\n`,
    )

    expect(() =>
      recoverWorkspaceSearchMigrationRehearsalRateContinuation({
        previousSegmentBytes: legacyBytes,
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      })
    ).toThrow('Invalid migration rehearsal rate evidence.')
  })

  test('recovers exact successor metadata from an authenticated complete SIGKILL prefix', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000))
    const committed = await stored.recorder.flush()
    const interrupted = new Uint8Array(committed.canonicalBytes.byteLength + 7)
    interrupted.set(committed.canonicalBytes)
    interrupted.set(new TextEncoder().encode('{"part'), committed.canonicalBytes.byteLength)

    const continuation =
      recoverWorkspaceSearchMigrationRehearsalRateContinuation({
        previousSegmentBytes: interrupted,
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      })

    expect(continuation.segmentOrdinal).toBe(1)
    expect(continuation.firstEventSequence).toBe(3)
    expect(continuation.previousSegmentDigest).toBe(committed.segmentDigest)
    expect(continuation.previousRecordMac).toBe(committed.terminalRecordMac)
    expect(continuation.canonicalPreviousSegmentBytes).toEqual(
      committed.canonicalBytes,
    )
    expect(continuation.discardedTrailingByteLength).toBe(7)
    expect(continuation.pendingAttempt).toBeNull()
    await stored.recorder.close()
  })

  test('recovers the authenticated pending charge needed for restart forfeiture', async () => {
    const killed = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
      failAtAppend: 3,
    })
    killed.recorder.record(attemptObservation(1, 1_000))
    await expect(killed.recorder.flush()).rejects.toThrow(
      'append was not confirmed',
    )

    const continuation =
      recoverWorkspaceSearchMigrationRehearsalRateContinuation({
        previousSegmentBytes: concatenate(killed.chunks),
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      })

    expect(continuation.firstEventSequence).toBe(2)
    expect(continuation.pendingAttempt).toEqual({
      attemptSequence: 1,
      phase: 'checkpoint-page',
    })
    await expect(killed.recorder.close()).rejects.toThrow(
      'append was not confirmed',
    )
  })

  test('rejects a complete tampered predecessor record and binding/key drift', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000))
    const committed = await stored.recorder.flush()
    const tampered = committed.canonicalBytes.slice()
    tampered[tampered.byteLength - 3] = 0x39

    for (const input of [
      {
        previousSegmentBytes: tampered,
        authenticationKey: key,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      },
      {
        previousSegmentBytes: committed.canonicalBytes,
        authenticationKey: new Uint8Array(32).fill(9),
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      },
      {
        previousSegmentBytes: committed.canonicalBytes,
        authenticationKey: key,
        expectedPolicyVersion: digest('wrong-policy'),
        expectedConfigurationBindingDigest: configurationBindingDigest,
      },
    ]) {
      expect(() =>
        recoverWorkspaceSearchMigrationRehearsalRateContinuation(input)
      ).toThrow('Invalid migration rehearsal rate evidence.')
    }
    await stored.recorder.close()
  })

  test('recalculates throttle, budget-stop, cadence, forfeiture, and sliding rate', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000))
    stored.recorder.record(attemptObservation(2, 1_400))
    stored.recorder.record(throttleObservation(2, 1_401))
    stored.recorder.record(budgetStopObservation(1_450))
    stored.recorder.record(cadenceObservation(1_500))
    stored.recorder.record(attemptObservation(3, 1_999))
    stored.recorder.record(attemptObservation(4, 2_000))
    stored.recorder.record(attemptObservation(5, 2_400))
    await stored.recorder.appendForfeitedReservation({
      forfeitedAttemptCount: 2,
      observedAtMilliseconds: 2_401,
    })
    const committed = await stored.recorder.flush()
    const result = finalize(
      [committed.canonicalBytes],
      durableEvidence({
        attemptCount: 5,
        forfeitedAttemptCount: 2,
        throttleCount: 1,
        budgetStopCount: 1,
        cadenceWaitCount: 1,
        cadenceWaitMilliseconds: 50,
      }),
    )

    expect(result.evidence.aggregate).toEqual({
      version: 2,
      policyVersion,
      attemptCount: 5,
      forfeitedAttemptCount: 2,
      throttleCount: 1,
      awsServiceThrottleCount: 1,
      rehearsalInjectedThrottleCount: 0,
      budgetStopCount: 1,
      operationalBudgetStopCount: 0,
      awsServiceThrottleBudgetStopCount: 1,
      rehearsalInjectedBudgetStopCount: 0,
      cadenceWaitCount: 1,
      cadenceWaitMilliseconds: 50,
      maximumInFlight: 1,
    })
    expect(result.evidence.observedMaximumRatePerSecond).toBe(3)
    expect(result.startedAttemptCount).toBe(5)
    expect(result.observationCount).toBe(14)
    expect(result.evidence.aggregateDigest).toBe(
      digest(serializeCanonicalJson(result.evidence.aggregate)),
    )
    expect(result.evidence.observationStreamDigest).toBe(result.artifactDigest)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.evidence)).toBe(true)
    expect(Object.isFrozen(result.evidence.aggregate)).toBe(true)
    const artifactText = new TextDecoder().decode(
      result.canonicalArtifactBytes,
    )
    let artifactValue: unknown = JSON.parse(artifactText)
    expect(serializeCanonicalJson(artifactValue)).toBe(artifactText)
    await stored.recorder.close()
  })

  test('separates the deterministic post-success exercise from zero AWS throttles', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000, 'measurement'))
    stored.recorder.record(throttleObservation(
      1,
      1_001,
      'rehearsal-after-success-injection',
    ))
    stored.recorder.record(budgetStopObservation(
      1_002,
      'rehearsal-after-success-injection',
    ))
    const committed = await stored.recorder.flush()
    const result = finalize(
      [committed.canonicalBytes],
      durableEvidence({
        throttleCount: 1,
        awsServiceThrottleCount: 0,
        rehearsalInjectedThrottleCount: 1,
        budgetStopCount: 1,
        operationalBudgetStopCount: 0,
        awsServiceThrottleBudgetStopCount: 0,
        rehearsalInjectedBudgetStopCount: 1,
      }),
    )

    expect(result.evidence.aggregate.awsServiceThrottleCount).toBe(0)
    expect(result.evidence.aggregate.rehearsalInjectedThrottleCount).toBe(1)
    expect(result.evidence.aggregate.rehearsalInjectedBudgetStopCount).toBe(1)
    expect(result.evidence.observedMaximumRatePerSecond).toBe(1)
    expect(result.startedAttemptCount).toBe(1)
    await stored.recorder.close()
  })

  test('rejects unknown or semantically mismatched observation provenance', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000))
    Reflect.apply(stored.recorder.record, stored.recorder, [{
      ...throttleObservation(1, 1_001),
      provenance: 'unknown',
    }])
    await expect(stored.recorder.flush()).rejects.toThrow(
      'Invalid migration rehearsal rate evidence.',
    )

    const mismatch = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    Reflect.apply(mismatch.recorder.record, mismatch.recorder, [{
      ...budgetStopObservation(1_002, 'operational'),
      reason: 'throttled',
    }])
    await expect(mismatch.recorder.flush()).rejects.toThrow(
      'Invalid migration rehearsal rate evidence.',
    )
    await expect(stored.recorder.close()).rejects.toThrow(
      'Invalid migration rehearsal rate evidence.',
    )
    await expect(mismatch.recorder.close()).rejects.toThrow(
      'Invalid migration rehearsal rate evidence.',
    )
  })

  test('rejects sequence, source-pair, and durable source-total mismatches', async () => {
    const wrongSequence = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    wrongSequence.recorder.record(attemptObservation(1, 1_000))
    wrongSequence.recorder.record(throttleObservation(2, 1_001))
    wrongSequence.recorder.record(budgetStopObservation(1_002))
    const wrongSequenceCommitted = await wrongSequence.recorder.flush()
    expect(() => finalize(
      [wrongSequenceCommitted.canonicalBytes],
      durableEvidence({ throttleCount: 1, budgetStopCount: 1 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')

    const wrongPair = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    wrongPair.recorder.record(attemptObservation(1, 1_000))
    wrongPair.recorder.record(throttleObservation(1, 1_001))
    wrongPair.recorder.record(budgetStopObservation(
      1_002,
      'rehearsal-after-success-injection',
    ))
    const wrongPairCommitted = await wrongPair.recorder.flush()
    expect(() => finalize(
      [wrongPairCommitted.canonicalBytes],
      durableEvidence({ throttleCount: 1, budgetStopCount: 1 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')

    const correctPair = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    correctPair.recorder.record(attemptObservation(1, 1_000))
    correctPair.recorder.record(throttleObservation(1, 1_001))
    correctPair.recorder.record(budgetStopObservation(1_002))
    const correctPairCommitted = await correctPair.recorder.flush()
    expect(() => finalize(
      [correctPairCommitted.canonicalBytes],
      durableEvidence({
        throttleCount: 1,
        awsServiceThrottleCount: 0,
        budgetStopCount: 1,
        awsServiceThrottleBudgetStopCount: 1,
      }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await wrongSequence.recorder.close()
    await wrongPair.recorder.close()
    await correctPair.recorder.close()
  })

  test('joins a SIGKILL cutoff only after restart forfeits the durable charge', async () => {
    const killed = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 10_000,
      failAtAppend: 3,
    })
    killed.recorder.record(attemptObservation(1, 10_000))
    await expect(killed.recorder.flush()).rejects.toThrow(
      'append was not confirmed',
    )
    const killedBytes = concatenate(killed.chunks)
    const chain = readSegmentChain(killedBytes)

    const restarted = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 2,
      previousSegmentDigest: chain.segmentDigest,
      previousRecordMac: chain.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 20_000,
    })
    await restarted.recorder.appendForfeitedAttempt({
      attemptSequence: 1,
      phase: 'checkpoint-page',
      observedAtMilliseconds: 20_000,
    })
    restarted.recorder.record(attemptObservation(2, 20_001))
    restarted.recorder.record(throttleObservation(2, 20_002))
    restarted.recorder.record(budgetStopObservation(20_003))
    const resumed = await restarted.recorder.flush()
    const result = finalize(
      [killedBytes, resumed.canonicalBytes],
      durableEvidence({
        attemptCount: 2,
        throttleCount: 1,
        budgetStopCount: 1,
      }),
    )

    expect(result.segmentCount).toBe(2)
    expect(result.startedAttemptCount).toBe(1)
    expect(result.evidence.aggregate.attemptCount).toBe(2)
    expect(result.evidence.aggregate.forfeitedAttemptCount).toBe(0)
    await restarted.recorder.close()
    await expect(killed.recorder.close()).rejects.toThrow(
      'append was not confirmed',
    )
  })

  test.each([
    ['gap', 4],
    ['duplicate', 2],
  ])('rejects a global event-sequence %s across process segments', async (
    _label,
    secondFirstEventSequence,
  ) => {
    const first = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    first.recorder.record(attemptObservation(1, 1_000))
    const firstCommitted = await first.recorder.flush()
    const second = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: secondFirstEventSequence,
      previousSegmentDigest: firstCommitted.segmentDigest,
      previousRecordMac: firstCommitted.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
    })
    second.recorder.record(attemptObservation(2, 2_000))
    const secondCommitted = await second.recorder.flush()

    expect(() => finalize(
      [firstCommitted.canonicalBytes, secondCommitted.canonicalBytes],
      durableEvidence({ attemptCount: 2 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await first.recorder.close()
    await second.recorder.close()
  })

  test.each([
    ['policy', digest('drifted-policy'), configurationBindingDigest],
    ['configuration', policyVersion, digest('drifted-configuration')],
  ])('rejects authenticated %s binding drift', async (
    _label,
    secondPolicyVersion,
    secondConfigurationBindingDigest,
  ) => {
    const first = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    first.recorder.record(attemptObservation(1, 1_000))
    const firstCommitted = await first.recorder.flush()
    const second = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 3,
      previousSegmentDigest: firstCommitted.segmentDigest,
      previousRecordMac: firstCommitted.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
      policyVersion: secondPolicyVersion,
      configurationBindingDigest: secondConfigurationBindingDigest,
    })
    second.recorder.record(attemptObservation(2, 2_000))
    const secondCommitted = await second.recorder.flush()

    expect(() => finalize(
      [firstCommitted.canonicalBytes, secondCommitted.canonicalBytes],
      durableEvidence({ attemptCount: 2 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await first.recorder.close()
    await second.recorder.close()
  })

  test('rejects segment UTC and event-time regression after restart', async () => {
    const first = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:02.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    first.recorder.record(attemptObservation(1, 1_500))
    const firstCommitted = await first.recorder.flush()
    const second = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 3,
      previousSegmentDigest: firstCommitted.segmentDigest,
      previousRecordMac: firstCommitted.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
    })
    second.recorder.record(attemptObservation(2, 2_000))
    const secondCommitted = await second.recorder.flush()

    expect(() => finalize(
      [firstCommitted.canonicalBytes, secondCommitted.canonicalBytes],
      durableEvidence({ attemptCount: 2 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await first.recorder.close()
    await second.recorder.close()
  })

  test('rejects canonical-byte tampering and a foreign authentication key', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    stored.recorder.record(attemptObservation(1, 1_000))
    const committed = await stored.recorder.flush()
    const tampered = committed.canonicalBytes.slice()
    const digit = new TextEncoder().encode('9')[0]
    if (digit === undefined) throw new Error('Missing fixture byte.')
    tampered[tampered.byteLength - 3] = digit

    expect(() => finalize(
      [tampered],
      durableEvidence(),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() => finalizeWorkspaceSearchMigrationRehearsalRateEvidence({
      segments: [committed.canonicalBytes],
      authenticationKey: new Uint8Array(32).fill(99),
      expectedPolicyVersion: policyVersion,
      expectedConfigurationBindingDigest: configurationBindingDigest,
      durableEvidence: durableEvidence(),
    })).toThrow('Invalid migration rehearsal rate evidence.')
    await stored.recorder.close()
  })

  test('rejects an unresolved charge and a mismatched durable ledger aggregate', async () => {
    const killed = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
      failAtAppend: 3,
    })
    killed.recorder.record(attemptObservation(1, 1_000))
    await expect(killed.recorder.flush()).rejects.toThrow()
    const killedBytes = concatenate(killed.chunks)
    expect(() => finalize([killedBytes], durableEvidence())).toThrow(
      'Invalid migration rehearsal rate evidence.',
    )

    const complete = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    complete.recorder.record(attemptObservation(1, 1_000))
    const committed = await complete.recorder.flush()
    expect(() => finalize(
      [committed.canonicalBytes],
      durableEvidence({ throttleCount: 1 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await complete.recorder.close()
    await expect(killed.recorder.close()).rejects.toThrow()
  })

  test('rejects evidence whose authenticated stream omits a throttle or budget stop', async () => {
    const withoutThrottle = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    withoutThrottle.recorder.record(attemptObservation(1, 1_000))
    withoutThrottle.recorder.record(budgetStopObservation(1_001))
    const withoutThrottleCommitted = await withoutThrottle.recorder.flush()
    expect(() => finalize(
      [withoutThrottleCommitted.canonicalBytes],
      durableEvidence({ budgetStopCount: 1 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')

    const withoutBudgetStop = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
    })
    withoutBudgetStop.recorder.record(attemptObservation(1, 1_000))
    withoutBudgetStop.recorder.record(throttleObservation(1, 1_001))
    const withoutBudgetStopCommitted = await withoutBudgetStop.recorder.flush()
    expect(() => finalize(
      [withoutBudgetStopCommitted.canonicalBytes],
      durableEvidence({ throttleCount: 1 }),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await withoutThrottle.recorder.close()
    await withoutBudgetStop.recorder.close()
  })

  test('rejects a stream containing only a conservatively forfeited charge', async () => {
    const killed = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 1_000,
      failAtAppend: 3,
    })
    killed.recorder.record(attemptObservation(1, 1_000))
    await expect(killed.recorder.flush()).rejects.toThrow()
    const killedBytes = concatenate(killed.chunks)
    const chain = readSegmentChain(killedBytes)
    const restarted = await createStoredSegment({
      segmentOrdinal: 1,
      firstEventSequence: 2,
      previousSegmentDigest: chain.segmentDigest,
      previousRecordMac: chain.terminalRecordMac,
      anchorUtc: '2026-08-02T00:00:01.000Z',
      monotonicAnchorMilliseconds: 2_000,
    })
    await restarted.recorder.appendForfeitedAttempt({
      attemptSequence: 1,
      phase: 'checkpoint-page',
      observedAtMilliseconds: 2_000,
    })
    const restartedCommitted = await restarted.recorder.flush()

    expect(() => finalize(
      [killedBytes, restartedCommitted.canonicalBytes],
      durableEvidence(),
    )).toThrow('Invalid migration rehearsal rate evidence.')
    await expect(killed.recorder.close()).rejects.toThrow()
    await restarted.recorder.close()
  })

  test('counts exact-boundary starts in distinct one-second windows', async () => {
    const stored = await createStoredSegment({
      segmentOrdinal: 0,
      firstEventSequence: 1,
      previousSegmentDigest: null,
      previousRecordMac: null,
      anchorUtc: '2026-08-02T00:00:00.000Z',
      monotonicAnchorMilliseconds: 0,
    })
    stored.recorder.record(attemptObservation(1, 0))
    stored.recorder.record(attemptObservation(2, 999))
    stored.recorder.record(attemptObservation(3, 1_000))
    stored.recorder.record(throttleObservation(3, 1_001))
    stored.recorder.record(budgetStopObservation(1_002))
    const committed = await stored.recorder.flush()
    const result = finalize(
      [committed.canonicalBytes],
      durableEvidence({
        attemptCount: 3,
        throttleCount: 1,
        budgetStopCount: 1,
      }),
    )

    expect(result.evidence.observedMaximumRatePerSecond).toBe(2)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence(
        structuredClone(result),
      )
    ).toThrow('Invalid migration rehearsal rate evidence.')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence(result)
    ).not.toThrow()
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence(result)
    ).toThrow('Invalid migration rehearsal rate evidence.')
    await stored.recorder.close()
  })
})
