import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { serializeCanonicalJson } from './migration-contract'
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
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for a local pre-dispatch stage-commit intent. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-commit-intent'

/** First local prepared-intent schema version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION = 1

/** Maximum exact canonical bytes accepted for one prepared intent. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES =
  16 * 1_024

/** Exact inactive durable head shared by prepared intent and commit evidence. */
export type WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead = {
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Highest globally contiguous committed stage ordinal. */
  readonly completedStageOrdinal: number
  /** Digest of the exact newly committed receipt. */
  readonly headReceiptDigest: string
  /** Required empty active-reservation digest after commit. */
  readonly activeReservationDigest: null
  /** Required empty active-stage ordinal after commit. */
  readonly activeStageOrdinal: null
  /** Required empty active-reservation expiry after commit. */
  readonly activeExpiresAt: null
  /** Cumulative explicit abandonment count at this committed head. */
  readonly abandonmentCount: number
  /** Cumulative abandonment-chain root at this committed head. */
  readonly abandonmentRootDigest: string
  /** Exact durable successor revision authenticated by the receipt. */
  readonly revision: number
}

/** Authenticated prerequisites permitting a bounded post-expiry commit. */
export type WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization = {
  /** Exclusive expiry of the exact active reservation. */
  readonly reservationExpiresAt: string
  /** Exclusive expiry of the authenticated suite permit. */
  readonly permitExpiresAt: string
  /** Inclusive last canonical millisecond admitted for commit recovery. */
  readonly recoveryDeadlineAt: string
  /** Authenticated receipt completion proven to precede reservation expiry. */
  readonly receiptCompletedAt: string
  /** Parent-observed child exit proven to precede reservation expiry. */
  readonly processExitedAt: string
  /** Digest of the exact parent-persisted material wrapper. */
  readonly materialEvidenceDigest: string
  /** Digest of an exact boundary wrapper, when the protocol has one. */
  readonly boundaryMaterialEvidenceDigest: string | null
  /** Digest of the exact authenticated child material. */
  readonly materialDigest: string
  /** Digest of the exact adapter-proven active claimed head. */
  readonly claimedStageHeadDigest: string
  /** Digest of the exact parent-persisted lifecycle wrapper. */
  readonly lifecycleEvidenceDigest: string
  /** Digest of the normalized parent-observed lifecycle payload. */
  readonly lifecycleDigest: string
  /** Digest of the complete genuine cleanup authorization binding. */
  readonly runtimeKeyCleanupAuthorizationBindingDigest: string
  /** Digest of the exact durable cleanup intent. */
  readonly cleanupIntentDigest: string
  /** Digest of the exact durable cleanup completion. */
  readonly cleanupCompletionDigest: string
  /** Trusted preparation time authenticated by the cleanup binding. */
  readonly cleanupPreparedAt: string
  /** Trusted cleanup completion proven to precede reservation expiry. */
  readonly cleanupCompletedAt: string
}

/** No additional command-specific irreversible commit gate is required. */
export type WorkspaceSearchMigrationRehearsalStageCommitGateNone = {
  /** Fixed discriminator for stages without an additional gate. */
  readonly kind: 'none'
}

/** Compact authenticated rollback-preimage gate retained by planning commit. */
export type WorkspaceSearchMigrationRehearsalStageCommitTargetPreimageGate = {
  /** Fixed rollback-preimage gate discriminator. */
  readonly kind: 'target-preimage'
  /** Digest of the full genuine target-preimage authorization binding. */
  readonly artifactBindingDigest: string
  /** SHA-256 digest of the exact canonical target-audit artifact bytes. */
  readonly contentDigest: string
  /** Exact positive canonical target-audit artifact byte length. */
  readonly byteLength: number
  /** Scenario-specific authenticated rollback-preimage purpose. */
  readonly purpose: 'complete-rollback-preimage' | 'partial-rollback-preimage'
  /** Digest of the complete parent-authenticated target context. */
  readonly contextDigest: string
  /** Trusted final observation admitting the planning commit gate. */
  readonly commitGateObservedAt: string
  /** Contextual digest of the authenticated target observation. */
  readonly observationDigest: string
  /** Pagination-independent digest of the target aggregate. */
  readonly aggregateDigest: string
  /** Exact authenticated auxiliary successor rate segment. */
  readonly rateSuccessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Digest of the final durable auxiliary rate aggregate. */
  readonly rateAggregateDigest: string
  /** Completion of the authenticated auxiliary rate segment. */
  readonly rateCompletedAt: string
}

