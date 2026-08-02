import { timingSafeEqual } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type WorkspaceSearchMigrationConfiguration,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationControlCliArguments,
  type WorkspaceSearchMigrationMeasureCliArguments,
} from './migration-control-cli'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
} from './migration-describe-table-rate-policy'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import type {
  CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type VerifyWorkspaceSearchMigrationRehearsalPermitInput,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  type AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResultInput,
  type WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
} from './migration-rehearsal-integrity-evidence'
import {
  finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact,
  type FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact,
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
} from './migration-rehearsal-reconciliation-audit'
import type {
  WorkspaceSearchMigrationRehearsalExpectedAuthority,
  WorkspaceSearchMigrationRehearsalReconciliationAwsLimits,
} from './migration-rehearsal-reconciliation-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS,
} from './migration-rehearsal-reconciliation-aws'
import {
  createWorkspaceSearchMigrationRehearsalRateRuntime,
  type CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  type WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'
import {
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
  type VerifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessorInput,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
} from './migration-rehearsal-stage-child-material'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
} from './migration-rehearsal-stage-fault-material'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CONTROL_ARGUMENTS_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES,
  writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive,
  type WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome,
} from './migration-rehearsal-stage-finalizer-cli'
import {
  authenticateWorkspaceSearchMigrationRehearsalCollectionContext,
  readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim,
  snapshotWorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim,
} from './migration-rehearsal-stage-finalizer'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
} from './migration-rehearsal-stage-receipt'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  collectWorkspaceSearchMigrationRehearsalTargetAudit,
  finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES,
  type CollectWorkspaceSearchMigrationRehearsalTargetAuditInput,
  type FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput,
  type WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact,
  type WorkspaceSearchMigrationRehearsalCollectedTargetAudit,
  type WorkspaceSearchMigrationRehearsalTargetAuditSession,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'

/** Explicit review acknowledgement required before collecting private evidence. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL =
  'collect-reviewed-non-production-migration-rehearsal-reconciliation'

/** Stable discriminator for secret-free reconciliation CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-cli-result'

/** Maximum canonical bytes accepted for one authenticated rehearsal permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_PERMIT_MAX_BYTES =
  64 * 1_024

/** Maximum exact bytes accepted for one cross-domain integrity result. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_INTEGRITY_MAX_BYTES =
  1_024 * 1_024

/** Maximum local path length admitted at the CLI boundary. */
const maximumPathLength = 4_096

/** Reserved runway for terminal reconciliation finalization and stage commit. */
const reconciliationCommitHeadroomMilliseconds = 10 * 60 * 1_000

/** Reserved post-restored runway for integrity/reconciliation and stage commit. */
const restoredTargetHeadroomMilliseconds = 25 * 60 * 1_000

/** Maximum bytes accepted for one persisted material wrapper. */
const maximumPersistedMaterialBytes = Math.max(
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
) * 2

/** Evidence-collection modes exposed by the standalone executable. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliMode =
  | 'reconcile'
  | 'target-preimage'
  | 'target-restored'

/** Strict material files replayed through the parent-authentication boundary. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliMaterialFiles = {
  /** Parent-persisted current child-material wrapper. */
  readonly materialFile: string
  /** Optional parent-persisted response-loss boundary wrapper. */
  readonly boundaryMaterialFile?: string
  /** Optional exact reviewed fault plan. */
  readonly faultPlanFile?: string
  /** Optional exact durable rate segment at a fault boundary. */
  readonly boundaryRateSegmentFile?: string
  /** Optional exact durable rate segment after response-loss reconciliation. */
  readonly finalRateSegmentFile?: string
}

/** Files shared by target-audit and terminal reconciliation modes. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliCommonArguments = {
  /** Selected executable mode. */
  readonly mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode
  /** Exact authenticated complete reviewed stage manifest. */
  readonly manifestFile: string
  /** Exact authenticated immediately preceding committed stage receipt. */
  readonly previousReceiptFile: string
  /** Command-specific parent-persisted current material files. */
  readonly materialFiles:
    WorkspaceSearchMigrationRehearsalReconciliationCliMaterialFiles
  /** Parent-persisted process lifecycle wrapper. */
  readonly lifecycleFile: string
  /** Parent-origin authentication over material and lifecycle. */
  readonly parentAuthenticationFile: string
  /** Exact reviewed control argument vector used by the child. */
  readonly controlArgumentsFile: string
  /** Canonical authenticated non-production rehearsal permit. */
  readonly permitFile: string
  /** Raw owner-only master key used to derive runtime/publication keys. */
  readonly authenticationKeyFile: string
  /** Exact predecessor rate segment for this standalone process. */
  readonly previousRateSegmentFile: string
  /** New exclusive rate segment for this standalone process. */
  readonly rateSegmentFile: string
  /** New exclusive canonical evidence output. */
  readonly outputFile: string
  /** Exact explicit protected-operation acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL
  /** Existing read-only measure command selecting physical resources. */
  readonly measure: WorkspaceSearchMigrationMeasureCliArguments
}

/** Fields shared by both target-audit collection modes. */
type WorkspaceSearchMigrationRehearsalTargetAuditCliBaseArguments =
  WorkspaceSearchMigrationRehearsalReconciliationCliCommonArguments & {
    /** Finite maximum number of complete target pages. */
    readonly maximumTargetPages: number
    /** Finite total target-audit deadline. */
    readonly maximumDurationMilliseconds: number
  }

/** Target-audit mode arguments with strict preimage-only #163 inputs. */
export type WorkspaceSearchMigrationRehearsalTargetAuditCliArguments =
  WorkspaceSearchMigrationRehearsalTargetAuditCliBaseArguments & (
    | {
      /** Selects the target baseline collected before apply admission. */
      readonly mode: 'target-preimage'
      /** Canonical passing live #163 result completed before target collection. */
      readonly integrityBeforeResultFile: string
      /** Dedicated raw #163 result authentication key. */
      readonly integrityKeyFile: string
    }
    | {
      /** Selects the target state observed after authoritative rollback. */
      readonly mode: 'target-restored'
    }
  )

/** Raw verified-terminal integrity file selection. */
export type WorkspaceSearchMigrationRehearsalVerifiedIntegrityCliFiles = {
  /** Selects one post-verified-terminal #163 result. */
  readonly kind: 'verified-result'
  /** Canonical complete #163 result file. */
  readonly resultFile: string
  /** Dedicated raw #163 result authentication key. */
  readonly integrityKeyFile: string
}

/** Raw rollback-terminal integrity and target file selection. */
export type WorkspaceSearchMigrationRehearsalRollbackIntegrityCliFiles = {
  /** Selects a purpose-bound before/after rollback comparison. */
  readonly kind: 'rollback-comparison'
  /** Canonical pre-apply #163 result file. */
  readonly beforeResultFile: string
  /** Canonical post-rollback #163 result file. */
  readonly afterResultFile: string
  /** Dedicated raw #163 result authentication key. */
  readonly integrityKeyFile: string
  /** Scenario-specific canonical pre-apply target audit. */
  readonly targetPreimageAuditFile: string
  /** Scenario-specific canonical post-rollback target audit. */
  readonly targetRestoredAuditFile: string
}

/** Terminal reconciliation mode arguments. */
export type WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments =
  WorkspaceSearchMigrationRehearsalReconciliationCliCommonArguments & {
    /** Fixed terminal reconciliation mode. */
    readonly mode: 'reconcile'
    /** Scenario-selected external integrity and target files. */
    readonly integrityFiles:
      | WorkspaceSearchMigrationRehearsalRollbackIntegrityCliFiles
      | WorkspaceSearchMigrationRehearsalVerifiedIntegrityCliFiles
  /** Finite strong-Query and wall-clock limits. */
    readonly limits: WorkspaceSearchMigrationRehearsalReconciliationAwsLimits
  }

/** Complete strictly parsed standalone CLI configuration. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliArguments =
  | WorkspaceSearchMigrationRehearsalTargetAuditCliArguments
  | WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments

/** Raw material bundle admitted only to the shared parent-authentication verifier. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedMaterialBytes = {
  /** Exact canonical manifest bytes. */
  readonly manifestBytes: Uint8Array
  /** Exact canonical predecessor receipt bytes. */
  readonly previousReceiptBytes: Uint8Array
  /** Exact parent-persisted current material bytes. */
  readonly materialBytes: Uint8Array
  /** Optional parent-persisted response-loss boundary material. */
  readonly boundaryMaterialBytes?: Uint8Array
  /** Optional exact reviewed fault-plan bytes. */
  readonly faultPlanBytes?: Uint8Array
  /** Optional exact durable boundary rate bytes. */
  readonly boundaryRateSegmentBytes?: Uint8Array
  /** Optional exact durable response-loss completion rate bytes. */
  readonly finalRateSegmentBytes?: Uint8Array
  /** Exact parent-persisted lifecycle bytes. */
  readonly lifecycleBytes: Uint8Array
  /** Exact parent-origin authentication bytes. */
  readonly parentAuthenticationBytes: Uint8Array
  /** Exact reviewed control-argument vector bytes. */
  readonly controlArgumentsBytes: Uint8Array
}

/** Parent-authenticated facts admitted to one collection operation. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext = {
  /** Restricted run identifier retained only in process memory. */
  readonly runId: string
  /** HMAC-derived locator for the exact restricted run identifier. */
  readonly runLocatorDigest: string
  /** Canonical scenario selected by the authenticated manifest. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Exact selected child command. */
  readonly command:
    | 'close-replan'
    | 'rollback-complete'
    | 'rollback-partial'
    | 'verify'
  /** Digest of the exact authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Exact permit-approved resource selection binding. */
  readonly requestedResourcesBinding: string
  /** Reviewed live configuration hash. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Digest of the exact authenticated rehearsal manifest. */
  readonly manifestDigest: string
  /** Digest of the committed close-replan stage receipt. */
  readonly planningReceiptDigest: string
  /** Digest of the admitted closed-fence execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Digest of the exact closed writer fence protecting the plan. */
  readonly writerFenceDigest: string
  /** Adapter-proven expected authority chain, empty only when no adoption occurred. */
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Trusted #163 lower bound and exclusive reservation-expiry ceiling. */
  readonly integrityWindow: {
    /** Inclusive lower observation boundary. */
    readonly startedAt: string
    /** Exclusive reservation-expiry observation ceiling. */
    readonly completedAt: string
  }
  /** Exact rollback terminal for restored audits, otherwise null. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
}

/** Input to the shared stage-material authentication boundary. */
export type AuthenticateWorkspaceSearchMigrationRehearsalCollectionContextInput = {
  /** Selected collection phase used to reject stage replay. */
  readonly mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode
  /** Exact raw parent-persisted evidence files. */
  readonly material: WorkspaceSearchMigrationRehearsalAuthenticatedMaterialBytes
  /** Owned runtime verification-key copy. */
  readonly runtimeVerificationKey: Uint8Array
  /** Owned parent-only publication-key copy. */
  readonly publicationVerificationKey: Uint8Array
}

