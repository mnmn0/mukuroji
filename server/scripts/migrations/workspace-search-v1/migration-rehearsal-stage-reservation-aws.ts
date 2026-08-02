import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type Put,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommitAdmissionMode,
} from './migration-rehearsal-stage-commit-evidence'
import {
  verifyWorkspaceSearchMigrationRehearsalStageCommitIntent,
  type WorkspaceSearchMigrationRehearsalStageCommitGate,
  type WorkspaceSearchMigrationRehearsalStageCommitIntent,
} from './migration-rehearsal-stage-commit-intent'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageHead,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'

export type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding,
  snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
} from './migration-rehearsal-reconciliation-audit'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding,
  type WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
} from './migration-rehearsal-target-audit'
import {
  consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
} from './migration-rehearsal-stage-parent-authorization'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable kind stored in the permit/resource-scoped durable suite-root row. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND =
  'workspace-search-migration-rehearsal-stage-head'

/** Durable suite-root row and nested state contract with abandonment chain. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION = 2

/** Maximum canonical nested head-state bytes accepted from DynamoDB. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_MAX_BYTES =
  64 * 1_024

/** Deterministic namespace reserved for suite root and immutable journals. */
const stageHeadRecordKeyPrefix = 'rehearsal-suite/v2'

/** Stable discriminator for one ordinal-specific immutable commit row. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND =
  'workspace-search-migration-rehearsal-stage-commit-journal'

/** First immutable ordinal-specific commit-journal row schema. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION =
  1

/** Stable discriminator for one strong-read-proven durable commit capability. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_KIND =
  'workspace-search-migration-rehearsal-stage-commit-durability-authorization'

/** First process-local durable commit authorization capability contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_VERSION =
  1

/** Stable discriminator for exact strong-read abandonment-set proof. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_KIND =
  'workspace-search-migration-rehearsal-stage-abandonment-durability-authorization'

/** First process-local abandonment durability capability contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_VERSION =
  1

/** Maximum bounded immutable abandonment rows recovered for publication. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_RECOVERY_MAX_ENTRIES =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES

/** Exact controlled attribute set for one immutable stage-commit row. */
const stageCommitJournalAttributeNames = Object.freeze([
  'abandonmentCount',
  'abandonmentRootDigest',
  'commitAdmittedAt',
  'commitEvidenceDigest',
  'commitEvidenceJson',
  'commitRevision',
  'kind',
  'manifestDigest',
  'migrationId',
  'parentAuthenticationDigest',
  'parentAuthorizationBindingDigest',
  'permitDigest',
  'publicationKeyDigest',
  'receiptDigest',
  'recordKey',
  'recordVersion',
  'requestedResourcesBinding',
  'stageOrdinal',
  'stageReservationClaimRevision',
  'stageReservationDigest',
  'stateTableLocationBindingDigest',
])

/** Exact controlled attribute set for one immutable abandonment row. */
const stageAbandonmentJournalAttributeNames = Object.freeze([
  'kind',
  'manifestDigest',
  'migrationId',
  'permitDigest',
  'recordKey',
  'recordVersion',
  'requestedResourcesBinding',
  'stageOrdinal',
  'stateTableLocationBindingDigest',
  'transitionDigest',
  'transitionJson',
])

/** Complete controlled attribute set for one durable stage-head row. */
const stageHeadAttributeNames = Object.freeze([
  'kind',
  'manifestDigest',
  'migrationId',
  'permitDigest',
  'recordKey',
  'recordVersion',
  'requestedResourcesBinding',
  'stateDigest',
  'stateJson',
  'stateRevision',
  'stateTableLocationBindingDigest',
  'stateWriteNonce',
])

/** Exact nested durable state fields. */
const stageHeadStateKeys = Object.freeze([
  'activeReservation',
  'abandonmentCount',
  'abandonmentRootDigest',
  'completedStageOrdinal',
  'headReceiptDigest',
  'kind',
  'lastAbandonedAt',
  'manifestDigest',
  'permitDigest',
  'requestedResourcesBinding',
  'stateVersion',
])

/** Exact nested active-reservation projection fields. */
const activeReservationKeys = Object.freeze([
  'expiresAt',
  'expectedCurrentRateSegmentOrdinal',
  'expectedPreviousRateSegment',
  'expectedTargetPreimageArtifactContentDigest',
  'manifestEntryDigest',
  'nonceDigest',
  'previousStageReceiptDigest',
  'reservationDigest',
  'reservedAt',
  'stageOrdinal',
])