/** Compact authenticated terminal-reconciliation gate retained by commit. */
export type WorkspaceSearchMigrationRehearsalStageCommitTerminalReconciliationGate = {
  /** Fixed terminal-reconciliation gate discriminator. */
  readonly kind: 'terminal-reconciliation'
  /** Digest of the full genuine reconciliation authorization binding. */
  readonly artifactBindingDigest: string
  /** SHA-256 digest of the exact canonical reconciliation artifact bytes. */
  readonly contentDigest: string
  /** Exact positive canonical reconciliation artifact byte length. */
  readonly byteLength: number
  /** Canonical terminal scenario authenticated by the artifact context. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Digest of the complete semantic reconciliation audit document. */
  readonly auditDigest: string
  /** Digest of the exact authenticated terminal reconciliation context. */
  readonly contextDigest: string
  /** Exact authenticated auxiliary successor rate segment. */
  readonly rateSuccessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Digest of the final durable auxiliary rate aggregate. */
  readonly rateAggregateDigest: string
  /** Completion of the authenticated auxiliary rate segment. */
  readonly rateCompletedAt: string
}

/** Command-specific one-shot gate compactly bound into a commit intent. */
export type WorkspaceSearchMigrationRehearsalStageCommitGate =
  | WorkspaceSearchMigrationRehearsalStageCommitGateNone
  | WorkspaceSearchMigrationRehearsalStageCommitTargetPreimageGate
  | WorkspaceSearchMigrationRehearsalStageCommitTerminalReconciliationGate

/** Secret-free claims authorizing one future durable commit attempt. */
export type WorkspaceSearchMigrationRehearsalStageCommitIntentClaims = {
  /** Fixed prepared-intent discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND
  /** Prepared-intent schema version. */
  readonly intentVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION
  /** Fixed isolated deployment class. */
  readonly stage: 'non-production'
  /** Digest of the authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the authenticated permit owning the suite. */
  readonly permitDigest: string
  /** Digest binding the explicit rehearsal resources. */
  readonly requestedResourcesBinding: string
  /** Digest binding the physical migration-state table. */
  readonly stateTableLocationBindingDigest: string
  /** Digest of the parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Digest of the exact parent-authentication artifact. */
  readonly parentAuthenticationDigest: string
  /** Digest of the genuine parent-authorization binding. */
  readonly parentAuthorizationBindingDigest: string
  /** Globally contiguous stage ordinal intended for commit. */
  readonly stageOrdinal: number
  /** Digest of the exact authenticated reservation. */
  readonly stageReservationDigest: string
  /** Durable revision at which the reservation owns the slot. */
  readonly stageReservationClaimRevision: number
  /** Digest of the exact authenticated receipt. */
  readonly receiptDigest: string
  /** Expected durable successor revision. */
  readonly commitRevision: number
  /** Expected inactive successor, not a statement of durable state. */
  readonly expectedHead: WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead
  /** Independent command-specific irreversible commit gate. */
  readonly commitGate: WorkspaceSearchMigrationRehearsalStageCommitGate
  /** Proactive authority for an actual dispatch crossing reservation expiry. */
  readonly recoveryAuthorization:
    WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization
  /** Trusted local preparation time fixed before remote preflight. */
  readonly preparedAt: string
  /** Explicit non-durable lifecycle state. */
  readonly intentStatus: 'prepared'
}

/** Complete publication-key-authenticated local prepared intent. */
export type WorkspaceSearchMigrationRehearsalStageCommitIntent =
  WorkspaceSearchMigrationRehearsalStageCommitIntentClaims & {
    /** HMAC-SHA-256 over the exact canonical prepared claims. */
    readonly intentMac: string
  }

/** Input for creating one authenticated prepared intent. */
export type CreateWorkspaceSearchMigrationRehearsalStageCommitIntentInput = {
  /** Strict secret-free prepared claims. */
  readonly claims: WorkspaceSearchMigrationRehearsalStageCommitIntentClaims
  /** Parent-only exact 32-byte publication key. */
  readonly signingKey: Uint8Array
}