/** Complete branded-authentication output retained for session construction. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedCollection = {
  /** Aliases-free secret-free facts admitted to collection and finalization. */
  readonly context:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext
  /** Verified reservation and selection re-presented to remote preflight. */
  readonly stageClaim:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim
}

/** Narrow session used by target scans and terminal reconciliation only. */
export interface WorkspaceSearchMigrationRehearsalReconciliationCliSession
  extends WorkspaceSearchMigrationRehearsalTargetAuditSession {
  /**
   * Returns the exact durable head strongly read during idempotent claim.
   *
   * @returns Detached claimed head, or undefined when no claim was presented.
   */
  readRehearsalClaimedStageHead():
    WorkspaceSearchMigrationRehearsalStageHead | undefined

  /**
   * Measures the exact six-resource configuration through the rate gate.
   *
   * @returns Complete measured configuration selected by the session.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>

  /**
   * Performs the high-level terminal reconciliation without exposing Query.
   *
   * @param input - Exact bounded reconciliation request.
   * @returns Authenticated collector result from the measured session.
   */
  collectRehearsalReconciliation(
    input: CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalReconciliationCollectorResult>

  /** Stops new rate-managed admission after interruption. */
  interruptDescribeTableRate(): void

  /** Drains owned work and closes all AWS clients. */
  close(): Promise<void>

  /**
   * Seals rate admission.
   *
   * @returns Final drained durable DescribeTable rate aggregate.
   */
  sealAndReadDescribeTableRateEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence>
}

/** Injectable secure file, trust, session, and artifact boundaries. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliDependencies = {
  /** Reads one stable owner-only regular file without following symlinks. */
  readonly readRestrictedFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Authenticates current stage material through the shared finalizer boundary. */
  readonly authenticateCollectionContext: (
    input: AuthenticateWorkspaceSearchMigrationRehearsalCollectionContextInput,
  ) => WorkspaceSearchMigrationRehearsalAuthenticatedCollection
  /** Authenticates the local permit before the first AWS call. */
  readonly verifyPermit: (
    input: VerifyWorkspaceSearchMigrationRehearsalPermitInput,
  ) => ReturnType<typeof verifyWorkspaceSearchMigrationRehearsalPermit>
  /** Authenticates one live #163 preimage into a one-shot target authority. */
  readonly authenticateIntegrityPreimage: (
    input:
      AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResultInput,
    digestKey: Uint8Array,
  ) => WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability
  /** Creates one fresh append-only actual-rate runtime. */
  readonly createRateRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRateRuntime>
  /** Creates one authenticated measured non-production session. */
  readonly createSession: (
    input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalReconciliationCliSession>
  /** Authenticates the exact immediate predecessor/successor rate link. */
  readonly verifyRateSegmentSuccessor: (
    input: VerifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessorInput,
  ) => WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
  /** Performs one complete measured target-table observation. */
  readonly collectTargetAudit: (
    input: CollectWorkspaceSearchMigrationRehearsalTargetAuditInput,
  ) => ReturnType<typeof collectWorkspaceSearchMigrationRehearsalTargetAudit>
  /** Finalizes one actual target observation into canonical authenticated bytes. */
  readonly finalizeTargetAudit: (
    input: FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput,
    runtimeSigningKey: Uint8Array,
    publicationSigningKey: Uint8Array,
  ) => WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact
  /** Finalizes one measured terminal result into canonical authenticated bytes. */
  readonly finalizeReconciliation: (
    input:
      FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput,
    runtimeSigningKey: Uint8Array,
    publicationSigningKey: Uint8Array,
  ) => WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact
  /** Rejects a pre-existing output before creating AWS capabilities. */
  readonly ensureOutputAbsent: (path: string) => Promise<void>
  /** Durably publishes one canonical owner-only file without replacement. */
  readonly writeOutputExclusive: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome>
  /** Returns a trusted finite wall-clock observation. */
  readonly clock: () => Date
  /** Returns a trusted finite monotonic-clock observation. */
  readonly monotonicClock: () => number
  /** Emits one canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable standalone process exit statuses. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliExitCode =
  | 0
  | 1
  | 2
  | 130

/** Stable raw-value-free failure categories. */
export type WorkspaceSearchMigrationRehearsalReconciliationCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'CAPABILITY_CLOSE_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INTERRUPTED'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Raw-free classified executable failure. */
class WorkspaceSearchMigrationRehearsalReconciliationCliError extends Error {
  /** Stable machine-readable category. */
  readonly code: WorkspaceSearchMigrationRehearsalReconciliationCliFailureCode

  /** Exact process status paired with the category. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalReconciliationCliExitCode

  /**
   * Creates one classified failure without retaining untrusted values.
   *
   * @param code - Stable raw-free category.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalReconciliationCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalReconciliationCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalReconciliationCliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Raw input buffers owned by one invocation for deterministic zeroization. */
type ReconciliationCliOwnedInputs = {
  /** Every raw file buffer read by this invocation. */
  readonly buffers: Uint8Array[]
  /** Parent-authenticated material file bundle. */
  readonly material: WorkspaceSearchMigrationRehearsalAuthenticatedMaterialBytes
  /** Strict parsed authenticated permit candidate. */
  readonly permit: unknown
  /** Exact reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Raw master key buffer. */
  readonly masterKey: Uint8Array
  /** Optional raw dedicated #163 key. */
  readonly integrityKey?: Uint8Array
  /** Optional raw #163 result bytes. */
  readonly integrityResultBytes?: Uint8Array
  /** Optional raw pre-apply #163 result bytes. */
  readonly integrityBeforeResultBytes?: Uint8Array
  /** Optional raw post-rollback #163 result bytes. */
  readonly integrityAfterResultBytes?: Uint8Array
  /** Optional raw scenario-specific pre-apply target audit. */
  readonly targetPreimageAuditBytes?: Uint8Array
  /** Optional raw scenario-specific restored target audit. */
  readonly targetRestoredAuditBytes?: Uint8Array
}

/** Default real filesystem, AWS, and artifact dependencies. */
const defaultReconciliationCliDependencies:
  WorkspaceSearchMigrationRehearsalReconciliationCliDependencies =
  Object.freeze({
    readRestrictedFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    authenticateCollectionContext: (input) => {
      const authenticated =
        authenticateWorkspaceSearchMigrationRehearsalCollectionContext(input)
      return Object.freeze({
        context:
          snapshotWorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext(
            authenticated,
          ),
        stageClaim:
          readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
            authenticated,
          ),
      })
    },
    verifyPermit: (input) =>
      verifyWorkspaceSearchMigrationRehearsalPermit(input),
    authenticateIntegrityPreimage: (input, digestKey) =>
      authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
        input,
        digestKey,
      ),
    createRateRuntime: (input) =>
      createWorkspaceSearchMigrationRehearsalRateRuntime(input),
    createSession: async (input) => {
      const identity = await import('./migration-identity-aws')
      return await identity
        .createAwsWorkspaceSearchMigrationNonProductionRehearsalSession(
          input,
        )
    },
    verifyRateSegmentSuccessor: (input) =>
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor(input),
    collectTargetAudit: (input) =>
      collectWorkspaceSearchMigrationRehearsalTargetAudit(input),
    finalizeTargetAudit: (
      input,
      runtimeSigningKey,
      publicationSigningKey,
    ) =>
      finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        input,
        runtimeSigningKey,
        publicationSigningKey,
      ),
    finalizeReconciliation: (
      input,
      runtimeSigningKey,
      publicationSigningKey,
    ) =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        input,
        runtimeSigningKey,
        publicationSigningKey,
      ),
    ensureOutputAbsent:
      ensureWorkspaceSearchMigrationRehearsalReconciliationOutputAbsent,
    writeOutputExclusive: (path, bytes) =>
      writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        path,
        bytes,
      ),
    clock: (): Date => new Date(),
    monotonicClock: (): number => Math.floor(performance.now()),
    writeStdoutLine: (line: string): void => console.log(line),
    writeStderrLine: (line: string): void => console.error(line),
  })

/**
 * Parses one exact ordered target-audit or reconciliation invocation.
 *
 * Physical AWS resources remain the existing `measure` suffix after `--`.
 * Terminal identities, counts, digests, scenarios, and authority entries have
 * no operator-controlled flags and are derived only after material HMACs pass.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Frozen detached strict executable configuration.
 */