/** Exact durable verified-rate summary property names. */
const activeReservationRateSegmentKeys = Object.freeze([
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

/** Stable raw-value-free durable reservation failure classes. */
export type WorkspaceSearchMigrationRehearsalStageReservationAwsErrorCode =
  | 'INVALID_STAGE_RESERVATION_STATE'
  | 'STAGE_RESERVATION_CONFLICT'
  | 'STAGE_RESERVATION_RECOVERY_REQUIRED'
  | 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN'

/** Stable raw-value-free durable reservation error. */
export class WorkspaceSearchMigrationRehearsalStageReservationAwsError
  extends Error {
  /** Machine-readable failure classification without resource values. */
  readonly code:
    WorkspaceSearchMigrationRehearsalStageReservationAwsErrorCode

  /**
   * Creates one durable reservation failure.
   *
   * @param code - Stable raw-value-free failure classification.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalStageReservationAwsErrorCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalStageReservationAwsError'
    this.code = code
  }
}

/** Narrow migration-state transport used only by the rehearsal head store. */
export interface WorkspaceSearchMigrationRehearsalStageReservationAwsTransport {
  /**
   * Strongly reads the adapter-owned manifest head.
   *
   * @param command - Exact adapter-owned consistent GetItem command.
   * @returns Raw low-level DynamoDB result.
   */
  getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Atomically creates or exact-predecessor replaces the manifest head.
   *
   * @param command - Exact adapter-owned single-Put transaction.
   * @returns Raw low-level DynamoDB result.
   */
  transactWriteRehearsalStageReservation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/** Physical table location known before the first measured table lookup. */
export type WorkspaceSearchMigrationRehearsalStageReservationAwsBinding = {
  /** Exact requested physical migration-state table name. */
  readonly stateTableName: string
  /** Authenticated binding of every requested rehearsal resource. */
  readonly requestedResourcesBinding: string
}

/** Construction input for one manifest-scoped durable head store. */
export type CreateWorkspaceSearchMigrationRehearsalStageReservationAwsStoreInput = {
  /** Requested state-table location and complete resource binding. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalStageReservationAwsBinding
  /** Complete authenticated manifest owning this single head. */
  readonly manifest: unknown
  /** Shared 32-byte manifest verification key used only during construction. */
  readonly manifestVerificationKey: Uint8Array
  /** Narrow low-level migration-state transport. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalStageReservationAwsTransport
}

/** Input for atomically claiming one exact next manifest entry. */
export type ClaimWorkspaceSearchMigrationRehearsalStageReservationInput = {
  /** Untrusted authenticated reservation candidate. */
  readonly reservation: unknown
  /** Independently authenticated exact manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Immediate runtime-authenticated predecessor receipt, or null at root. */
  readonly previousReceipt?: unknown | null
  /** Trusted canonical claim time before the reservation expires. */
  readonly observedAt: string
  /** Shared 32-byte stage verification key. */
  readonly verificationKey: Uint8Array
  /** Parent-only key authenticating special predecessor commit journals. */
  readonly publicationVerificationKey?: Uint8Array | null
}

/**
 * Raw five-field stage claim accepted before the first remote identity read.
 */
export type PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput = {
  /** Untrusted authenticated reservation candidate. */
  readonly reservation: unknown
  /** Independently authenticated exact manifest selection. */
  readonly selection: unknown
  /** Immediate runtime-authenticated predecessor receipt, or null at root. */
  readonly previousReceipt: unknown | null
  /** Shared non-Proxy 32-byte stage authentication key. */
  readonly stageKey: Uint8Array
  /** Parent-only non-Proxy 32-byte commit-journal authentication key. */
  readonly publicationKey: Uint8Array | null
}

/** Secret-free bindings detached from one authenticated stage reservation. */
export type WorkspaceSearchMigrationRehearsalStageReservationClaimBinding = {
  /** Digest of the exact authenticated manifest. */
  readonly manifestDigest: string
  /** Digest of the authenticated non-production permit. */
  readonly permitDigest: string
  /** Exact reviewed implementation commit OID. */
  readonly commit: string
  /** Authenticated complete requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Reviewed measured-configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** SHA-256 digest of the exact stage key retained by the capability. */
  readonly stageKeyDigest: string
  /** SHA-256 digest of the parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Exact authenticated rate predecessor selected before child execution. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Exact fresh rate-segment ordinal required from this child. */
  readonly expectedCurrentRateSegmentOrdinal: number
  /** Planning-commit-pinned rollback preimage bytes, or null otherwise. */
  readonly expectedTargetPreimageArtifactContentDigest: string | null
  /** Canonical inclusive reservation creation time. */
  readonly reservedAt: string
  /** Canonical exclusive reservation expiry time. */
  readonly expiresAt: string
}

/** Input supplied only after caller, journal, and permit preflight succeeds. */
export type ClaimPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput = {
  /** Requested state-table location and authenticated resource binding. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalStageReservationAwsBinding
  /** Narrow migration-state transport owned by the authenticated session. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalStageReservationAwsTransport
  /** Trusted canonical claim time sampled from the permit clock. */
  readonly observedAt: string
}

/**
 * One-shot preauthenticated claim retaining its stage key only until use.
 */
export interface PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim {
  /** Secret-free authenticated bindings available before remote preflight. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalStageReservationClaimBinding

  /**
   * Claims the exact stage once and zeroizes the retained key on every result.
   *
   * @param input - Trusted time, authenticated state binding, and narrow transport.
   * @returns Newly durable secret-free stage head.
   */
  claim(
    input:
      ClaimPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageHead>

  /** Zeroizes the retained key when remote preflight never reaches claim. */
  destroy(): void
}

/** Raw four-field stage commit accepted before the first remote identity read. */
export type PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommitInput = {
  /** Untrusted authenticated reservation candidate. */
  readonly reservation: unknown
  /** Independently authenticated exact manifest selection. */
  readonly selection: unknown
  /** Persisted authenticated receipt becoming the new durable head. */
  readonly receipt: unknown
  /** Immediate authenticated predecessor receipt, or null at stage one. */
  readonly previousReceipt: unknown | null
  /** Exact parent-authorized abandonments since the predecessor commit. */
  readonly reservationAbandonments: readonly unknown[]
  /** In-memory parent authorization capability for persisted stage evidence. */
  readonly parentAuthorization: unknown
  /** Pre-fsynced authenticated local prepared intent authorizing dispatch. */
  readonly commitIntent: unknown
  /** Fresh same-process proof of the exact durable runtime-key cleanup. */
  readonly runtimeKeyCleanupAuthorization: unknown
  /** Command-specific one-shot audit gate, or null for an ordinary stage. */
  readonly commitGateAuthorization: unknown | null
  /** Child-visible 32-byte runtime verification key. */
  readonly runtimeKey: Uint8Array
  /** Parent-only 32-byte durable commit authorization key. */
  readonly publicationKey: Uint8Array
}

/** Secret-free bindings detached from one authenticated stage commit. */
export type WorkspaceSearchMigrationRehearsalStageReservationCommitBinding =
  WorkspaceSearchMigrationRehearsalStageReservationClaimBinding & {
    /** Digest of the exact authenticated successor receipt. */
    readonly receiptDigest: string
    /** Exact global stage ordinal advanced by this commit. */
    readonly stageOrdinal: number
    /** Exact durable successor revision authenticated by the receipt. */
    readonly commitRevision: number
    /** Cumulative explicit abandonment count authenticated by the receipt. */
    readonly abandonmentCount: number
    /** Cumulative abandonment-chain root authenticated by the receipt. */
    readonly abandonmentRootDigest: string
    /** Digest of the exact authenticated local prepared intent. */
    readonly commitIntentDigest: string
    /** Trusted local preparation time fixed before remote preflight. */
    readonly preparedAt: string
    /** Exclusive permit expiry authenticated by the prepared intent. */
    readonly permitExpiresAt: string
    /** Inclusive final dispatch instant for bounded recovery. */
    readonly recoveryDeadlineAt: string
    /** Digest of the exact verified parent-authentication artifact. */
    readonly parentAuthenticationDigest: string
    /** Digest of the complete secret-free parent-authorization binding. */
    readonly parentAuthorizationBindingDigest: string
  }

/** Input supplied only after caller, journal, and permit preflight succeeds. */
export type CommitPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput = {
  /** Requested state-table location and authenticated resource binding. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalStageReservationAwsBinding
  /** Narrow migration-state transport owned by the authenticated preflight. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalStageReservationAwsTransport
  /** Trusted dispatch time sampled after remote identity preflight. */
  readonly commitDispatchAt: string
}

/** Secret-free transport observation kept outside durable commit evidence. */
export type WorkspaceSearchMigrationRehearsalStageCommitTransportObservation =
  | 'transaction-returned'
  | 'exact-strong-read-reconciled'

/** Explicit result distinguishing direct commit from exact strong-read proof. */
export type WorkspaceSearchMigrationRehearsalStageReservationCommitResult = {
  /** Local observation of how this invocation learned the durable fact. */
  readonly transportObservation:
    WorkspaceSearchMigrationRehearsalStageCommitTransportObservation
  /** Immutable secret-free durable successor head. */
  readonly head: WorkspaceSearchMigrationRehearsalStageHead
  /** Exact authenticated evidence atomically stored with the successor. */
  readonly commitEvidence:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence
}

/** One-shot preauthenticated commit retaining its stage key only until use. */
export interface PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsCommit {
  /** Secret-free authenticated bindings available before remote preflight. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalStageReservationCommitBinding

  /**
   * Commits once or recovers the exact already committed immutable row.
   *
   * Exact replay is recoverable only when both the terminal head and its
   * immutable commit journal row reauthenticate to this prepared intent.
   *
   * @param input - Trusted time, authenticated state binding, and narrow transport.
   * @returns Frozen direct or exact-response-loss reconciliation result.
   */
  commit(
    input:
      CommitPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult>

  /** Zeroizes the retained key when remote preflight never reaches commit. */
  destroy(): void
}

/** Input for advancing one claimed head after receipt persistence. */
export type CommitWorkspaceSearchMigrationRehearsalStageReservationInput = {
  /** Exact active authenticated reservation token. */
  readonly reservation: unknown
  /** Independently authenticated exact manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Persisted authenticated stage receipt becoming the new head. */
  readonly receipt: unknown
  /** Immediate authenticated predecessor receipt, or null at stage one. */
  readonly previousReceipt: unknown | null
  /** Exact parent-authorized abandonments since the predecessor commit. */
  readonly reservationAbandonments: readonly unknown[]
  /** In-memory parent authorization capability for persisted stage evidence. */
  readonly parentAuthorization: unknown
  /** Pre-fsynced authenticated local prepared intent. */
  readonly commitIntent: unknown
  /** Fresh same-process proof of the exact durable runtime-key cleanup. */
  readonly runtimeKeyCleanupAuthorization: unknown
  /** Command-specific one-shot audit gate, or null for an ordinary stage. */
  readonly commitGateAuthorization: unknown | null
  /** Trusted dispatch time sampled after remote identity preflight. */
  readonly commitDispatchAt: string
  /** Child-visible 32-byte manifest, reservation, and receipt key. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only 32-byte abandonment and commit-evidence key. */
  readonly publicationVerificationKey: Uint8Array
}

/** Full authenticated special-gate binding retained until the durable CAS. */
type WorkspaceSearchMigrationRehearsalStageCommitGateAuthorizationBinding =
  | WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding
  | WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding
  | null

/** Input for strongly recovering one arbitrary immutable commit journal row. */
export type RecoverWorkspaceSearchMigrationRehearsalStageCommitInput = {
  /** Authenticated receipt whose immutable commit row must be recovered. */
  readonly receipt: unknown
  /** Exact one-based global ordinal used to address the immutable row. */
  readonly stageOrdinal: number
  /** Child-visible 32-byte receipt verification key. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only 32-byte commit-evidence verification key. */
  readonly publicationVerificationKey: Uint8Array
}

/** Exact full-suite input for bounded same-store strong-read recovery. */
export type RecoverWorkspaceSearchMigrationRehearsalStageCommitChainInput = {
  /** Runtime-authenticated receipts in exact global ordinal order. */
  readonly receipts: readonly unknown[]
  /** Exact signed reservation/abandonment pairs in cumulative order. */
  readonly reservationAbandonments: readonly unknown[]
  /** Runtime key for manifest and receipt authentication. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only key for immutable commit-evidence authentication. */
  readonly publicationVerificationKey: Uint8Array
}

/** Opaque process-local proof of one exact immutable strong-read commit row. */
export type WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization = {
  /** Fixed durability-authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_KIND
  /** Durability-authorization capability schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_VERSION
  /** Digest of the privately retained secret-free strong-read binding. */
  readonly bindingDigest: string
}

/** Secret-free facts proven by one genuine strong-read authorization. */
export type WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding = {
  /** Exact publication-authenticated evidence from the immutable journal. */
  readonly commitEvidence:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence
  /** Digest of the exact canonical commit evidence. */
  readonly commitEvidenceDigest: string
  /** Digest of the runtime-authenticated receipt addressing the row. */
  readonly receiptDigest: string
  /** Exact one-based immutable journal ordinal. */
  readonly stageOrdinal: number
  /** Exact inactive durable head installed by this commit. */
  readonly commitHead: WorkspaceSearchMigrationRehearsalStageHead
  /** Validated current suite head at or beyond this commit. */
  readonly currentHead: WorkspaceSearchMigrationRehearsalStageHead
  /** Digest binding the authenticated physical migration-state location. */
  readonly stateTableLocationBindingDigest: string
  /** Digest of the deterministic immutable journal record locator. */
  readonly journalRecordKeyDigest: string
  /** Digest of the exact strictly decoded immutable DynamoDB item. */
  readonly journalItemDigest: string
  /** Digest of the unchanged terminal root snapshot bracketing all row reads. */
  readonly terminalRootSnapshotDigest: string
  /** Required source proving both journal and current root were strong reads. */
  readonly provenance: 'dynamodb-consistent-read'
}

/** One exact immutable abandonment row retained behind a local capability. */
export type WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityRowBinding = {
  /** Parent-authenticated transition recovered from the immutable row. */
  readonly abandonment:
    WorkspaceSearchMigrationRehearsalStageReservationAbandonment
  /** Digest of the exact runtime-authenticated abandoned reservation. */
  readonly reservationDigest: string
  /** Digest of the exact parent-authenticated abandonment transition. */
  readonly abandonmentDigest: string
  /** Exact global stage ordinal owning this abandonment. */
  readonly stageOrdinal: number
  /** Exact cumulative one-based abandonment ordinal. */
  readonly abandonmentCount: number
  /** Digest of the deterministic immutable journal record locator. */
  readonly journalRecordKeyDigest: string
  /** Digest of the exact strictly decoded immutable DynamoDB item. */
  readonly journalItemDigest: string
}

/** Opaque proof of the exact bounded immutable abandonment-row set. */
export type WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization = {
  /** Fixed abandonment durability-authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_KIND
  /** Abandonment durability capability schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_VERSION
  /** Digest of the privately retained exact durable-row binding. */
  readonly bindingDigest: string
}

/** Secret-free facts behind one genuine abandonment durability capability. */
export type WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding = {
  /** Exact immutable row proofs in cumulative abandonment order. */
  readonly rows:
    readonly WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityRowBinding[]
  /** Exact terminal cumulative abandonment count, including explicit zero. */
  readonly abandonmentCount: number
  /** Exact terminal cumulative abandonment-chain root. */
  readonly abandonmentRootDigest: string
  /** Digest binding the authenticated physical migration-state location. */
  readonly stateTableLocationBindingDigest: string
  /** Digest of the unchanged terminal root bracketing every recovered row. */
  readonly terminalRootSnapshotDigest: string
  /** Required source proving rows and both root snapshots were strong reads. */
  readonly provenance: 'dynamodb-consistent-read'
}

/** Complete same-root recovery result consumed by publication verification. */
export type WorkspaceSearchMigrationRehearsalStageDurabilityRecovery = {
  /** Ordered exact immutable commit-row capabilities for all 36 stages. */
  readonly commitAuthorizations:
    readonly WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization[]
  /** Exact immutable abandonment-set capability, including explicit zero. */
  readonly abandonmentAuthorization:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization
}

/** Strong-read recovery returns only an opaque durability authorization. */
export type WorkspaceSearchMigrationRehearsalStageCommitRecovery =
  WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization

/** Input for explicitly abandoning one expired contained reservation. */
export type AbandonWorkspaceSearchMigrationRehearsalStageReservationInput = {
  /** Exact active runtime-authenticated reservation token. */
  readonly reservation: unknown
  /** Independently authenticated exact manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Parent-signed immutable abandonment transition. */
  readonly abandonment: unknown
  /** Genuine same-process proof that the exact runtime key was erased. */
  readonly runtimeKeyCleanupAuthorization: unknown
  /** Trusted canonical parent time not before transition authorization. */
  readonly observedAt: string
  /** Runtime-only key for manifest and reservation verification. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only key for abandonment authorization verification. */
  readonly publicationVerificationKey: Uint8Array
}

/** Manifest-scoped durable reservation capability. */
export interface WorkspaceSearchMigrationRehearsalStageReservationAwsStore {
  /**
   * Claims the exact next entry once, or replaces only an expired claim.
   *
   * @param input - Authenticated reservation, selection, time, and key.
   * @returns Newly committed secret-free durable head.
   */
  claim(
    input: ClaimWorkspaceSearchMigrationRehearsalStageReservationInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageHead>

  /**
   * Advances the head only while the exact reservation still owns the slot.
   *
   * @param input - Active reservation, persisted receipt, time, and key.
   * @returns Newly committed secret-free durable head.
   */
  commit(
    input: CommitWorkspaceSearchMigrationRehearsalStageReservationInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult>

  /**
   * Strongly recovers all 36 immutable rows through this exact store.
   *
   * @param input - Ordered receipts and separated verification keys.
   * @returns Ordered process-local durability authorizations.
   */
  recoverCommitChain(
    input: RecoverWorkspaceSearchMigrationRehearsalStageCommitChainInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageDurabilityRecovery>

  /**
   * Strongly recovers one exact immutable commit row for any prior ordinal.
   *
   * @param input - Authenticated receipt, ordinal, and verification key.
   * @returns Exact journal evidence plus the validated current suite head.
   */
  recoverCommit(
    input: RecoverWorkspaceSearchMigrationRehearsalStageCommitInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageCommitRecovery>

  /**
   * Removes the exact expired active reservation through a parent-signed CAS.
   *
   * @param input - Exact active token, signed transition, time, and split keys.
   * @returns Newly committed secret-free durable head.
   */
  abandon(
    input: AbandonWorkspaceSearchMigrationRehearsalStageReservationInput,
  ): Promise<WorkspaceSearchMigrationRehearsalStageHead>

  /**
   * Strongly reads the current secret-free manifest head.
   *
   * @returns Current head, or the canonical absent root projection.
   */
  read(): Promise<WorkspaceSearchMigrationRehearsalStageHead>
}

/** Reservation fields retained in the single durable active slot. */
type DurableActiveReservation = {
  /** Digest of the exact complete authenticated reservation. */
  readonly reservationDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Required predecessor head receipt, or null at stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Exact rate predecessor authenticated when this claim became durable. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Exact rate-segment ordinal reserved for the claimed child. */
  readonly expectedCurrentRateSegmentOrdinal: number
  /** Planning-commit-pinned rollback preimage bytes, or null otherwise. */
  readonly expectedTargetPreimageArtifactContentDigest: string | null
  /** Exact next global stage ordinal. */
  readonly stageOrdinal: number
  /** Public digest of fresh process reservation entropy. */
  readonly nonceDigest: string
  /** Canonical inclusive reservation creation time. */
  readonly reservedAt: string
  /** Canonical exclusive reservation expiry. */
  readonly expiresAt: string
}

/** Canonical nested state stored and digest-bound as one unit. */
type DurableStageHeadState = {
  /** Fixed nested state discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND
  /** Fixed nested state version. */
  readonly stateVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION
  /** Digest of the complete authenticated manifest. */
  readonly manifestDigest: string
  /** Digest of the permit globally owning this suite root. */
  readonly permitDigest: string
  /** Authenticated requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Highest committed global stage ordinal. */
  readonly completedStageOrdinal: number
  /** Exact committed receipt digest, or null at the root. */
  readonly headReceiptDigest: string | null
  /** Sole active next-stage reservation, or null. */
  readonly activeReservation: DurableActiveReservation | null
  /** Cumulative explicit abandonment transition count. */
  readonly abandonmentCount: number
  /** Cumulative explicit abandonment transition root. */
  readonly abandonmentRootDigest: string
  /** Last parent-authorized abandonment time, or null before any. */
  readonly lastAbandonedAt: string | null
}

/** Strict loaded row retained for an exact-predecessor transaction. */
type LoadedDurableStageHead = {
  /** Detached validated nested state. */
  readonly state: DurableStageHeadState
  /** Canonical exact nested state JSON. */
  readonly stateJson: string
  /** Domain-separated digest of the nested state and table location. */
  readonly stateDigest: string
  /** Monotonic current row revision. */
  readonly revision: number
  /** Exact current state write nonce. */
  readonly writeNonce: string
}

/** Authenticated material written beside one exact durable successor head. */
type PreparedStageCommitJournal = {
  /** Exact authenticated reservation consumed by the successor. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Exact authenticated receipt becoming the successor head. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact authenticated durable evidence installed in the same transaction. */
  readonly commitEvidence:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence
}

/** One independently verified abandonment and its exact reservation. */
type AuthenticatedStageCommitReservationAbandonment = {
  /** Runtime-authenticated reservation removed before the successful claim. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Parent-authorized immutable transition extending the cumulative root. */
  readonly abandonment:
    WorkspaceSearchMigrationRehearsalStageReservationAbandonment
}

/** Strict immutable journal row retained with its provenance digest. */
type LoadedStageCommitJournal = {
  /** Publication-authenticated exact durable evidence. */
  readonly commitEvidence:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence
  /** Digest of the exact strictly decoded DynamoDB row. */
  readonly journalItemDigest: string
  /** Deterministic exact immutable row key used by the strong read. */
  readonly recordKey: string
}

/** Strict immutable abandonment row retained with provenance digests. */
type LoadedStageAbandonmentJournal = {
  /** Parent-authenticated exact abandonment transition. */
  readonly abandonment:
    WorkspaceSearchMigrationRehearsalStageReservationAbandonment
  /** Digest of the exact strictly decoded DynamoDB row. */
  readonly journalItemDigest: string
  /** Deterministic exact immutable row key used by the strong read. */
  readonly recordKey: string
}

/** Authenticated manifest and deterministic table location retained by store. */
type PreparedStageHeadBinding = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Digest binding the requested physical table and resource selection. */
  readonly stateTableLocationBindingDigest: string
  /** Deterministic permit/resource-scoped record namespace. */
  readonly recordNamespace: string
  /** Deterministic permit/resource-scoped suite-root row key. */
  readonly recordKey: string
  /** Exact authenticated manifest digest. */
  readonly manifestDigest: string
  /** Detached exact authenticated reviewed manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Digest of the runtime key authenticated by the manifest. */
  readonly manifestKeyDigest: string
  /** Exact authenticated permit digest pinning the suite root. */
  readonly permitDigest: string
  /** Authenticated complete requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Ordered exact manifest-entry digests. */
  readonly manifestEntryDigests: readonly string[]
  /** Digest of the parent-only key authorized by the reviewed manifest. */
  readonly publicationKeyDigest: string
}

/** Captured receiver-preserving transport functions. */
type PreparedStageHeadTransport = {
  /** Strongly reads the sole adapter-owned row. */
  readonly get: (command: GetItemCommand) => Promise<GetItemCommandOutput>
  /** Executes one exact-predecessor Put transaction. */
  readonly transactWrite: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/** Strict guards mapping malformed durable state to one stable failure. */
const stageHeadGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failInvalidStageHead,
)

/** Private brand storage for strong-read commit durability capabilities. */
const stageCommitDurabilityAuthorizationBindings = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding
>()

/** Private brand storage for exact abandonment-set durability capability. */
const stageAbandonmentDurabilityAuthorizationBindings = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding
>()

/**
 * Creates the canonical physical migration-state location binding digest.
 *
 * The digest is safe to place in a pre-transaction commit intent while the
 * raw table name remains confined to the authenticated AWS boundary.
 *
 * @param value - Explicit state table and complete requested-resource binding.
 * @returns Domain-separated lowercase SHA-256 location digest.
 */
export function createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest(
  value: WorkspaceSearchMigrationRehearsalStageReservationAwsBinding,
): string {
  const record = stageHeadGuards.requireRecord(value)
  stageHeadGuards.requireExactKeys(record, [
    'requestedResourcesBinding',
    'stateTableName',
  ])
  const stateTableName = readStateTableName(
    stageHeadGuards.readOwn(record, 'stateTableName'),
  )
  const requestedResourcesBinding = readStageHeadDigest(
    stageHeadGuards.readOwn(record, 'requestedResourcesBinding'),
  )
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-stage-head-location',
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
    stateTableName,
    requestedResourcesBinding,
  })
}

/**
 * Reauthenticates and detaches one one-shot stage claim before remote I/O.
 *
 * The returned capability retains only a private key copy. Raw caller objects
 * and buffers are never crossed over the later STS and S3 await boundaries.
 *
 * @param input - Exact reservation, selection, and 32-byte stage key.
 * @returns Frozen one-shot claim capability and secret-free binding.
 */
export function prepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaim(
  input:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput,
): PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  let retainedRuntimeKey: Uint8Array | undefined
  let retainedPublicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'previousReceipt',
      'publicationKey',
      'reservation',
      'selection',
      'stageKey',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'stageKey'),
    )
    const publicationKeyValue =
      stageHeadGuards.readOwn(record, 'publicationKey')
    publicationKey = publicationKeyValue === null
      ? undefined
      : copyStageHeadKey(publicationKeyValue)
    const selection = requireSelectedStage(
      stageHeadGuards.readOwn(record, 'selection'),
      runtimeKey,
    )
    requireStageClaimRuntimeKeyBinding(selection, runtimeKey)
    if (publicationKey !== undefined) {
      requireStageCommitKeyBindings(selection, runtimeKey, publicationKey)
    }
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection,
        verificationKey: runtimeKey,
      })
    const previousReceipt = verifyOptionalStageCommitPreviousReceipt(
      stageHeadGuards.readOwn(record, 'previousReceipt'),
      runtimeKey,
    )
    retainedRuntimeKey = copyStageHeadKey(runtimeKey)
    retainedPublicationKey = publicationKey === undefined
      ? undefined
      : copyStageHeadKey(publicationKey)
    const claimBinding = Object.freeze({
      manifestDigest: reservation.manifestDigest,
      permitDigest: reservation.permitDigest,
      commit: reservation.commit,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
      configurationBindingDigest:
        reservation.configurationBindingDigest,
      policyVersion: reservation.policyVersion,
      stageKeyDigest: createHash('sha256')
        .update(retainedRuntimeKey)
        .digest('hex'),
      publicationKeyDigest: reservation.publicationKeyDigest,
      expectedPreviousRateSegment:
        reservation.expectedPreviousRateSegment,
      expectedCurrentRateSegmentOrdinal:
        reservation.expectedCurrentRateSegmentOrdinal,
      expectedTargetPreimageArtifactContentDigest:
        reservation.expectedTargetPreimageArtifactContentDigest,
      reservedAt: reservation.reservedAt,
      expiresAt: reservation.expiresAt,
    })
    let activeRuntimeKey: Uint8Array | undefined = retainedRuntimeKey
    let activePublicationKey: Uint8Array | undefined =
      retainedPublicationKey
    retainedRuntimeKey = undefined
    retainedPublicationKey = undefined
    let consumed = false
    return Object.freeze({
      binding: claimBinding,
      /** Claims once after remote non-production preflight succeeds. */
      claim: async (
        claimInput:
          ClaimPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput,
      ): Promise<WorkspaceSearchMigrationRehearsalStageHead> => {
        if (
          consumed ||
          activeRuntimeKey === undefined
        ) {
          return failInvalidStageHead()
        }
        consumed = true
        const claimRuntimeKey = activeRuntimeKey
        const claimPublicationKey = activePublicationKey
        activeRuntimeKey = undefined
        activePublicationKey = undefined
        try {
          const store =
            createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
              binding: claimInput.binding,
              manifest: selection.manifest,
              manifestVerificationKey: claimRuntimeKey,
              transport: claimInput.transport,
            })
          return await store.claim({
            reservation,
            selection,
            previousReceipt,
            observedAt: claimInput.observedAt,
            verificationKey: claimRuntimeKey,
            publicationVerificationKey: claimPublicationKey ?? null,
          })
        } finally {
          zeroizeStageHeadKey(claimRuntimeKey)
          zeroizeStageHeadKey(claimPublicationKey)
        }
      },
      /** Destroys an unused claim capability and both retained keys. */
      destroy: (): void => {
        consumed = true
        zeroizeStageHeadKey(activeRuntimeKey)
        zeroizeStageHeadKey(activePublicationKey)
        activeRuntimeKey = undefined
        activePublicationKey = undefined
      },
    })
  } catch (error: unknown) {
    zeroizeStageHeadKey(retainedRuntimeKey)
    zeroizeStageHeadKey(retainedPublicationKey)
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/**
 * Reauthenticates and detaches one one-shot stage commit before remote I/O.
 *
 * The returned capability retains only a private key copy and authenticated
 * detached values. It reconciles an exact successor only when this same
 * invocation received an outcome-uncertain transaction failure.
 *
 * @param input - Exact reservation, selection, receipt, and 32-byte stage key.
 * @returns Frozen one-shot commit capability and secret-free binding.
 */
export function prepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommit(
  input:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommitInput,
): PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsCommit {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  let retainedRuntimeKey: Uint8Array | undefined
  let retainedPublicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'commitGateAuthorization',
      'commitIntent',
      'parentAuthorization',
      'previousReceipt',
      'publicationKey',
      'receipt',
      'reservation',
      'reservationAbandonments',
      'runtimeKey',
      'runtimeKeyCleanupAuthorization',
      'selection',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'runtimeKey'),
    )
    publicationKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'publicationKey'),
    )
    const selection = requireSelectedStage(
      stageHeadGuards.readOwn(record, 'selection'),
      runtimeKey,
    )
    requireStageCommitKeyBindings(selection, runtimeKey, publicationKey)
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection,
        verificationKey: runtimeKey,
      })
    const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
      stageHeadGuards.readOwn(record, 'receipt'),
      runtimeKey,
    )
    requireReceiptMatchesReservation(receipt, reservation)
    const previousReceipt = verifyOptionalStageCommitPreviousReceipt(
      stageHeadGuards.readOwn(record, 'previousReceipt'),
      runtimeKey,
    )
    requireStageCommitPreviousReceipt(
      selection,
      receipt,
      previousReceipt,
    )
    const reservationAbandonments =
      authenticateStageCommitReservationAbandonments(
        stageHeadGuards.readOwn(record, 'reservationAbandonments'),
        selection,
        previousReceipt,
        reservation,
        receipt,
        runtimeKey,
        publicationKey,
      )
    const parentAuthorization = stageHeadGuards.readOwn(
      record,
      'parentAuthorization',
    )
    const parentAuthorizationBinding =
      requireStageCommitParentAuthorization(
        parentAuthorization,
        selection,
        reservation,
        receipt,
        publicationKey,
      )
    const commitIntent =
      verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
        stageHeadGuards.readOwn(record, 'commitIntent'),
        publicationKey,
      )
    requireCommitIntentMatchesAuthenticatedMaterial(
      commitIntent,
      reservation,
      receipt,
      parentAuthorizationBinding,
    )
    const runtimeKeyCleanupAuthorization = stageHeadGuards.readOwn(
      record,
      'runtimeKeyCleanupAuthorization',
    )
    const runtimeKeyCleanupBinding =
      readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
        runtimeKeyCleanupAuthorization,
      )
    requireRuntimeKeyCleanupMatchesCommit(
      runtimeKeyCleanupBinding,
      reservation,
      parentAuthorizationBinding,
      runtimeKey,
    )
    const commitGateAuthorization = stageHeadGuards.readOwn(
      record,
      'commitGateAuthorization',
    )
    requireStageCommitGateAuthorization(
      commitGateAuthorization,
      commitIntent,
      selection,
      reservation,
      receipt,
    )
    retainedRuntimeKey = copyStageHeadKey(runtimeKey)
    retainedPublicationKey = copyStageHeadKey(publicationKey)
    const commitBinding = Object.freeze({
      manifestDigest: reservation.manifestDigest,
      permitDigest: reservation.permitDigest,
      commit: reservation.commit,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
      configurationBindingDigest:
        reservation.configurationBindingDigest,
      policyVersion: reservation.policyVersion,
      stageKeyDigest: createHash('sha256')
        .update(retainedRuntimeKey)
        .digest('hex'),
      publicationKeyDigest: reservation.publicationKeyDigest,
      expectedPreviousRateSegment:
        reservation.expectedPreviousRateSegment,
      expectedCurrentRateSegmentOrdinal:
        reservation.expectedCurrentRateSegmentOrdinal,
      expectedTargetPreimageArtifactContentDigest:
        reservation.expectedTargetPreimageArtifactContentDigest,
      reservedAt: reservation.reservedAt,
      expiresAt: reservation.expiresAt,
      receiptDigest: createMigrationDigest(receipt),
      stageOrdinal: reservation.stageOrdinal,
      commitRevision: receipt.stageReservationCommitRevision,
      abandonmentCount: receipt.stageReservationAbandonmentCount,
      abandonmentRootDigest:
        receipt.stageReservationAbandonmentRootDigest,
      commitIntentDigest: createMigrationDigest(commitIntent),
      preparedAt: commitIntent.preparedAt,
      permitExpiresAt: commitIntent.recoveryAuthorization.permitExpiresAt,
      recoveryDeadlineAt:
        commitIntent.recoveryAuthorization.recoveryDeadlineAt,
      parentAuthenticationDigest:
        parentAuthorizationBinding.parentAuthenticationDigest,
      parentAuthorizationBindingDigest:
        createMigrationDigest(parentAuthorizationBinding),
    })
    let activeRuntimeKey: Uint8Array | undefined = retainedRuntimeKey
    let activePublicationKey: Uint8Array | undefined =
      retainedPublicationKey
    retainedRuntimeKey = undefined
    retainedPublicationKey = undefined
    let consumed = false
    return Object.freeze({
      binding: commitBinding,
      /** Commits once and reconciles only this uncertain exact successor. */
      commit: async (
        commitInput:
          CommitPreparedWorkspaceSearchMigrationRehearsalStageReservationAwsInput,
      ): Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult> => {
        if (
          consumed ||
          activeRuntimeKey === undefined ||
          activePublicationKey === undefined
        ) {
          return failInvalidStageHead()
        }
        consumed = true
        const commitRuntimeKey = activeRuntimeKey
        const commitPublicationKey = activePublicationKey
        activeRuntimeKey = undefined
        activePublicationKey = undefined
        try {
          const store =
            createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
              binding: commitInput.binding,
              manifest: selection.manifest,
              manifestVerificationKey: commitRuntimeKey,
              transport: commitInput.transport,
            })
          return await store.commit({
            reservation,
            selection,
            receipt,
            previousReceipt,
            reservationAbandonments,
            parentAuthorization,
            commitIntent,
            runtimeKeyCleanupAuthorization,
            commitGateAuthorization,
            commitDispatchAt: commitInput.commitDispatchAt,
            runtimeVerificationKey: commitRuntimeKey,
            publicationVerificationKey: commitPublicationKey,
          })
        } finally {
          zeroizeStageHeadKey(commitRuntimeKey)
          zeroizeStageHeadKey(commitPublicationKey)
        }
      },
      /** Destroys an unused commit capability and retained keys. */
      destroy: (): void => {
        consumed = true
        zeroizeStageHeadKey(activeRuntimeKey)
        zeroizeStageHeadKey(activePublicationKey)
        activeRuntimeKey = undefined
        activePublicationKey = undefined
      },
    })
  } catch (error: unknown) {
    zeroizeStageHeadKey(retainedRuntimeKey)
    zeroizeStageHeadKey(retainedPublicationKey)
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/**
 * Creates one frozen secret-free commit result.
 *
 * @param outcome - Direct commit or response-loss reconciliation outcome.
 * @param head - Strict durable successor head.
 * @returns Detached frozen result and head projection.
 */
function createStageCommitResult(
  transportObservation:
    WorkspaceSearchMigrationRehearsalStageCommitTransportObservation,
  head: WorkspaceSearchMigrationRehearsalStageHead,
  commitEvidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
): WorkspaceSearchMigrationRehearsalStageReservationCommitResult {
  return Object.freeze({
    transportObservation,
    head: Object.freeze({
      manifestDigest: head.manifestDigest,
      completedStageOrdinal: head.completedStageOrdinal,
      headReceiptDigest: head.headReceiptDigest,
      activeReservationDigest: head.activeReservationDigest,
      activeStageOrdinal: head.activeStageOrdinal,
      activeExpiresAt: head.activeExpiresAt,
      abandonmentCount: head.abandonmentCount,
      abandonmentRootDigest: head.abandonmentRootDigest,
      revision: head.revision,
    }),
    commitEvidence,
  })
}

/**
 * Creates one durable manifest-scoped exact-predecessor stage-head store.
 *
 * @param input - Authenticated manifest, requested table, and narrow transport.
 * @returns Frozen claim, commit, and strong-read capability.
 */
export function createWorkspaceSearchMigrationRehearsalStageReservationAwsStore(
  input:
    CreateWorkspaceSearchMigrationRehearsalStageReservationAwsStoreInput,
): WorkspaceSearchMigrationRehearsalStageReservationAwsStore {
  const prepared = prepareStageHeadStoreInput(input)
  return Object.freeze({
    claim: async (
      claimInput:
        ClaimWorkspaceSearchMigrationRehearsalStageReservationInput,
    ) =>
      await claimStageReservation(prepared, claimInput),
    commit: async (
      commitInput:
        CommitWorkspaceSearchMigrationRehearsalStageReservationInput,
    ) =>
      await commitStageReservation(prepared, commitInput),
    recoverCommit: async (
      recoveryInput:
        RecoverWorkspaceSearchMigrationRehearsalStageCommitInput,
    ) => await recoverStageCommit(prepared, recoveryInput),
    recoverCommitChain: async (
      recoveryInput:
        RecoverWorkspaceSearchMigrationRehearsalStageCommitChainInput,
    ) => await recoverStageCommitChain(prepared, recoveryInput),
    abandon: async (
      abandonInput:
        AbandonWorkspaceSearchMigrationRehearsalStageReservationInput,
    ) =>
      await abandonStageReservation(prepared, abandonInput),
    read: async () => await readStageHead(prepared),
  })
}

/**
 * Reads facts retained behind one genuine strong-read durability capability.
 *
 * @param value - Candidate capability returned by `recoverCommit`.
 * @returns Frozen secret-free immutable-row and current-root binding.
 */
export function readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding {
  const record = stageHeadGuards.requireRecord(value)
  const binding = stageCommitDurabilityAuthorizationBindings.get(record)
  if (binding === undefined) return failInvalidStageHead()
  return binding
}

/**
 * Reads facts retained behind one genuine abandonment-set capability.
 *
 * @param value - Candidate capability returned by full-chain recovery.
 * @returns Frozen exact row set and its bracketing terminal-root binding.
 */
export function readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding {
  const record = stageHeadGuards.requireRecord(value)
  const binding = stageAbandonmentDurabilityAuthorizationBindings.get(record)
  if (binding === undefined) return failInvalidStageHead()
  return binding
}

/** Authenticates construction input and captures transport before any await. */
function prepareStageHeadStoreInput(
  input:
    CreateWorkspaceSearchMigrationRehearsalStageReservationAwsStoreInput,
): {
  /** Authenticated deterministic table and manifest binding. */
  readonly binding: PreparedStageHeadBinding
  /** Captured narrow transport. */
  readonly transport: PreparedStageHeadTransport
} {
  let manifestKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'binding',
      'manifest',
      'manifestVerificationKey',
      'transport',
    ])
    manifestKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'manifestVerificationKey'),
    )
    const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
      stageHeadGuards.readOwn(record, 'manifest'),
      manifestKey,
    )
    const bindingRecord = stageHeadGuards.requireRecord(
      stageHeadGuards.readOwn(record, 'binding'),
    )
    stageHeadGuards.requireExactKeys(bindingRecord, [
      'requestedResourcesBinding',
      'stateTableName',
    ])
    const stateTableName = readStateTableName(
      stageHeadGuards.readOwn(bindingRecord, 'stateTableName'),
    )
    const requestedResourcesBinding = readStageHeadDigest(
      stageHeadGuards.readOwn(bindingRecord, 'requestedResourcesBinding'),
    )
    if (requestedResourcesBinding !== manifest.requestedResourcesBinding) {
      return failInvalidStageHead()
    }
    const manifestDigest = createMigrationDigest(manifest)
    const manifestKeyDigest = createHash('sha256')
      .update(manifestKey)
      .digest('hex')
    if (manifest.evidenceKeyDigest !== manifestKeyDigest) {
      return failInvalidStageHead()
    }
    const stateTableLocationBindingDigest =
      createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
        stateTableName,
        requestedResourcesBinding,
      })
    const recordKeyBindingDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-suite-key',
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      stateTableLocationBindingDigest,
      permitDigest: manifest.permitDigest,
      requestedResourcesBinding,
    })
    const recordNamespace =
      `${stageHeadRecordKeyPrefix}/${recordKeyBindingDigest}`
    const transport = prepareStageHeadTransport(
      stageHeadGuards.readOwn(record, 'transport'),
    )
    return Object.freeze({
      binding: Object.freeze({
        stateTableName,
        stateTableLocationBindingDigest,
        recordNamespace,
        recordKey: `${recordNamespace}/root`,
        manifestDigest,
        manifest,
        manifestKeyDigest,
        permitDigest: manifest.permitDigest,
        requestedResourcesBinding,
        manifestEntryDigests: Object.freeze(
          manifest.entries.map((entry) => createMigrationDigest(entry)),
        ),
        publicationKeyDigest: manifest.publicationKeyDigest,
      }),
      transport,
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(manifestKey)
  }
}

