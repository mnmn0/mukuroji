import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { createMigrationDigest } from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
  WorkspaceSearchMigrationRehearsalPermitValidity,
} from './migration-identity-aws'
import type {
  WorkspaceSearchMigrationRehearsalArtifactAwsPublisher,
} from './migration-rehearsal-artifact-aws'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceIndex,
  serializeWorkspaceSearchMigrationRehearsalEvidenceIndex,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS,
  type WorkspaceSearchMigrationRehearsalArtifactEvidence,
  type WorkspaceSearchMigrationRehearsalAttestationEvidence,
} from './migration-rehearsal-evidence'
import type {
  WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher,
  WorkspaceSearchMigrationRehearsalEvidencePublication,
  WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
} from './migration-rehearsal-evidence-aws'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  type WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  type WorkspaceSearchMigrationRehearsalSuitePublicationBindings,
  type WorkspaceSearchMigrationRehearsalSuitePublicationMaterial,
} from './migration-rehearsal-suite-finalizer'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for one completed secret-free publication result. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-publication-result'

/** First complete prepare, publish, finalize, and index publication flow. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_VERSION = 1

/** Fixed Object Lock duration after the canonical suite completion time. */
const publicationRetentionMilliseconds = 366 * 24 * 60 * 60 * 1_000

/** Minimum Object Lock duration measured from the actual publication clock. */
const minimumRemainingRetentionMilliseconds = 365 * 24 * 60 * 60 * 1_000

/** Headroom preventing IAM whole-day rounding from dropping below 365. */
const remainingRetentionHeadroomMilliseconds = 12 * 60 * 60 * 1_000

/** Maximum finite timeout forwarded to either immutable S3 publisher. */
const maximumRequestTimeoutMilliseconds = 30_000

/** Exact dedicated evidence key length consumed by one publication. */
const evidenceKeyByteLength = 32

/** Exact public orchestration input fields. */
const publicationInputKeys = Object.freeze([
  'clock',
  'evidenceSigningKey',
  'requestTimeoutMilliseconds',
  'session',
  'suite',
])

/** Exact complete live DescribeTable aggregate fields. */
const liveRateEvidenceKeys = Object.freeze([
  'attemptCount',
  'awsServiceThrottleBudgetStopCount',
  'awsServiceThrottleCount',
  'budgetStopCount',
  'cadenceWaitCount',
  'cadenceWaitMilliseconds',
  'forfeitedAttemptCount',
  'maximumInFlight',
  'operationalBudgetStopCount',
  'policyVersion',
  'rehearsalInjectedBudgetStopCount',
  'rehearsalInjectedThrottleCount',
  'throttleCount',
  'version',
])

/** Stable secret-free failures raised by the orchestration boundary. */
export type WorkspaceSearchMigrationRehearsalPublicationFailureCode =
  | 'CAPABILITY_CLOSE_FAILED'
  | 'INVALID_ARGUMENT'
  | 'PUBLICATION_FAILED'
  | 'SESSION_BINDING_MISMATCH'

/**
 * Minimal authenticated session capability consumed by final publication.
 *
 * A full `WorkspaceSearchMigrationNonProductionRehearsalAwsSession` is
 * structurally compatible. No mutation, table, or raw transport surface is
 * accepted by this orchestration boundary.
 */
export interface WorkspaceSearchMigrationRehearsalPublicationSession {
  /** Creates the journal-bound immutable child-artifact publisher. */
  readonly createRehearsalArtifactPublisher:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
      'createRehearsalArtifactPublisher'
    ]
  /** Creates the journal-bound immutable evidence-index publisher. */
  readonly createRehearsalEvidencePublisher:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
      'createRehearsalEvidencePublisher'
    ]
  /** Reads digest-only permit, caller, resource, commit, and key facts. */
  readonly readRehearsalEvidenceSessionBinding:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
      'readRehearsalEvidenceSessionBinding'
    ]
  /** Reads the current actual-rate aggregate and reviewed policy digest. */
  readonly readDescribeTableRateEvidence:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
      'readDescribeTableRateEvidence'
    ]
  /** Reads the permit interval containing first-stage start through completion. */
  readonly readRehearsalPermitValidity:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
      'readRehearsalPermitValidity'
    ]
  /** Drains and closes all session-owned AWS capabilities. */
  readonly close: WorkspaceSearchMigrationNonProductionRehearsalAwsSession[
    'close'
  ]
}