export function parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalReconciliationCliArguments {
  const values = snapshotArguments(arguments_)
  const mode = readMode(values[0])
  const common = parseCommonPrefix(values, mode)
  let cursor = common.nextOffset
  let targetPreimageFiles: {
    /** Canonical live #163 result path. */
    readonly integrityBeforeResultFile: string
    /** Dedicated #163 authentication-key path. */
    readonly integrityKeyFile: string
  } | undefined
  let modeSpecific:
    | Pick<
      WorkspaceSearchMigrationRehearsalTargetAuditCliArguments,
      'maximumDurationMilliseconds' | 'maximumTargetPages'
    >
    | Pick<WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments, 'integrityFiles' | 'limits'>
  if (mode === 'target-preimage' || mode === 'target-restored') {
    if (
      values[cursor] !== '--maximum-target-pages' ||
      values[cursor + 2] !== '--maximum-duration-milliseconds'
    ) throw invalidUsage()
    modeSpecific = Object.freeze({
      maximumTargetPages: readPositiveInteger(
        values[cursor + 1],
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES,
      ),
      maximumDurationMilliseconds: readPositiveInteger(
        values[cursor + 3],
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS,
      ),
    })
    cursor += 4
    if (mode === 'target-preimage') {
      if (
        values[cursor] !== '--integrity-before-result-file' ||
        values[cursor + 2] !== '--integrity-key-file'
      ) throw invalidUsage()
      targetPreimageFiles = Object.freeze({
        integrityBeforeResultFile: readPath(values[cursor + 1]),
        integrityKeyFile: readPath(values[cursor + 3]),
      })
      cursor += 4
    }
  } else {
    const parsed = parseReconciliationInputs(values, cursor)
    modeSpecific = parsed.value
    cursor = parsed.nextOffset
  }
  if (
    values[cursor] !== '--output-file' ||
    values[cursor + 2] !== '--approval' ||
    values[cursor + 3] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL ||
    values[cursor + 4] !== '--'
  ) throw invalidUsage()
  const outputFile = readPath(values[cursor + 1])
  const measureArguments = values.slice(cursor + 5)
  let measure: ReturnType<
    typeof parseWorkspaceSearchMigrationControlCliArguments
  >
  try {
    measure = parseWorkspaceSearchMigrationControlCliArguments(
      measureArguments,
    )
  } catch {
    throw invalidUsage()
  }
  if (measure.command !== 'measure') throw invalidUsage()
  if ('maximumTargetPages' in modeSpecific) {
    if (mode === 'reconcile') throw invalidUsage()
    const commonTargetFields = Object.freeze({
      ...common.value,
      maximumTargetPages: modeSpecific.maximumTargetPages,
      maximumDurationMilliseconds:
        modeSpecific.maximumDurationMilliseconds,
      outputFile,
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL,
      measure,
    })
    const configuration: WorkspaceSearchMigrationRehearsalTargetAuditCliArguments =
      mode === 'target-preimage'
        ? Object.freeze({
            mode,
            ...commonTargetFields,
            ...requireTargetPreimageFiles(targetPreimageFiles),
          })
        : Object.freeze({ mode, ...commonTargetFields })
    requireUniquePaths(configuration)
    return configuration
  }
  if (mode !== 'reconcile') throw invalidUsage()
  const configuration:
    WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments =
    Object.freeze({
      mode,
      ...common.value,
      integrityFiles: modeSpecific.integrityFiles,
      limits: modeSpecific.limits,
      outputFile,
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL,
      measure,
    })
  requireUniquePaths(configuration)
  return configuration
}

/**
 * Requires the exact two preimage-only #163 file selections.
 *
 * @param value - Parsed file selection or absence from another mode.
 * @returns Strict detached preimage file paths.
 */
function requireTargetPreimageFiles(
  value: {
    /** Canonical live #163 result path. */
    readonly integrityBeforeResultFile: string
    /** Dedicated #163 authentication-key path. */
    readonly integrityKeyFile: string
  } | undefined,
): {
  /** Canonical live #163 result path. */
  readonly integrityBeforeResultFile: string
  /** Dedicated #163 authentication-key path. */
  readonly integrityKeyFile: string
} {
  if (value === undefined) throw invalidUsage()
  return value
}

/** Parsed common prefix and the first mode-specific argument index. */
type ParsedCommonPrefix = {
  /** Frozen common CLI fields. */
  readonly value: Omit<
    WorkspaceSearchMigrationRehearsalReconciliationCliCommonArguments,
    'approval' | 'measure' | 'mode' | 'outputFile'
  >
  /** Index of the first mode-specific flag. */
  readonly nextOffset: number
}

/** Parses the exact common material, key, and rate-file prefix. */
function parseCommonPrefix(
  values: readonly string[],
  _mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode,
): ParsedCommonPrefix {
  if (
    values[1] !== '--manifest-file' ||
    values[3] !== '--previous-receipt-file' ||
    values[5] !== '--material-file'
  ) throw invalidUsage()
  const materialFile = readPath(values[6])
  let cursor = 7
  const optionalMaterial: {
    boundaryMaterialFile?: string
    faultPlanFile?: string
    boundaryRateSegmentFile?: string
    finalRateSegmentFile?: string
  } = {}
  if (values[cursor] === '--boundary-material-file') {
    optionalMaterial.boundaryMaterialFile = readPath(values[cursor + 1])
    cursor += 2
  }
  if (values[cursor] === '--fault-plan-file') {
    optionalMaterial.faultPlanFile = readPath(values[cursor + 1])
    cursor += 2
  }
  if (values[cursor] === '--boundary-rate-segment-file') {
    optionalMaterial.boundaryRateSegmentFile = readPath(values[cursor + 1])
    cursor += 2
  }
  if (values[cursor] === '--final-rate-segment-file') {
    optionalMaterial.finalRateSegmentFile = readPath(values[cursor + 1])
    cursor += 2
  }
  requireValidMaterialFileShape(optionalMaterial)
  if (
    values[cursor] !== '--lifecycle-file' ||
    values[cursor + 2] !== '--parent-authentication-file' ||
    values[cursor + 4] !== '--control-arguments-file' ||
    values[cursor + 6] !== '--permit-file' ||
    values[cursor + 8] !== '--authentication-key-file' ||
    values[cursor + 10] !== '--previous-rate-segment-file' ||
    values[cursor + 12] !== '--rate-segment-file'
  ) throw invalidUsage()
  return Object.freeze({
    value: Object.freeze({
      manifestFile: readPath(values[2]),
      previousReceiptFile: readPath(values[4]),
      materialFiles: Object.freeze({
        materialFile,
        ...optionalMaterial,
      }),
      lifecycleFile: readPath(values[cursor + 1]),
      parentAuthenticationFile: readPath(values[cursor + 3]),
      controlArgumentsFile: readPath(values[cursor + 5]),
      permitFile: readPath(values[cursor + 7]),
      authenticationKeyFile: readPath(values[cursor + 9]),
      previousRateSegmentFile: readPath(values[cursor + 11]),
      rateSegmentFile: readPath(values[cursor + 13]),
    }),
    nextOffset: cursor + 14,
  })
}

/** Parsed reconciliation-only file and limit suffix. */
type ParsedReconciliationInputs = {
  /** Frozen reconciliation-only fields. */
  readonly value: Pick<
    WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments,
    'integrityFiles' | 'limits'
  >
  /** First output flag index. */
  readonly nextOffset: number
}

/** Parses one of the exact verified or rollback reconciliation profiles. */
function parseReconciliationInputs(
  values: readonly string[],
  initialOffset: number,
): ParsedReconciliationInputs {
  let cursor = initialOffset
  let integrityFiles:
    | WorkspaceSearchMigrationRehearsalRollbackIntegrityCliFiles
    | WorkspaceSearchMigrationRehearsalVerifiedIntegrityCliFiles
  if (values[cursor] === '--integrity-result-file') {
    if (values[cursor + 2] !== '--integrity-key-file') throw invalidUsage()
    integrityFiles = Object.freeze({
      kind: 'verified-result',
      resultFile: readPath(values[cursor + 1]),
      integrityKeyFile: readPath(values[cursor + 3]),
    })
    cursor += 4
  } else if (
    values[cursor] === '--integrity-before-result-file' &&
    values[cursor + 2] === '--integrity-after-result-file' &&
    values[cursor + 4] === '--integrity-key-file' &&
    values[cursor + 6] === '--target-preimage-audit-file' &&
    values[cursor + 8] === '--target-restored-audit-file'
  ) {
    integrityFiles = Object.freeze({
      kind: 'rollback-comparison',
      beforeResultFile: readPath(values[cursor + 1]),
      afterResultFile: readPath(values[cursor + 3]),
      integrityKeyFile: readPath(values[cursor + 5]),
      targetPreimageAuditFile: readPath(values[cursor + 7]),
      targetRestoredAuditFile: readPath(values[cursor + 9]),
    })
    cursor += 10
  } else {
    throw invalidUsage()
  }
  if (
    values[cursor] !== '--maximum-query-pages' ||
    values[cursor + 2] !== '--maximum-query-items' ||
    values[cursor + 4] !== '--maximum-query-bytes' ||
    values[cursor + 6] !== '--request-timeout-milliseconds' ||
    values[cursor + 8] !== '--maximum-duration-milliseconds'
  ) throw invalidUsage()
  return Object.freeze({
    value: Object.freeze({
      integrityFiles,
      limits: Object.freeze({
        maximumPages: readPositiveInteger(
          values[cursor + 1],
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES,
        ),
        maximumItems: readPositiveInteger(
          values[cursor + 3],
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS,
        ),
        maximumBytes: readPositiveInteger(
          values[cursor + 5],
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES,
        ),
        requestTimeoutMilliseconds: readPositiveInteger(
          values[cursor + 7],
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS,
        ),
        maximumDurationMilliseconds: readPositiveInteger(
          values[cursor + 9],
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
        ),
      }),
    }),
    nextOffset: cursor + 10,
  })
}

/**
 * Runs one authenticated target observation or terminal reconciliation.
 *
 * All local files are read before AWS composition. Permit and stage context
 * authenticate independently, the measured configuration is compared to the
 * stage binding, and success is emitted only after session/rate closure and a
 * durable no-replace artifact publication.
 *
 * @param arguments_ - Exact ordered standalone CLI arguments.
 * @param dependencies - Injectable secure I/O and no-AWS unit boundaries.
 * @param signal - Optional cooperative cancellation signal.
 * @returns Stable process exit status.
 */