/** Captures exact receiver-preserving transport methods. */
function prepareStageHeadTransport(value: unknown): PreparedStageHeadTransport {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failInvalidStageHead()
  }
  try {
    const get: unknown = Reflect.get(
      value,
      'getRehearsalStageReservation',
    )
    const transactWrite: unknown = Reflect.get(
      value,
      'transactWriteRehearsalStageReservation',
    )
    if (typeof get !== 'function' || typeof transactWrite !== 'function') {
      return failInvalidStageHead()
    }
    return Object.freeze({
      /** Calls the captured strong-read function with its original receiver. */
      get: (command: GetItemCommand): Promise<GetItemCommandOutput> =>
        Reflect.apply(get, value, [command]),
      /** Calls the captured transaction function with its original receiver. */
      transactWrite: (
        command: TransactWriteItemsCommand,
      ): Promise<TransactWriteItemsCommandOutput> =>
        Reflect.apply(transactWrite, value, [command]),
    })
  } catch {
    return failInvalidStageHead()
  }
}

/** Claims one next stage through a strong-read plus exact CAS. */
async function claimStageReservation(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  input: ClaimWorkspaceSearchMigrationRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'observedAt',
      ...(Object.hasOwn(record, 'previousReceipt')
        ? ['previousReceipt']
        : []),
      ...(Object.hasOwn(record, 'publicationVerificationKey')
        ? ['publicationVerificationKey']
        : []),
      'reservation',
      'selection',
      'verificationKey',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'verificationKey'),
    )
    const publicationKeyValue = Object.hasOwn(
      record,
      'publicationVerificationKey',
    )
      ? stageHeadGuards.readOwn(record, 'publicationVerificationKey')
      : null
    publicationKey = publicationKeyValue === null
      ? undefined
      : copyStageHeadKey(publicationKeyValue)
    const selection = stageHeadGuards.readOwn(record, 'selection')
    const authenticatedSelection = requireSelectedStage(selection, runtimeKey)
    requireStageClaimRuntimeKeyBinding(authenticatedSelection, runtimeKey)
    if (publicationKey !== undefined) {
      requireStageCommitKeyBindings(
        authenticatedSelection,
        runtimeKey,
        publicationKey,
      )
    }
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection: authenticatedSelection,
        verificationKey: runtimeKey,
      })
    const previousReceipt = verifyOptionalStageCommitPreviousReceipt(
      Object.hasOwn(record, 'previousReceipt')
        ? stageHeadGuards.readOwn(record, 'previousReceipt')
        : null,
      runtimeKey,
    )
    requireReservationMatchesStore(prepared.binding, reservation)
    const observedAt = readStageHeadTimestamp(
      stageHeadGuards.readOwn(record, 'observedAt'),
    )
    const predecessor = await loadStageHead(prepared)
    const predecessorState = predecessor?.state ??
      createInitialStageHeadState(prepared.binding)
    const reservationDigest = createMigrationDigest(reservation)
    if (
      predecessor !== undefined &&
      isExactActiveReservation(
        predecessor.state,
        reservation,
        reservationDigest,
      )
    ) return projectStageHead(predecessor)
    requireStageClaimPreviousReceipt(
      authenticatedSelection,
      reservation,
      previousReceipt,
    )
    requireReservationActiveAt(reservation, observedAt)
    requireReservationMayClaim(predecessorState, reservation)
    await requireStageClaimRatePredecessor(
      prepared,
      authenticatedSelection,
      reservation,
      previousReceipt,
      publicationKey,
    )
    const successorState: DurableStageHeadState = Object.freeze({
      ...predecessorState,
      activeReservation: Object.freeze({
        reservationDigest,
        manifestEntryDigest: reservation.manifestEntryDigest,
        previousStageReceiptDigest:
          reservation.previousStageReceiptDigest,
        expectedPreviousRateSegment:
          reservation.expectedPreviousRateSegment,
        expectedCurrentRateSegmentOrdinal:
          reservation.expectedCurrentRateSegmentOrdinal,
        expectedTargetPreimageArtifactContentDigest:
          reservation.expectedTargetPreimageArtifactContentDigest,
        stageOrdinal: reservation.stageOrdinal,
        nonceDigest: reservation.nonceDigest,
        reservedAt: reservation.reservedAt,
        expiresAt: reservation.expiresAt,
      }),
    })
    const successor = prepareLoadedStageHead(
      prepared.binding,
      successorState,
      (predecessor?.revision ?? 0) + 1,
      reservation.nonceDigest,
    )
    try {
      await writeStageHead(prepared, predecessor, successor)
    } catch (error: unknown) {
      if (!(error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError) ||
        (error.code !== 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN' &&
          error.code !== 'STAGE_RESERVATION_CONFLICT')) throw error
      let reconciled: LoadedDurableStageHead | undefined
      try {
        reconciled = await loadStageHead(prepared)
      } catch {
        throw error
      }
      if (reconciled === undefined) throw error
      if (error.code === 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN') {
        if (!isExactLoadedStageHeadSuccessor(reconciled, successor)) {
          throw error
        }
      } else if (!isExactActiveReservation(
        reconciled.state,
        reservation,
        reservationDigest,
      )) throw error
      return projectStageHead(reconciled)
    }
    return projectStageHead(successor)
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/**
 * Compares every authenticated predecessor-fencing component of two rows.
 *
 * @param actual - Strongly read validated durable row.
 * @param expected - Exact invocation-local successor representation.
 * @returns Whether the read proves this invocation's transaction committed.
 */
function isExactLoadedStageHeadSuccessor(
  actual: LoadedDurableStageHead,
  expected: LoadedDurableStageHead,
): boolean {
  return actual.stateJson === expected.stateJson &&
    actual.stateDigest === expected.stateDigest &&
    actual.revision === expected.revision &&
    actual.writeNonce === expected.writeNonce
}

/** Requires separated runtime and publication keys to match the manifest. */
function requireStageCommitKeyBindings(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): void {
  const runtimeKeyDigest = createHash('sha256')
    .update(runtimeKey)
    .digest('hex')
  const publicationKeyDigest = createHash('sha256')
    .update(publicationKey)
    .digest('hex')
  if (
    selection.manifest.evidenceKeyDigest !== runtimeKeyDigest ||
    selection.manifest.publicationKeyDigest !== publicationKeyDigest ||
    runtimeKeyDigest === publicationKeyDigest
  ) return failInvalidStageHead()
}

/** Requires the claim runtime key to match and differ from publication key. */
function requireStageClaimRuntimeKeyBinding(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  runtimeKey: Uint8Array,
): void {
  const runtimeKeyDigest = createHash('sha256')
    .update(runtimeKey)
    .digest('hex')
  if (
    selection.manifest.evidenceKeyDigest !== runtimeKeyDigest ||
    selection.manifest.publicationKeyDigest === runtimeKeyDigest
  ) return failInvalidStageHead()
}

/** Verifies one optional immediate predecessor with the runtime key. */
function verifyOptionalStageCommitPreviousReceipt(
  value: unknown,
  runtimeKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReceipt | null {
  return value === null
    ? null
    : verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        value,
        runtimeKey,
      )
}

/**
 * Requires a claim to carry its exact runtime-authenticated predecessor.
 *
 * @param selection - Authenticated manifest entry being claimed.
 * @param reservation - Authenticated reservation for that entry.
 * @param previousReceipt - Authenticated immediate predecessor, or root null.
 */
function requireStageClaimPreviousReceipt(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): void {
  const previousReceiptDigest = previousReceipt === null
    ? null
    : createMigrationDigest(previousReceipt)
  if (
    selection.previousStageReceiptDigest !== previousReceiptDigest ||
    reservation.previousStageReceiptDigest !== previousReceiptDigest ||
    (previousReceipt === null && reservation.stageOrdinal !== 1) ||
    (previousReceipt !== null &&
      (
        previousReceipt.stageOrdinal + 1 !== reservation.stageOrdinal ||
        previousReceipt.manifestDigest !== reservation.manifestDigest ||
        previousReceipt.permitDigest !== reservation.permitDigest ||
        previousReceipt.commit !== reservation.commit ||
        previousReceipt.requestedResourcesBinding !==
          reservation.requestedResourcesBinding ||
        previousReceipt.configurationBindingDigest !==
          reservation.configurationBindingDigest ||
        previousReceipt.policyVersion !== reservation.policyVersion
      ))
  ) return failInvalidStageHead()
}

/**
 * Strongly authenticates the durable rate predecessor for one fresh claim.
 *
 * Ordinary stages inherit the immediate receipt segment. Rollback apply and
 * release stages instead inherit the auxiliary successor authenticated by the
 * predecessor's immutable publication-key-MACed commit journal.
 *
 * @param prepared - Authenticated store binding and strong-read transport.
 * @param selection - Authenticated manifest entry being freshly claimed.
 * @param reservation - Authenticated expected predecessor and current ordinal.
 * @param previousReceipt - Runtime-authenticated immediate receipt, or null.
 * @param publicationKey - Parent-only commit-journal verification key.
 */
async function requireStageClaimRatePredecessor(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  publicationKey: Uint8Array | undefined,
): Promise<void> {
  let expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  let expectedTargetPreimageArtifactContentDigest: string | null = null
  if (previousReceipt === null) {
    expectedPreviousRateSegment = null
  } else if (
    selection.entry.command === 'apply' &&
    (selection.entry.scenario === 'complete-apply-rollback' ||
      selection.entry.scenario === 'partial-apply-rollback')
  ) {
    if (publicationKey === undefined) return failInvalidStageHead()
    const journal = await loadStageCommitJournal(
      prepared,
      previousReceipt,
      publicationKey,
    )
    if (journal.commitEvidence.commitGate.kind !== 'target-preimage') {
      return failInvalidStageHead()
    }
    expectedPreviousRateSegment =
      journal.commitEvidence.commitGate.rateSuccessor
    expectedTargetPreimageArtifactContentDigest =
      journal.commitEvidence.commitGate.contentDigest
  } else if (selection.entry.command === 'release') {
    if (publicationKey === undefined) return failInvalidStageHead()
    const journal = await loadStageCommitJournal(
      prepared,
      previousReceipt,
      publicationKey,
    )
    if (
      journal.commitEvidence.commitGate.kind !==
        'terminal-reconciliation'
    ) return failInvalidStageHead()
    expectedPreviousRateSegment =
      journal.commitEvidence.commitGate.rateSuccessor
  } else {
    expectedPreviousRateSegment = Object.freeze({
      ...previousReceipt.rateSegment,
    })
  }
  const expectedCurrentRateSegmentOrdinal = expectedPreviousRateSegment === null
    ? 0
    : expectedPreviousRateSegment.segmentOrdinal + 1
  if (
    serializeCanonicalJson(expectedPreviousRateSegment) !==
      serializeCanonicalJson(reservation.expectedPreviousRateSegment) ||
    reservation.expectedCurrentRateSegmentOrdinal !==
      expectedCurrentRateSegmentOrdinal ||
    reservation.expectedTargetPreimageArtifactContentDigest !==
      expectedTargetPreimageArtifactContentDigest
  ) return failInvalidStageHead()
}

/** Requires the current receipt to extend its exact authenticated predecessor. */
function requireStageCommitPreviousReceipt(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): void {
  const previousReceiptDigest = previousReceipt === null
    ? null
    : createMigrationDigest(previousReceipt)
  if (
    selection.previousStageReceiptDigest !== previousReceiptDigest ||
    receipt.previousStageReceiptDigest !== previousReceiptDigest ||
    (previousReceipt === null && receipt.stageOrdinal !== 1) ||
    (previousReceipt !== null &&
      (
        previousReceipt.stageOrdinal + 1 !== receipt.stageOrdinal ||
        previousReceipt.manifestDigest !== receipt.manifestDigest ||
        previousReceipt.permitDigest !== receipt.permitDigest ||
        previousReceipt.requestedResourcesBinding !==
          receipt.requestedResourcesBinding
      ))
  ) return failInvalidStageHead()
}