/** Raw-value-free failure for the complete evidence publication flow. */
export class WorkspaceSearchMigrationRehearsalPublicationError extends Error {
  /** Stable secret-free failure category. */
  readonly code: WorkspaceSearchMigrationRehearsalPublicationFailureCode

  /**
   * Creates one stable publication failure.
   *
   * @param code - Secret-free failure category.
   */
  constructor(code: WorkspaceSearchMigrationRehearsalPublicationFailureCode) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalPublicationError'
    this.code = code
  }
}

/** Private marker for a live publisher clock that reversed or left its permit. */
class PublicationClockDrift extends Error {
  /** Creates one raw-value-free live-clock failure. */
  constructor() {
    super('PUBLICATION_CLOCK_DRIFT')
    this.name = 'PublicationClockDrift'
  }
}

/**
 * Ownership-transferring input for one complete immutable publication.
 *
 * The session must already have authenticated its non-production permit, STS
 * caller, journal tags, exact requested resources, and measured configuration.
 * The signing-key buffer and session both transfer to this invocation and are
 * zeroized or closed before the returned promise settles.
 */
export type PublishWorkspaceSearchMigrationRehearsalSuiteInput = {
  /** Authentic one-shot suite preparation consumed before child publication. */
  readonly suite: WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation
  /** Already authenticated and measured non-production session capability. */
  readonly session: WorkspaceSearchMigrationRehearsalPublicationSession
  /** Dedicated raw 32-byte evidence HMAC key whose ownership transfers here. */
  readonly evidenceSigningKey: Uint8Array
  /** Trusted clock shared by the session permit and immutable publishers. */
  readonly clock: () => Date
  /** Positive finite deadline for every individual immutable S3 request. */
  readonly requestTimeoutMilliseconds: number
}

/** Identifier-free result safe to emit outside restricted operator state. */
export type WorkspaceSearchMigrationRehearsalPublicationResult = {
  /** Stable publication-result discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_RESULT_KIND
  /** Strict complete-publication contract version. */
  readonly publicationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_VERSION
  /** Exact number of immutable canonical child artifacts. */
  readonly artifactCount: 10
  /** Digest binding every exact immutable child reference in canonical order. */
  readonly artifactManifestDigest: string
  /** Exact canonical evidence-index byte length. */
  readonly byteLength: number
  /** SHA-256 digest of the exact canonical evidence-index bytes. */
  readonly contentDigest: string
  /** Domain-separated digest of the exact immutable evidence object version. */
  readonly immutableVersionDigest: string
  /** Digest binding the evidence bucket, object, version, and KMS identity. */
  readonly storageLocatorDigest: string
  /** Canonical UTC Object Lock deadline shared by index and child artifacts. */
  readonly retainedUntil: string
}

/** Captured receiver-preserving methods from the transferred session. */
type CapturedPublicationSession = {
  /** Creates one session-bound immutable child publisher. */
  readonly createArtifactPublisher:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'createRehearsalArtifactPublisher'
    ]
  /** Creates one session-bound immutable index publisher. */
  readonly createEvidencePublisher:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'createRehearsalEvidencePublisher'
    ]
  /** Reads the measured permit, caller, resource, commit, and key binding. */
  readonly readEvidenceBinding:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readRehearsalEvidenceSessionBinding'
    ]
  /** Reads the current rate policy and actual aggregate projection. */
  readonly readRateEvidence:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readDescribeTableRateEvidence'
    ]
  /** Reads the authenticated inclusive issue and exclusive expiry bounds. */
  readonly readPermitValidity:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readRehearsalPermitValidity'
    ]
  /** Drains and closes every session-owned transport. */
  readonly close: WorkspaceSearchMigrationRehearsalPublicationSession[
    'close'
  ]
}