/** Stable raw-value-free prepared-intent validation failure. */
export class WorkspaceSearchMigrationRehearsalStageCommitIntentError
  extends Error {
  /** Creates the sole stable public prepared-intent failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_COMMIT_INTENT')
    this.name = 'WorkspaceSearchMigrationRehearsalStageCommitIntentError'
  }
}

/** MAC domain intentionally disjoint from committed durable evidence. */
const stageCommitIntentMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-commit-intent:v1'

/** Exact byte length required for the publication key. */
const stageCommitIntentKeyBytes = 32

/** Strict guards mapped to the single prepared-intent failure. */
const intentGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageCommitIntent,
)

/** Exact authenticated prepared claim names. */
const intentClaimKeys = Object.freeze([
  'commitGate',
  'commitRevision',
  'expectedHead',
  'intentStatus',
  'intentVersion',
  'kind',
  'manifestDigest',
  'parentAuthenticationDigest',
  'parentAuthorizationBindingDigest',
  'permitDigest',
  'publicationKeyDigest',
  'preparedAt',
  'recoveryAuthorization',
  'receiptDigest',
  'requestedResourcesBinding',
  'stage',
  'stageOrdinal',
  'stageReservationClaimRevision',
  'stageReservationDigest',
  'stateTableLocationBindingDigest',
])

/** Exact complete prepared document names. */
const intentKeys = Object.freeze([...intentClaimKeys, 'intentMac'])

/** Exact expected-head property names. */
const expectedHeadKeys = Object.freeze([
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
 * Creates one canonical authenticated local prepared intent.
 *
 * @param input - Strict prepared claims and parent publication key.
 * @returns Frozen authenticated prepared intent.
 */
export function createWorkspaceSearchMigrationRehearsalStageCommitIntent(
  input: CreateWorkspaceSearchMigrationRehearsalStageCommitIntentInput,
): WorkspaceSearchMigrationRehearsalStageCommitIntent {
  let claimsValue: unknown
  let signingKeyValue: unknown
  try {
    claimsValue = input.claims
    signingKeyValue = input.signingKey
  } catch {
    return failStageCommitIntent()
  }
  const claims = readStageCommitIntentClaims(claimsValue)
  const key = copyStageCommitIntentKey(signingKeyValue)
  try {
    const intent = Object.freeze({
      ...claims,
      intentMac: createStageCommitIntentMac(claims, key),
    })
    requireBoundedStageCommitIntent(intent)
    return intent
  } finally {
    zeroizeStageCommitIntentKey(key)
  }
}

/**
 * Authenticates one parsed local prepared intent.
 *
 * @param value - Untrusted parsed prepared intent.
 * @param verificationKey - Parent-only exact publication key.
 * @returns Frozen detached authenticated prepared intent.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitIntent {
  const record = intentGuards.requireRecord(value)
  intentGuards.requireExactKeys(record, intentKeys)
  const claims = readStageCommitIntentClaims(record)
  const intentMac = intentGuards.readDigest(
    intentGuards.readOwn(record, 'intentMac'),
  )
  const key = copyStageCommitIntentKey(verificationKey)
  try {
    if (!safeStageCommitIntentDigestEqual(
      intentMac,
      createStageCommitIntentMac(claims, key),
    )) return failStageCommitIntent()
    const intent = Object.freeze({ ...claims, intentMac })
    requireBoundedStageCommitIntent(intent)
    return intent
  } finally {
    zeroizeStageCommitIntentKey(key)
  }
}

/**
 * Parses exact canonical bytes and authenticates a prepared intent.
 *
 * @param bytes - Exact canonical prepared-intent bytes.
 * @param verificationKey - Parent-only exact publication key.
 * @returns Frozen detached authenticated prepared intent.
 */
export function parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument(
  bytes: Uint8Array,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitIntent {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      nodeUtilTypes.isSharedArrayBuffer(bytes.buffer) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES
    ) return failStageCommitIntent()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const intent = verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
      candidate,
      verificationKey,
    )
    if (serializeCanonicalJson(intent) !== text) return failStageCommitIntent()
    return intent
  } catch {
    return failStageCommitIntent()
  }
}

/**
 * Reads and validates the exact prepared claims.
 *
 * @param value - Untrusted complete or claims-only prepared-intent record.
 * @returns Frozen detached canonical prepared claims.
 */
function readStageCommitIntentClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitIntentClaims {
  const record = intentGuards.requireRecord(value)
  intentGuards.requireExactKeys(
    record,
    Object.hasOwn(record, 'intentMac') ? intentKeys : intentClaimKeys,
  )
  if (
    intentGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND ||
    intentGuards.readOwn(record, 'intentVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION ||
    intentGuards.readOwn(record, 'stage') !== 'non-production' ||
    intentGuards.readOwn(record, 'intentStatus') !== 'prepared'
  ) return failStageCommitIntent()
  const manifestDigest = intentGuards.readDigest(
    intentGuards.readOwn(record, 'manifestDigest'),
  )
  const stageOrdinal = readPositiveSafeInteger(
    intentGuards.readOwn(record, 'stageOrdinal'),
  )
  const stageReservationClaimRevision = readPositiveSafeInteger(
    intentGuards.readOwn(record, 'stageReservationClaimRevision'),
  )
  const receiptDigest = intentGuards.readDigest(
    intentGuards.readOwn(record, 'receiptDigest'),
  )
  const commitRevision = readPositiveSafeInteger(
    intentGuards.readOwn(record, 'commitRevision'),
  )
  const expectedHead = readStageCommitIntentExpectedHead(
    intentGuards.readOwn(record, 'expectedHead'),
  )
  const commitGate = readStageCommitGate(
    intentGuards.readOwn(record, 'commitGate'),
  )
  const recoveryAuthorization = readStageCommitRecoveryAuthorization(
    intentGuards.readOwn(record, 'recoveryAuthorization'),
  )
  if (
    expectedHead.manifestDigest !== manifestDigest ||
    expectedHead.completedStageOrdinal !== stageOrdinal ||
    expectedHead.headReceiptDigest !== receiptDigest ||
    expectedHead.revision !== commitRevision ||
    stageReservationClaimRevision >= commitRevision
  ) return failStageCommitIntent()
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
    intentVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
    stage: 'non-production',
    manifestDigest,
    permitDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: intentGuards.readDigest(
      intentGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    stateTableLocationBindingDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'stateTableLocationBindingDigest'),
    ),
    publicationKeyDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'publicationKeyDigest'),
    ),
    parentAuthenticationDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'parentAuthenticationDigest'),
    ),
    parentAuthorizationBindingDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'parentAuthorizationBindingDigest'),
    ),
    stageOrdinal,
    stageReservationDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'stageReservationDigest'),
    ),
    stageReservationClaimRevision,
    receiptDigest,
    commitRevision,
    expectedHead,
    commitGate,
    recoveryAuthorization,
    preparedAt: intentGuards.readTimestamp(
      intentGuards.readOwn(record, 'preparedAt'),
    ),
    intentStatus: 'prepared',
  })
}

/**
 * Reads one exact command-specific compact commit gate.
 *
 * @param value - Untrusted compact gate candidate.
 * @returns Frozen strict gate union member.
 */
function readStageCommitGate(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitGate {
  const record = intentGuards.requireRecord(value)
  const kind = intentGuards.readOwn(record, 'kind')
  if (kind === 'none') {
    intentGuards.requireExactKeys(record, ['kind'])
    return Object.freeze({ kind: 'none' })
  }
  if (kind === 'target-preimage') {
    intentGuards.requireExactKeys(record, targetPreimageCommitGateKeys)
    const rateCompletedAt = intentGuards.readTimestamp(
      intentGuards.readOwn(record, 'rateCompletedAt'),
    )
    const commitGateObservedAt = intentGuards.readTimestamp(
      intentGuards.readOwn(record, 'commitGateObservedAt'),
    )
    if (Date.parse(rateCompletedAt) > Date.parse(commitGateObservedAt)) {
      return failStageCommitIntent()
    }
    const purpose = readStageCommitTargetPreimagePurpose(
      intentGuards.readOwn(record, 'purpose'),
    )
    return Object.freeze({
      kind,
      artifactBindingDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'artifactBindingDigest'),
      ),
      contentDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'contentDigest'),
      ),
      byteLength: readPositiveSafeInteger(
        intentGuards.readOwn(record, 'byteLength'),
      ),
      purpose,
      contextDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'contextDigest'),
      ),
      commitGateObservedAt,
      observationDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'observationDigest'),
      ),
      aggregateDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'aggregateDigest'),
      ),
      rateSuccessor: readStageCommitVerifiedRateSegment(
        intentGuards.readOwn(record, 'rateSuccessor'),
      ),
      rateAggregateDigest: intentGuards.readDigest(
        intentGuards.readOwn(record, 'rateAggregateDigest'),
      ),
      rateCompletedAt,
    })
  }
  if (kind !== 'terminal-reconciliation') return failStageCommitIntent()
  intentGuards.requireExactKeys(record, terminalReconciliationCommitGateKeys)
  const rateCompletedAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'rateCompletedAt'),
  )
  return Object.freeze({
    kind,
    artifactBindingDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'artifactBindingDigest'),
    ),
    contentDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveSafeInteger(
      intentGuards.readOwn(record, 'byteLength'),
    ),
    scenario: readStageCommitScenario(
      intentGuards.readOwn(record, 'scenario'),
    ),
    contextDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'contextDigest'),
    ),
    auditDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'auditDigest'),
    ),
    rateSuccessor: readStageCommitVerifiedRateSegment(
      intentGuards.readOwn(record, 'rateSuccessor'),
    ),
    rateAggregateDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'rateAggregateDigest'),
    ),
    rateCompletedAt,
  })
}