/** Requires one genuine parent capability to authorize the exact receipt. */
function requireStageCommitParentAuthorization(
  authorization: unknown,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  publicationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding {
  const binding =
    readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
      authorization,
    )
  const expectedClaimedHead: WorkspaceSearchMigrationRehearsalStageHead =
    Object.freeze({
      manifestDigest: receipt.manifestDigest,
      completedStageOrdinal: receipt.stageOrdinal - 1,
      headReceiptDigest: receipt.previousStageReceiptDigest,
      activeReservationDigest: receipt.stageReservationDigest,
      activeStageOrdinal: receipt.stageOrdinal,
      activeExpiresAt: reservation.expiresAt,
      abandonmentCount: receipt.stageReservationAbandonmentCount,
      abandonmentRootDigest:
        receipt.stageReservationAbandonmentRootDigest,
      revision: receipt.stageReservationClaimRevision,
    })
  const publicationKeyDigest = createHash('sha256')
    .update(publicationKey)
    .digest('hex')
  if (
    binding.publicationKeyDigest !== publicationKeyDigest ||
    binding.manifestDigest !== selection.manifestDigest ||
    binding.manifestEntryDigest !== createMigrationDigest(selection.entry) ||
    binding.previousStageReceiptDigest !==
      selection.previousStageReceiptDigest ||
    binding.stageOrdinal !== receipt.stageOrdinal ||
    binding.stageReservationDigest !== receipt.stageReservationDigest ||
    binding.stageReservationDigest !== createMigrationDigest(reservation) ||
    binding.claimedStageHeadDigest !==
      createMigrationDigest(expectedClaimedHead) ||
    binding.lifecycleDigest !== receipt.processLifecycle.lifecycleDigest ||
    binding.faultPlanDigest !== selection.entry.faultPlanDigest
  ) return failInvalidStageHead()
  return binding
}

/** Verifies the exact ordered abandonment chain since the previous commit. */
function authenticateStageCommitReservationAbandonments(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  successfulReservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): readonly AuthenticatedStageCommitReservationAbandonment[] {
  const previousRevision = previousReceipt?.stageReservationCommitRevision ?? 0
  const previousCount =
    previousReceipt?.stageReservationAbandonmentCount ?? 0
  const previousRoot =
    previousReceipt?.stageReservationAbandonmentRootDigest ??
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
  const abandonmentDelta =
    receipt.stageReservationAbandonmentCount - previousCount
  if (
    abandonmentDelta < 0 ||
    abandonmentDelta > 36 ||
    !Number.isSafeInteger(abandonmentDelta)
  ) return failInvalidStageHead()
  const values = copyExactStageCommitAbandonmentArray(
    value,
    abandonmentDelta,
  )
  const authenticated:
    AuthenticatedStageCommitReservationAbandonment[] = []
  let revision = previousRevision
  let count = previousCount
  let root = previousRoot
  let lastAbandonedAt: string | undefined
  const successfulReservationDigest = createMigrationDigest(
    successfulReservation,
  )
  for (const candidate of values) {
    const record = stageHeadGuards.requireRecord(candidate)
    stageHeadGuards.requireExactKeys(record, [
      'abandonment',
      'reservation',
    ])
    const abandonedReservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection,
        verificationKey: runtimeKey,
      })
    const abandonment =
      verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        abandonment: stageHeadGuards.readOwn(record, 'abandonment'),
        reservation: abandonedReservation,
        selection,
        runtimeVerificationKey: runtimeKey,
        publicationVerificationKey: publicationKey,
      })
    if (
      createMigrationDigest(abandonedReservation) ===
        successfulReservationDigest ||
      abandonment.reservationClaimRevision !== revision + 1 ||
      abandonment.previousAbandonmentCount !== count ||
      abandonment.previousAbandonmentRootDigest !== root ||
      abandonment.abandonmentCount !== count + 1 ||
      abandonment.abandonmentRevision !==
        abandonment.reservationClaimRevision + 1 ||
      (lastAbandonedAt !== undefined &&
        Date.parse(abandonedReservation.reservedAt) <
          Date.parse(lastAbandonedAt))
    ) return failInvalidStageHead()
    revision = abandonment.abandonmentRevision
    count = abandonment.abandonmentCount
    root = abandonment.abandonmentRootDigest
    lastAbandonedAt = abandonment.abandonedAt
    authenticated.push(Object.freeze({
      reservation: abandonedReservation,
      abandonment,
    }))
  }
  if (
    receipt.stageReservationClaimRevision !== revision + 1 ||
    receipt.stageReservationCommitRevision !==
      receipt.stageReservationClaimRevision + 1 ||
    receipt.stageReservationAbandonmentCount !== count ||
    receipt.stageReservationAbandonmentRootDigest !== root ||
    (lastAbandonedAt !== undefined &&
      Date.parse(successfulReservation.reservedAt) <
        Date.parse(lastAbandonedAt))
  ) return failInvalidStageHead()
  return Object.freeze(authenticated)
}

/** Copies one exact dense ordinary abandonment-pair array. */
function copyExactStageCommitAbandonmentArray(
  value: unknown,
  expectedLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expectedLength ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== expectedLength + 1
  ) return failInvalidStageHead()
  const values: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failInvalidStageHead()
    values.push(descriptor.value)
  }
  return Object.freeze(values)
}

/** Commits one receipt only while its exact reservation still owns the slot. */
async function commitStageReservation(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  input: CommitWorkspaceSearchMigrationRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult> {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'commitGateAuthorization',
      'commitDispatchAt',
      'commitIntent',
      'parentAuthorization',
      'previousReceipt',
      'publicationVerificationKey',
      'receipt',
      'reservation',
      'reservationAbandonments',
      'runtimeKeyCleanupAuthorization',
      'runtimeVerificationKey',
      'selection',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'runtimeVerificationKey'),
    )
    publicationKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'publicationVerificationKey'),
    )
    const selection = requireSelectedStage(
      stageHeadGuards.readOwn(record, 'selection'),
      runtimeKey,
    )
    requireStageCommitKeyBindings(selection, runtimeKey, publicationKey)
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection,
        verificationKey: runtimeKey,
      })
    requireReservationMatchesStore(prepared.binding, reservation)
    const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
      stageHeadGuards.readOwn(record, 'receipt'),
      runtimeKey,
    )
    requireReceiptMatchesReservation(receipt, reservation)
    const previousReceipt = verifyOptionalStageCommitPreviousReceipt(
      stageHeadGuards.readOwn(record, 'previousReceipt'),
      runtimeKey,
    )
    requireStageCommitPreviousReceipt(
      selection,
      receipt,
      previousReceipt,
    )
    authenticateStageCommitReservationAbandonments(
      stageHeadGuards.readOwn(record, 'reservationAbandonments'),
      selection,
      previousReceipt,
      reservation,
      receipt,
      runtimeKey,
      publicationKey,
    )
    const parentAuthorizationBinding =
      requireStageCommitParentAuthorization(
        stageHeadGuards.readOwn(record, 'parentAuthorization'),
        selection,
        reservation,
        receipt,
        publicationKey,
      )
    const commitIntent =
      verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
        stageHeadGuards.readOwn(record, 'commitIntent'),
        publicationKey,
      )
    requireCommitIntentMatchesAuthenticatedMaterial(
      commitIntent,
      reservation,
      receipt,
      parentAuthorizationBinding,
    )
    const runtimeKeyCleanupAuthorization = stageHeadGuards.readOwn(
      record,
      'runtimeKeyCleanupAuthorization',
    )
    const runtimeKeyCleanupBinding =
      readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
        runtimeKeyCleanupAuthorization,
      )
    requireRuntimeKeyCleanupMatchesCommit(
      runtimeKeyCleanupBinding,
      reservation,
      parentAuthorizationBinding,
      runtimeKey,
    )
    const commitGateAuthorization = stageHeadGuards.readOwn(
      record,
      'commitGateAuthorization',
    )
    const commitGateBinding = requireStageCommitGateAuthorization(
      commitGateAuthorization,
      commitIntent,
      selection,
      reservation,
      receipt,
    )
    const commitDispatchAt = readStageHeadTimestamp(
      stageHeadGuards.readOwn(record, 'commitDispatchAt'),
    )
    if (
      Date.parse(receipt.startedAt) < Date.parse(reservation.reservedAt) ||
      Date.parse(commitIntent.preparedAt) <= Date.parse(receipt.completedAt) ||
      Date.parse(commitIntent.preparedAt) <=
        Date.parse(receipt.processLifecycle.processExitedAt) ||
      Date.parse(commitIntent.preparedAt) >=
        Date.parse(commitIntent.recoveryAuthorization.recoveryDeadlineAt) ||
      commitIntent.stateTableLocationBindingDigest !==
        prepared.binding.stateTableLocationBindingDigest
    ) return failInvalidStageHead()
    const admissionMode = readStageCommitAdmissionMode(
      commitIntent,
      commitDispatchAt,
    )
    const predecessor = await loadStageHead(prepared)
    if (predecessor === undefined) return failStageHeadConflict()
    const projectedPredecessor = projectStageHead(predecessor)
    if (isExactCommitIntentSuccessor(
      projectedPredecessor,
      commitIntent,
    )) {
      const recoveredEvidence = await loadStageCommitJournal(
        prepared,
        receipt,
        publicationKey,
      )
      requireCommitEvidenceMatchesIntent(
        recoveredEvidence.commitEvidence,
        commitIntent,
      )
      consumeStageCommitAuthorizations(
        runtimeKeyCleanupAuthorization,
        runtimeKeyCleanupBinding,
        commitGateAuthorization,
        commitGateBinding,
      )
      return createStageCommitResult(
        'exact-strong-read-reconciled',
        projectedPredecessor,
        recoveredEvidence.commitEvidence,
      )
    }
    const reservationDigest = createMigrationDigest(reservation)
    requireReservationMayCommit(
      predecessor.state,
      reservation,
      reservationDigest,
    )
    if (receipt.stageReservationClaimRevision !== predecessor.revision) {
      return failInvalidStageHead()
    }
    if (
      commitIntent.commitGate.kind !== 'none' &&
      admissionMode !== 'ordinary'
    ) return failInvalidStageHead()
    if (
      receipt.stageReservationAbandonmentCount !==
        predecessor.state.abandonmentCount ||
      receipt.stageReservationAbandonmentRootDigest !==
        predecessor.state.abandonmentRootDigest
    ) return failInvalidStageHead()
    const receiptDigest = createMigrationDigest(receipt)
    const successorState: DurableStageHeadState = Object.freeze({
      ...predecessor.state,
      completedStageOrdinal: reservation.stageOrdinal,
      headReceiptDigest: receiptDigest,
      activeReservation: null,
    })
    const successor = prepareLoadedStageHead(
      prepared.binding,
      successorState,
      predecessor.revision + 1,
      receiptDigest,
    )
    if (receipt.stageReservationCommitRevision !== successor.revision) {
      return failInvalidStageHead()
    }
    const successorHead = projectStageHead(successor)
    if (!isExactCommitIntentSuccessor(
      successorHead,
      commitIntent,
    )) return failInvalidStageHead()
    const commitEvidence = createCommittedStageEvidenceFromIntent(
      commitIntent,
      successorHead,
      commitDispatchAt,
      admissionMode,
      publicationKey,
    )
    consumeStageCommitAuthorizations(
      runtimeKeyCleanupAuthorization,
      runtimeKeyCleanupBinding,
      commitGateAuthorization,
      commitGateBinding,
    )
    try {
      await writeStageHead(
        prepared,
        predecessor,
        successor,
        undefined,
        Object.freeze({ reservation, receipt, commitEvidence }),
      )
    } catch (error: unknown) {
      if (
        !(error instanceof
          WorkspaceSearchMigrationRehearsalStageReservationAwsError) ||
        (error.code !== 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN' &&
          error.code !== 'STAGE_RESERVATION_CONFLICT')
      ) throw error
      const reconciled = await loadStageHead(prepared)
      if (
        reconciled === undefined ||
        !isExactCommitIntentSuccessor(
          projectStageHead(reconciled),
          commitIntent,
        )
      ) throw error
      let recoveredEvidence: LoadedStageCommitJournal
      try {
        recoveredEvidence = await loadStageCommitJournal(
          prepared,
          receipt,
          publicationKey,
        )
      } catch {
        throw error
      }
      requireCommitEvidenceMatchesIntent(
        recoveredEvidence.commitEvidence,
        commitIntent,
      )
      if (
        serializeCanonicalJson(recoveredEvidence.commitEvidence) !==
          serializeCanonicalJson(commitEvidence)
      ) throw error
      return createStageCommitResult(
        'exact-strong-read-reconciled',
        projectStageHead(reconciled),
        recoveredEvidence.commitEvidence,
      )
    }
    const committedJournal = await loadStageCommitJournal(
      prepared,
      receipt,
      publicationKey,
    )
    requireCommitEvidenceMatchesIntent(
      committedJournal.commitEvidence,
      commitIntent,
    )
    if (
      serializeCanonicalJson(committedJournal.commitEvidence) !==
        serializeCanonicalJson(commitEvidence)
    ) return failInvalidStageHead()
    return createStageCommitResult(
      'transaction-returned',
      successorHead,
      committedJournal.commitEvidence,
    )
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/** Strongly recovers the fixed full-suite commit chain in ordinal order. */
async function recoverStageCommitChain(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  input: RecoverWorkspaceSearchMigrationRehearsalStageCommitChainInput,
): Promise<WorkspaceSearchMigrationRehearsalStageDurabilityRecovery> {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'publicationVerificationKey',
      'receipts',
      'reservationAbandonments',
      'runtimeVerificationKey',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'runtimeVerificationKey'),
    )
    publicationKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'publicationVerificationKey'),
    )
    if (
      createHash('sha256').update(runtimeKey).digest('hex') !==
        prepared.binding.manifestKeyDigest ||
      createHash('sha256').update(publicationKey).digest('hex') !==
        prepared.binding.publicationKeyDigest
    ) return failInvalidStageHead()
    const receipts = copyExactStageCommitChainArray(
      stageHeadGuards.readOwn(record, 'receipts'),
    )
    const authenticatedReceipts:
      WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        receipts[index],
        runtimeKey,
      )
      requireReceiptMatchesPreparedStageHeadBinding(
        receipt,
        prepared.binding,
      )
      if (receipt.stageOrdinal !== index + 1) return failInvalidStageHead()
      authenticatedReceipts.push(receipt)
    }
    const terminalReceipt = authenticatedReceipts.at(-1)
    if (terminalReceipt === undefined) return failInvalidStageHead()
    const authenticatedAbandonments =
      authenticateStageCommitRecoveryAbandonments(
        stageHeadGuards.readOwn(record, 'reservationAbandonments'),
        authenticatedReceipts,
        prepared.binding,
        runtimeKey,
        publicationKey,
      )
    const rootBefore = await loadStageHead(prepared)
    if (rootBefore === undefined) return failInvalidStageHead()
    requireTerminalStageCommitRoot(rootBefore, terminalReceipt)
    const journals: LoadedStageCommitJournal[] = []
    for (const receipt of authenticatedReceipts) {
      journals.push(await loadStageCommitJournal(
        prepared,
        receipt,
        publicationKey,
      ))
    }
    const abandonmentJournals: LoadedStageAbandonmentJournal[] = []
    for (const authenticated of authenticatedAbandonments) {
      abandonmentJournals.push(await loadStageAbandonmentJournal(
        prepared,
        authenticated,
        authenticatedReceipts,
        runtimeKey,
        publicationKey,
      ))
    }
    const rootAfter = await loadStageHead(prepared)
    if (
      rootAfter === undefined ||
      !isExactLoadedStageHeadSuccessor(rootAfter, rootBefore)
    ) return failInvalidStageHead()
    const authorizations:
      WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization[] =
        []
    for (let index = 0; index < authenticatedReceipts.length; index += 1) {
      const receipt = authenticatedReceipts[index]
      const journal = journals[index]
      if (receipt === undefined || journal === undefined) {
        return failInvalidStageHead()
      }
      authorizations.push(createStageCommitDurabilityAuthorization(
        prepared.binding,
        receipt,
        journal,
        rootBefore,
      ))
    }
    return Object.freeze({
      commitAuthorizations: Object.freeze(authorizations),
      abandonmentAuthorization:
        createStageAbandonmentDurabilityAuthorization(
          prepared.binding,
          authenticatedAbandonments,
          abandonmentJournals,
          rootBefore,
        ),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/**
 * Authenticates the exact bounded abandonment chain declared by all receipts.
 *
 * @param value - Untrusted dense reservation/abandonment pair array.
 * @param receipts - Authenticated full-suite receipt chain.
 * @param binding - Authenticated manifest and durable-location binding.
 * @param runtimeKey - Runtime reservation verification key.
 * @param publicationKey - Parent abandonment verification key.
 * @returns Frozen exact transition pairs in cumulative count order.
 */
function authenticateStageCommitRecoveryAbandonments(
  value: unknown,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  binding: PreparedStageHeadBinding,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): readonly AuthenticatedStageCommitReservationAbandonment[] {
  const terminalReceipt = receipts.at(-1)
  if (
    terminalReceipt === undefined ||
    terminalReceipt.stageReservationAbandonmentCount >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_RECOVERY_MAX_ENTRIES
  ) return failInvalidStageHead()
  const values = copyExactStageCommitAbandonmentArray(
    value,
    terminalReceipt.stageReservationAbandonmentCount,
  )
  const authenticated:
    AuthenticatedStageCommitReservationAbandonment[] = []
  let cursor = 0
  let revision = 0
  let count = 0
  let root =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]
    if (receipt === undefined) return failInvalidStageHead()
    const selection = createStageCommitRecoverySelection(
      binding,
      receipts,
      index,
    )
    const abandonmentDelta =
      receipt.stageReservationAbandonmentCount - count
    if (
      abandonmentDelta < 0 ||
      !Number.isSafeInteger(abandonmentDelta) ||
      cursor + abandonmentDelta > values.length
    ) return failInvalidStageHead()
    let lastAbandonedAt: string | undefined
    for (let offset = 0; offset < abandonmentDelta; offset += 1) {
      const candidate = values[cursor]
      const pairRecord = stageHeadGuards.requireRecord(candidate)
      stageHeadGuards.requireExactKeys(pairRecord, [
        'abandonment',
        'reservation',
      ])
      const reservation =
        verifyWorkspaceSearchMigrationRehearsalStageReservation({
          reservation: stageHeadGuards.readOwn(pairRecord, 'reservation'),
          selection,
          verificationKey: runtimeKey,
        })
      requireReservationMatchesStore(binding, reservation)
      const abandonment =
        verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
          abandonment: stageHeadGuards.readOwn(pairRecord, 'abandonment'),
          reservation,
          selection,
          runtimeVerificationKey: runtimeKey,
          publicationVerificationKey: publicationKey,
        })
      if (
        createMigrationDigest(reservation) ===
          receipt.stageReservationDigest ||
        abandonment.reservationClaimRevision !== revision + 1 ||
        abandonment.previousAbandonmentCount !== count ||
        abandonment.previousAbandonmentRootDigest !== root ||
        abandonment.abandonmentCount !== count + 1 ||
        abandonment.abandonmentRevision !==
          abandonment.reservationClaimRevision + 1 ||
        (lastAbandonedAt !== undefined &&
          Date.parse(reservation.reservedAt) <
            Date.parse(lastAbandonedAt))
      ) return failInvalidStageHead()
      authenticated.push(Object.freeze({ reservation, abandonment }))
      revision = abandonment.abandonmentRevision
      count = abandonment.abandonmentCount
      root = abandonment.abandonmentRootDigest
      lastAbandonedAt = abandonment.abandonedAt
      cursor += 1
    }
    if (
      receipt.stageReservationClaimRevision !== revision + 1 ||
      receipt.stageReservationCommitRevision !==
        receipt.stageReservationClaimRevision + 1 ||
      receipt.stageReservationAbandonmentCount !== count ||
      receipt.stageReservationAbandonmentRootDigest !== root
    ) return failInvalidStageHead()
    revision = receipt.stageReservationCommitRevision
  }
  if (cursor !== values.length) return failInvalidStageHead()
  return Object.freeze(authenticated)
}

