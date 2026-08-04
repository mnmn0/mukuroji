import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  serializeCanonicalJson,
} from './migration-contract'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import type {
  WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead,
  WorkspaceSearchMigrationRehearsalStageCommitGate,
  WorkspaceSearchMigrationRehearsalStageCommitTargetPreimageGate,
  WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization,
} from './migration-rehearsal-stage-commit-intent'

export type {
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead,
} from './migration-rehearsal-stage-commit-intent'

/** Stable discriminator for authenticated durable stage-commit evidence. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-commit-evidence'

/** First authenticated durable stage-commit evidence schema. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION =
  1

/** Maximum exact canonical bytes accepted for one commit-evidence document. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_MAX_BYTES =
  16 * 1_024

/** Actual reservation-time branch admitting one durable commit. */
export type WorkspaceSearchMigrationRehearsalStageCommitAdmissionMode =
  | 'ordinary'
  | 'bounded-recovery'

/** Secret-free authenticated claims for one durable stage commit. */
export type WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims = {
  /** Fixed commit-evidence discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND
  /** Commit-evidence schema version. */
  readonly evidenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION
  /** Fixed isolated deployment class accepted by the commit boundary. */
  readonly stage: 'non-production'
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the authenticated non-production permit owning the suite. */
  readonly permitDigest: string
  /** Digest binding every explicitly selected rehearsal resource. */
  readonly requestedResourcesBinding: string
  /** Digest binding the physical migration-state table location. */
  readonly stateTableLocationBindingDigest: string
  /** Digest of the parent-only publication key authorized by the permit. */
  readonly publicationKeyDigest: string
  /** Digest of the exact parent-authentication artifact verified at commit. */
  readonly parentAuthenticationDigest: string
  /** Digest of the complete secret-free parent-authorization binding. */
  readonly parentAuthorizationBindingDigest: string
  /** Globally contiguous stage ordinal committed by this invocation. */
  readonly stageOrdinal: number
  /** Digest of the exact authenticated reservation consumed by the commit. */
  readonly stageReservationDigest: string
  /** Durable revision at which the consumed reservation owned the slot. */
  readonly stageReservationClaimRevision: number
  /** Digest of the exact authenticated stage receipt. */
  readonly receiptDigest: string
  /** Expected durable successor revision authenticated by the receipt. */
  readonly commitRevision: number
  /** Exact inactive durable successor returned by the commit boundary. */
  readonly head: WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead
  /** Independent command-specific irreversible commit gate used. */
  readonly commitGate: WorkspaceSearchMigrationRehearsalStageCommitGate
  /** Proactive authenticated prerequisites retained for durable audit. */
  readonly recoveryAuthorization:
    WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization
  /** Actual ordinary or bounded-recovery timing branch used at dispatch. */
  readonly admissionMode:
    WorkspaceSearchMigrationRehearsalStageCommitAdmissionMode
  /** Trusted admission time fixed before the durable transaction is sent. */
  readonly commitAdmittedAt: string
  /** Immutable durable fact independent of the transaction response path. */
  readonly durableStatus: 'committed'
}

/** Complete domain-separated HMAC-authenticated commit evidence. */
export type WorkspaceSearchMigrationRehearsalStageCommitEvidence =
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims & {
    /** HMAC-SHA-256 over the exact canonical commit-evidence claims. */
    readonly evidenceMac: string
  }

/** Input for creating one authenticated commit-evidence document. */
export type CreateWorkspaceSearchMigrationRehearsalStageCommitEvidenceInput = {
  /** Strict secret-free claims derived from authenticated commit material. */
  readonly claims: WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims
  /** Shared exact 32-byte stage authentication key. */
  readonly signingKey: Uint8Array
}

/** Stable raw-value-free commit-evidence validation failure. */
export class WorkspaceSearchMigrationRehearsalStageCommitEvidenceError
  extends Error {
  /** Creates the sole stable public evidence failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_COMMIT_EVIDENCE')
    this.name =
      'WorkspaceSearchMigrationRehearsalStageCommitEvidenceError'
  }
}

/** HMAC domain separating commit evidence from every other stage artifact. */
const stageCommitEvidenceMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-commit-evidence:v1'

/** Exact byte length required for the shared stage key. */
const stageCommitEvidenceKeyBytes = 32

/** Strict record guards mapped to one stable evidence failure. */
const evidenceGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageCommitEvidence,
)