/** Reads one exact rollback-preimage purpose. */
function readStageCommitTargetPreimagePurpose(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitTargetPreimageGate['purpose'] {
  if (
    value !== 'complete-rollback-preimage' &&
    value !== 'partial-rollback-preimage'
  ) return failStageCommitIntent()
  return value
}

/** Reads one exact canonical rehearsal scenario. */
function readStageCommitScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failStageCommitIntent()
}

/** Reads and deeply freezes one compact authenticated rate successor. */
function readStageCommitVerifiedRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = intentGuards.requireRecord(value)
  intentGuards.requireExactKeys(record, verifiedRateSegmentKeys)
  const eventCount = readNonNegativeSafeInteger(
    intentGuards.readOwn(record, 'eventCount'),
  )
  const firstCommittedEventSequence = readNullableNonNegativeSafeInteger(
    intentGuards.readOwn(record, 'firstCommittedEventSequence'),
  )
  const lastCommittedEventSequence = readNullableNonNegativeSafeInteger(
    intentGuards.readOwn(record, 'lastCommittedEventSequence'),
  )
  const firstEventSequence = readPositiveSafeInteger(
    intentGuards.readOwn(record, 'firstEventSequence'),
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
  ) return failStageCommitIntent()
  return Object.freeze({
    authenticationKeyFingerprint: intentGuards.readDigest(
      intentGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeSafeInteger(
      intentGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: intentGuards.readDigest(
      intentGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Reads one null or nonnegative safe integer. */
function readNullableNonNegativeSafeInteger(value: unknown): number | null {
  if (value === null) return null
  return readNonNegativeSafeInteger(value)
}

/**
 * Reads exact proactive authority for a bounded post-expiry dispatch.
 *
 * @param value - Untrusted nested recovery authorization candidate.
 * @returns Frozen validated recovery authorization.
 */
function readStageCommitRecoveryAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitRecoveryAuthorization {
  const record = intentGuards.requireRecord(value)
  intentGuards.requireExactKeys(record, recoveryAuthorizationKeys)
  const reservationExpiresAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'reservationExpiresAt'),
  )
  const permitExpiresAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'permitExpiresAt'),
  )
  const recoveryDeadlineAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'recoveryDeadlineAt'),
  )
  const receiptCompletedAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'receiptCompletedAt'),
  )
  const processExitedAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'processExitedAt'),
  )
  const cleanupPreparedAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'cleanupPreparedAt'),
  )
  const cleanupCompletedAt = intentGuards.readTimestamp(
    intentGuards.readOwn(record, 'cleanupCompletedAt'),
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
  ) return failStageCommitIntent()
  const boundaryMaterialEvidenceDigestValue = intentGuards.readOwn(
    record,
    'boundaryMaterialEvidenceDigest',
  )
  if (
    boundaryMaterialEvidenceDigestValue !== null &&
    typeof boundaryMaterialEvidenceDigestValue !== 'string'
  ) return failStageCommitIntent()
  const boundaryMaterialEvidenceDigest =
    boundaryMaterialEvidenceDigestValue === null
      ? null
      : intentGuards.readDigest(boundaryMaterialEvidenceDigestValue)
  return Object.freeze({
    reservationExpiresAt,
    permitExpiresAt,
    recoveryDeadlineAt,
    receiptCompletedAt,
    processExitedAt,
    materialEvidenceDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'materialEvidenceDigest'),
    ),
    boundaryMaterialEvidenceDigest,
    materialDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'materialDigest'),
    ),
    claimedStageHeadDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'claimedStageHeadDigest'),
    ),
    lifecycleEvidenceDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'lifecycleEvidenceDigest'),
    ),
    lifecycleDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'lifecycleDigest'),
    ),
    runtimeKeyCleanupAuthorizationBindingDigest: intentGuards.readDigest(
      intentGuards.readOwn(
        record,
        'runtimeKeyCleanupAuthorizationBindingDigest',
      ),
    ),
    cleanupIntentDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'cleanupIntentDigest'),
    ),
    cleanupCompletionDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'cleanupCompletionDigest'),
    ),
    cleanupPreparedAt,
    cleanupCompletedAt,
  })
}