/** Detached safe invocation state captured before semantic preparation. */
type PreparedPublicationInput = {
  /** One-shot material detached from the authentic suite capability. */
  readonly suite: WorkspaceSearchMigrationRehearsalSuitePublicationMaterial
  /** Receiver-preserving transferred non-production capability. */
  readonly session: CapturedPublicationSession
  /** Detached signing-key copy used only to create the HMAC index. */
  readonly signingKey: Uint8Array
  /** Detached verification-key copy transferred to the S3 publisher. */
  readonly verificationKey: Uint8Array
  /** SHA-256 digest of the parent-only final-publication key. */
  readonly publicationKeyDigest: string
  /** Captured trusted publisher clock. */
  readonly clock: () => Date
  /** Captured finite S3 request timeout. */
  readonly requestTimeoutMilliseconds: number
}

/** Parsed strict measured-session binding. */
type ParsedEvidenceSessionBinding = {
  /** Exact reviewed commit authenticated by the permit. */
  readonly commit: string
  /** Exact measured configuration digest. */
  readonly configurationHash: string
  /** SHA-256 digest of the child/runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the parent-only final-publication key. */
  readonly publicationKeyDigest: string
  /** Detached exact non-production attestations. */
  readonly attestation: WorkspaceSearchMigrationRehearsalAttestationEvidence
}

/** Fixed retention and monotonic permit-contained publisher clock. */
type PreparedPublicationTiming = {
  /** One immutable deadline fixed before the first child publication. */
  readonly retainedUntil: string
  /** Shared guarded live clock used by both immutable publishers. */
  readonly clock: () => Date
}

/** Strict detached live durable DescribeTable aggregate. */
type ParsedLiveRateEvidence =
  WorkspaceSearchMigrationDescribeTableRateEvidence

/** Strict guards bound to this module's stable invalid-argument failure. */
const publicationGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failPublication('INVALID_ARGUMENT'),
)

/** Strict guards bound to authenticated-session drift classification. */
const sessionBindingGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failPublication('SESSION_BINDING_MISMATCH'),
)

/**
 * Publishes one complete rehearsal using the mandatory two-phase invariant.
 *
 * All ten canonical child artifacts are semantically prepared before the
 * first PutObject. Their immutable references are then fed back into the suite
 * finalizer, the complete claims are HMAC-signed, and only then is the final
 * index published. No bucket name, object key, account, role, cursor, owner,
 * resource name, or key material is returned.
 *
 * @param input - Transferred suite, non-production session, key, and bounds.
 * @returns Secret-free immutable digest and locator result after all close.
 * @throws {WorkspaceSearchMigrationRehearsalPublicationError} On invalid
 * input, session drift, publication failure, or capability-close failure.
 */
export async function publishWorkspaceSearchMigrationRehearsalSuite(
  input: PublishWorkspaceSearchMigrationRehearsalSuiteInput,
): Promise<WorkspaceSearchMigrationRehearsalPublicationResult> {
  let prepared: PreparedPublicationInput | undefined
  let transferredSession: CapturedPublicationSession | undefined
  let artifactPublisher:
    WorkspaceSearchMigrationRehearsalArtifactAwsPublisher | undefined
  let evidencePublisher:
    WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher | undefined
  let result: WorkspaceSearchMigrationRehearsalPublicationResult | undefined
  let primaryFailure: unknown
  let failed = false

  try {
    transferredSession = captureTransferredSession(input)
    prepared = preparePublicationInput(input, transferredSession)
    const artifacts = prepared.suite.artifacts
    const sessionBinding = readSessionBinding(
      prepared.session.readEvidenceBinding(),
    )
    const permitValidity = readPermitValidity(
      prepared.session.readPermitValidity(),
    )
    const liveRateEvidence = readLiveRateEvidence(
      prepared.session.readRateEvidence(),
    )
    requireSessionBinding(
      prepared.suite.bindings,
      sessionBinding,
      prepared.publicationKeyDigest,
      liveRateEvidence,
      permitValidity,
    )
    const timing = createPublicationTiming(
      prepared.suite.bindings.completedAt,
      permitValidity,
      prepared.clock,
    )
    const retainedUntil = timing.retainedUntil
    artifactPublisher = prepared.session.createArtifactPublisher({
      clock: timing.clock,
      requestTimeoutMilliseconds: prepared.requestTimeoutMilliseconds,
    })
    const publishedArtifacts: WorkspaceSearchMigrationRehearsalArtifactEvidence[] = []
    for (const artifact of artifacts) {
      publishedArtifacts.push(await artifactPublisher.publishArtifact({
        artifactBytes: artifact.canonicalBytes,
        completedAt: prepared.suite.bindings.completedAt,
        kind: artifact.kind,
        retainedUntil,
      }))
    }
    const detachedArtifacts = Object.freeze(publishedArtifacts.map(
      (artifact) => Object.freeze({ ...artifact }),
    ))
    const claims = prepared.suite.finalize(detachedArtifacts)
    const evidenceIndex = createWorkspaceSearchMigrationRehearsalEvidenceIndex({
      evidence: claims,
      signingKey: prepared.signingKey,
    })
    zeroizeKey(prepared.signingKey)
    const evidenceBytes =
      serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(evidenceIndex)
    evidencePublisher = prepared.session.createEvidencePublisher({
      clock: timing.clock,
      requestTimeoutMilliseconds: prepared.requestTimeoutMilliseconds,
    })
    const publication = await evidencePublisher.publishEvidence({
      evidenceBytes,
      retainedUntil,
      verificationKey: prepared.verificationKey,
    })
    result = createPublicationResult(
      publication,
      detachedArtifacts,
    )
  } catch (error: unknown) {
    failed = true
    primaryFailure = error
  }

  const closeFailure = await closePublicationCapabilities(
    evidencePublisher,
    artifactPublisher,
    prepared?.session ?? transferredSession,
  )
  zeroizeKey(prepared?.signingKey)
  zeroizeKey(prepared?.verificationKey)

  if (failed) {
    throw normalizePublicationFailure(primaryFailure)
  }
  if (closeFailure !== undefined) {
    throw new WorkspaceSearchMigrationRehearsalPublicationError(
      'CAPABILITY_CLOSE_FAILED',
    )
  }
  if (result === undefined) return failPublication('PUBLICATION_FAILED')
  return result
}