/** Exact claim fields authenticated by the evidence MAC. */
const evidenceClaimKeys = Object.freeze([
  'admissionMode',
  'commitAdmittedAt',
  'commitGate',
  'commitRevision',
  'durableStatus',
  'evidenceVersion',
  'head',
  'kind',
  'manifestDigest',
  'parentAuthenticationDigest',
  'parentAuthorizationBindingDigest',
  'permitDigest',
  'publicationKeyDigest',
  'recoveryAuthorization',
  'requestedResourcesBinding',
  'receiptDigest',
  'stage',
  'stageOrdinal',
  'stageReservationClaimRevision',
  'stageReservationDigest',
  'stateTableLocationBindingDigest',
])

/** Exact complete evidence fields including its MAC. */
const evidenceKeys = Object.freeze([
  ...evidenceClaimKeys,
  'evidenceMac',
])

/** Exact nested durable-head fields. */
const evidenceHeadKeys = Object.freeze([
  'abandonmentCount',
  'abandonmentRootDigest',
  'activeExpiresAt',
  'activeReservationDigest',
  'activeStageOrdinal',
  'completedStageOrdinal',
  'headReceiptDigest',
  'manifestDigest',
  'revision',
])

/** Exact bounded-recovery authorization property names. */
const recoveryAuthorizationKeys = Object.freeze([
  'boundaryMaterialEvidenceDigest',
  'claimedStageHeadDigest',
  'cleanupCompletedAt',
  'cleanupCompletionDigest',
  'cleanupIntentDigest',
  'cleanupPreparedAt',
  'lifecycleDigest',
  'lifecycleEvidenceDigest',
  'materialDigest',
  'materialEvidenceDigest',
  'permitExpiresAt',
  'processExitedAt',
  'receiptCompletedAt',
  'recoveryDeadlineAt',
  'reservationExpiresAt',
  'runtimeKeyCleanupAuthorizationBindingDigest',
])

/** Exact target-preimage compact gate property names. */
const targetPreimageCommitGateKeys = Object.freeze([
  'aggregateDigest',
  'artifactBindingDigest',
  'byteLength',
  'commitGateObservedAt',
  'contentDigest',
  'contextDigest',
  'kind',
  'observationDigest',
  'purpose',
  'rateAggregateDigest',
  'rateCompletedAt',
  'rateSuccessor',
])

/** Exact terminal-reconciliation compact gate property names. */
const terminalReconciliationCommitGateKeys = Object.freeze([
  'artifactBindingDigest',
  'auditDigest',
  'byteLength',
  'contentDigest',
  'contextDigest',
  'kind',
  'rateAggregateDigest',
  'rateCompletedAt',
  'rateSuccessor',
  'scenario',
])

/** Exact compact verified-rate segment property names. */
const verifiedRateSegmentKeys = Object.freeze([
  'authenticationKeyFingerprint',
  'eventCount',
  'firstCommittedEventSequence',
  'firstEventSequence',
  'lastCommittedEventSequence',
  'segmentDigest',
  'segmentLocatorDigest',
  'segmentOrdinal',
  'terminalRecordMac',
])

/**
 * Creates one canonical authenticated durable stage-commit evidence record.
 *
 * @param input - Strict claims and shared stage signing key.
 * @returns Frozen authenticated commit evidence.
 */
export function createWorkspaceSearchMigrationRehearsalStageCommitEvidence(
  input: CreateWorkspaceSearchMigrationRehearsalStageCommitEvidenceInput,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  let claimsValue: unknown
  let signingKeyValue: unknown
  try {
    claimsValue = input.claims
    signingKeyValue = input.signingKey
  } catch {
    return failStageCommitEvidence()
  }
  const claims = readStageCommitEvidenceClaims(claimsValue)
  const key = copyStageCommitEvidenceKey(signingKeyValue)
  try {
    const evidence = Object.freeze({
      ...claims,
      evidenceMac: createStageCommitEvidenceMac(claims, key),
    })
    requireBoundedStageCommitEvidence(evidence)
    return evidence
  } finally {
    zeroizeStageCommitEvidenceBytes(key)
  }
}