/**
 * Reconstructs one exact authenticated selection from the retained manifest.
 *
 * @param binding - Authenticated manifest retained by the store.
 * @param receipts - Authenticated full-suite receipt chain.
 * @param index - Zero-based manifest entry index.
 * @returns Frozen exact selection accepted by reservation verification.
 */
function createStageCommitRecoverySelection(
  binding: PreparedStageHeadBinding,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  index: number,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const entry = binding.manifest.entries[index]
  if (entry === undefined) return failInvalidStageHead()
  const previousReceipt = receipts[index - 1]
  return Object.freeze({
    manifest: binding.manifest,
    manifestDigest: binding.manifestDigest,
    entry,
    previousStageReceiptDigest: previousReceipt === undefined
      ? null
      : createMigrationDigest(previousReceipt),
  })
}

/** Copies the sole accepted dense ordinary 36-receipt chain. */
function copyExactStageCommitChainArray(value: unknown): readonly unknown[] {
  const expectedLength =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expectedLength ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== expectedLength + 1
  ) return failInvalidStageHead()
  const receipts: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failInvalidStageHead()
    receipts.push(descriptor.value)
  }
  return Object.freeze(receipts)
}

/** Requires one bracketing root to be the exact inactive stage-36 head. */
function requireTerminalStageCommitRoot(
  root: LoadedDurableStageHead,
  terminalReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): void {
  const head = projectStageHead(root)
  if (
    terminalReceipt.stageOrdinal !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES ||
    head.completedStageOrdinal !== terminalReceipt.stageOrdinal ||
    head.headReceiptDigest !== createMigrationDigest(terminalReceipt) ||
    head.activeReservationDigest !== null ||
    head.activeStageOrdinal !== null ||
    head.activeExpiresAt !== null ||
    head.abandonmentCount !==
      terminalReceipt.stageReservationAbandonmentCount ||
    head.abandonmentRootDigest !==
      terminalReceipt.stageReservationAbandonmentRootDigest ||
    head.revision !== terminalReceipt.stageReservationCommitRevision
  ) return failInvalidStageHead()
}

/** Creates one opaque capability from a verified row and root snapshot. */
function createStageCommitDurabilityAuthorization(
  binding: PreparedStageHeadBinding,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  journal: LoadedStageCommitJournal,
  current: LoadedDurableStageHead,
): WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization {
  const currentHead = projectStageHead(current)
  if (
    currentHead.completedStageOrdinal < receipt.stageOrdinal ||
    currentHead.revision < journal.commitEvidence.commitRevision ||
    (currentHead.completedStageOrdinal === receipt.stageOrdinal &&
      !isExactCommitEvidenceSuccessor(
        currentHead,
        journal.commitEvidence,
      ))
  ) return failInvalidStageHead()
  const authorizationBinding:
    WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding =
      Object.freeze({
        commitEvidence: journal.commitEvidence,
        commitEvidenceDigest:
          createMigrationDigest(journal.commitEvidence),
        receiptDigest: createMigrationDigest(receipt),
        stageOrdinal: receipt.stageOrdinal,
        commitHead: Object.freeze({ ...journal.commitEvidence.head }),
        currentHead,
        stateTableLocationBindingDigest:
          binding.stateTableLocationBindingDigest,
        journalRecordKeyDigest: createMigrationDigest({
          kind: 'workspace-search-migration-rehearsal-stage-commit-locator',
          stateTableLocationBindingDigest:
            binding.stateTableLocationBindingDigest,
          recordKey: journal.recordKey,
        }),
        journalItemDigest: journal.journalItemDigest,
        terminalRootSnapshotDigest:
          createStageTerminalRootSnapshotDigest(current),
        provenance: 'dynamodb-consistent-read',
      })
  const authorization:
    WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization =
      Object.freeze({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_KIND,
        authorizationVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_DURABILITY_AUTHORIZATION_VERSION,
        bindingDigest: createMigrationDigest(authorizationBinding),
      })
  stageCommitDurabilityAuthorizationBindings.set(
    authorization,
    authorizationBinding,
  )
  return authorization
}

/**
 * Creates one opaque capability proving the exact abandonment-row set.
 *
 * @param binding - Authenticated manifest and physical location binding.
 * @param authenticated - Exact signed reservation/transition pairs.
 * @param journals - Strict strong-read rows in identical cumulative order.
 * @param current - Unchanged terminal root bracketing every row read.
 * @returns Genuine process-local abandonment durability capability.
 */
function createStageAbandonmentDurabilityAuthorization(
  binding: PreparedStageHeadBinding,
  authenticated:
    readonly AuthenticatedStageCommitReservationAbandonment[],
  journals: readonly LoadedStageAbandonmentJournal[],
  current: LoadedDurableStageHead,
): WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization {
  if (
    authenticated.length !== journals.length ||
    current.state.abandonmentCount !== authenticated.length
  ) return failInvalidStageHead()
  const rows:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityRowBinding[] = []
  for (let index = 0; index < authenticated.length; index += 1) {
    const pair = authenticated[index]
    const journal = journals[index]
    if (
      pair === undefined ||
      journal === undefined ||
      serializeCanonicalJson(pair.abandonment) !==
        serializeCanonicalJson(journal.abandonment) ||
      pair.abandonment.abandonmentCount !== index + 1
    ) return failInvalidStageHead()
    rows.push(Object.freeze({
      abandonment: journal.abandonment,
      reservationDigest: createMigrationDigest(pair.reservation),
      abandonmentDigest: createMigrationDigest(journal.abandonment),
      stageOrdinal: journal.abandonment.stageOrdinal,
      abandonmentCount: journal.abandonment.abandonmentCount,
      journalRecordKeyDigest: createMigrationDigest({
        kind:
          'workspace-search-migration-rehearsal-stage-abandonment-locator',
        stateTableLocationBindingDigest:
          binding.stateTableLocationBindingDigest,
        recordKey: journal.recordKey,
      }),
      journalItemDigest: journal.journalItemDigest,
    }))
  }
  const authorizationBinding:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding =
      Object.freeze({
        rows: Object.freeze(rows),
        abandonmentCount: current.state.abandonmentCount,
        abandonmentRootDigest: current.state.abandonmentRootDigest,
        stateTableLocationBindingDigest:
          binding.stateTableLocationBindingDigest,
        terminalRootSnapshotDigest:
          createStageTerminalRootSnapshotDigest(current),
        provenance: 'dynamodb-consistent-read',
      })
  const authorization:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization =
      Object.freeze({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_KIND,
        authorizationVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_DURABILITY_AUTHORIZATION_VERSION,
        bindingDigest: createMigrationDigest(authorizationBinding),
      })
  stageAbandonmentDurabilityAuthorizationBindings.set(
    authorization,
    authorizationBinding,
  )
  return authorization
}

/**
 * Derives the shared digest of one exact terminal root snapshot.
 *
 * @param current - Strictly decoded strong-read terminal root.
 * @returns Digest shared by every capability from the same bracketing read.
 */
function createStageTerminalRootSnapshotDigest(
  current: LoadedDurableStageHead,
): string {
  return createMigrationDigest({
    stateDigest: current.stateDigest,
    revision: current.revision,
    writeNonce: current.writeNonce,
  })
}

/** Strongly recovers one immutable ordinal-specific commit journal row. */
async function recoverStageCommit(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  input: RecoverWorkspaceSearchMigrationRehearsalStageCommitInput,
): Promise<WorkspaceSearchMigrationRehearsalStageCommitRecovery> {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'publicationVerificationKey',
      'receipt',
      'runtimeVerificationKey',
      'stageOrdinal',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'runtimeVerificationKey'),
    )
    publicationKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'publicationVerificationKey'),
    )
    if (
      createHash('sha256').update(runtimeKey).digest('hex') !==
        prepared.binding.manifestKeyDigest ||
      createHash('sha256').update(publicationKey).digest('hex') !==
        prepared.binding.publicationKeyDigest
    ) return failInvalidStageHead()
    const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
      stageHeadGuards.readOwn(record, 'receipt'),
      runtimeKey,
    )
    const stageOrdinal = readStageHeadPositiveInteger(
      stageHeadGuards.readOwn(record, 'stageOrdinal'),
    )
    requireReceiptMatchesPreparedStageHeadBinding(
      receipt,
      prepared.binding,
    )
    if (receipt.stageOrdinal !== stageOrdinal) {
      return failInvalidStageHead()
    }
    const journal = await loadStageCommitJournal(
      prepared,
      receipt,
      publicationKey,
    )
    const current = await loadStageHead(prepared)
    if (current === undefined) return failInvalidStageHead()
    return createStageCommitDurabilityAuthorization(
      prepared.binding,
      receipt,
      journal,
      current,
    )
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/** Requires one authenticated receipt to belong to the prepared suite. */
function requireReceiptMatchesPreparedStageHeadBinding(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  binding: PreparedStageHeadBinding,
): void {
  if (
    receipt.manifestDigest !== binding.manifestDigest ||
    receipt.permitDigest !== binding.permitDigest ||
    receipt.requestedResourcesBinding !==
      binding.requestedResourcesBinding ||
    binding.manifestEntryDigests[receipt.stageOrdinal - 1] !==
      receipt.manifestEntryDigest
  ) return failInvalidStageHead()
}

/**
 * Requires a prepared intent to bind the exact reservation and receipt.
 *
 * @param intent - Authenticated preflight intent prepared before remote I/O.
 * @param reservation - Runtime-authenticated active reservation.
 * @param receipt - Runtime-authenticated exact successor receipt.
 * @param parentAuthorization - Genuine parent authorization binding.
 */
function requireCommitIntentMatchesAuthenticatedMaterial(
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  parentAuthorization:
    WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
): void {
  const receiptDigest = createMigrationDigest(receipt)
  const recoveryAuthorization = intent.recoveryAuthorization
  const cleanupAuthorization =
    parentAuthorization.runtimeKeyCleanupAuthorization
  if (
    intent.manifestDigest !== receipt.manifestDigest ||
    intent.permitDigest !== receipt.permitDigest ||
    intent.requestedResourcesBinding !==
      receipt.requestedResourcesBinding ||
    intent.publicationKeyDigest !==
      parentAuthorization.publicationKeyDigest ||
    intent.parentAuthenticationDigest !==
      parentAuthorization.parentAuthenticationDigest ||
    intent.parentAuthorizationBindingDigest !==
      createMigrationDigest(parentAuthorization) ||
    intent.stageOrdinal !== receipt.stageOrdinal ||
    intent.stageReservationDigest !==
      createMigrationDigest(reservation) ||
    intent.stageReservationDigest !== receipt.stageReservationDigest ||
    intent.stageReservationClaimRevision !==
      receipt.stageReservationClaimRevision ||
    intent.receiptDigest !== receiptDigest ||
    intent.commitRevision !== receipt.stageReservationCommitRevision ||
    intent.expectedHead.abandonmentCount !==
      receipt.stageReservationAbandonmentCount ||
    intent.expectedHead.abandonmentRootDigest !==
      receipt.stageReservationAbandonmentRootDigest ||
    recoveryAuthorization.reservationExpiresAt !== reservation.expiresAt ||
    recoveryAuthorization.receiptCompletedAt !== receipt.completedAt ||
    recoveryAuthorization.processExitedAt !==
      receipt.processLifecycle.processExitedAt ||
    recoveryAuthorization.materialEvidenceDigest !==
      parentAuthorization.materialEvidenceDigest ||
    recoveryAuthorization.boundaryMaterialEvidenceDigest !==
      parentAuthorization.boundaryMaterialEvidenceDigest ||
    recoveryAuthorization.materialDigest !==
      parentAuthorization.materialDigest ||
    recoveryAuthorization.claimedStageHeadDigest !==
      parentAuthorization.claimedStageHeadDigest ||
    recoveryAuthorization.lifecycleEvidenceDigest !==
      parentAuthorization.lifecycleEvidenceDigest ||
    recoveryAuthorization.lifecycleDigest !==
      parentAuthorization.lifecycleDigest ||
    recoveryAuthorization.runtimeKeyCleanupAuthorizationBindingDigest !==
      cleanupAuthorization.authorizationBindingDigest ||
    recoveryAuthorization.cleanupIntentDigest !==
      cleanupAuthorization.cleanupIntentDigest ||
    recoveryAuthorization.cleanupCompletionDigest !==
      cleanupAuthorization.cleanupCompletionDigest ||
    recoveryAuthorization.cleanupPreparedAt !==
      cleanupAuthorization.preparedAt ||
    recoveryAuthorization.cleanupCompletedAt !==
      cleanupAuthorization.completedAt
  ) return failInvalidStageHead()
}

/**
 * Requires a fresh cleanup capability to match the parent-persisted binding.
 *
 * @param binding - Genuine unconsumed cleanup capability binding.
 * @param reservation - Exact reservation whose runtime key was erased.
 * @param parentAuthorization - Parent-authenticated persisted cleanup facts.
 * @param runtimeKey - Exact in-memory runtime key used for authentication.
 */
function requireRuntimeKeyCleanupMatchesCommit(
  binding:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  parentAuthorization:
    WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  runtimeKey: Uint8Array,
): void {
  const expected = parentAuthorization.runtimeKeyCleanupAuthorization
  if (
    binding.reservationDigest !== createMigrationDigest(reservation) ||
    binding.manifestDigest !== reservation.manifestDigest ||
    binding.permitDigest !== reservation.permitDigest ||
    binding.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    binding.stageOrdinal !== reservation.stageOrdinal ||
    binding.parentLivenessProtocol !== reservation.parentLivenessProtocol ||
    binding.runtimeKeyFingerprint !==
      createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
        runtimeKey,
      ) ||
    binding.reservationDigest !== expected.reservationDigest ||
    binding.manifestDigest !== expected.manifestDigest ||
    binding.permitDigest !== expected.permitDigest ||
    binding.requestedResourcesBinding !==
      expected.requestedResourcesBinding ||
    binding.stageOrdinal !== expected.stageOrdinal ||
    binding.parentLivenessProtocol !== expected.parentLivenessProtocol ||
    binding.runtimeKeyFingerprint !== expected.runtimeKeyFingerprint ||
    binding.runtimeFileIdentityDigest !==
      expected.runtimeFileIdentityDigest ||
    binding.cleanupIntentDigest !== expected.cleanupIntentDigest ||
    binding.cleanupCompletionDigest !== expected.cleanupCompletionDigest ||
    binding.preparedAt !== expected.preparedAt ||
    binding.completedAt !== expected.completedAt ||
    createMigrationDigest(binding) !== expected.authorizationBindingDigest ||
    Date.parse(binding.preparedAt) > Date.parse(binding.completedAt) ||
    Date.parse(binding.completedAt) >= Date.parse(reservation.expiresAt)
  ) return failInvalidStageHead()
}

/**
 * Authenticates the command-specific one-shot cap against the signed intent.
 *
 * @param authorization - Candidate special cap or required explicit null.
 * @param intent - Publication-authenticated durable commit intent.
 * @param selection - Independently authenticated manifest selection.
 * @param reservation - Exact active reservation bounding special evidence.
 * @param receipt - Runtime-authenticated receipt becoming durable.
 * @returns Full unconsumed gate binding retained until the CAS boundary.
 */
function requireStageCommitGateAuthorization(
  authorization: unknown,
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalStageCommitGateAuthorizationBinding {
  const rollbackPlanning =
    selection.entry.command === 'close-replan' &&
    receipt.evidence.kind === 'planning-sealed' &&
    (selection.entry.scenario === 'complete-apply-rollback' ||
      selection.entry.scenario === 'partial-apply-rollback')
  if (rollbackPlanning) {
    if (authorization === null || intent.commitGate.kind !== 'target-preimage') {
      return failInvalidStageHead()
    }
    const binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        authorization,
      )
    requireTargetPreimageCommitGateMatches(
      binding,
      intent.commitGate,
      selection,
      reservation,
      receipt,
    )
    return binding
  }
  if (receipt.evidence.kind === 'terminal') {
    if (
      authorization === null ||
      intent.commitGate.kind !== 'terminal-reconciliation'
    ) return failInvalidStageHead()
    const binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        authorization,
      )
    requireTerminalReconciliationCommitGateMatches(
      binding,
      intent.commitGate,
      reservation,
      receipt,
    )
    return binding
  }
  if (authorization !== null || intent.commitGate.kind !== 'none') {
    return failInvalidStageHead()
  }
  return null
}

/**
 * Requires a rollback-planning preimage cap to equal the compact intent gate.
 *
 * @param binding - Full genuine target-preimage capability binding.
 * @param gate - Compact target-preimage binding authenticated by the intent.
 * @param selection - Exact rollback planning manifest selection.
 * @param reservation - Active reservation bounding the observation.
 * @param receipt - Exact prospective planning receipt.
 */
function requireTargetPreimageCommitGateMatches(
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
  gate: Extract<
    WorkspaceSearchMigrationRehearsalStageCommitGate,
    { readonly kind: 'target-preimage' }
  >,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): void {
  if (receipt.evidence.kind !== 'planning-sealed') {
    return failInvalidStageHead()
  }
  const expectedPurpose = selection.entry.scenario ===
      'complete-apply-rollback'
    ? 'complete-rollback-preimage'
    : selection.entry.scenario === 'partial-apply-rollback'
    ? 'partial-rollback-preimage'
    : failInvalidStageHead()
  const context = binding.context
  const compact = createTargetPreimageCommitGate(binding)
  if (
    serializeCanonicalJson(compact) !== serializeCanonicalJson(gate) ||
    binding.purpose !== expectedPurpose ||
    binding.commit !== receipt.commit ||
    binding.configurationHash !== receipt.configurationBindingDigest ||
    binding.sourceResourceBindingDigest !==
      receipt.requestedResourcesBinding ||
    context.scenario !== receipt.scenario ||
    context.runLocatorDigest !== receipt.runLocatorDigest ||
    context.manifestDigest !== selection.manifestDigest ||
    context.permitDigest !== receipt.permitDigest ||
    context.requestedResourcesBinding !==
      receipt.requestedResourcesBinding ||
    context.configurationBindingDigest !==
      receipt.configurationBindingDigest ||
    context.planningReceiptDigest !== createMigrationDigest(receipt) ||
    context.executionBoundaryDigest !==
      receipt.evidence.executionBoundaryDigest ||
    context.sealedPlanningAuthorityDigest !==
      receipt.evidence.sealedPlanningAuthorityDigest ||
    context.planDigest !== receipt.evidence.planDigest ||
    context.writerFenceDigest !== receipt.writerFenceDigest ||
    binding.prospectivePlanningReceiptDigest !==
      createMigrationDigest(receipt) ||
    binding.expectedPlanningReceiptCompletedAt !== receipt.completedAt ||
    serializeCanonicalJson(binding.rate.predecessor) !==
      serializeCanonicalJson(receipt.rateSegment) ||
    Date.parse(binding.commitGateObservedAt) >=
      Date.parse(reservation.expiresAt) ||
    Date.parse(binding.rate.completedAt) >= Date.parse(reservation.expiresAt)
  ) return failInvalidStageHead()
}

/**
 * Requires one terminal cap to equal the receipt and compact signed gate.
 *
 * @param binding - Full genuine terminal reconciliation capability binding.
 * @param gate - Compact terminal binding authenticated by the intent.
 * @param reservation - Active reservation bounding terminal reconciliation.
 * @param receipt - Exact terminal receipt becoming durable.
 */