export async function runWorkspaceSearchMigrationRehearsalReconciliationCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalReconciliationCliDependencies =
      defaultReconciliationCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationRehearsalReconciliationCliExitCode> {
  let output = captureOutputDependencies(dependencies)
  let inputs: ReconciliationCliOwnedInputs | undefined
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  let runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined
  let session: WorkspaceSearchMigrationRehearsalReconciliationCliSession |
    undefined
  let artifactBytes: Uint8Array | undefined
  let removeAbortListener: (() => void) | undefined
  let primaryFailure: unknown
  let result: {
    readonly operation: WorkspaceSearchMigrationRehearsalReconciliationCliMode
    readonly contentDigest: string
    readonly byteLength: number
    readonly rateSegmentDigest: string
  } | undefined
  try {
    const captured = captureDependencies(dependencies)
    output = captured
    const configuration =
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        arguments_,
      )
    requireActive(signal)
    await captured.ensureOutputAbsent(configuration.outputFile)
    inputs = await readAllInputs(configuration, captured)
    const derived = deriveWorkspaceSearchMigrationRehearsalKeys(
      inputs.masterKey,
    )
    runtimeKey = derived.runtimeKey
    publicationKey = derived.publicationKey
    requireDedicatedKeys(inputs, runtimeKey, publicationKey)
    zeroize(inputs.masterKey)
    const requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(
        configuration.measure.resources,
      )
    const permitKey = copyKey(runtimeKey)
    let permitClaims: ReturnType<
      typeof verifyWorkspaceSearchMigrationRehearsalPermit
    >
    try {
      permitClaims = captured.verifyPermit({
        permit: inputs.permit,
        verificationKey: permitKey,
        account: configuration.measure.resources.account,
        region: configuration.measure.resources.region,
        commit: configuration.measure.resources.commit,
        requestedResourcesBinding,
        currentTime: readClock(captured.clock),
      })
    } finally {
      zeroize(permitKey)
    }
    if (
      permitClaims.evidenceKeyDigest !== derived.runtimeKeyDigest ||
      permitClaims.publicationKeyDigest !== derived.publicationKeyDigest
    ) throw authenticationFailed()
    const contextRuntimeKey = copyKey(runtimeKey)
    const contextPublicationKey = copyKey(publicationKey)
    let authenticatedCollection:
      WorkspaceSearchMigrationRehearsalAuthenticatedCollection
    try {
      authenticatedCollection = captured.authenticateCollectionContext({
        mode: configuration.mode,
        material: inputs.material,
        runtimeVerificationKey: contextRuntimeKey,
        publicationVerificationKey: contextPublicationKey,
      })
    } catch {
      throw authenticationFailed()
    } finally {
      zeroize(contextRuntimeKey)
      zeroize(contextPublicationKey)
    }
    const context = authenticatedCollection.context
    const stageClaim = authenticatedCollection.stageClaim
    requireContextBindings(
      context,
      configuration,
      inputs,
      requestedResourcesBinding,
    )
    requireActive(signal)
    const targetIntegrityBefore = configuration.mode === 'target-preimage'
      ? authenticateTargetIntegrityBefore(
          inputs,
          permitClaims.integrityResourceIdentityDigest,
          captured,
        )
      : null
    const rateRuntimeKey = copyKey(runtimeKey)
    try {
      runtime = await captured.createRateRuntime({
        segmentFile: configuration.rateSegmentFile,
        previousSegmentFile: configuration.previousRateSegmentFile,
        expectedPolicyVersion: context.policyVersion,
        expectedConfigurationBindingDigest:
          context.configurationBindingDigest,
        authenticationKey: rateRuntimeKey,
      })
    } finally {
      zeroize(rateRuntimeKey)
    }
    const sessionPermitKey = copyKey(runtimeKey)
    const sessionStageKey = copyKey(runtimeKey)
    try {
      session = await captured.createSession({
        requested: configuration.measure.resources,
        ratePolicy: inputs.ratePolicy,
        bootstrapRateCheckpoint: configuration.measure.rateBootstrap,
        recoverInterruptedCleanup:
          configuration.measure.rateRecoverInterruptedCleanup,
        recoverInterruptedAttempt:
          configuration.measure.rateRecoverInterruptedAttempt,
        rateRecorder: runtime.recorder,
        permit: inputs.permit,
        permitVerificationKey: sessionPermitKey,
        permitClock: captured.clock,
        stageReservationClaim: {
          reservation: stageClaim.reservation,
          selection: stageClaim.selection,
          previousReceipt: null,
          stageKey: sessionStageKey,
          publicationKey: null,
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } finally {
      zeroize(sessionPermitKey)
      zeroize(sessionStageKey)
    }
    const activeSession = session
    const claimedHead = activeSession.readRehearsalClaimedStageHead()
    requireClaimedStageHeadBindings(claimedHead, context, stageClaim)
    const collectionDeadline = createCollectionDeadline(
      configuration.mode === 'reconcile'
        ? configuration.limits.maximumDurationMilliseconds
        : configuration.maximumDurationMilliseconds,
      stageClaim.reservation.expiresAt,
      configuration.mode === 'target-restored'
        ? restoredTargetHeadroomMilliseconds
        : reconciliationCommitHeadroomMilliseconds,
      captured.clock,
      captured.monotonicClock,
    )
    /** Interrupts new rate admission when the caller aborts. */
    const abortListener = (): void => {
      try {
        activeSession.interruptDescribeTableRate()
      } catch {
        // The stable interrupted/close path still owns final cleanup.
      }
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', abortListener, { once: true })
      removeAbortListener = (): void =>
        signal.removeEventListener('abort', abortListener)
    }
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    const measuredConfiguration = await activeSession.measureConfiguration()
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    const measuredConfigurationHash =
      createWorkspaceSearchConfigurationHash(measuredConfiguration)
    if (measuredConfigurationHash !== context.configurationBindingDigest) {
      throw authenticationFailed()
    }
    requireActive(signal)
    const pendingCollection: PendingReconciliationCliCollection =
      configuration.mode === 'reconcile'
      ? Object.freeze({
        kind: 'reconciliation',
        collectorResult: await collectReconciliationResult(
          configuration,
          inputs,
          context,
          activeSession,
          captured,
          runtimeKey,
          publicationKey,
          collectionDeadline,
          signal,
        ),
      })
      : Object.freeze({
        kind: 'target-audit',
        audit: await collectTargetObservation(
          configuration,
          context,
          measuredConfiguration,
          activeSession,
          captured,
          readCollectionRemainingDuration(
            collectionDeadline,
            captured.monotonicClock,
          ),
          signal,
        ),
      })
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    const durableRateEvidence =
      await activeSession.sealAndReadDescribeTableRateEvidence()
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    const committedRateSegment = await runtime.flush()
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    await runtime.close()
    runtime = undefined
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    let rateProof: ReconciliationCliRateProof
    try {
      rateProof = await verifyClosedRateSegment(
        configuration,
        context,
        committedRateSegment,
        durableRateEvidence,
        runtimeKey,
        captured,
        inputs.buffers,
      )
    } finally {
      zeroize(committedRateSegment.canonicalBytes)
    }
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    const completedAt = readCollectionWallClockBeforeCutoff(
      collectionDeadline,
      captured.clock,
    ).toISOString()
    const artifact = finalizePendingCollection(
      configuration,
      pendingCollection,
      context,
      rateProof,
      completedAt,
      targetIntegrityBefore,
      runtimeKey,
      publicationKey,
      captured,
    )
    artifactBytes = artifact.canonicalBytes
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    await activeSession.close()
    session = undefined
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    requireActive(signal)
    const outcome = await captured.writeOutputExclusive(
      configuration.outputFile,
      artifactBytes,
    )
    if (outcome !== 'created') {
      if (outcome === 'exists' || outcome === 'reconciled') {
        throw outputExists()
      }
      throw outputWriteFailed()
    }
    requireCollectionDeadlineActive(
      collectionDeadline,
      captured.monotonicClock,
    )
    result = Object.freeze({
      operation: configuration.mode,
      contentDigest: artifact.contentDigest,
      byteLength: artifact.byteLength,
      rateSegmentDigest: rateProof.successor.successor.segmentDigest,
    })
  } catch (error: unknown) {
    primaryFailure = error
  }
  removeAbortListener?.()
  const closeFailed = await closeCapabilities(session, runtime)
  zeroize(runtimeKey)
  zeroize(publicationKey)
  zeroize(artifactBytes)
  zeroizeOwnedInputs(inputs)
  if (primaryFailure !== undefined) {
    const failure = classifyFailure(primaryFailure, signal)
    writeFailure(output.writeStderrLine, failure.code)
    return failure.exitCode
  }
  if (closeFailed) {
    writeFailure(output.writeStderrLine, 'CAPABILITY_CLOSE_FAILED')
    return 1
  }
  if (result === undefined) {
    writeFailure(output.writeStderrLine, 'OPERATION_FAILED')
    return 1
  }
  output.writeStdoutLine(serializeCanonicalJson({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
    status: 'succeeded',
    ...result,
  }))
  return 0
}

/** Common canonical artifact projection returned by either collector mode. */
type CollectedCanonicalArtifact = {
  /** Exact canonical artifact bytes. */
  readonly canonicalBytes: Uint8Array
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** SHA-256 digest of the exact canonical bytes. */
  readonly contentDigest: string
}

/** Raw measured result retained until session and rate capabilities close. */
type PendingReconciliationCliCollection =
  | {
    /** Selects a measured terminal reconciliation result. */
    readonly kind: 'reconciliation'
    /** Complete normalized result before final artifact authentication. */
    readonly collectorResult:
      WorkspaceSearchMigrationRehearsalReconciliationCollectorResult
  }
  | {
    /** Selects one measured target observation capability. */
    readonly kind: 'target-audit'
    /** Opaque actual paginated target observation. */
    readonly audit: WorkspaceSearchMigrationRehearsalCollectedTargetAudit
  }

/** Independently authenticated durable standalone rate proof. */
type ReconciliationCliRateProof = {
  /** Branded proof of the exact immediate predecessor/successor rate link. */
  readonly successor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
  /** Exact durable rate-ledger aggregate read after collection. */
  readonly durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Mutable trusted wall/monotonic boundary for one collection lifecycle. */
type ReconciliationCliCollectionDeadline = {
  /** Absolute monotonic deadline including collection and durable publication. */
  readonly deadlineMilliseconds: number
  /** Exclusive wall-clock cutoff before reserved parent-finalization runway. */
  readonly reservationCutoffAtMilliseconds: number
  /** Mode-specific runway excluded from this collection deadline. */
  readonly reservationHeadroomMilliseconds: number
  /** Latest trusted monotonic sample used to reject clock regression. */
  lastObservedMilliseconds: number
  /** Latest trusted wall-clock sample used to reject clock regression. */
  lastObservedWallClockMilliseconds: number
}

/** Trusted collection clock whose first sample is the integrity completion. */
type ReconciliationCliIntegrityCompletionClock = {
  /** Non-regressing cutoff-bound clock passed into the measured session. */
  readonly clock: () => Date
  /** Reads the first in-session sample after integrity authentication. */
  readonly readCompletedAt: () => string
}

/** Collects and signs one terminal reconciliation audit. */
async function collectReconciliationResult(
  configuration:
    WorkspaceSearchMigrationRehearsalTerminalReconciliationCliArguments,
  inputs: ReconciliationCliOwnedInputs,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  session: WorkspaceSearchMigrationRehearsalReconciliationCliSession,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  deadline: ReconciliationCliCollectionDeadline,
  signal: AbortSignal | undefined,
): Promise<WorkspaceSearchMigrationRehearsalReconciliationCollectorResult> {
  const maximumDurationMilliseconds = Math.min(
    configuration.limits.maximumDurationMilliseconds,
    readCollectionRemainingDuration(
      deadline,
      dependencies.monotonicClock,
    ),
  )
  const integrityCompletionClock = createReconciliationIntegrityCompletionClock(
    context,
    deadline,
    dependencies.clock,
  )
  const integrity = createReconciliationIntegrityInput(inputs, context)
  const rollbackTarget = integrity.kind === 'rollback-comparison'
    ? createRollbackTargetInput(
        inputs,
        context,
        runtimeKey,
        publicationKey,
      )
    : undefined
  let collectorResult:
    WorkspaceSearchMigrationRehearsalReconciliationCollectorResult
  try {
    collectorResult = await session.collectRehearsalReconciliation({
      runId: context.runId,
      runLocatorDigest: context.runLocatorDigest,
      scenario: context.scenario,
      expectedAuthorities: context.expectedAuthorities,
      integrity,
      ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
      limits: Object.freeze({
        ...configuration.limits,
        maximumDurationMilliseconds,
      }),
      clock: integrityCompletionClock.clock,
      ...(signal === undefined ? {} : { signal }),
    })
  } finally {
    zeroize(integrity.digestKey)
    zeroize(rollbackTarget?.runtimeVerificationKey)
    zeroize(rollbackTarget?.publicationVerificationKey)
  }
  const integrityCompletedAt = integrityCompletionClock.readCompletedAt()
  requireCollectorContextBindings(
    collectorResult,
    context,
    integrityCompletedAt,
    deadline.reservationCutoffAtMilliseconds,
  )
  return collectorResult
}

/** Requires measured collector facts to reproduce parent-authenticated context. */
function requireCollectorContextBindings(
  collectorResult:
    WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  integrityCompletedAt: string,
  reservationCutoffAtMilliseconds: number,
): void {
  const collected = collectorResult.context
  if (
    collected.scenario !== context.scenario ||
    collected.runLocatorDigest !== context.runLocatorDigest ||
    collected.configurationBindingDigest !==
      context.configurationBindingDigest ||
    collected.sealedPlanningAuthorityDigest !==
      context.sealedPlanningAuthorityDigest ||
    collected.planDigest !== context.planDigest
  ) throw authenticationFailed()
  const integrity = collectorResult.integrity
  if (
    integrity.completedAt !== integrityCompletedAt ||
    Date.parse(integrityCompletedAt) <
      Date.parse(context.integrityWindow.startedAt) ||
    Date.parse(integrityCompletedAt) >=
      reservationCutoffAtMilliseconds
  ) {
    throw authenticationFailed()
  }
  if (integrity.kind === 'verified-result') {
    if (context.terminal !== null) throw authenticationFailed()
    return
  }
  const terminal = context.terminal
  if (
    terminal === null ||
    integrity.startedAt !== context.integrityWindow.startedAt ||
    integrity.terminalRootDigest !== terminal.rootDigest ||
    collected.terminalRootKind !== terminal.kind ||
    collected.terminalRootVersion !== terminal.version ||
    collected.terminalRootDigest !== terminal.rootDigest ||
    collected.terminalAt !== terminal.terminalAt ||
    integrity.purpose !== (
      terminal.scenario === 'partial-apply-rollback'
        ? 'partial-rollback'
        : 'complete-rollback'
    )
  ) throw authenticationFailed()
}

/** Collects one purpose-bound complete target observation before signing. */
async function collectTargetObservation(
  configuration: WorkspaceSearchMigrationRehearsalTargetAuditCliArguments,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  measuredConfiguration: WorkspaceSearchMigrationConfiguration,
  session: WorkspaceSearchMigrationRehearsalReconciliationCliSession,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  maximumDurationMilliseconds: number,
  signal: AbortSignal | undefined,
): Promise<WorkspaceSearchMigrationRehearsalCollectedTargetAudit> {
  return await dependencies.collectTargetAudit({
    session,
    configuration: measuredConfiguration,
    configurationHash: context.configurationBindingDigest,
    maximumPages: configuration.maximumTargetPages,
    maximumDurationMilliseconds,
    clock: dependencies.clock,
    monotonicClock: dependencies.monotonicClock,
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Rereads and independently authenticates the durable successor rate file. */
async function verifyClosedRateSegment(
  configuration: WorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  committed: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  runtimeKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  ownedBuffers: Uint8Array[],
): Promise<ReconciliationCliRateProof> {
  /** Reads and retains one exact owner-only rate segment. */
  const readSegment = async (path: string): Promise<Uint8Array> => {
    let bytes: Uint8Array
    try {
      bytes = await dependencies.readRestrictedFile(
        path,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
    } catch {
      throw inputUnreadable()
    }
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      nodeUtilTypes.isSharedArrayBuffer(bytes.buffer) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
    ) throw inputInvalid()
    ownedBuffers.push(bytes)
    return bytes
  }
  const predecessorBytes = await readSegment(
    configuration.previousRateSegmentFile,
  )
  const currentBytes = await readSegment(configuration.rateSegmentFile)
  if (!sameBytes(currentBytes, committed.canonicalBytes)) {
    throw authenticationFailed()
  }
  const verificationKey = copyKey(runtimeKey)
  let successor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
  try {
    successor = dependencies.verifyRateSegmentSuccessor({
      predecessorSegmentBytes: predecessorBytes,
      successorSegmentBytes: currentBytes,
      authenticationKey: verificationKey,
      expectedPolicyVersion: context.policyVersion,
      expectedConfigurationBindingDigest:
        context.configurationBindingDigest,
    })
  } finally {
    zeroize(verificationKey)
  }
  if (!sameCommittedAndVerifiedSegment(committed, successor.successor)) {
    throw authenticationFailed()
  }
  return Object.freeze({
    successor,
    durableEvidence,
  })
}

/** Finalizes only after session close and durable rate-segment verification. */
function finalizePendingCollection(
  configuration: WorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  pending: PendingReconciliationCliCollection,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  rateProof: ReconciliationCliRateProof,
  completedAt: string,
  integrityBefore:
    WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability | null,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
): CollectedCanonicalArtifact {
  const runtimeSigningKey = copyKey(runtimeKey)
  const publicationSigningKey = copyKey(publicationKey)
  try {
    if (configuration.mode === 'reconcile') {
      if (pending.kind !== 'reconciliation') throw authenticationFailed()
      return dependencies.finalizeReconciliation(
        {
          collectorResult: pending.collectorResult,
          rate: {
            verifiedSuccessor: rateProof.successor,
            durableEvidence: rateProof.durableEvidence,
            completedAt,
          },
        },
        runtimeSigningKey,
        publicationSigningKey,
      )
    }
    if (pending.kind !== 'target-audit') throw authenticationFailed()
    const targetContext = createTargetAuditContext(context)
    const rate = Object.freeze({
      verifiedSuccessor: rateProof.successor,
      durableEvidence: rateProof.durableEvidence,
      completedAt,
    })
    if (configuration.mode === 'target-preimage') {
      if (integrityBefore === null) throw authenticationFailed()
      return dependencies.finalizeTargetAudit({
        audit: pending.audit,
        context: targetContext,
        integrityBefore,
        purpose: context.scenario === 'partial-apply-rollback'
          ? 'partial-rollback-preimage'
          : 'complete-rollback-preimage',
        rate,
        terminal: null,
      }, runtimeSigningKey, publicationSigningKey)
    }
    const terminal = context.terminal
    if (terminal === null) throw authenticationFailed()
    if (terminal.scenario === 'partial-apply-rollback') {
      return dependencies.finalizeTargetAudit({
        audit: pending.audit,
        context: targetContext,
        integrityBefore: null,
        purpose: 'partial-rollback-restored',
        rate,
        terminal,
      }, runtimeSigningKey, publicationSigningKey)
    }
    return dependencies.finalizeTargetAudit({
      audit: pending.audit,
      context: targetContext,
      integrityBefore: null,
      purpose: 'complete-rollback-restored',
      rate,
      terminal,
    }, runtimeSigningKey, publicationSigningKey)
  } finally {
    zeroize(runtimeSigningKey)
    zeroize(publicationSigningKey)
  }
}

/** Projects only parent-authenticated scenario and planning target context. */
function createTargetAuditContext(
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  if (!isRollbackScenario(context.scenario)) {
    throw authenticationFailed()
  }
  return Object.freeze({
    scenario: context.scenario,
    runLocatorDigest: context.runLocatorDigest,
    manifestDigest: context.manifestDigest,
    permitDigest: context.permitDigest,
    requestedResourcesBinding: context.requestedResourcesBinding,
    configurationBindingDigest: context.configurationBindingDigest,
    planningReceiptDigest: context.planningReceiptDigest,
    executionBoundaryDigest: context.executionBoundaryDigest,
    sealedPlanningAuthorityDigest:
      context.sealedPlanningAuthorityDigest,
    planDigest: context.planDigest,
    writerFenceDigest: context.writerFenceDigest,
  })
}

/** Compares the exact durable bytes without early-exit content leakage. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Requires reread authentication to reproduce every flushed segment field. */
function sameCommittedAndVerifiedSegment(
  committed: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  verified:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor[
      'successor'
    ],
): boolean {
  return committed.segmentLocatorDigest === verified.segmentLocatorDigest &&
    committed.segmentOrdinal === verified.segmentOrdinal &&
    committed.eventCount === verified.eventCount &&
    committed.firstCommittedEventSequence ===
      verified.firstCommittedEventSequence &&
    committed.lastCommittedEventSequence ===
      verified.lastCommittedEventSequence &&
    committed.terminalRecordMac === verified.terminalRecordMac &&
    committed.segmentDigest === verified.segmentDigest
}

/**
 * Authenticates the target-preimage #163 result before any AWS capability opens.
 *
 * @param inputs - Invocation-owned raw result and dedicated key buffers.
 * @param expectedResourceIdentityDigest - Authenticated permit resource identity.
 * @param dependencies - Captured trusted authenticator and wall clock.
 * @returns One-shot live #163 authority consumed by target finalization.
 */
function authenticateTargetIntegrityBefore(
  inputs: ReconciliationCliOwnedInputs,
  expectedResourceIdentityDigest: string,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
): WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability {
  const resultBytes = inputs.integrityBeforeResultBytes
  if (resultBytes === undefined) throw authenticationFailed()
  const key = copyRequiredInputKey(inputs.integrityKey)
  try {
    return dependencies.authenticateIntegrityPreimage({
      resultBytes,
      expectedResourceIdentityDigest,
      clock: dependencies.clock,
    }, key)
  } catch {
    throw authenticationFailed()
  } finally {
    zeroize(key)
  }
}

/** Creates the exact identity-session integrity union from authenticated context. */
function createReconciliationIntegrityInput(
  inputs: ReconciliationCliOwnedInputs,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
): CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput[
  'integrity'
] {
  const key = copyRequiredInputKey(inputs.integrityKey)
  if (inputs.integrityResultBytes !== undefined) {
    return Object.freeze({
      kind: 'verified-result',
      resultBytes: inputs.integrityResultBytes,
      digestKey: key,
    })
  }
  const beforeResultBytes = inputs.integrityBeforeResultBytes
  const afterResultBytes = inputs.integrityAfterResultBytes
  if (beforeResultBytes === undefined || afterResultBytes === undefined) {
    zeroize(key)
    throw authenticationFailed()
  }
  return Object.freeze({
    kind: 'rollback-comparison',
    startedAt: context.integrityWindow.startedAt,
    beforeResultBytes,
    afterResultBytes,
    digestKey: key,
  })
}

/** Creates the exact rollback target input with an owned runtime key later. */
function createRollbackTargetInput(
  inputs: ReconciliationCliOwnedInputs,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): NonNullable<
  CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput[
    'rollbackTarget'
  ]
> {
  const preimageAuditBytes = inputs.targetPreimageAuditBytes
  const restoredAuditBytes = inputs.targetRestoredAuditBytes
  if (preimageAuditBytes === undefined || restoredAuditBytes === undefined) {
    throw authenticationFailed()
  }
  const terminal = context.terminal
  if (terminal === null) throw authenticationFailed()
  let runtimeVerificationKey: Uint8Array | undefined
  let publicationVerificationKey: Uint8Array | undefined
  try {
    runtimeVerificationKey = copyKey(runtimeKey)
    publicationVerificationKey = copyKey(publicationKey)
    return Object.freeze({
      preimageAuditBytes,
      restoredAuditBytes,
      context: createTargetAuditContext(context),
      applyStartedAt: terminal.applyStartedAt,
      runtimeVerificationKey,
      publicationVerificationKey,
    })
  } catch (error: unknown) {
    zeroize(runtimeVerificationKey)
    zeroize(publicationVerificationKey)
    throw error
  }
}

/** Reads every restricted file before the first AWS session is created. */
async function readAllInputs(
  configuration: WorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  dependencies: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
): Promise<ReconciliationCliOwnedInputs> {
  const buffers: Uint8Array[] = []
  /** Reads, validates, and retains one restricted input buffer. */
  const read = async (path: string, maximumBytes: number): Promise<Uint8Array> => {
    let bytes: Uint8Array
    try {
      bytes = await dependencies.readRestrictedFile(path, maximumBytes)
    } catch {
      throw inputUnreadable()
    }
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      nodeUtilTypes.isSharedArrayBuffer(bytes.buffer) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes
    ) throw inputInvalid()
    buffers.push(bytes)
    return bytes
  }
  try {
    const materialFiles = configuration.materialFiles
    const material: WorkspaceSearchMigrationRehearsalAuthenticatedMaterialBytes =
      Object.freeze({
        manifestBytes: await read(
          configuration.manifestFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
        ),
        previousReceiptBytes: await read(
          configuration.previousReceiptFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
        ),
        materialBytes: await read(
          materialFiles.materialFile,
          maximumPersistedMaterialBytes,
        ),
        ...(materialFiles.boundaryMaterialFile === undefined
          ? {}
          : {
            boundaryMaterialBytes: await read(
              materialFiles.boundaryMaterialFile,
              maximumPersistedMaterialBytes,
            ),
          }),
        ...(materialFiles.faultPlanFile === undefined
          ? {}
          : {
            faultPlanBytes: await read(
              materialFiles.faultPlanFile,
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
            ),
          }),
        ...(materialFiles.boundaryRateSegmentFile === undefined
          ? {}
          : {
            boundaryRateSegmentBytes: await read(
              materialFiles.boundaryRateSegmentFile,
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
            ),
          }),
        ...(materialFiles.finalRateSegmentFile === undefined
          ? {}
          : {
            finalRateSegmentBytes: await read(
              materialFiles.finalRateSegmentFile,
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
            ),
          }),
        lifecycleBytes: await read(
          configuration.lifecycleFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES,
        ),
        parentAuthenticationBytes: await read(
          configuration.parentAuthenticationFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES,
        ),
        controlArgumentsBytes: await read(
          configuration.controlArgumentsFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CONTROL_ARGUMENTS_MAX_BYTES,
        ),
      })
    const permitBytes = await read(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_PERMIT_MAX_BYTES,
    )
    const permit = parseCanonicalJson(permitBytes)
    const masterKey = await read(
      configuration.authenticationKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
    )
    requireExactKey(masterKey)
    const ratePolicyBytes = await read(
      configuration.measure.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
    )
    let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
    try {
      ratePolicy =
        parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
          ratePolicyBytes,
        )
    } catch {
      throw inputInvalid()
    }
    if (configuration.mode === 'target-restored') {
      return Object.freeze({ buffers, material, permit, ratePolicy, masterKey })
    }
    if (configuration.mode === 'target-preimage') {
      const integrityKey = await read(
        configuration.integrityKeyFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
      )
      requireExactKey(integrityKey)
      return Object.freeze({
        buffers,
        material,
        permit,
        ratePolicy,
        masterKey,
        integrityKey,
        integrityBeforeResultBytes: await read(
          configuration.integrityBeforeResultFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_INTEGRITY_MAX_BYTES,
        ),
      })
    }
    const integrityKey = await read(
      configuration.integrityFiles.integrityKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
    )
    requireExactKey(integrityKey)
    if (configuration.integrityFiles.kind === 'verified-result') {
      return Object.freeze({
        buffers,
        material,
        permit,
        ratePolicy,
        masterKey,
        integrityKey,
        integrityResultBytes: await read(
          configuration.integrityFiles.resultFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_INTEGRITY_MAX_BYTES,
        ),
      })
    }
    return Object.freeze({
      buffers,
      material,
      permit,
      ratePolicy,
      masterKey,
      integrityKey,
      integrityBeforeResultBytes: await read(
        configuration.integrityFiles.beforeResultFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_INTEGRITY_MAX_BYTES,
      ),
      integrityAfterResultBytes: await read(
        configuration.integrityFiles.afterResultFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_INTEGRITY_MAX_BYTES,
      ),
      targetPreimageAuditBytes: await read(
        configuration.integrityFiles.targetPreimageAuditFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
      ),
      targetRestoredAuditBytes: await read(
        configuration.integrityFiles.targetRestoredAuditFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
      ),
    })
  } catch (error: unknown) {
    for (const buffer of buffers) zeroize(buffer)
    throw error
  }
}

/** Requires authenticated context to match permit, resources, and mode. */
function requireContextBindings(
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  configuration: WorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  inputs: ReconciliationCliOwnedInputs,
  requestedResourcesBinding: string,
): void {
  const expectedPermitDigest = createMigrationDigest(inputs.permit)
  if (
    context.permitDigest !== expectedPermitDigest ||
    context.requestedResourcesBinding !== requestedResourcesBinding ||
    context.configurationBindingDigest.length !== 64 ||
    context.policyVersion !== inputs.ratePolicy.policyVersion ||
    context.runId.length === 0 ||
    context.runLocatorDigest.length !== 64 ||
    context.manifestDigest.length !== 64 ||
    context.planningReceiptDigest.length !== 64 ||
    context.executionBoundaryDigest.length !== 64 ||
    context.sealedPlanningAuthorityDigest.length !== 64 ||
    context.planDigest.length !== 64 ||
    context.writerFenceDigest.length !== 64
  ) throw authenticationFailed()
  if (
    configuration.mode === 'target-preimage' &&
    (
      context.command !== 'close-replan' ||
      context.terminal !== null ||
      !isRollbackScenario(context.scenario)
    )
  ) throw authenticationFailed()
  if (
    configuration.mode === 'target-restored' &&
    (
      context.terminal === null ||
      !isRollbackScenario(context.scenario) ||
      context.command !== scenarioRollbackCommand(context.scenario)
    )
  ) throw authenticationFailed()
  if (configuration.mode === 'reconcile') {
    const expectedCommand = isRollbackScenario(context.scenario)
      ? scenarioRollbackCommand(context.scenario)
      : 'verify'
    if (
      context.command !== expectedCommand ||
      (configuration.integrityFiles.kind === 'rollback-comparison') !==
        isRollbackScenario(context.scenario)
    ) throw authenticationFailed()
  }
}

/**
 * Requires the remote idempotent claim read to reproduce authenticated state.
 *
 * @param head - Strongly read durable head returned by session construction.
 * @param context - Parent-authenticated collection facts.
 * @param stageClaim - Brand-private verified reservation and selection.
 */
function requireClaimedStageHeadBindings(
  head: WorkspaceSearchMigrationRehearsalStageHead | undefined,
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  stageClaim:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim,
): void {
  try {
    if (
      head === undefined ||
      nodeUtilTypes.isProxy(head) ||
      nodeUtilTypes.isProxy(stageClaim) ||
      nodeUtilTypes.isProxy(stageClaim.reservation) ||
      nodeUtilTypes.isProxy(stageClaim.selection)
    ) throw authenticationFailed()
    const reservation = stageClaim.reservation
    const selection = stageClaim.selection
    const entry = selection.entry
    if (
      context.manifestDigest !== selection.manifestDigest ||
      context.manifestDigest !== reservation.manifestDigest ||
      context.permitDigest !== selection.manifest.permitDigest ||
      context.permitDigest !== reservation.permitDigest ||
      context.requestedResourcesBinding !==
        selection.manifest.requestedResourcesBinding ||
      context.requestedResourcesBinding !==
        reservation.requestedResourcesBinding ||
      context.configurationBindingDigest !==
        selection.manifest.configurationBindingDigest ||
      context.configurationBindingDigest !==
        reservation.configurationBindingDigest ||
      context.policyVersion !== selection.manifest.policyVersion ||
      context.policyVersion !== reservation.policyVersion ||
      context.scenario !== entry.scenario ||
      context.scenario !== reservation.scenario ||
      context.command !== entry.command ||
      context.command !== reservation.command ||
      reservation.manifestEntryDigest !== createMigrationDigest(entry) ||
      reservation.stageOrdinal !== entry.ordinal ||
      reservation.expiresAt !== context.integrityWindow.completedAt ||
      head.manifestDigest !== context.manifestDigest ||
      head.completedStageOrdinal !== entry.ordinal - 1 ||
      head.headReceiptDigest !== selection.previousStageReceiptDigest ||
      head.activeReservationDigest !== createMigrationDigest(reservation) ||
      head.activeStageOrdinal !== entry.ordinal ||
      head.activeExpiresAt !== reservation.expiresAt
    ) throw authenticationFailed()
  } catch {
    throw authenticationFailed()
  }
}

/** Returns whether a scenario terminates by rollback. */
function isRollbackScenario(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): scenario is 'complete-apply-rollback' | 'partial-apply-rollback' {
  return scenario === 'complete-apply-rollback' ||
    scenario === 'partial-apply-rollback'
}

/** Returns the exact rollback command for one rollback scenario. */
function scenarioRollbackCommand(
  scenario: 'complete-apply-rollback' | 'partial-apply-rollback',
): 'rollback-complete' | 'rollback-partial' {
  return scenario === 'partial-apply-rollback'
    ? 'rollback-partial'
    : 'rollback-complete'
}

/** Requires purpose-separated key material for independent evidence domains. */
function requireDedicatedKeys(
  inputs: ReconciliationCliOwnedInputs,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): void {
  const keys = [
    inputs.masterKey,
    runtimeKey,
    publicationKey,
    ...(inputs.integrityKey === undefined ? [] : [inputs.integrityKey]),
  ]
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const leftKey = keys[left]
      const rightKey = keys[right]
      if (
        leftKey !== undefined &&
        rightKey !== undefined &&
        timingSafeEqual(leftKey, rightKey)
      ) throw authenticationFailed()
    }
  }
}

/**
 * Rejects any existing output path before AWS composition.
 *
 * @param path - Exact candidate output path.
 * @returns Nothing when the path does not exist.
 */
export async function ensureWorkspaceSearchMigrationRehearsalReconciliationOutputAbsent(
  path: string,
): Promise<void> {
  const resolved = readPath(path)
  try {
    await lstat(resolved)
  } catch (error: unknown) {
    if (isFileSystemErrorCode(error, 'ENOENT')) return
    throw outputWriteFailed()
  }
  throw outputExists()
}

/** Closes session before runtime and reports any cleanup failure. */
async function closeCapabilities(
  session: WorkspaceSearchMigrationRehearsalReconciliationCliSession |
    undefined,
  runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined,
): Promise<boolean> {
  let failed = false
  if (session !== undefined) {
    try {
      await session.close()
    } catch {
      failed = true
    }
  }
  if (runtime !== undefined) {
    try {
      await runtime.close()
    } catch {
      failed = true
    }
  }
  return failed
}

/** Captures the complete dependency object before the first await. */
function captureDependencies(
  value: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
): WorkspaceSearchMigrationRehearsalReconciliationCliDependencies {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) throw invalidUsage()
  const dependencies = {
    readRestrictedFile: value.readRestrictedFile,
    authenticateCollectionContext: value.authenticateCollectionContext,
    verifyPermit: value.verifyPermit,
    authenticateIntegrityPreimage: value.authenticateIntegrityPreimage,
    createRateRuntime: value.createRateRuntime,
    createSession: value.createSession,
    verifyRateSegmentSuccessor: value.verifyRateSegmentSuccessor,
    collectTargetAudit: value.collectTargetAudit,
    finalizeTargetAudit: value.finalizeTargetAudit,
    finalizeReconciliation: value.finalizeReconciliation,
    ensureOutputAbsent: value.ensureOutputAbsent,
    writeOutputExclusive: value.writeOutputExclusive,
    clock: value.clock,
    monotonicClock: value.monotonicClock,
    writeStdoutLine: value.writeStdoutLine,
    writeStderrLine: value.writeStderrLine,
  }
  for (const dependency of Object.values(dependencies)) {
    if (typeof dependency !== 'function') throw invalidUsage()
  }
  return Object.freeze(dependencies)
}

/** Captures output functions even when another dependency is malformed. */
function captureOutputDependencies(
  value: WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
): Pick<
  WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  'writeStderrLine' | 'writeStdoutLine'
> {
  try {
    if (
      typeof value.writeStdoutLine === 'function' &&
      typeof value.writeStderrLine === 'function'
    ) {
      return Object.freeze({
        writeStdoutLine: value.writeStdoutLine,
        writeStderrLine: value.writeStderrLine,
      })
    }
  } catch {
    // Fall through to the stable default output boundary.
  }
  return Object.freeze({
    writeStdoutLine: defaultReconciliationCliDependencies.writeStdoutLine,
    writeStderrLine: defaultReconciliationCliDependencies.writeStderrLine,
  })
}

/** Parses exact canonical JSON without retaining raw text. */
function parseCanonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (serializeCanonicalJson(value) !== text) throw inputInvalid()
    return value
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalReconciliationCliError) {
      throw error
    }
    throw inputInvalid()
  }
}