/**
 * Authenticates and validates one parsed durable commit-evidence candidate.
 *
 * @param value - Untrusted parsed commit evidence.
 * @param verificationKey - Shared exact 32-byte stage verification key.
 * @returns Frozen detached authenticated commit evidence.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, evidenceKeys)
  const claims = readStageCommitEvidenceClaims(record)
  const evidenceMac = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'evidenceMac'),
  )
  const key = copyStageCommitEvidenceKey(verificationKey)
  try {
    if (!safeStageCommitEvidenceDigestEqual(
      evidenceMac,
      createStageCommitEvidenceMac(claims, key),
    )) return failStageCommitEvidence()
    const evidence = Object.freeze({ ...claims, evidenceMac })
    requireBoundedStageCommitEvidence(evidence)
    return evidence
  } finally {
    zeroizeStageCommitEvidenceBytes(key)
  }
}

/**
 * Parses exact canonical bytes and authenticates one commit-evidence record.
 *
 * @param bytes - Exact canonical JSON bytes without a trailing newline.
 * @param verificationKey - Shared exact 32-byte stage verification key.
 * @returns Frozen detached authenticated commit evidence.
 */
export function parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
  bytes: Uint8Array,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      nodeUtilTypes.isSharedArrayBuffer(bytes.buffer) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_MAX_BYTES
    ) return failStageCommitEvidence()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const evidence =
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
        candidate,
        verificationKey,
      )
    if (serializeCanonicalJson(evidence) !== text) {
      return failStageCommitEvidence()
    }
    return evidence
  } catch {
    return failStageCommitEvidence()
  }
}

/** Reads and validates exact commit-evidence claims. */
function readStageCommitEvidenceClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims {
  const record = evidenceGuards.requireRecord(value)
  const actualKeys = Object.keys(record)
  evidenceGuards.requireExactKeys(
    record,
    actualKeys.includes('evidenceMac') ? evidenceKeys : evidenceClaimKeys,
  )
  if (
    evidenceGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND ||
    evidenceGuards.readOwn(record, 'evidenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION ||
    evidenceGuards.readOwn(record, 'stage') !== 'non-production'
  ) return failStageCommitEvidence()
  const manifestDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'manifestDigest'),
  )
  const permitDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'permitDigest'),
  )
  const requestedResourcesBinding = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'requestedResourcesBinding'),
  )
  const stateTableLocationBindingDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'stateTableLocationBindingDigest'),
  )
  const publicationKeyDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'publicationKeyDigest'),
  )
  const parentAuthenticationDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'parentAuthenticationDigest'),
  )
  const parentAuthorizationBindingDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'parentAuthorizationBindingDigest'),
  )
  const stageOrdinal = readPositiveSafeInteger(
    evidenceGuards.readOwn(record, 'stageOrdinal'),
  )
  const stageReservationDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'stageReservationDigest'),
  )
  const stageReservationClaimRevision = readPositiveSafeInteger(
    evidenceGuards.readOwn(record, 'stageReservationClaimRevision'),
  )
  const receiptDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'receiptDigest'),
  )
  const commitRevision = readPositiveSafeInteger(
    evidenceGuards.readOwn(record, 'commitRevision'),
  )
  const commitAdmittedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'commitAdmittedAt'),
  )
  const recoveryAuthorization = readStageCommitRecoveryAuthorization(
    evidenceGuards.readOwn(record, 'recoveryAuthorization'),
  )
  const admissionModeValue = evidenceGuards.readOwn(
    record,
    'admissionMode',
  )
  if (
    admissionModeValue !== 'ordinary' &&
    admissionModeValue !== 'bounded-recovery'
  ) return failStageCommitEvidence()
  const commitAdmittedMilliseconds = Date.parse(commitAdmittedAt)
  const reservationExpiresMilliseconds = Date.parse(
    recoveryAuthorization.reservationExpiresAt,
  )
  if (
    (admissionModeValue === 'ordinary' &&
      commitAdmittedMilliseconds >= reservationExpiresMilliseconds) ||
    (admissionModeValue === 'bounded-recovery' &&
      (commitAdmittedMilliseconds < reservationExpiresMilliseconds ||
        commitAdmittedMilliseconds >
          Date.parse(recoveryAuthorization.recoveryDeadlineAt)))
  ) return failStageCommitEvidence()
  if (evidenceGuards.readOwn(record, 'durableStatus') !== 'committed') {
    return failStageCommitEvidence()
  }
  const head = readStageCommitEvidenceHead(
    evidenceGuards.readOwn(record, 'head'),
  )
  const commitGate = readStageCommitGate(
    evidenceGuards.readOwn(record, 'commitGate'),
  )
  if (
    (commitGate.kind !== 'none' && admissionModeValue !== 'ordinary') ||
    head.manifestDigest !== manifestDigest ||
    head.completedStageOrdinal !== stageOrdinal ||
    head.headReceiptDigest !== receiptDigest ||
    head.revision !== commitRevision ||
    stageReservationClaimRevision >= commitRevision
  ) return failStageCommitEvidence()
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
    evidenceVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION,
    stage: 'non-production',
    manifestDigest,
    permitDigest,
    requestedResourcesBinding,
    stateTableLocationBindingDigest,
    publicationKeyDigest,
    parentAuthenticationDigest,
    parentAuthorizationBindingDigest,
    stageOrdinal,
    stageReservationDigest,
    stageReservationClaimRevision,
    receiptDigest,
    commitRevision,
    head,
    commitGate,
    recoveryAuthorization,
    admissionMode: admissionModeValue,
    commitAdmittedAt,
    durableStatus: 'committed',
  })
}