/** Captures, validates, detaches, and consumes all caller-owned input. */
function preparePublicationInput(
  input: PublishWorkspaceSearchMigrationRehearsalSuiteInput,
  session: CapturedPublicationSession,
): PreparedPublicationInput {
  const keys = consumeEvidenceKey(input.evidenceSigningKey)
  const requestTimeoutMilliseconds = input.requestTimeoutMilliseconds
  try {
    if (
      !Number.isSafeInteger(requestTimeoutMilliseconds) ||
      requestTimeoutMilliseconds <= 0 ||
      requestTimeoutMilliseconds > maximumRequestTimeoutMilliseconds ||
      !isDirectFunction(input.clock)
    ) {
      return failPublication('INVALID_ARGUMENT')
    }
    const suite =
      consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
        input.suite,
      )
    return Object.freeze({
      suite,
      session,
      signingKey: keys.signingKey,
      verificationKey: keys.verificationKey,
      publicationKeyDigest: keys.digest,
      clock: input.clock,
      requestTimeoutMilliseconds,
    })
  } catch {
    zeroizeKey(keys.signingKey)
    zeroizeKey(keys.verificationKey)
    return failPublication('INVALID_ARGUMENT')
  }
}

/** Validates the envelope before capturing its transferred session. */
function captureTransferredSession(
  input: PublishWorkspaceSearchMigrationRehearsalSuiteInput,
): CapturedPublicationSession {
  const record = publicationGuards.requireRecord(input)
  publicationGuards.requireExactKeys(record, publicationInputKeys)
  return capturePublicationSession(input.session)
}