/** Snapshots untrusted programmatic arguments without invoking array proxies. */
function snapshotArguments(arguments_: readonly string[]): readonly string[] {
  if (
    !Array.isArray(arguments_) ||
    nodeUtilTypes.isProxy(arguments_) ||
    arguments_.length === 0 ||
    arguments_.length > 160
  ) throw invalidUsage()
  const values: string[] = []
  for (const value of arguments_) {
    if (typeof value !== 'string' || value.length === 0) throw invalidUsage()
    values.push(value)
  }
  return Object.freeze(values)
}

/** Reads one exact supported collection mode. */
function readMode(
  value: string | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationCliMode {
  if (
    value !== 'reconcile' &&
    value !== 'target-preimage' &&
    value !== 'target-restored'
  ) throw invalidUsage()
  return value
}

/** Reads one safe non-empty local path. */
function readPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumPathLength ||
    value !== value.trim() ||
    value.includes('\0')
  ) throw invalidUsage()
  return value
}

/** Reads one bounded positive base-ten integer. */
function readPositiveInteger(
  value: string | undefined,
  maximum: number,
): number {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value)
  ) throw invalidUsage()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw invalidUsage()
  return parsed
}

/** Requires one exact ordinary 32-byte key buffer. */
function requireExactKey(value: Uint8Array): void {
  if (
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES
  ) throw inputInvalid()
}