/** Reads one exact command-specific compact commit gate. */
function readStageCommitGate(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitGate {
  const record = evidenceGuards.requireRecord(value)
  const kind = evidenceGuards.readOwn(record, 'kind')
  if (kind === 'none') {
    evidenceGuards.requireExactKeys(record, ['kind'])
    return Object.freeze({ kind: 'none' })
  }
  if (kind === 'target-preimage') {
    evidenceGuards.requireExactKeys(record, targetPreimageCommitGateKeys)
    const rateCompletedAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'rateCompletedAt'),
    )
    const commitGateObservedAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'commitGateObservedAt'),
    )
    if (Date.parse(rateCompletedAt) > Date.parse(commitGateObservedAt)) {
      return failStageCommitEvidence()
    }
    return Object.freeze({
      kind,
      artifactBindingDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'artifactBindingDigest'),
      ),
      contentDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'contentDigest'),
      ),
      byteLength: readPositiveSafeInteger(
        evidenceGuards.readOwn(record, 'byteLength'),
      ),
      purpose: readStageCommitTargetPreimagePurpose(
        evidenceGuards.readOwn(record, 'purpose'),
      ),
      contextDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'contextDigest'),
      ),
      commitGateObservedAt,
      observationDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'observationDigest'),
      ),
      aggregateDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'aggregateDigest'),
      ),
      rateSuccessor: readStageCommitVerifiedRateSegment(
        evidenceGuards.readOwn(record, 'rateSuccessor'),
      ),
      rateAggregateDigest: evidenceGuards.readDigest(
        evidenceGuards.readOwn(record, 'rateAggregateDigest'),
      ),
      rateCompletedAt,
    })
  }
  if (kind !== 'terminal-reconciliation') {
    return failStageCommitEvidence()
  }
  evidenceGuards.requireExactKeys(record, terminalReconciliationCommitGateKeys)
  return Object.freeze({
    kind,
    artifactBindingDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'artifactBindingDigest'),
    ),
    contentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveSafeInteger(
      evidenceGuards.readOwn(record, 'byteLength'),
    ),
    scenario: readStageCommitScenario(
      evidenceGuards.readOwn(record, 'scenario'),
    ),
    contextDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contextDigest'),
    ),
    auditDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'auditDigest'),
    ),
    rateSuccessor: readStageCommitVerifiedRateSegment(
      evidenceGuards.readOwn(record, 'rateSuccessor'),
    ),
    rateAggregateDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'rateAggregateDigest'),
    ),
    rateCompletedAt: evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'rateCompletedAt'),
    ),
  })
}