/**
 * Reads one exact inactive expected successor.
 *
 * @param value - Untrusted expected-head candidate.
 * @returns Frozen validated inactive expected head.
 */
function readStageCommitIntentExpectedHead(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead {
  const record = intentGuards.requireRecord(value)
  intentGuards.requireExactKeys(record, expectedHeadKeys)
  if (
    intentGuards.readOwn(record, 'activeReservationDigest') !== null ||
    intentGuards.readOwn(record, 'activeStageOrdinal') !== null ||
    intentGuards.readOwn(record, 'activeExpiresAt') !== null
  ) return failStageCommitIntent()
  return Object.freeze({
    manifestDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'manifestDigest'),
    ),
    completedStageOrdinal: readPositiveSafeInteger(
      intentGuards.readOwn(record, 'completedStageOrdinal'),
    ),
    headReceiptDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'headReceiptDigest'),
    ),
    activeReservationDigest: null,
    activeStageOrdinal: null,
    activeExpiresAt: null,
    abandonmentCount: readNonNegativeSafeInteger(
      intentGuards.readOwn(record, 'abandonmentCount'),
    ),
    abandonmentRootDigest: intentGuards.readDigest(
      intentGuards.readOwn(record, 'abandonmentRootDigest'),
    ),
    revision: readPositiveSafeInteger(
      intentGuards.readOwn(record, 'revision'),
    ),
  })
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Untrusted numeric candidate.
 * @returns Validated positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failStageCommitIntent()
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Untrusted numeric candidate.
 * @returns Validated nonnegative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failStageCommitIntent()
  return value
}

/**
 * Copies one ordinary exact-length publication key.
 *
 * @param value - Untrusted key candidate.
 * @returns Invocation-owned exact 32-byte key copy.
 */
function copyStageCommitIntentKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== stageCommitIntentKeyBytes
  ) return failStageCommitIntent()
  try {
    return new Uint8Array(value)
  } catch {
    return failStageCommitIntent()
  }
}

/**
 * Creates the intent-only domain-separated MAC.
 *
 * @param claims - Exact canonical prepared claims.
 * @param key - Invocation-owned publication key.
 * @returns Lowercase HMAC-SHA-256 digest.
 */
function createStageCommitIntentMac(
  claims: WorkspaceSearchMigrationRehearsalStageCommitIntentClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(stageCommitIntentMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/**
 * Compares two validated hexadecimal digests without early exit.
 *
 * @param left - First lowercase hexadecimal digest.
 * @param right - Second lowercase hexadecimal digest.
 * @returns Whether both digest byte strings are identical.
 */
function safeStageCommitIntentDigestEqual(
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

/**
 * Requires the complete prepared intent to remain bounded.
 *
 * @param value - Complete authenticated prepared intent.
 */
function requireBoundedStageCommitIntent(
  value: WorkspaceSearchMigrationRehearsalStageCommitIntent,
): void {
  if (
    new TextEncoder().encode(serializeCanonicalJson(value)).byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES
  ) return failStageCommitIntent()
}

/**
 * Overwrites one owned key buffer on every completion path.
 *
 * @param value - Optional invocation-owned key copy.
 */
function zeroizeStageCommitIntentKey(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    value.fill(0)
  } catch {
    // The buffer was already detached or otherwise inaccessible.
  }
}

/**
 * Raises the sole raw-value-free prepared-intent failure.
 *
 * @returns Never; always throws the stable validation error.
 */
function failStageCommitIntent(): never {
  throw new WorkspaceSearchMigrationRehearsalStageCommitIntentError()
}