/** Copies one exact key for an ownership-transferring downstream boundary. */
function copyKey(value: Uint8Array): Uint8Array {
  requireExactKey(value)
  return value.slice()
}

/** Copies one optional required input key or fails closed. */
function copyRequiredInputKey(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) throw authenticationFailed()
  return copyKey(value)
}

/** Reads one trusted finite Date observation. */
function readClock(clock: () => Date): Date {
  try {
    const value = Reflect.apply(clock, undefined, [])
    const timestamp = Date.prototype.getTime.call(value)
    if (!Number.isFinite(timestamp)) throw authenticationFailed()
    return new Date(timestamp)
  } catch {
    throw authenticationFailed()
  }
}

/**
 * Creates the clock that captures actual #163 authentication completion.
 *
 * The identity session authenticates #163 material before beginning strong
 * reconciliation reads, so its first clock sample is taken only after that
 * authentication completes. The exact first sample is later required back
 * byte-for-byte, preventing an adapter from substituting a deadline or a
 * different observation time.
 *
 * @param context - Parent-authenticated lifecycle bounds for this collection.
 * @param deadline - Shared cutoff and non-regressing wall-clock state.
 * @param clock - Trusted wall clock wrapped for every in-session sample.
 * @returns Cutoff-bound clock and one-shot completion observation reader.
 */