/** Captures receiver-preserving direct methods from one transferred session. */
function capturePublicationSession(
  session: WorkspaceSearchMigrationRehearsalPublicationSession,
): CapturedPublicationSession {
  if (
    typeof session !== 'object' ||
    session === null ||
    nodeUtilTypes.isProxy(session)
  ) {
    return failPublication('INVALID_ARGUMENT')
  }
  let createArtifactPublisher:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'createRehearsalArtifactPublisher'
    ]
  let createEvidencePublisher:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'createRehearsalEvidencePublisher'
    ]
  let readEvidenceBinding:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readRehearsalEvidenceSessionBinding'
    ]
  let readRateEvidence:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readDescribeTableRateEvidence'
    ]
  let readPermitValidity:
    WorkspaceSearchMigrationRehearsalPublicationSession[
      'readRehearsalPermitValidity'
    ]
  let close: WorkspaceSearchMigrationRehearsalPublicationSession['close']
  try {
    createArtifactPublisher = session.createRehearsalArtifactPublisher
    createEvidencePublisher = session.createRehearsalEvidencePublisher
    readEvidenceBinding = session.readRehearsalEvidenceSessionBinding
    readRateEvidence = session.readDescribeTableRateEvidence
    readPermitValidity = session.readRehearsalPermitValidity
    close = session.close
  } catch {
    return failPublication('INVALID_ARGUMENT')
  }
  if (
    !isDirectFunction(createArtifactPublisher) ||
    !isDirectFunction(createEvidencePublisher) ||
    !isDirectFunction(readEvidenceBinding) ||
    !isDirectFunction(readRateEvidence) ||
    !isDirectFunction(readPermitValidity) ||
    !isDirectFunction(close)
  ) {
    return failPublication('INVALID_ARGUMENT')
  }
  return Object.freeze({
    createArtifactPublisher: (publisherInput) =>
      Reflect.apply(createArtifactPublisher, session, [publisherInput]),
    createEvidencePublisher: (publisherInput) =>
      Reflect.apply(createEvidencePublisher, session, [publisherInput]),
    readEvidenceBinding: () =>
      Reflect.apply(readEvidenceBinding, session, []),
    readRateEvidence: () => Reflect.apply(readRateEvidence, session, []),
    readPermitValidity: () =>
      Reflect.apply(readPermitValidity, session, []),
    close: () => Reflect.apply(close, session, []),
  })
}

/** Returns whether a callback is a non-proxy function capability. */
function isDirectFunction(value: unknown): value is (...arguments_: never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/** Consumes one exact non-shared key into signing and verification copies. */
function consumeEvidenceKey(value: Uint8Array): {
  /** Detached index-signing copy. */
  readonly signingKey: Uint8Array
  /** Detached publication-verification copy. */
  readonly verificationKey: Uint8Array
  /** SHA-256 digest matched against the authenticated permit. */
  readonly digest: string
} {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPublication('INVALID_ARGUMENT')
  }
  const buffer = publicationGuards.readIntrinsicBuffer(value)
  const byteLength = publicationGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength !== evidenceKeyByteLength
  ) {
    zeroizeKey(value)
    return failPublication('INVALID_ARGUMENT')
  }
  const signingKey = new Uint8Array(evidenceKeyByteLength)
  const verificationKey = new Uint8Array(evidenceKeyByteLength)
  try {
    Uint8Array.prototype.set.call(signingKey, value)
    Uint8Array.prototype.set.call(verificationKey, value)
    return Object.freeze({
      signingKey,
      verificationKey,
      digest: createHash('sha256').update(signingKey).digest('hex'),
    })
  } catch {
    zeroizeKey(signingKey)
    zeroizeKey(verificationKey)
    return failPublication('INVALID_ARGUMENT')
  } finally {
    zeroizeKey(value)
  }
}

/** Parses and detaches the exact authenticated evidence session binding. */
function readSessionBinding(
  value: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
): ParsedEvidenceSessionBinding {
  const record = sessionBindingGuards.requireRecord(value)
  sessionBindingGuards.requireExactKeys(record, [
    'attestation',
    'commit',
    'configurationHash',
    'evidenceKeyDigest',
    'publicationKeyDigest',
  ])
  const commit = sessionBindingGuards.readOwn(record, 'commit')
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  const evidenceKeyDigest = readBindingDigest(record, 'evidenceKeyDigest')
  const publicationKeyDigest = readBindingDigest(
    record,
    'publicationKeyDigest',
  )
  if (evidenceKeyDigest === publicationKeyDigest) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  return Object.freeze({
    commit,
    configurationHash: readBindingDigest(record, 'configurationHash'),
    evidenceKeyDigest,
    publicationKeyDigest,
    attestation: readSessionAttestation(
      sessionBindingGuards.readOwn(record, 'attestation'),
    ),
  })
}

/** Reads one session-binding digest through the drift-specific failure. */
function readBindingDigest(record: object, key: string): string {
  return sessionBindingGuards.readDigest(
    sessionBindingGuards.readOwn(record, key),
  )
}