/** Reads one exact rollback-preimage purpose. */
function readStageCommitTargetPreimagePurpose(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitTargetPreimageGate['purpose'] {
  if (
    value !== 'complete-rollback-preimage' &&
    value !== 'partial-rollback-preimage'
  ) return failStageCommitEvidence()
  return value
}

/** Reads one exact canonical rehearsal scenario. */
function readStageCommitScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failStageCommitEvidence()
}

/** Reads and deeply freezes one compact authenticated rate successor. */
function readStageCommitVerifiedRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, verifiedRateSegmentKeys)
  const eventCount = readNonNegativeSafeInteger(
    evidenceGuards.readOwn(record, 'eventCount'),
  )
  const firstCommittedEventSequence = readNullableNonNegativeSafeInteger(
    evidenceGuards.readOwn(record, 'firstCommittedEventSequence'),
  )
  const lastCommittedEventSequence = readNullableNonNegativeSafeInteger(
    evidenceGuards.readOwn(record, 'lastCommittedEventSequence'),
  )
  const firstEventSequence = readPositiveSafeInteger(
    evidenceGuards.readOwn(record, 'firstEventSequence'),
  )
  if (
    (eventCount === 0 &&
      (firstCommittedEventSequence !== null ||
        lastCommittedEventSequence !== null)) ||
    (eventCount > 0 &&
      (firstCommittedEventSequence === null ||
        lastCommittedEventSequence === null ||
        firstCommittedEventSequence !== firstEventSequence ||
        lastCommittedEventSequence - firstEventSequence + 1 !== eventCount ||
        lastCommittedEventSequence < firstCommittedEventSequence))
  ) return failStageCommitEvidence()
  return Object.freeze({
    authenticationKeyFingerprint: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeSafeInteger(
      evidenceGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Reads one null or nonnegative safe integer. */
function readNullableNonNegativeSafeInteger(value: unknown): number | null {
  if (value === null) return null
  return readNonNegativeSafeInteger(value)
}

/**
 * Reads the exact proactive bounded-recovery prerequisites.
 *
 * @param value - Untrusted nested recovery authorization candidate.
 * @returns Frozen validated recovery authorization.
 */
function readStageCommitRecoveryAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, recoveryAuthorizationKeys)
  const reservationExpiresAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'reservationExpiresAt'),
  )
  const permitExpiresAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'permitExpiresAt'),
  )
  const recoveryDeadlineAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'recoveryDeadlineAt'),
  )
  const receiptCompletedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'receiptCompletedAt'),
  )
  const processExitedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'processExitedAt'),
  )
  const cleanupPreparedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'cleanupPreparedAt'),
  )
  const cleanupCompletedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'cleanupCompletedAt'),
  )
  const reservationExpiresMilliseconds = Date.parse(reservationExpiresAt)
  const permitExpiresMilliseconds = Date.parse(permitExpiresAt)
  const expectedDeadlineMilliseconds =
    reservationExpiresMilliseconds +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  if (
    permitExpiresMilliseconds <
      expectedDeadlineMilliseconds +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS ||
    Date.parse(recoveryDeadlineAt) !== expectedDeadlineMilliseconds ||
    Date.parse(receiptCompletedAt) >= reservationExpiresMilliseconds ||
    Date.parse(processExitedAt) >= reservationExpiresMilliseconds ||
    Date.parse(cleanupCompletedAt) >= reservationExpiresMilliseconds ||
    Date.parse(cleanupPreparedAt) > Date.parse(cleanupCompletedAt)
  ) return failStageCommitEvidence()
  const boundaryMaterialEvidenceDigestValue = evidenceGuards.readOwn(
    record,
    'boundaryMaterialEvidenceDigest',
  )
  if (
    boundaryMaterialEvidenceDigestValue !== null &&
    typeof boundaryMaterialEvidenceDigestValue !== 'string'
  ) return failStageCommitEvidence()
  return Object.freeze({
    reservationExpiresAt,
    permitExpiresAt,
    recoveryDeadlineAt,
    receiptCompletedAt,
    processExitedAt,
    materialEvidenceDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'materialEvidenceDigest'),
    ),
    boundaryMaterialEvidenceDigest:
      boundaryMaterialEvidenceDigestValue === null
        ? null
        : evidenceGuards.readDigest(boundaryMaterialEvidenceDigestValue),
    materialDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'materialDigest'),
    ),
    claimedStageHeadDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'claimedStageHeadDigest'),
    ),
    lifecycleEvidenceDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'lifecycleEvidenceDigest'),
    ),
    lifecycleDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'lifecycleDigest'),
    ),
    runtimeKeyCleanupAuthorizationBindingDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(
        record,
        'runtimeKeyCleanupAuthorizationBindingDigest',
      ),
    ),
    cleanupIntentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'cleanupIntentDigest'),
    ),
    cleanupCompletionDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'cleanupCompletionDigest'),
    ),
    cleanupPreparedAt,
    cleanupCompletedAt,
  })
}