function createReconciliationIntegrityCompletionClock(
  context: WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  deadline: ReconciliationCliCollectionDeadline,
  clock: () => Date,
): ReconciliationCliIntegrityCompletionClock {
  const startedAtMilliseconds = Date.parse(context.integrityWindow.startedAt)
  const expiresAtMilliseconds = Date.parse(context.integrityWindow.completedAt)
  if (
    !Number.isSafeInteger(startedAtMilliseconds) ||
    new Date(startedAtMilliseconds).toISOString() !==
      context.integrityWindow.startedAt ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    new Date(expiresAtMilliseconds).toISOString() !==
      context.integrityWindow.completedAt ||
    startedAtMilliseconds >= expiresAtMilliseconds
  ) throw authenticationFailed()
  if (
    expiresAtMilliseconds -
      deadline.reservationHeadroomMilliseconds !==
        deadline.reservationCutoffAtMilliseconds
  ) throw operationFailed()
  let completedAt: string | undefined
  return Object.freeze({
    clock: (): Date => {
      const observed = readCollectionWallClockBeforeCutoff(deadline, clock)
      if (completedAt === undefined) completedAt = observed.toISOString()
      return observed
    },
    readCompletedAt: (): string => {
      if (completedAt === undefined) throw operationFailed()
      if (Date.parse(completedAt) < startedAtMilliseconds) {
        throw operationFailed()
      }
      return completedAt
    },
  })
}