/** Parses exact non-production attestations from the authenticated session. */
function readSessionAttestation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAttestationEvidence {
  const record = sessionBindingGuards.requireRecord(value)
  sessionBindingGuards.requireExactKeys(record, [
    'callerAttestationDigest',
    'permitDigest',
    'productionIsolationDigest',
    'resourceAttestationDigest',
    'stage',
  ])
  if (sessionBindingGuards.readOwn(record, 'stage') !== 'non-production') {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  return Object.freeze({
    stage: 'non-production',
    permitDigest: readBindingDigest(record, 'permitDigest'),
    callerAttestationDigest:
      readBindingDigest(record, 'callerAttestationDigest'),
    resourceAttestationDigest:
      readBindingDigest(record, 'resourceAttestationDigest'),
    productionIsolationDigest:
      readBindingDigest(record, 'productionIsolationDigest'),
  })
}

/** Requires suite identity, key, and rate policy to match the live session. */
function requireSessionBinding(
  suite: WorkspaceSearchMigrationRehearsalSuitePublicationBindings,
  binding: ParsedEvidenceSessionBinding,
  publicationKeyDigest: string,
  rateEvidence: ParsedLiveRateEvidence,
  permitValidity: WorkspaceSearchMigrationRehearsalPermitValidity,
): void {
  const finalizedRate = suite.rateAggregate
  if (
    binding.commit !== suite.commit ||
    binding.configurationHash !== suite.configurationHash ||
    binding.publicationKeyDigest !== publicationKeyDigest ||
    rateEvidence.policyVersion !== suite.ratePolicyVersion ||
    rateEvidence.version !== finalizedRate.version ||
    rateEvidence.policyVersion !== finalizedRate.policyVersion ||
    rateEvidence.attemptCount !== finalizedRate.attemptCount ||
    rateEvidence.forfeitedAttemptCount !==
      finalizedRate.forfeitedAttemptCount ||
    rateEvidence.throttleCount !== finalizedRate.throttleCount ||
    rateEvidence.awsServiceThrottleCount !==
      finalizedRate.awsServiceThrottleCount ||
    rateEvidence.rehearsalInjectedThrottleCount !==
      finalizedRate.rehearsalInjectedThrottleCount ||
    rateEvidence.budgetStopCount !== finalizedRate.budgetStopCount ||
    rateEvidence.operationalBudgetStopCount !==
      finalizedRate.operationalBudgetStopCount ||
    rateEvidence.awsServiceThrottleBudgetStopCount !==
      finalizedRate.awsServiceThrottleBudgetStopCount ||
    rateEvidence.rehearsalInjectedBudgetStopCount !==
      finalizedRate.rehearsalInjectedBudgetStopCount ||
    rateEvidence.cadenceWaitCount !== finalizedRate.cadenceWaitCount ||
    rateEvidence.cadenceWaitMilliseconds !==
      finalizedRate.cadenceWaitMilliseconds ||
    rateEvidence.maximumInFlight !== finalizedRate.maximumInFlight ||
    Date.parse(suite.firstStageStartedAt) <
      Date.parse(permitValidity.issuedAt) ||
    Date.parse(suite.completedAt) >= Date.parse(permitValidity.expiresAt) ||
    !attestationsEqual(binding.attestation, suite.attestation)
  ) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
}

/** Strictly parses the complete live durable actual-rate aggregate. */
function readLiveRateEvidence(
  value: WorkspaceSearchMigrationDescribeTableRateEvidence,
): ParsedLiveRateEvidence {
  const record = sessionBindingGuards.requireRecord(value)
  sessionBindingGuards.requireExactKeys(record, liveRateEvidenceKeys)
  if (
    sessionBindingGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  ) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  const maximumInFlight = sessionBindingGuards.readOwn(
    record,
    'maximumInFlight',
  )
  if (maximumInFlight !== 0 && maximumInFlight !== 1) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  const evidence: ParsedLiveRateEvidence = Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: sessionBindingGuards.readDigest(
      sessionBindingGuards.readOwn(record, 'policyVersion'),
    ),
    attemptCount: readLiveRateCount(record, 'attemptCount'),
    forfeitedAttemptCount:
      readLiveRateCount(record, 'forfeitedAttemptCount'),
    throttleCount: readLiveRateCount(record, 'throttleCount'),
    awsServiceThrottleCount:
      readLiveRateCount(record, 'awsServiceThrottleCount'),
    rehearsalInjectedThrottleCount:
      readLiveRateCount(record, 'rehearsalInjectedThrottleCount'),
    budgetStopCount: readLiveRateCount(record, 'budgetStopCount'),
    operationalBudgetStopCount:
      readLiveRateCount(record, 'operationalBudgetStopCount'),
    awsServiceThrottleBudgetStopCount:
      readLiveRateCount(record, 'awsServiceThrottleBudgetStopCount'),
    rehearsalInjectedBudgetStopCount:
      readLiveRateCount(record, 'rehearsalInjectedBudgetStopCount'),
    cadenceWaitCount: readLiveRateCount(record, 'cadenceWaitCount'),
    cadenceWaitMilliseconds:
      readLiveRateCount(record, 'cadenceWaitMilliseconds'),
    maximumInFlight,
  })
  if (
    evidence.throttleCount !==
      evidence.awsServiceThrottleCount +
        evidence.rehearsalInjectedThrottleCount ||
    evidence.budgetStopCount !==
      evidence.operationalBudgetStopCount +
        evidence.awsServiceThrottleBudgetStopCount +
        evidence.rehearsalInjectedBudgetStopCount
  ) return failPublication('SESSION_BINDING_MISMATCH')
  return evidence
}