/** Reads one exact inactive durable successor head. */
function readStageCommitEvidenceHead(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, evidenceHeadKeys)
  const activeReservationDigest = evidenceGuards.readOwn(
    record,
    'activeReservationDigest',
  )
  const activeStageOrdinal = evidenceGuards.readOwn(
    record,
    'activeStageOrdinal',
  )
  const activeExpiresAt = evidenceGuards.readOwn(record, 'activeExpiresAt')
  if (
    activeReservationDigest !== null ||
    activeStageOrdinal !== null ||
    activeExpiresAt !== null
  ) return failStageCommitEvidence()
  return Object.freeze({
    manifestDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'manifestDigest'),
    ),
    completedStageOrdinal: readPositiveSafeInteger(
      evidenceGuards.readOwn(record, 'completedStageOrdinal'),
    ),
    headReceiptDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'headReceiptDigest'),
    ),
    activeReservationDigest: null,
    activeStageOrdinal: null,
    activeExpiresAt: null,
    abandonmentCount: readNonNegativeSafeInteger(
      evidenceGuards.readOwn(record, 'abandonmentCount'),
    ),
    abandonmentRootDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'abandonmentRootDigest'),
    ),
    revision: readPositiveSafeInteger(
      evidenceGuards.readOwn(record, 'revision'),
    ),
  })
}

/** Reads one positive safe integer. */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failStageCommitEvidence()
  return value
}

/** Reads one nonnegative safe integer. */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failStageCommitEvidence()
  return value
}

/** Copies one ordinary private exact-length stage key. */
function copyStageCommitEvidenceKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== stageCommitEvidenceKeyBytes
  ) return failStageCommitEvidence()
  try {
    return new Uint8Array(value)
  } catch {
    return failStageCommitEvidence()
  }
}

/** Creates the domain-separated MAC over exact canonical claims. */
function createStageCommitEvidenceMac(
  claims: WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(stageCommitEvidenceMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Compares two validated hexadecimal digests without early exit. */
function safeStageCommitEvidenceDigestEqual(
  left: string,
  right: string,
): boolean {
  try {
    const leftBytes = Buffer.from(left, 'hex')
    const rightBytes = Buffer.from(right, 'hex')
    return leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(leftBytes, rightBytes)
  } catch {
    return false
  }
}

/** Requires the complete canonical evidence to remain within its byte cap. */
function requireBoundedStageCommitEvidence(
  value: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
): void {
  if (
    new TextEncoder().encode(serializeCanonicalJson(value)).byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_MAX_BYTES
  ) return failStageCommitEvidence()
}

/** Overwrites one owned key buffer on every completion path. */
function zeroizeStageCommitEvidenceBytes(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    value.fill(0)
  } catch {
    // The buffer was already detached or otherwise inaccessible.
  }
}

/** Raises one stable raw-value-free evidence failure. */
function failStageCommitEvidence(): never {
  throw new WorkspaceSearchMigrationRehearsalStageCommitEvidenceError()
}