function requireTerminalReconciliationCommitGateMatches(
  binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
  gate: Extract<
    WorkspaceSearchMigrationRehearsalStageCommitGate,
    { readonly kind: 'terminal-reconciliation' }
  >,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): void {
  if (receipt.evidence.kind !== 'terminal') return failInvalidStageHead()
  const evidence = receipt.evidence
  const context =
    snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
      binding,
    )
  const predecessor = evidence.command === 'verify'
    ? receipt.rateSegment
    : context.targetAudits?.restored.rate.successor
  if (
    predecessor === undefined ||
    serializeCanonicalJson(createTerminalReconciliationCommitGate(binding)) !==
      serializeCanonicalJson(gate) ||
    createMigrationDigest(binding) !==
      evidence.reconciliationArtifactBindingDigest ||
    binding.contentDigest !==
      evidence.reconciliationArtifactContentDigest ||
    binding.byteLength !== evidence.reconciliationArtifactByteLength ||
    binding.auditDigest !== evidence.reconciliationArtifactAuditDigest ||
    serializeCanonicalJson(context) !==
      serializeCanonicalJson(evidence.reconciliationContext) ||
    serializeCanonicalJson(binding.rate) !==
      serializeCanonicalJson(evidence.reconciliationRate) ||
    serializeCanonicalJson(binding.rate.predecessor) !==
      serializeCanonicalJson(predecessor) ||
    binding.scenario !== receipt.scenario ||
    Date.parse(binding.rate.completedAt) >= Date.parse(reservation.expiresAt)
  ) return failInvalidStageHead()
}

/** Creates the exact compact target-preimage gate stored in intent evidence. */
function createTargetPreimageCommitGate(
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
): Extract<
  WorkspaceSearchMigrationRehearsalStageCommitGate,
  { readonly kind: 'target-preimage' }
> {
  return Object.freeze({
    kind: 'target-preimage',
    artifactBindingDigest: binding.bindingDigest,
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    purpose: binding.purpose,
    contextDigest: binding.contextDigest,
    commitGateObservedAt: binding.commitGateObservedAt,
    observationDigest: binding.observationDigest,
    aggregateDigest: binding.aggregateDigest,
    rateSuccessor: binding.rate.successor,
    rateAggregateDigest: binding.rate.aggregateDigest,
    rateCompletedAt: binding.rate.completedAt,
  })
}

/** Creates the exact compact terminal gate stored in intent evidence. */
function createTerminalReconciliationCommitGate(
  binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
): Extract<
  WorkspaceSearchMigrationRehearsalStageCommitGate,
  { readonly kind: 'terminal-reconciliation' }
> {
  const context =
    snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
      binding,
    )
  return Object.freeze({
    kind: 'terminal-reconciliation',
    artifactBindingDigest: createMigrationDigest(binding),
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    scenario: binding.scenario,
    contextDigest: createMigrationDigest(context),
    auditDigest: binding.auditDigest,
    rateSuccessor: binding.rate.successor,
    rateAggregateDigest: binding.rate.aggregateDigest,
    rateCompletedAt: binding.rate.completedAt,
  })
}

/**
 * Consumes cleanup and command-specific caps at one exact durable boundary.
 *
 * @param cleanupAuthorization - Fresh cleanup capability to consume.
 * @param cleanupBinding - Full cleanup binding authenticated at preflight.
 * @param gateAuthorization - Special capability or required explicit null.
 * @param gateBinding - Full special binding authenticated at preflight.
 */
function consumeStageCommitAuthorizations(
  cleanupAuthorization: unknown,
  cleanupBinding:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  gateAuthorization: unknown,
  gateBinding:
    WorkspaceSearchMigrationRehearsalStageCommitGateAuthorizationBinding,
): void {
  let consumedGate:
    WorkspaceSearchMigrationRehearsalStageCommitGateAuthorizationBinding = null
  if (gateBinding !== null) {
    consumedGate = Object.hasOwn(gateBinding, 'bindingDigest')
      ? consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
          gateAuthorization,
        )
      : consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
          gateAuthorization,
        )
  }
  const consumedCleanup =
    consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
      cleanupAuthorization,
    )
  if (
    serializeCanonicalJson(consumedCleanup) !==
      serializeCanonicalJson(cleanupBinding) ||
    serializeCanonicalJson(consumedGate) !== serializeCanonicalJson(gateBinding)
  ) return failInvalidStageHead()
}

/**
 * Creates committed evidence only after the exact successor is admitted.
 *
 * @param intent - Authenticated prepared intent authorizing the dispatch.
 * @param head - Exact inactive successor passed to the transaction.
 * @param commitAdmittedAt - Trusted post-preflight dispatch instant.
 * @param admissionMode - Actual reservation-time branch selected at dispatch.
 * @param publicationKey - Parent-only committed-evidence signing key.
 * @returns Frozen authenticated evidence stored atomically with the head.
 */
function createCommittedStageEvidenceFromIntent(
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  head: WorkspaceSearchMigrationRehearsalStageHead,
  commitAdmittedAt: string,
  admissionMode: WorkspaceSearchMigrationRehearsalStageCommitAdmissionMode,
  publicationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  if (!isExactCommitIntentSuccessor(head, intent)) {
    return failInvalidStageHead()
  }
  return createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
    claims: Object.freeze({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
      evidenceVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_VERSION,
      stage: 'non-production',
      manifestDigest: intent.manifestDigest,
      permitDigest: intent.permitDigest,
      requestedResourcesBinding: intent.requestedResourcesBinding,
      stateTableLocationBindingDigest:
        intent.stateTableLocationBindingDigest,
      publicationKeyDigest: intent.publicationKeyDigest,
      parentAuthenticationDigest: intent.parentAuthenticationDigest,
      parentAuthorizationBindingDigest:
        intent.parentAuthorizationBindingDigest,
      stageOrdinal: intent.stageOrdinal,
      stageReservationDigest: intent.stageReservationDigest,
      stageReservationClaimRevision:
        intent.stageReservationClaimRevision,
      receiptDigest: intent.receiptDigest,
      commitRevision: intent.commitRevision,
      head: Object.freeze({ ...intent.expectedHead }),
      commitGate: intent.commitGate,
      recoveryAuthorization: Object.freeze({
        ...intent.recoveryAuthorization,
      }),
      admissionMode,
      commitAdmittedAt,
      durableStatus: 'committed',
    }),
    signingKey: publicationKey,
  })
}

/**
 * Requires recovered committed bytes to derive from the prepared intent.
 *
 * @param evidence - Publication-authenticated immutable journal evidence.
 * @param intent - Exact local prepared intent for this invocation.
 */
function requireCommitEvidenceMatchesIntent(
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
): void {
  const commitAdmittedMilliseconds = Date.parse(evidence.commitAdmittedAt)
  const reservationExpiresMilliseconds = Date.parse(
    intent.recoveryAuthorization.reservationExpiresAt,
  )
  const timingMatches = evidence.admissionMode === 'ordinary'
    ? commitAdmittedMilliseconds < reservationExpiresMilliseconds
    : evidence.admissionMode === 'bounded-recovery' &&
      commitAdmittedMilliseconds >= reservationExpiresMilliseconds &&
      commitAdmittedMilliseconds <=
        Date.parse(intent.recoveryAuthorization.recoveryDeadlineAt)
  if (
    evidence.manifestDigest !== intent.manifestDigest ||
    evidence.permitDigest !== intent.permitDigest ||
    evidence.requestedResourcesBinding !==
      intent.requestedResourcesBinding ||
    evidence.stateTableLocationBindingDigest !==
      intent.stateTableLocationBindingDigest ||
    evidence.publicationKeyDigest !== intent.publicationKeyDigest ||
    evidence.parentAuthenticationDigest !==
      intent.parentAuthenticationDigest ||
    evidence.parentAuthorizationBindingDigest !==
      intent.parentAuthorizationBindingDigest ||
    evidence.stageOrdinal !== intent.stageOrdinal ||
    evidence.stageReservationDigest !== intent.stageReservationDigest ||
    evidence.stageReservationClaimRevision !==
      intent.stageReservationClaimRevision ||
    evidence.receiptDigest !== intent.receiptDigest ||
    evidence.commitRevision !== intent.commitRevision ||
    serializeCanonicalJson(evidence.commitGate) !==
      serializeCanonicalJson(intent.commitGate) ||
    (intent.commitGate.kind !== 'none' &&
      evidence.admissionMode !== 'ordinary') ||
    serializeCanonicalJson(evidence.recoveryAuthorization) !==
      serializeCanonicalJson(intent.recoveryAuthorization) ||
    Date.parse(evidence.commitAdmittedAt) <= Date.parse(intent.preparedAt) ||
    !timingMatches ||
    serializeCanonicalJson(evidence.head) !==
      serializeCanonicalJson(intent.expectedHead)
  ) return failInvalidStageHead()
}

/**
 * Selects the only timing branch admitted for this actual dispatch.
 *
 * @param intent - Authenticated prepared intent carrying both time ceilings.
 * @param commitDispatchAt - Trusted post-preflight dispatch timestamp.
 * @returns Ordinary or bounded-recovery admission mode.
 */
function readStageCommitAdmissionMode(
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  commitDispatchAt: string,
): WorkspaceSearchMigrationRehearsalStageCommitAdmissionMode {
  const dispatchMilliseconds = Date.parse(commitDispatchAt)
  if (
    dispatchMilliseconds <= Date.parse(intent.preparedAt) ||
    dispatchMilliseconds >
      Date.parse(intent.recoveryAuthorization.recoveryDeadlineAt)
  ) return failStageHeadConflict()
  return dispatchMilliseconds <
      Date.parse(intent.recoveryAuthorization.reservationExpiresAt)
    ? 'ordinary'
    : 'bounded-recovery'
}

/**
 * Checks a current head against every prepared expected-successor field.
 *
 * @param head - Strictly decoded current durable head.
 * @param intent - Authenticated local prepared intent.
 * @returns Whether the head is the intent's exact inactive successor.
 */
function isExactCommitIntentSuccessor(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
): boolean {
  return head.manifestDigest === intent.expectedHead.manifestDigest &&
    head.completedStageOrdinal === intent.expectedHead.completedStageOrdinal &&
    head.headReceiptDigest === intent.expectedHead.headReceiptDigest &&
    head.activeReservationDigest ===
      intent.expectedHead.activeReservationDigest &&
    head.activeStageOrdinal === intent.expectedHead.activeStageOrdinal &&
    head.activeExpiresAt === intent.expectedHead.activeExpiresAt &&
    head.abandonmentCount === intent.expectedHead.abandonmentCount &&
    head.abandonmentRootDigest ===
      intent.expectedHead.abandonmentRootDigest &&
    head.revision === intent.expectedHead.revision
}

/** Checks one current head against every authenticated evidence successor. */
function isExactCommitEvidenceSuccessor(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
): boolean {
  return head.manifestDigest === evidence.head.manifestDigest &&
    head.completedStageOrdinal === evidence.head.completedStageOrdinal &&
    head.headReceiptDigest === evidence.head.headReceiptDigest &&
    head.activeReservationDigest === evidence.head.activeReservationDigest &&
    head.activeStageOrdinal === evidence.head.activeStageOrdinal &&
    head.activeExpiresAt === evidence.head.activeExpiresAt &&
    head.abandonmentCount === evidence.head.abandonmentCount &&
    head.abandonmentRootDigest === evidence.head.abandonmentRootDigest &&
    head.revision === evidence.head.revision
}

/** Applies one parent-authenticated explicit abandonment plus immutable row. */
async function abandonStageReservation(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  input: AbandonWorkspaceSearchMigrationRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = stageHeadGuards.requireRecord(input)
    stageHeadGuards.requireExactKeys(record, [
      'abandonment',
      'observedAt',
      'publicationVerificationKey',
      'reservation',
      'runtimeKeyCleanupAuthorization',
      'runtimeVerificationKey',
      'selection',
    ])
    runtimeKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'runtimeVerificationKey'),
    )
    publicationKey = copyStageHeadKey(
      stageHeadGuards.readOwn(record, 'publicationVerificationKey'),
    )
    const selection = requireSelectedStage(
      stageHeadGuards.readOwn(record, 'selection'),
      runtimeKey,
    )
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: stageHeadGuards.readOwn(record, 'reservation'),
        selection,
        verificationKey: runtimeKey,
      })
    requireReservationMatchesStore(prepared.binding, reservation)
    const abandonment =
      verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        abandonment: stageHeadGuards.readOwn(record, 'abandonment'),
        reservation,
        selection,
        runtimeVerificationKey: runtimeKey,
        publicationVerificationKey: publicationKey,
      })
    const observedAt = readStageHeadTimestamp(
      stageHeadGuards.readOwn(record, 'observedAt'),
    )
    const recoveryDeadlineMilliseconds =
      Date.parse(reservation.expiresAt) +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
    if (
      Date.parse(abandonment.abandonedAt) < recoveryDeadlineMilliseconds ||
      Date.parse(observedAt) < recoveryDeadlineMilliseconds
    ) return failStageReservationRecoveryRequired()
    if (Date.parse(observedAt) < Date.parse(abandonment.abandonedAt)) {
      return failInvalidStageHead()
    }
    const cleanupAuthorization =
      consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
        stageHeadGuards.readOwn(
          record,
          'runtimeKeyCleanupAuthorization',
        ),
      )
    requireRuntimeKeyCleanupMatchesAbandonment(
      cleanupAuthorization,
      reservation,
      abandonment,
      runtimeKey,
    )
    const predecessor = await loadStageHead(prepared)
    if (predecessor === undefined) return failStageHeadConflict()
    const reservationDigest = createMigrationDigest(reservation)
    requireReservationMayCommit(
      predecessor.state,
      reservation,
      reservationDigest,
    )
    if (
      predecessor.revision !== abandonment.reservationClaimRevision ||
      predecessor.state.abandonmentCount !==
        abandonment.previousAbandonmentCount ||
      predecessor.state.abandonmentRootDigest !==
        abandonment.previousAbandonmentRootDigest ||
      abandonment.abandonmentRevision !== predecessor.revision + 1
    ) return failStageHeadConflict()
    const successorState: DurableStageHeadState = Object.freeze({
      ...predecessor.state,
      activeReservation: null,
      abandonmentCount: abandonment.abandonmentCount,
      abandonmentRootDigest: abandonment.abandonmentRootDigest,
      lastAbandonedAt: abandonment.abandonedAt,
    })
    const abandonmentDigest = createMigrationDigest(abandonment)
    const successor = prepareLoadedStageHead(
      prepared.binding,
      successorState,
      abandonment.abandonmentRevision,
      abandonmentDigest,
    )
    try {
      await writeStageHead(
        prepared,
        predecessor,
        successor,
        abandonment,
      )
    } catch (error: unknown) {
      if (
        !(error instanceof
          WorkspaceSearchMigrationRehearsalStageReservationAwsError) ||
        error.code !== 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN'
      ) throw error
      let reconciled: LoadedDurableStageHead | undefined
      try {
        reconciled = await loadStageHead(prepared)
      } catch {
        throw error
      }
      if (
        reconciled === undefined ||
        !isExactLoadedStageHeadSuccessor(reconciled, successor)
      ) throw error
    }
    return projectStageHead(successor)
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    return failInvalidStageHead()
  } finally {
    zeroizeStageHeadKey(runtimeKey)
    zeroizeStageHeadKey(publicationKey)
  }
}

/** Requires one consumed cleanup proof to authorize this exact abandonment. */
function requireRuntimeKeyCleanupMatchesAbandonment(
  cleanup:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  abandonment: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  runtimeKey: Uint8Array,
): void {
  if (
    cleanup.reservationDigest !== createMigrationDigest(reservation) ||
    cleanup.manifestDigest !== reservation.manifestDigest ||
    cleanup.permitDigest !== reservation.permitDigest ||
    cleanup.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    cleanup.stageOrdinal !== reservation.stageOrdinal ||
    cleanup.parentLivenessProtocol !==
      reservation.parentLivenessProtocol ||
    cleanup.parentLivenessProtocol !==
      abandonment.parentLivenessProtocol ||
    cleanup.runtimeKeyFingerprint !==
      createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
        runtimeKey,
      ) ||
    cleanup.runtimeKeyFingerprint !== abandonment.runtimeKeyFingerprint ||
    cleanup.cleanupCompletionDigest !==
      abandonment.runtimeKeyCleanupCompletionDigest ||
    Date.parse(cleanup.completedAt) > Date.parse(abandonment.abandonedAt)
  ) return failInvalidStageHead()
}

/** Strongly reads one current durable head or the canonical absent root. */
async function readStageHead(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  const loaded = await loadStageHead(prepared)
  if (loaded !== undefined) return projectStageHead(loaded)
  return Object.freeze({
    manifestDigest: prepared.binding.manifestDigest,
    completedStageOrdinal: 0,
    headReceiptDigest: null,
    activeReservationDigest: null,
    activeStageOrdinal: null,
    activeExpiresAt: null,
    abandonmentCount: 0,
    abandonmentRootDigest:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    revision: 0,
  })
}

/** Strongly loads and strictly validates the adapter-owned row. */
async function loadStageHead(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
): Promise<LoadedDurableStageHead | undefined> {
  let output: GetItemCommandOutput
  try {
    output = await prepared.transport.get(
      new GetItemCommand({
        TableName: prepared.binding.stateTableName,
        Key: createStageHeadPrimaryKey(prepared.binding.recordKey),
        ConsistentRead: true,
      }),
    )
  } catch {
    return failStageHeadTransportUncertain()
  }
  const item = readOptionalStageHeadItem(output)
  if (item === undefined) return undefined
  return parseStageHeadItem(item, prepared.binding)
}

/** Strongly loads and reauthenticates one immutable commit journal row. */
async function loadStageCommitJournal(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  verificationKey: Uint8Array,
): Promise<LoadedStageCommitJournal> {
  const recordKey = createStageCommitJournalRecordKey(
    prepared.binding,
    receipt.stageOrdinal,
  )
  let output: GetItemCommandOutput
  try {
    output = await prepared.transport.get(
      new GetItemCommand({
        TableName: prepared.binding.stateTableName,
        Key: createStageHeadPrimaryKey(recordKey),
        ConsistentRead: true,
      }),
    )
  } catch {
    return failStageHeadTransportUncertain()
  }
  const item = readOptionalStageHeadItem(output)
  if (item === undefined) return failInvalidStageHead()
  const commitEvidence = parseStageCommitJournalItem(
    item,
    prepared.binding,
    receipt,
    recordKey,
    verificationKey,
  )
  return Object.freeze({
    commitEvidence,
    journalItemDigest: createMigrationDigest(encodeUnknownAttributeMap(item)),
    recordKey,
  })
}

/**
 * Strongly loads and reauthenticates one immutable abandonment journal row.
 *
 * @param prepared - Authenticated store and captured narrow transport.
 * @param authenticated - Exact signed reservation/abandonment pair.
 * @param receipts - Authenticated full-suite receipt chain.
 * @param runtimeKey - Runtime reservation verification key.
 * @param publicationKey - Parent abandonment verification key.
 * @returns Strict immutable row with its locator and item digests.
 */
async function loadStageAbandonmentJournal(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  authenticated: AuthenticatedStageCommitReservationAbandonment,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): Promise<LoadedStageAbandonmentJournal> {
  const recordKey = createAbandonmentJournalRecordKey(
    prepared.binding,
    authenticated.abandonment,
  )
  let output: GetItemCommandOutput
  try {
    output = await prepared.transport.get(
      new GetItemCommand({
        TableName: prepared.binding.stateTableName,
        Key: createStageHeadPrimaryKey(recordKey),
        ConsistentRead: true,
      }),
    )
  } catch {
    return failStageHeadTransportUncertain()
  }
  const item = readOptionalStageHeadItem(output)
  if (item === undefined) return failInvalidStageHead()
  const selection = createStageCommitRecoverySelection(
    prepared.binding,
    receipts,
    authenticated.abandonment.stageOrdinal - 1,
  )
  const abandonment = parseStageAbandonmentJournalItem(
    item,
    prepared.binding,
    authenticated,
    selection,
    recordKey,
    runtimeKey,
    publicationKey,
  )
  return Object.freeze({
    abandonment,
    journalItemDigest: createMigrationDigest(encodeUnknownAttributeMap(item)),
    recordKey,
  })
}