/** Reads one nonnegative safe live rate counter. */
function readLiveRateCount(record: object, key: string): number {
  const value = sessionBindingGuards.readOwn(record, key)
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  return value
}

/** Parses the exact authenticated permit interval used for suite containment. */
function readPermitValidity(
  value: WorkspaceSearchMigrationRehearsalPermitValidity,
): WorkspaceSearchMigrationRehearsalPermitValidity {
  const record = sessionBindingGuards.requireRecord(value)
  sessionBindingGuards.requireExactKeys(record, ['expiresAt', 'issuedAt'])
  let issuedAt: string
  let expiresAt: string
  try {
    issuedAt = sessionBindingGuards.readTimestamp(
      sessionBindingGuards.readOwn(record, 'issuedAt'),
    )
    expiresAt = sessionBindingGuards.readTimestamp(
      sessionBindingGuards.readOwn(record, 'expiresAt'),
    )
  } catch {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) {
    return failPublication('SESSION_BINDING_MISMATCH')
  }
  return Object.freeze({ issuedAt, expiresAt })
}

/** Compares every exact digest-only non-production attestation field. */
function attestationsEqual(
  left: WorkspaceSearchMigrationRehearsalAttestationEvidence,
  right: WorkspaceSearchMigrationRehearsalAttestationEvidence,
): boolean {
  return left.stage === right.stage &&
    left.permitDigest === right.permitDigest &&
    left.callerAttestationDigest === right.callerAttestationDigest &&
    left.resourceAttestationDigest === right.resourceAttestationDigest &&
    left.productionIsolationDigest === right.productionIsolationDigest
}

/** Creates one fixed retention deadline and shared monotonic publisher clock. */
function createPublicationTiming(
  completedAt: string,
  permitValidity: WorkspaceSearchMigrationRehearsalPermitValidity,
  clock: () => Date,
): PreparedPublicationTiming {
  const completedAtMilliseconds = Date.parse(completedAt)
  const publicationTimeMilliseconds = readPublicationClock(clock)
  const permitIssuedAtMilliseconds = Date.parse(permitValidity.issuedAt)
  const permitExpiresAtMilliseconds = Date.parse(permitValidity.expiresAt)
  const minimumRetainedUntilMilliseconds =
    publicationTimeMilliseconds +
    minimumRemainingRetentionMilliseconds +
    remainingRetentionHeadroomMilliseconds
  const maximumRetainedUntilMilliseconds =
    completedAtMilliseconds + publicationRetentionMilliseconds
  const retainedUntilMilliseconds =
    minimumRetainedUntilMilliseconds
  if (
    !Number.isSafeInteger(completedAtMilliseconds) ||
    !Number.isSafeInteger(publicationTimeMilliseconds) ||
    !Number.isSafeInteger(permitIssuedAtMilliseconds) ||
    !Number.isSafeInteger(permitExpiresAtMilliseconds) ||
    !Number.isSafeInteger(minimumRetainedUntilMilliseconds) ||
    !Number.isSafeInteger(maximumRetainedUntilMilliseconds) ||
    publicationTimeMilliseconds < completedAtMilliseconds ||
    publicationTimeMilliseconds < permitIssuedAtMilliseconds ||
    publicationTimeMilliseconds >= permitExpiresAtMilliseconds ||
    retainedUntilMilliseconds > maximumRetainedUntilMilliseconds
  ) {
    return failPublication('INVALID_ARGUMENT')
  }
  let previousTimeMilliseconds = publicationTimeMilliseconds
  return Object.freeze({
    retainedUntil: new Date(retainedUntilMilliseconds).toISOString(),
    /** Returns one nondecreasing permit-contained live publisher time. */
    clock: (): Date => {
      const currentTimeMilliseconds = readPublicationClock(clock)
      const remainingRetentionMilliseconds =
        retainedUntilMilliseconds - currentTimeMilliseconds
      if (
        currentTimeMilliseconds < previousTimeMilliseconds ||
        currentTimeMilliseconds < permitIssuedAtMilliseconds ||
        currentTimeMilliseconds >= permitExpiresAtMilliseconds ||
        !Number.isSafeInteger(remainingRetentionMilliseconds) ||
        remainingRetentionMilliseconds <
          minimumRemainingRetentionMilliseconds
      ) {
        throw new PublicationClockDrift()
      }
      previousTimeMilliseconds = currentTimeMilliseconds
      return new Date(currentTimeMilliseconds)
    },
  })
}