/**
 * Starts one total collection deadline capped by the active reservation.
 *
 * @param maximumDurationMilliseconds - Operator-reviewed collection ceiling.
 * @param reservationExpiresAt - Authenticated exclusive reservation expiry.
 * @param reservationHeadroomMilliseconds - Runway reserved after collection.
 * @param clock - Trusted wall clock used only to calculate reservation runway.
 * @param monotonicClock - Trusted monotonic clock owning the total deadline.
 * @returns Mutable monotonic deadline state shared by every later boundary.
 */
function createCollectionDeadline(
  maximumDurationMilliseconds: number,
  reservationExpiresAt: string,
  reservationHeadroomMilliseconds: number,
  clock: () => Date,
  monotonicClock: () => number,
): ReconciliationCliCollectionDeadline {
  const startedAtMilliseconds = readMonotonicClock(monotonicClock)
  const observedAtMilliseconds = readClock(clock).getTime()
  const reservationExpiresAtMilliseconds = Date.parse(reservationExpiresAt)
  const reservationCutoffAtMilliseconds =
    reservationExpiresAtMilliseconds -
      reservationHeadroomMilliseconds
  const reservationRemainingMilliseconds =
    reservationCutoffAtMilliseconds - observedAtMilliseconds
  const admittedDurationMilliseconds = Math.min(
    maximumDurationMilliseconds,
    reservationRemainingMilliseconds,
  )
  const deadlineMilliseconds =
    startedAtMilliseconds + admittedDurationMilliseconds
  if (
    !Number.isSafeInteger(maximumDurationMilliseconds) ||
    maximumDurationMilliseconds < 1 ||
    maximumDurationMilliseconds >
      Math.max(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS,
      ) ||
    !Number.isSafeInteger(reservationExpiresAtMilliseconds) ||
    new Date(reservationExpiresAtMilliseconds).toISOString() !==
      reservationExpiresAt ||
    !Number.isSafeInteger(reservationHeadroomMilliseconds) ||
    reservationHeadroomMilliseconds < 1 ||
    !Number.isSafeInteger(reservationCutoffAtMilliseconds) ||
    !Number.isSafeInteger(admittedDurationMilliseconds) ||
    admittedDurationMilliseconds < 1 ||
    !Number.isSafeInteger(deadlineMilliseconds)
  ) throw operationFailed()
  return {
    deadlineMilliseconds,
    reservationCutoffAtMilliseconds,
    reservationHeadroomMilliseconds,
    lastObservedMilliseconds: startedAtMilliseconds,
    lastObservedWallClockMilliseconds: observedAtMilliseconds,
  }
}

/**
 * Samples one non-regressing wall clock strictly before the reserved cutoff.
 *
 * @param deadline - Shared deadline retaining the exclusive wall-clock cutoff.
 * @param clock - Trusted wall clock sampled exactly once at this boundary.
 * @returns Detached trusted wall-clock observation inside the collection time.
 */
function readCollectionWallClockBeforeCutoff(
  deadline: ReconciliationCliCollectionDeadline,
  clock: () => Date,
): Date {
  const observedAt = readClock(clock)
  const observedAtMilliseconds = observedAt.getTime()
  if (
    observedAtMilliseconds < deadline.lastObservedWallClockMilliseconds ||
    observedAtMilliseconds >= deadline.reservationCutoffAtMilliseconds
  ) throw operationFailed()
  deadline.lastObservedWallClockMilliseconds = observedAtMilliseconds
  return observedAt
}

/**
 * Returns the positive integer collection duration left at one boundary.
 *
 * @param deadline - Shared total collection deadline state.
 * @param monotonicClock - Trusted monotonic clock to sample exactly once.
 * @returns Positive whole milliseconds remaining before the deadline.
 */
function readCollectionRemainingDuration(
  deadline: ReconciliationCliCollectionDeadline,
  monotonicClock: () => number,
): number {
  const observedAtMilliseconds = readMonotonicClock(monotonicClock)
  if (observedAtMilliseconds < deadline.lastObservedMilliseconds) {
    throw operationFailed()
  }
  deadline.lastObservedMilliseconds = observedAtMilliseconds
  const remainingMilliseconds = Math.floor(
    deadline.deadlineMilliseconds - observedAtMilliseconds,
  )
  if (remainingMilliseconds < 1) throw operationFailed()
  return remainingMilliseconds
}

/**
 * Fails when collection or durable publication crosses the total deadline.
 *
 * @param deadline - Shared total collection deadline state.
 * @param monotonicClock - Trusted monotonic clock to sample exactly once.
 */
function requireCollectionDeadlineActive(
  deadline: ReconciliationCliCollectionDeadline,
  monotonicClock: () => number,
): void {
  readCollectionRemainingDuration(deadline, monotonicClock)
}

/** Reads one trusted non-negative finite monotonic clock sample. */
function readMonotonicClock(monotonicClock: () => number): number {
  try {
    const value = Reflect.apply(monotonicClock, undefined, [])
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) throw operationFailed()
    return value
  } catch {
    throw operationFailed()
  }
}

/** Requires a non-aborted invocation before starting a new boundary. */
function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationRehearsalReconciliationCliError(
      'INTERRUPTED',
      130,
    )
  }
}

/** Requires either the simple or exact response-loss material file protocol. */
function requireValidMaterialFileShape(value: {
  boundaryMaterialFile?: string
  faultPlanFile?: string
  boundaryRateSegmentFile?: string
  finalRateSegmentFile?: string
}): void {
  const count = Object.keys(value).length
  if (count === 0) return
  if (
    count === 2 &&
    value.faultPlanFile !== undefined &&
    value.boundaryRateSegmentFile !== undefined
  ) return
  if (
    count === 4 &&
    value.boundaryMaterialFile !== undefined &&
    value.faultPlanFile !== undefined &&
    value.boundaryRateSegmentFile !== undefined &&
    value.finalRateSegmentFile !== undefined
  ) return
  throw invalidUsage()
}

/** Rejects path aliasing between every input, rate segment, and output. */
function requireUniquePaths(
  configuration: WorkspaceSearchMigrationRehearsalReconciliationCliArguments,
): void {
  const paths = [
    configuration.manifestFile,
    configuration.previousReceiptFile,
    configuration.materialFiles.materialFile,
    configuration.lifecycleFile,
    configuration.parentAuthenticationFile,
    configuration.controlArgumentsFile,
    configuration.permitFile,
    configuration.authenticationKeyFile,
    configuration.previousRateSegmentFile,
    configuration.rateSegmentFile,
    configuration.outputFile,
    configuration.measure.ratePolicyFile,
    ...(configuration.materialFiles.boundaryMaterialFile === undefined
      ? []
      : [configuration.materialFiles.boundaryMaterialFile]),
    ...(configuration.materialFiles.faultPlanFile === undefined
      ? []
      : [configuration.materialFiles.faultPlanFile]),
    ...(configuration.materialFiles.boundaryRateSegmentFile === undefined
      ? []
      : [configuration.materialFiles.boundaryRateSegmentFile]),
    ...(configuration.materialFiles.finalRateSegmentFile === undefined
      ? []
      : [configuration.materialFiles.finalRateSegmentFile]),
    ...(configuration.mode === 'target-preimage'
      ? [
          configuration.integrityBeforeResultFile,
          configuration.integrityKeyFile,
        ]
      : []),
    ...(configuration.mode !== 'reconcile'
      ? []
      : [
        configuration.integrityFiles.integrityKeyFile,
        ...(configuration.integrityFiles.kind === 'verified-result'
          ? [configuration.integrityFiles.resultFile]
          : [
            configuration.integrityFiles.beforeResultFile,
            configuration.integrityFiles.afterResultFile,
            configuration.integrityFiles.targetPreimageAuditFile,
            configuration.integrityFiles.targetRestoredAuditFile,
          ]),
      ]),
  ]
  if (new Set(paths).size !== paths.length) throw invalidUsage()
}

/** Best-effort overwrites one owned raw buffer. */
function zeroize(value: Uint8Array | undefined): void {
  zeroizeWorkspaceSearchMigrationRehearsalKey(value)
}

/** Overwrites every raw input buffer exactly once on terminal cleanup. */
function zeroizeOwnedInputs(
  inputs: ReconciliationCliOwnedInputs | undefined,
): void {
  if (inputs === undefined) return
  for (const buffer of inputs.buffers) zeroize(buffer)
}

/** Maps one internal error to a raw-free stable public classification. */
function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  if (
    error instanceof WorkspaceSearchMigrationRehearsalReconciliationCliError
  ) return error
  if (signal?.aborted === true) {
    return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
      'INTERRUPTED',
      130,
    )
  }
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'OPERATION_FAILED',
    1,
  )
}

/** Emits one canonical failure line without raw arguments or errors. */
function writeFailure(
  writeLine: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalReconciliationCliFailureCode,
): void {
  writeLine(serializeCanonicalJson({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
    status: 'error',
    code,
  }))
}

/** Tests one filesystem error code without reflecting its message or path. */
function isFileSystemErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  try {
    return Reflect.get(error, 'code') === code
  } catch {
    return false
  }
}

/** Creates a stable invalid-usage failure. */
function invalidUsage(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'INVALID_USAGE',
    2,
  )
}

/** Creates a stable unreadable-input failure. */
function inputUnreadable(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'INPUT_FILE_UNREADABLE',
    1,
  )
}

/** Creates a stable malformed-input failure. */
function inputInvalid(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'INPUT_FILE_INVALID',
    1,
  )
}

/** Creates a stable authentication failure. */
function authenticationFailed(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'AUTHENTICATION_FAILED',
    1,
  )
}

/** Creates a stable operational failure without reflecting timing details. */
function operationFailed(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates a stable existing-output failure. */
function outputExists(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates a stable output-write failure. */
function outputWriteFailed(): WorkspaceSearchMigrationRehearsalReconciliationCliError {
  return new WorkspaceSearchMigrationRehearsalReconciliationCliError(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

/** Executes the standalone script and assigns its stable process status. */
async function runDirectReconciliationCli(): Promise<void> {
  process.exitCode = await runWorkspaceSearchMigrationRehearsalReconciliationCli(
    process.argv.slice(2),
  )
}

if (import.meta.main) {
  await runDirectReconciliationCli()
}