/**
 * Strictly parses one immutable abandonment row and every duplicate binding.
 *
 * @param item - Strongly read low-level DynamoDB item.
 * @param binding - Authenticated store location and manifest binding.
 * @param authenticated - Expected signed reservation/transition pair.
 * @param selection - Exact manifest selection for this stage.
 * @param recordKey - Deterministic row key used by the strong read.
 * @param runtimeKey - Runtime reservation verification key.
 * @param publicationKey - Parent transition verification key.
 * @returns Detached authenticated transition exactly matching the local pair.
 */
function parseStageAbandonmentJournalItem(
  item: Readonly<Record<string, AttributeValue>>,
  binding: PreparedStageHeadBinding,
  authenticated: AuthenticatedStageCommitReservationAbandonment,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  recordKey: string,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReservationAbandonment {
  requireExactStageAbandonmentJournalAttributeKeys(item)
  const transitionJson = readStageHeadStringAttribute(
    item,
    'transitionJson',
  )
  let candidate: unknown
  try {
    candidate = JSON.parse(transitionJson)
  } catch {
    return failInvalidStageHead()
  }
  const abandonment =
    verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
      abandonment: candidate,
      reservation: authenticated.reservation,
      selection,
      runtimeVerificationKey: runtimeKey,
      publicationVerificationKey: publicationKey,
    })
  if (
    serializeCanonicalJson(abandonment) !== transitionJson ||
    serializeCanonicalJson(abandonment) !==
      serializeCanonicalJson(authenticated.abandonment) ||
    readStageHeadStringAttribute(item, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND ||
    readStageHeadStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStageHeadStringAttribute(item, 'recordKey') !== recordKey ||
    readStageHeadNumberAttribute(item, 'recordVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION ||
    readStageHeadDigestAttribute(item, 'manifestDigest') !==
      binding.manifestDigest ||
    readStageHeadDigestAttribute(item, 'permitDigest') !==
      binding.permitDigest ||
    readStageHeadDigestAttribute(item, 'requestedResourcesBinding') !==
      binding.requestedResourcesBinding ||
    readStageHeadDigestAttribute(
      item,
      'stateTableLocationBindingDigest',
    ) !== binding.stateTableLocationBindingDigest ||
    readStageHeadNumberAttribute(item, 'stageOrdinal') !==
      abandonment.stageOrdinal ||
    readStageHeadDigestAttribute(item, 'transitionDigest') !==
      createMigrationDigest(abandonment)
  ) return failInvalidStageHead()
  return abandonment
}

/** Strictly parses one immutable row and rederives every duplicated binding. */
function parseStageCommitJournalItem(
  item: Readonly<Record<string, AttributeValue>>,
  binding: PreparedStageHeadBinding,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  recordKey: string,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  requireExactStageCommitJournalAttributeKeys(item)
  const commitEvidenceJson = readStageHeadStringAttribute(
    item,
    'commitEvidenceJson',
  )
  let candidate: unknown
  try {
    candidate = JSON.parse(commitEvidenceJson)
  } catch {
    return failInvalidStageHead()
  }
  const commitEvidence =
    verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
      candidate,
      verificationKey,
    )
  if (
    serializeCanonicalJson(commitEvidence) !== commitEvidenceJson ||
    readStageHeadStringAttribute(item, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND ||
    readStageHeadStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStageHeadStringAttribute(item, 'recordKey') !== recordKey ||
    readStageHeadNumberAttribute(item, 'recordVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION ||
    readStageHeadDigestAttribute(item, 'manifestDigest') !==
      binding.manifestDigest ||
    readStageHeadDigestAttribute(item, 'permitDigest') !==
      binding.permitDigest ||
    readStageHeadDigestAttribute(item, 'publicationKeyDigest') !==
      binding.publicationKeyDigest ||
    readStageHeadDigestAttribute(item, 'publicationKeyDigest') !==
      commitEvidence.publicationKeyDigest ||
    readStageHeadDigestAttribute(item, 'parentAuthenticationDigest') !==
      commitEvidence.parentAuthenticationDigest ||
    readStageHeadDigestAttribute(
      item,
      'parentAuthorizationBindingDigest',
    ) !== commitEvidence.parentAuthorizationBindingDigest ||
    readStageHeadDigestAttribute(item, 'requestedResourcesBinding') !==
      binding.requestedResourcesBinding ||
    readStageHeadDigestAttribute(
      item,
      'stateTableLocationBindingDigest',
    ) !== binding.stateTableLocationBindingDigest ||
    readStageHeadNumberAttribute(item, 'stageOrdinal') !==
      receipt.stageOrdinal ||
    readStageHeadDigestAttribute(item, 'receiptDigest') !==
      createMigrationDigest(receipt) ||
    readStageHeadDigestAttribute(item, 'stageReservationDigest') !==
      receipt.stageReservationDigest ||
    readStageHeadNumberAttribute(item, 'stageReservationClaimRevision') !==
      receipt.stageReservationClaimRevision ||
    readStageHeadNumberAttribute(item, 'commitRevision') !==
      receipt.stageReservationCommitRevision ||
    readStageHeadNumberAttribute(item, 'abandonmentCount') !==
      receipt.stageReservationAbandonmentCount ||
    readStageHeadDigestAttribute(item, 'abandonmentRootDigest') !==
      receipt.stageReservationAbandonmentRootDigest ||
    readStageHeadStringAttribute(item, 'commitAdmittedAt') !==
      commitEvidence.commitAdmittedAt ||
    readStageHeadDigestAttribute(item, 'commitEvidenceDigest') !==
      createMigrationDigest(commitEvidence) ||
    commitEvidence.manifestDigest !== binding.manifestDigest ||
    commitEvidence.permitDigest !== binding.permitDigest ||
    commitEvidence.requestedResourcesBinding !==
      binding.requestedResourcesBinding ||
    commitEvidence.stateTableLocationBindingDigest !==
      binding.stateTableLocationBindingDigest ||
    commitEvidence.stageOrdinal !== receipt.stageOrdinal ||
    commitEvidence.stageReservationDigest !==
      receipt.stageReservationDigest ||
    commitEvidence.stageReservationClaimRevision !==
      receipt.stageReservationClaimRevision ||
    commitEvidence.receiptDigest !== createMigrationDigest(receipt) ||
    commitEvidence.commitRevision !==
      receipt.stageReservationCommitRevision
  ) return failInvalidStageHead()
  return commitEvidence
}

/** Requires the exact controlled immutable commit-journal attribute set. */
function requireExactStageCommitJournalAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  const actual = Object.keys(item).sort()
  const expected = [...stageCommitJournalAttributeNames].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) return failInvalidStageHead()
}

/**
 * Requires the exact controlled immutable abandonment-journal attributes.
 *
 * @param item - Strongly read low-level item to validate.
 */
function requireExactStageAbandonmentJournalAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  const actual = Object.keys(item).sort()
  const expected = [...stageAbandonmentJournalAttributeNames].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) return failInvalidStageHead()
}

/** Writes one successor with an absent or exact-predecessor condition. */
async function writeStageHead(
  prepared: {
    /** Authenticated store binding. */
    readonly binding: PreparedStageHeadBinding
    /** Captured transport. */
    readonly transport: PreparedStageHeadTransport
  },
  predecessor: LoadedDurableStageHead | undefined,
  successor: LoadedDurableStageHead,
  abandonment?: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  commitJournal?: PreparedStageCommitJournal,
): Promise<void> {
  try {
    await prepared.transport.transactWrite(
      createStageHeadWriteCommand(
        prepared.binding,
        predecessor,
        successor,
        abandonment,
        commitJournal,
      ),
    )
  } catch (error: unknown) {
    if (isStageHeadConditionalFailure(error)) {
      return failStageHeadConflict()
    }
    return failStageHeadTransportUncertain()
  }
}

/** Creates the canonical empty head before stage one is claimed. */
function createInitialStageHeadState(
  binding: PreparedStageHeadBinding,
): DurableStageHeadState {
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
    stateVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
    manifestDigest: binding.manifestDigest,
    permitDigest: binding.permitDigest,
    requestedResourcesBinding: binding.requestedResourcesBinding,
    completedStageOrdinal: 0,
    headReceiptDigest: null,
    activeReservation: null,
    abandonmentCount: 0,
    abandonmentRootDigest:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    lastAbandonedAt: null,
  })
}

/** Requires one reservation to target the store's exact manifest and entry. */
function requireReservationMatchesStore(
  binding: PreparedStageHeadBinding,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): void {
  if (
    reservation.manifestDigest !== binding.manifestDigest ||
    reservation.permitDigest !== binding.permitDigest ||
    reservation.requestedResourcesBinding !==
      binding.requestedResourcesBinding ||
    reservation.publicationKeyDigest !== binding.publicationKeyDigest ||
    binding.manifestEntryDigests[reservation.stageOrdinal - 1] !==
      reservation.manifestEntryDigest
  ) return failInvalidStageHead()
}

/** Requires a reservation creation and expiry interval to contain one time. */
function requireReservationActiveAt(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  observedAt: string,
): void {
  if (
    Date.parse(observedAt) < Date.parse(reservation.reservedAt) ||
    Date.parse(observedAt) >= Date.parse(reservation.expiresAt)
  ) return failStageHeadConflict()
}

/** Enforces next-head order without implicit expiry-based replacement. */
function requireReservationMayClaim(
  state: DurableStageHeadState,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): void {
  if (
    reservation.stageOrdinal !== state.completedStageOrdinal + 1 ||
    reservation.previousStageReceiptDigest !== state.headReceiptDigest ||
    state.activeReservation !== null ||
    (state.lastAbandonedAt !== null &&
      Date.parse(reservation.reservedAt) <
        Date.parse(state.lastAbandonedAt))
  ) return failStageHeadConflict()
}

/** Checks whether the exact reservation already owns the active slot. */
function isExactActiveReservation(
  state: DurableStageHeadState,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  reservationDigest: string,
): boolean {
  const active = state.activeReservation
  return active !== null &&
    active.reservationDigest === reservationDigest &&
    active.nonceDigest === reservation.nonceDigest &&
    active.stageOrdinal === reservation.stageOrdinal &&
    active.manifestEntryDigest === reservation.manifestEntryDigest &&
    active.previousStageReceiptDigest ===
      reservation.previousStageReceiptDigest &&
    serializeCanonicalJson(active.expectedPreviousRateSegment) ===
      serializeCanonicalJson(reservation.expectedPreviousRateSegment) &&
    active.expectedCurrentRateSegmentOrdinal ===
      reservation.expectedCurrentRateSegmentOrdinal &&
    active.expectedTargetPreimageArtifactContentDigest ===
      reservation.expectedTargetPreimageArtifactContentDigest &&
    active.reservedAt === reservation.reservedAt &&
    active.expiresAt === reservation.expiresAt &&
    state.completedStageOrdinal + 1 === reservation.stageOrdinal &&
    state.headReceiptDigest === reservation.previousStageReceiptDigest
}

/** Requires the exact token to still own the active durable slot. */
function requireReservationMayCommit(
  state: DurableStageHeadState,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  reservationDigest: string,
): void {
  const active = state.activeReservation
  if (active === null || !isExactActiveReservation(
    state,
    reservation,
    reservationDigest,
  )) return failStageHeadConflict()
}

/** Requires every receipt selection binding to equal its reservation claims. */
function requireReceiptMatchesReservation(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): void {
  if (
    receipt.stage !== 'non-production' ||
    receipt.manifestDigest !== reservation.manifestDigest ||
    receipt.manifestEntryDigest !== reservation.manifestEntryDigest ||
    receipt.previousStageReceiptDigest !==
      reservation.previousStageReceiptDigest ||
    receipt.stageOrdinal !== reservation.stageOrdinal ||
    receipt.scenario !== reservation.scenario ||
    receipt.scenarioStageOrdinal !== reservation.scenarioStageOrdinal ||
    receipt.command !== reservation.command ||
    receipt.attemptOrdinal !== reservation.attemptOrdinal ||
    receipt.outcome !== reservation.expectedOutcome ||
    receipt.controlArgumentsDigest !== reservation.controlArgumentsDigest ||
    receipt.permitDigest !== reservation.permitDigest ||
    receipt.commit !== reservation.commit ||
    receipt.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    receipt.configurationBindingDigest !==
      reservation.configurationBindingDigest ||
    receipt.policyVersion !== reservation.policyVersion ||
    receipt.stageReservationDigest !==
      createMigrationDigest(reservation)
  ) return failInvalidStageHead()
}

/** Prepares one canonical successor row representation. */
function prepareLoadedStageHead(
  binding: PreparedStageHeadBinding,
  state: DurableStageHeadState,
  revision: number,
  writeNonce: string,
): LoadedDurableStageHead {
  requireStageHeadStateInvariants(state, binding)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    return failInvalidStageHead()
  }
  const stateJson = serializeCanonicalJson(state)
  if (
    new TextEncoder().encode(stateJson).byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_MAX_BYTES ||
    !isHexDigest(writeNonce)
  ) return failInvalidStageHead()
  return Object.freeze({
    state,
    stateJson,
    stateDigest: createStageHeadStateDigest(binding, state),
    revision,
    writeNonce,
  })
}

/** Parses one exact low-level row and rederives every duplicated binding. */
function parseStageHeadItem(
  item: Readonly<Record<string, AttributeValue>>,
  binding: PreparedStageHeadBinding,
): LoadedDurableStageHead {
  requireExactStageHeadAttributeKeys(item)
  if (
    readStageHeadStringAttribute(item, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND ||
    readStageHeadStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStageHeadStringAttribute(item, 'recordKey') !== binding.recordKey ||
    readStageHeadNumberAttribute(item, 'recordVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION ||
    readStageHeadDigestAttribute(item, 'permitDigest') !==
      binding.permitDigest ||
    readStageHeadDigestAttribute(item, 'requestedResourcesBinding') !==
      binding.requestedResourcesBinding ||
    readStageHeadDigestAttribute(
      item,
      'stateTableLocationBindingDigest',
    ) !== binding.stateTableLocationBindingDigest
  ) return failInvalidStageHead()
  if (
    readStageHeadDigestAttribute(item, 'manifestDigest') !==
      binding.manifestDigest
  ) return failStageHeadConflict()
  const stateJson = readStageHeadStringAttribute(item, 'stateJson')
  if (
    new TextEncoder().encode(stateJson).byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_MAX_BYTES
  ) return failInvalidStageHead()
  let candidate: unknown
  try {
    candidate = JSON.parse(stateJson)
  } catch {
    return failInvalidStageHead()
  }
  const state = parseStageHeadState(candidate, binding)
  const revision = readStageHeadNumberAttribute(item, 'stateRevision')
  const writeNonce = readStageHeadDigestAttribute(item, 'stateWriteNonce')
  const prepared = prepareLoadedStageHead(
    binding,
    state,
    revision,
    writeNonce,
  )
  if (
    readStageHeadStringAttribute(item, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND ||
    readStageHeadStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStageHeadStringAttribute(item, 'recordKey') !== binding.recordKey ||
    readStageHeadNumberAttribute(item, 'recordVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION ||
    readStageHeadDigestAttribute(item, 'manifestDigest') !==
      binding.manifestDigest ||
    readStageHeadDigestAttribute(item, 'permitDigest') !==
      binding.permitDigest ||
    readStageHeadDigestAttribute(item, 'requestedResourcesBinding') !==
      binding.requestedResourcesBinding ||
    readStageHeadDigestAttribute(
      item,
      'stateTableLocationBindingDigest',
    ) !== binding.stateTableLocationBindingDigest ||
    readStageHeadDigestAttribute(item, 'stateDigest') !==
      prepared.stateDigest ||
    stateJson !== prepared.stateJson
  ) return failInvalidStageHead()
  return prepared
}

/** Strictly parses the canonical nested head state. */
function parseStageHeadState(
  value: unknown,
  binding: PreparedStageHeadBinding,
): DurableStageHeadState {
  const record = stageHeadGuards.requireRecord(value)
  stageHeadGuards.requireExactKeys(record, stageHeadStateKeys)
  const kind = stageHeadGuards.readOwn(record, 'kind')
  const stateVersion = stageHeadGuards.readOwn(record, 'stateVersion')
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND ||
    stateVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION
  ) return failInvalidStageHead()
  const activeValue = stageHeadGuards.readOwn(record, 'activeReservation')
  const state: DurableStageHeadState = Object.freeze({
    kind,
    stateVersion,
    manifestDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'manifestDigest'),
    ),
    permitDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    completedStageOrdinal: readStageHeadNonNegativeInteger(
      stageHeadGuards.readOwn(record, 'completedStageOrdinal'),
    ),
    headReceiptDigest: readStageHeadNullableDigest(
      stageHeadGuards.readOwn(record, 'headReceiptDigest'),
    ),
    activeReservation: activeValue === null
      ? null
      : parseActiveReservation(activeValue),
    abandonmentCount: readStageHeadNonNegativeInteger(
      stageHeadGuards.readOwn(record, 'abandonmentCount'),
    ),
    abandonmentRootDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'abandonmentRootDigest'),
    ),
    lastAbandonedAt: readStageHeadNullableTimestamp(
      stageHeadGuards.readOwn(record, 'lastAbandonedAt'),
    ),
  })
  requireStageHeadStateInvariants(state, binding)
  return state
}

/** Strictly parses one nested active-reservation projection. */
function parseActiveReservation(value: unknown): DurableActiveReservation {
  const record = stageHeadGuards.requireRecord(value)
  stageHeadGuards.requireExactKeys(record, activeReservationKeys)
  const reservedAt = readStageHeadTimestamp(
    stageHeadGuards.readOwn(record, 'reservedAt'),
  )
  const expiresAt = readStageHeadTimestamp(
    stageHeadGuards.readOwn(record, 'expiresAt'),
  )
  if (Date.parse(expiresAt) <= Date.parse(reservedAt)) {
    return failInvalidStageHead()
  }
  return Object.freeze({
    reservationDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'reservationDigest'),
    ),
    manifestEntryDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'manifestEntryDigest'),
    ),
    previousStageReceiptDigest: readStageHeadNullableDigest(
      stageHeadGuards.readOwn(record, 'previousStageReceiptDigest'),
    ),
    expectedPreviousRateSegment:
      stageHeadGuards.readOwn(record, 'expectedPreviousRateSegment') === null
        ? null
        : parseActiveReservationRateSegment(
            stageHeadGuards.readOwn(
              record,
              'expectedPreviousRateSegment',
            ),
          ),
    expectedCurrentRateSegmentOrdinal: readStageHeadNonNegativeInteger(
      stageHeadGuards.readOwn(
        record,
        'expectedCurrentRateSegmentOrdinal',
      ),
    ),
    expectedTargetPreimageArtifactContentDigest: readStageHeadNullableDigest(
      stageHeadGuards.readOwn(
        record,
        'expectedTargetPreimageArtifactContentDigest',
      ),
    ),
    stageOrdinal: readStageHeadPositiveInteger(
      stageHeadGuards.readOwn(record, 'stageOrdinal'),
    ),
    nonceDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'nonceDigest'),
    ),
    reservedAt,
    expiresAt,
  })
}