/** Calls the captured clock and returns one finite detached epoch value. */
function readPublicationClock(clock: () => Date): number {
  let value: unknown
  let epochMilliseconds: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failPublication('INVALID_ARGUMENT')
  }
  if (
    typeof epochMilliseconds !== 'number' ||
    !Number.isSafeInteger(epochMilliseconds)
  ) {
    return failPublication('INVALID_ARGUMENT')
  }
  return epochMilliseconds
}

/** Creates and freezes the only externally visible publication projection. */
function createPublicationResult(
  publication: WorkspaceSearchMigrationRehearsalEvidencePublication,
  artifacts: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[],
): WorkspaceSearchMigrationRehearsalPublicationResult {
  if (
    artifacts.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS.length
  ) {
    return failPublication('PUBLICATION_FAILED')
  }
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_RESULT_KIND,
    publicationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_VERSION,
    artifactCount: 10,
    artifactManifestDigest: createMigrationDigest(artifacts),
    byteLength: publication.byteLength,
    contentDigest: publication.contentDigest,
    immutableVersionDigest: publication.immutableVersionDigest,
    storageLocatorDigest: publication.storageLocatorDigest,
    retainedUntil: publication.retainedUntil,
  })
}

/** Attempts every close in reverse capability order and preserves the first. */
async function closePublicationCapabilities(
  evidencePublisher:
    WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher | undefined,
  artifactPublisher:
    WorkspaceSearchMigrationRehearsalArtifactAwsPublisher | undefined,
  session: CapturedPublicationSession | undefined,
): Promise<unknown | undefined> {
  let closeFailure: unknown
  let closeFailed = false
  for (const publisher of [evidencePublisher, artifactPublisher]) {
    if (publisher === undefined) continue
    try {
      publisher.close()
    } catch (error: unknown) {
      if (!closeFailed) closeFailure = error
      closeFailed = true
    }
  }
  if (session !== undefined) {
    try {
      await session.close()
    } catch (error: unknown) {
      if (!closeFailed) closeFailure = error
      closeFailed = true
    }
  }
  return closeFailed ? closeFailure : undefined
}

/** Overwrites one owned key buffer without reflecting caller data. */
function zeroizeKey(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    Uint8Array.prototype.fill.call(value, 0)
  } catch {
    // The stable orchestration failure still hides local key material.
  }
}

/** Maps every lower-level failure to this module's raw-value-free boundary. */
function normalizePublicationFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalPublicationError {
  if (error instanceof WorkspaceSearchMigrationRehearsalPublicationError) {
    return error
  }
  return new WorkspaceSearchMigrationRehearsalPublicationError(
    'PUBLICATION_FAILED',
  )
}

/** Raises one stable publication error without incorporating raw input. */
function failPublication(
  code: WorkspaceSearchMigrationRehearsalPublicationFailureCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalPublicationError(code)
}