/** Strictly reconstructs one durable authenticated rate summary. */
function parseActiveReservationRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = stageHeadGuards.requireRecord(value)
  stageHeadGuards.requireExactKeys(record, activeReservationRateSegmentKeys)
  const eventCount = readStageHeadNonNegativeInteger(
    stageHeadGuards.readOwn(record, 'eventCount'),
  )
  const firstCommittedEventSequence =
    readStageHeadNullablePositiveInteger(
      stageHeadGuards.readOwn(record, 'firstCommittedEventSequence'),
    )
  const lastCommittedEventSequence =
    readStageHeadNullablePositiveInteger(
      stageHeadGuards.readOwn(record, 'lastCommittedEventSequence'),
    )
  const firstEventSequence = readStageHeadPositiveInteger(
    stageHeadGuards.readOwn(record, 'firstEventSequence'),
  )
  if (
    (eventCount === 0 &&
      (firstCommittedEventSequence !== null ||
        lastCommittedEventSequence !== null)) ||
    (eventCount > 0 &&
      (firstCommittedEventSequence === null ||
        lastCommittedEventSequence === null ||
        firstCommittedEventSequence !== firstEventSequence ||
        lastCommittedEventSequence < firstCommittedEventSequence ||
        lastCommittedEventSequence - firstCommittedEventSequence + 1 !==
          eventCount))
  ) return failInvalidStageHead()
  return Object.freeze({
    authenticationKeyFingerprint: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readStageHeadNonNegativeInteger(
      stageHeadGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Enforces root, head, active-slot, and manifest-entry invariants. */
function requireStageHeadStateInvariants(
  state: DurableStageHeadState,
  binding: PreparedStageHeadBinding,
): void {
  if (
    state.manifestDigest !== binding.manifestDigest ||
    state.permitDigest !== binding.permitDigest ||
    state.requestedResourcesBinding !==
      binding.requestedResourcesBinding ||
    state.completedStageOrdinal > binding.manifestEntryDigests.length ||
    (state.completedStageOrdinal === 0) !==
      (state.headReceiptDigest === null) ||
    (state.abandonmentCount === 0) !==
      (state.lastAbandonedAt === null) ||
    (state.abandonmentCount === 0 &&
      state.abandonmentRootDigest !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST)
  ) return failInvalidStageHead()
  const active = state.activeReservation
  if (active === null) return
  const activeEntry = binding.manifest.entries[active.stageOrdinal - 1]
  if (activeEntry === undefined) return failInvalidStageHead()
  const requiresTargetPreimage = activeEntry.command === 'apply' &&
    (activeEntry.scenario === 'complete-apply-rollback' ||
      activeEntry.scenario === 'partial-apply-rollback')
  if (
    active.stageOrdinal !== state.completedStageOrdinal + 1 ||
    active.stageOrdinal > binding.manifestEntryDigests.length ||
    active.previousStageReceiptDigest !== state.headReceiptDigest ||
    binding.manifestEntryDigests[active.stageOrdinal - 1] !==
      active.manifestEntryDigest ||
    (active.expectedTargetPreimageArtifactContentDigest !== null) !==
      requiresTargetPreimage ||
    (active.stageOrdinal === 1 &&
      (active.expectedPreviousRateSegment !== null ||
        active.expectedCurrentRateSegmentOrdinal !== 0)) ||
    (active.stageOrdinal > 1 &&
      (active.expectedPreviousRateSegment === null ||
        active.expectedCurrentRateSegmentOrdinal !==
          active.expectedPreviousRateSegment.segmentOrdinal + 1))
  ) return failInvalidStageHead()
}

/** Creates one low-level absent/exact-predecessor single-Put transaction. */
function createStageHeadWriteCommand(
  binding: PreparedStageHeadBinding,
  predecessor: LoadedDurableStageHead | undefined,
  successor: LoadedDurableStageHead,
  abandonment?: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  commitJournal?: PreparedStageCommitJournal,
): TransactWriteItemsCommand {
  if (abandonment !== undefined && commitJournal !== undefined) {
    return failInvalidStageHead()
  }
  const put: Put = {
    TableName: binding.stateTableName,
    Item: createStageHeadItem(binding, successor),
    ConditionExpression: predecessor === undefined
      ? 'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)'
      : [
          '#migrationId = :migrationId',
          '#recordKey = :recordKey',
          '#kind = :kind',
          '#recordVersion = :recordVersion',
          '#stateTableLocationBindingDigest = :stateTableLocationBindingDigest',
          '#manifestDigest = :manifestDigest',
          '#permitDigest = :permitDigest',
          '#requestedResourcesBinding = :requestedResourcesBinding',
          '#stateDigest = :expectedStateDigest',
          '#stateRevision = :expectedStateRevision',
          '#stateWriteNonce = :expectedStateWriteNonce',
        ].join(' AND '),
    ExpressionAttributeNames: {
      '#kind': 'kind',
      '#manifestDigest': 'manifestDigest',
      '#migrationId': 'migrationId',
      '#permitDigest': 'permitDigest',
      '#recordKey': 'recordKey',
      '#recordVersion': 'recordVersion',
      '#requestedResourcesBinding': 'requestedResourcesBinding',
      '#stateDigest': 'stateDigest',
      '#stateRevision': 'stateRevision',
      '#stateTableLocationBindingDigest':
        'stateTableLocationBindingDigest',
      '#stateWriteNonce': 'stateWriteNonce',
    },
    ...(predecessor === undefined
      ? {}
      : {
          ExpressionAttributeValues: {
            ':expectedStateDigest': { S: predecessor.stateDigest },
            ':expectedStateRevision': { N: String(predecessor.revision) },
            ':expectedStateWriteNonce': { S: predecessor.writeNonce },
            ':kind': {
              S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
            },
            ':manifestDigest': { S: binding.manifestDigest },
            ':migrationId': { S: WORKSPACE_SEARCH_MIGRATION_ID },
            ':permitDigest': { S: binding.permitDigest },
            ':recordKey': { S: binding.recordKey },
            ':recordVersion': {
              N: String(
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
              ),
            },
            ':requestedResourcesBinding': {
              S: binding.requestedResourcesBinding,
            },
            ':stateTableLocationBindingDigest': {
              S: binding.stateTableLocationBindingDigest,
            },
          },
        }),
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
  const transitionPut = abandonment === undefined
    ? undefined
    : createAbandonmentJournalPut(binding, abandonment)
  const commitPut = commitJournal === undefined
    ? undefined
    : createStageCommitJournalPut(binding, commitJournal)
  return new TransactWriteItemsCommand({
    TransactItems: [
      { Put: put },
      ...(transitionPut === undefined ? [] : [{ Put: transitionPut }]),
      ...(commitPut === undefined ? [] : [{ Put: commitPut }]),
    ],
  })
}

/** Creates one immutable ordinal-specific stage-commit journal Put. */
function createStageCommitJournalPut(
  binding: PreparedStageHeadBinding,
  journal: PreparedStageCommitJournal,
): Put {
  const recordKey = createStageCommitJournalRecordKey(
    binding,
    journal.receipt.stageOrdinal,
  )
  return {
    TableName: binding.stateTableName,
    Item: createStageCommitJournalItem(binding, recordKey, journal),
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
}

/** Creates the reserved immutable journal key for one global stage ordinal. */
function createStageCommitJournalRecordKey(
  binding: PreparedStageHeadBinding,
  stageOrdinal: number,
): string {
  return `${binding.recordNamespace}/stage/${stageOrdinal}/commit`
}

/** Creates one bounded strict immutable commit-journal item. */
function createStageCommitJournalItem(
  binding: PreparedStageHeadBinding,
  recordKey: string,
  journal: PreparedStageCommitJournal,
): Readonly<Record<string, AttributeValue>> {
  const evidence = journal.commitEvidence
  const receipt = journal.receipt
  const commitEvidenceJson = serializeCanonicalJson(evidence)
  const item = {
    abandonmentCount: {
      N: String(receipt.stageReservationAbandonmentCount),
    },
    abandonmentRootDigest: {
      S: receipt.stageReservationAbandonmentRootDigest,
    },
    commitAdmittedAt: { S: evidence.commitAdmittedAt },
    commitEvidenceDigest: { S: createMigrationDigest(evidence) },
    commitEvidenceJson: { S: commitEvidenceJson },
    commitRevision: {
      N: String(receipt.stageReservationCommitRevision),
    },
    kind: {
      S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND,
    },
    manifestDigest: { S: binding.manifestDigest },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    parentAuthenticationDigest: {
      S: evidence.parentAuthenticationDigest,
    },
    parentAuthorizationBindingDigest: {
      S: evidence.parentAuthorizationBindingDigest,
    },
    permitDigest: { S: binding.permitDigest },
    publicationKeyDigest: { S: evidence.publicationKeyDigest },
    receiptDigest: { S: createMigrationDigest(receipt) },
    recordKey: { S: recordKey },
    recordVersion: {
      N: String(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION,
      ),
    },
    requestedResourcesBinding: {
      S: binding.requestedResourcesBinding,
    },
    stageOrdinal: { N: String(receipt.stageOrdinal) },
    stageReservationClaimRevision: {
      N: String(receipt.stageReservationClaimRevision),
    },
    stageReservationDigest: {
      S: createMigrationDigest(journal.reservation),
    },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/** Creates one immutable ordinal-specific abandonment journal Put. */
function createAbandonmentJournalPut(
  binding: PreparedStageHeadBinding,
  abandonment: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
): Put {
  const recordKey = createAbandonmentJournalRecordKey(
    binding,
    abandonment,
  )
  return {
    TableName: binding.stateTableName,
    Item: createAbandonmentJournalItem(
      binding,
      recordKey,
      abandonment,
    ),
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
}

/** Creates the reserved ordinal-specific immutable abandonment row key. */
function createAbandonmentJournalRecordKey(
  binding: PreparedStageHeadBinding,
  abandonment: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
): string {
  return `${binding.recordNamespace}/stage/${abandonment.stageOrdinal}` +
    `/abandon/${abandonment.abandonmentCount}`
}

/** Creates one complete immutable abandonment journal item. */
function createAbandonmentJournalItem(
  binding: PreparedStageHeadBinding,
  recordKey: string,
  abandonment: WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
): Readonly<Record<string, AttributeValue>> {
  const transitionJson = serializeCanonicalJson(abandonment)
  const item = {
    kind: { S: abandonment.kind },
    manifestDigest: { S: abandonment.manifestDigest },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    permitDigest: { S: abandonment.permitDigest },
    recordKey: { S: recordKey },
    recordVersion: { N: String(abandonment.abandonmentVersion) },
    requestedResourcesBinding: {
      S: abandonment.requestedResourcesBinding,
    },
    stageOrdinal: { N: String(abandonment.stageOrdinal) },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
    transitionDigest: { S: createMigrationDigest(abandonment) },
    transitionJson: { S: transitionJson },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/** Creates one complete controlled low-level row. */
function createStageHeadItem(
  binding: PreparedStageHeadBinding,
  head: LoadedDurableStageHead,
): Readonly<Record<string, AttributeValue>> {
  const item = {
    kind: {
      S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
    },
    manifestDigest: { S: binding.manifestDigest },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    permitDigest: { S: binding.permitDigest },
    recordKey: { S: binding.recordKey },
    recordVersion: {
      N: String(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION),
    },
    requestedResourcesBinding: {
      S: binding.requestedResourcesBinding,
    },
    stateDigest: { S: head.stateDigest },
    stateJson: { S: head.stateJson },
    stateRevision: { N: String(head.revision) },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
    stateWriteNonce: { S: head.writeNonce },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/** Creates the exact shared migration-state primary key. */
function createStageHeadPrimaryKey(
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
  }
}

/** Creates a domain-separated digest for exact nested state and location. */
function createStageHeadStateDigest(
  binding: PreparedStageHeadBinding,
  state: DurableStageHeadState,
): string {
  return createMigrationDigest({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
    stateTableLocationBindingDigest:
      binding.stateTableLocationBindingDigest,
    state,
  })
}

/** Projects a validated row without exposing physical resource identities. */
function projectStageHead(
  head: LoadedDurableStageHead,
): WorkspaceSearchMigrationRehearsalStageHead {
  const active = head.state.activeReservation
  return Object.freeze({
    manifestDigest: head.state.manifestDigest,
    completedStageOrdinal: head.state.completedStageOrdinal,
    headReceiptDigest: head.state.headReceiptDigest,
    activeReservationDigest: active?.reservationDigest ?? null,
    activeStageOrdinal: active?.stageOrdinal ?? null,
    activeExpiresAt: active?.expiresAt ?? null,
    abandonmentCount: head.state.abandonmentCount,
    abandonmentRootDigest: head.state.abandonmentRootDigest,
    revision: head.revision,
  })
}

/** Reads and detaches an optional low-level DynamoDB Item. */
function readOptionalStageHeadItem(
  output: unknown,
): Readonly<Record<string, AttributeValue>> | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    nodeUtilTypes.isProxy(output)
  ) return failInvalidStageHead()
  const descriptor = Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (!Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) {
    return failInvalidStageHead()
  }
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(descriptor.value))
  } catch {
    return failInvalidStageHead()
  }
}

/** Requires the exact controlled row attribute set. */
function requireExactStageHeadAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  const actual = Object.keys(item).sort()
  const expected = [...stageHeadAttributeNames].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) return failInvalidStageHead()
}

/** Reads one exact string AttributeValue. */
function readStageHeadStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = readStageHeadAttribute(item, name)
  if (
    typeof attribute !== 'object' ||
    attribute === null ||
    nodeUtilTypes.isProxy(attribute) ||
    Object.keys(attribute).length !== 1 ||
    typeof attribute.S !== 'string'
  ) return failInvalidStageHead()
  return attribute.S
}

/** Reads one exact nonnegative safe-integer number AttributeValue. */
function readStageHeadNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = readStageHeadAttribute(item, name)
  if (
    typeof attribute !== 'object' ||
    attribute === null ||
    nodeUtilTypes.isProxy(attribute) ||
    Object.keys(attribute).length !== 1 ||
    typeof attribute.N !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(attribute.N)
  ) return failInvalidStageHead()
  const value = Number(attribute.N)
  if (!Number.isSafeInteger(value) || value < 0) {
    return failInvalidStageHead()
  }
  return value
}

/** Reads one exact lowercase digest string AttributeValue. */
function readStageHeadDigestAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  return readStageHeadDigest(readStageHeadStringAttribute(item, name))
}

/** Reads one own detached low-level attribute. */
function readStageHeadAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): AttributeValue {
  const descriptor = Object.getOwnPropertyDescriptor(item, name)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return failInvalidStageHead()
  }
  const value = item[name]
  if (value === undefined) {
    return failInvalidStageHead()
  }
  return value
}

/** Reauthenticates and detaches one exact selected-stage object. */
function requireSelectedStage(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const record = stageHeadGuards.requireRecord(value)
  stageHeadGuards.requireExactKeys(record, [
    'entry',
    'manifest',
    'manifestDigest',
    'previousStageReceiptDigest',
  ])
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    stageHeadGuards.readOwn(record, 'manifest'),
    verificationKey,
  )
  const manifestDigest = readStageHeadDigest(
      stageHeadGuards.readOwn(record, 'manifestDigest'),
  )
  if (manifestDigest !== createMigrationDigest(manifest)) {
    return failInvalidStageHead()
  }
  const entryRecord = stageHeadGuards.requireRecord(
    stageHeadGuards.readOwn(record, 'entry'),
  )
  stageHeadGuards.requireExactKeys(entryRecord, [
    'attemptOrdinal',
    'command',
    'controlArgumentsDigest',
    'expectedOutcome',
    'faultPlanDigest',
    'ordinal',
    'scenario',
    'scenarioStageOrdinal',
  ])
  const ordinal = readStageHeadPositiveInteger(
    stageHeadGuards.readOwn(entryRecord, 'ordinal'),
  )
  const manifestEntry = manifest.entries[ordinal - 1]
  if (
    manifestEntry === undefined ||
    createMigrationDigest(entryRecord) !== createMigrationDigest(manifestEntry)
  ) return failInvalidStageHead()
  return Object.freeze({
    entry: manifestEntry,
    manifest,
    manifestDigest,
    previousStageReceiptDigest: readStageHeadNullableDigest(
      stageHeadGuards.readOwn(record, 'previousStageReceiptDigest'),
    ),
  })
}

/** Reads one validated physical DynamoDB table name. */
function readStateTableName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) return failInvalidStageHead()
  return value
}

/** Copies one exact non-Proxy 32-byte verification key. */
function copyStageHeadKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    stageHeadGuards.readIntrinsicByteLength(value) !== 32
  ) return failInvalidStageHead()
  try {
    const copied = new Uint8Array(32)
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
    return copied
  } catch {
    return failInvalidStageHead()
  }
}

/**
 * Zeroizes one invocation-owned stage key through the intrinsic implementation.
 *
 * @param key - Optional plain key copy to erase.
 */
function zeroizeStageHeadKey(key: Uint8Array | undefined): void {
  if (key === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, key, [0])
  } catch {
    // Cleanup must not replace the primary durable-state outcome.
  }
}

/** Reads one canonical timestamp. */
function readStageHeadTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failInvalidStageHead()
  return value
}

/** Reads one canonical nullable timestamp. */
function readStageHeadNullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  return readStageHeadTimestamp(value)
}

/** Reads one strict lowercase SHA-256 digest. */
function readStageHeadDigest(value: unknown): string {
  if (!isHexDigest(value)) return failInvalidStageHead()
  return value
}

/** Reads one strict nullable SHA-256 digest. */
function readStageHeadNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return readStageHeadDigest(value)
}

/** Reads one positive safe integer. */
function readStageHeadPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) {
    return failInvalidStageHead()
  }
  return value
}

/** Reads one positive safe integer or explicit null. */
function readStageHeadNullablePositiveInteger(
  value: unknown,
): number | null {
  return value === null ? null : readStageHeadPositiveInteger(value)
}

/** Reads one nonnegative safe integer. */
function readStageHeadNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    return failInvalidStageHead()
  }
  return value
}

/** Recognizes an explicit DynamoDB conditional transaction rejection. */
function isStageHeadConditionalFailure(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) return false
  let name: unknown
  try {
    name = Reflect.get(error, 'name')
  } catch {
    return false
  }
  if (name === 'ConditionalCheckFailedException') return true
  if (name !== 'TransactionCanceledException') return false
  let reasons: unknown
  try {
    reasons = Reflect.get(error, 'CancellationReasons')
  } catch {
    return false
  }
  if (
    !Array.isArray(reasons) ||
    reasons.length < 1 ||
    reasons.length > 2
  ) return false
  let conditionalFailureCount = 0
  for (const reason of reasons) {
    if (
      typeof reason !== 'object' ||
      reason === null ||
      nodeUtilTypes.isProxy(reason)
    ) return false
    let code: unknown
    try {
      code = Reflect.get(reason, 'Code')
    } catch {
      return false
    }
    if (code === 'ConditionalCheckFailed') {
      conditionalFailureCount += 1
    } else if (code !== 'None') return false
  }
  return conditionalFailureCount === 1
}

/** Raises one stable malformed-state failure. */
function failInvalidStageHead(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationAwsError(
    'INVALID_STAGE_RESERVATION_STATE',
  )
}

/** Raises one stable exact-predecessor or active-slot conflict. */
function failStageHeadConflict(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationAwsError(
    'STAGE_RESERVATION_CONFLICT',
  )
}

/** Raises one stable pre-deadline recovery-required failure. */
function failStageReservationRecoveryRequired(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationAwsError(
    'STAGE_RESERVATION_RECOVERY_REQUIRED',
  )
}

/** Raises one stable transport outcome-uncertain failure. */
function failStageHeadTransportUncertain(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationAwsError(
    'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
  )
}
