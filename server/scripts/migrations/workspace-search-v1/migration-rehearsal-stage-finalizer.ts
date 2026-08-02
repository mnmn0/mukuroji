import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationControlExecutionTerminalEvidence,
} from './migration-control-coordinator'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'
import type {
  WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence,
  WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence,
} from './migration-rehearsal-process-runner'
import {
  authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes,
  snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
} from './migration-rehearsal-reconciliation-audit'
import {
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  createWorkspaceSearchMigrationRehearsalStageParentAuthorization,
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorization,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-stage-parent-authorization'

export {
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
}

export type {
  WorkspaceSearchMigrationRehearsalStageParentAuthorization,
  WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding,
}
import {
  verifyWorkspaceSearchMigrationRehearsalStageChildMaterial,
  type WorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalLocatorDigest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest,
  selectWorkspaceSearchMigrationRehearsalStage,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageLeaseObservation,
  type WorkspaceSearchMigrationRehearsalStageProcessLifecycle,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  type WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'
import type {
  WorkspaceSearchMigrationRehearsalExpectedAuthority,
} from './migration-rehearsal-reconciliation-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Happy-path manifest entry admitted by the generic-success finalizer. */
type WorkspaceSearchMigrationRehearsalHappyPathStageEntry =
  WorkspaceSearchMigrationRehearsalStageManifestEntry & {
    /** Only the canonical verified happy path is admitted. */
    readonly scenario: 'happy-path-verified'
    /** Exact generic-success command in the happy-path chain. */
    readonly command: 'apply' | 'close-replan' | 'release' | 'verify'
    /** Generic-success material can prove only ordinary completion. */
    readonly expectedOutcome: 'completed'
    /** The happy path deliberately carries no injected fault plan. */
    readonly faultPlanDigest: null
    /** The complete happy path stays in its first process attempt. */
    readonly attemptOrdinal: 1
  }

/** Complete-rollback manifest entry admitted by the generic finalizer. */
type WorkspaceSearchMigrationRehearsalCompleteRollbackStageEntry =
  WorkspaceSearchMigrationRehearsalStageManifestEntry & {
    /** Only the canonical complete-apply rollback path is admitted. */
    readonly scenario: 'complete-apply-rollback'
    /** Exact generic-success command in the complete-rollback chain. */
    readonly command:
      | 'apply'
      | 'close-replan'
      | 'release'
      | 'rollback-complete'
    /** Generic-success material can prove only ordinary completion. */
    readonly expectedOutcome: 'completed'
    /** Complete rollback deliberately carries no injected fault plan. */
    readonly faultPlanDigest: null
    /** The complete rollback path stays in its first process attempt. */
    readonly attemptOrdinal: 1
  }

/** Authenticated selection accepted by the production generic finalizer. */
export type WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage =
  Omit<WorkspaceSearchMigrationRehearsalSelectedStage, 'entry'> & {
    /** Exact supported completed entry reauthenticated by the finalizer. */
    readonly entry:
      | WorkspaceSearchMigrationRehearsalCompleteRollbackStageEntry
      | WorkspaceSearchMigrationRehearsalHappyPathStageEntry
  }

/** Any authenticated entry in the fixed complete 36-stage manifest. */
export type WorkspaceSearchMigrationRehearsalSupportedSelectedStage =
  WorkspaceSearchMigrationRehearsalSelectedStage

/** Raw authenticated pre-apply target audit consumed by an apply stage. */
export type WorkspaceSearchMigrationRehearsalStagePreimageAuditInput = {
  /** Exact canonical purpose-bound target-audit artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Caller-owned dedicated 32-byte target-audit key to consume. */
  readonly verificationKey: Uint8Array
}

/** No-additional-material proof for a completed planning stage. */
export type WorkspaceSearchMigrationRehearsalPlanningFinalizationProof = {
  /** Selects strict planning evidence from the child coordinator result. */
  readonly kind: 'planning'
}

/** Additional raw audit material admitted for one completed apply stage. */
export type WorkspaceSearchMigrationRehearsalApplyFinalizationProof = {
  /** Selects strict complete-apply or apply-fault evidence. */
  readonly kind: 'apply'
  /** Historical planning receipt required when a fault is the predecessor. */
  readonly planningReceipt: unknown | null
  /** Required by rollback paths and forbidden by ordinary apply paths. */
  readonly targetPreimageAudit:
    WorkspaceSearchMigrationRehearsalStagePreimageAuditInput | null
}

/** Raw external evidence required to finalize one terminal stage. */
export type WorkspaceSearchMigrationRehearsalTerminalFinalizationProof = {
  /** Selects strict verified or complete-rollback terminal evidence. */
  readonly kind: 'terminal'
  /** Authenticated close-replan receipt anchoring the integrity window. */
  readonly planningReceipt: unknown
  /** Actual dual-key-authenticated terminal reconciliation artifact bytes. */
  readonly reconciliationArtifactBytes: Uint8Array
}

/** No-additional-material proof for terminal-bound writer-fence release. */
export type WorkspaceSearchMigrationRehearsalReleaseFinalizationProof = {
  /** Selects strict release evidence from the child coordinator result. */
  readonly kind: 'release'
}

/** Command-specific external material accepted by the offline finalizer. */
export type WorkspaceSearchMigrationRehearsalStageFinalizationProof =
  | WorkspaceSearchMigrationRehearsalApplyFinalizationProof
  | WorkspaceSearchMigrationRehearsalPlanningFinalizationProof
  | WorkspaceSearchMigrationRehearsalReleaseFinalizationProof
  | WorkspaceSearchMigrationRehearsalTerminalFinalizationProof

/** Stable discriminator for one parent-authenticated lifecycle binding. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-parent-authentication'

/** First parent-authenticated persisted lifecycle binding contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_VERSION =
  1

/** Claims binding parent-persisted material and lifecycle to one selection. */
export type WorkspaceSearchMigrationRehearsalStageParentAuthenticationClaims = {
  /** Fixed parent-authentication discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_KIND
  /** Parent-authentication schema version. */
  readonly authenticationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_VERSION
  /** Digest of the authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the predecessor receipt, or null at global stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Globally contiguous selected stage ordinal. */
  readonly stageOrdinal: number
  /** Digest of the exact normalized persisted child-material wrapper. */
  readonly materialEvidenceDigest: string
  /** Digest of the persisted boundary wrapper used by completion, else null. */
  readonly boundaryMaterialEvidenceDigest: string | null
  /** Digest of the reviewed fault plan for fault material, else null. */
  readonly faultPlanDigest: string | null
  /** SHA-256 of exact authenticated boundary rate bytes, else null. */
  readonly boundaryRateSegmentBytesDigest: string | null
  /** SHA-256 of exact authenticated final rate bytes, else null. */
  readonly finalRateSegmentBytesDigest: string | null
  /** Digest of the exact normalized persisted parent-lifecycle wrapper. */
  readonly lifecycleEvidenceDigest: string
  /** Genuine durable runtime-key cleanup bound to this exact stage. */
  readonly runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding
}

/** Complete parent-origin HMAC over persisted stage lifecycle evidence. */
export type WorkspaceSearchMigrationRehearsalStageParentAuthentication =
  WorkspaceSearchMigrationRehearsalStageParentAuthenticationClaims & {
    /** Domain-separated HMAC-SHA-256 over the exact claims. */
    readonly authenticationMac: string
  }

/** Input for authenticating persisted parent evidence before offline use. */
/** Success-material fields accepted by parent authentication and finalization. */
export type WorkspaceSearchMigrationRehearsalSuccessMaterialAuthenticationInput = {
  /** Selects one ordinary or takeover-completed child material wrapper. */
  readonly materialKind: 'success'
  /** Parent-persisted child-material evidence document. */
  readonly persistedMaterialEvidence: unknown
}

/** Fault-boundary fields accepted by parent authentication and finalization. */
export type WorkspaceSearchMigrationRehearsalFaultBoundaryMaterialAuthenticationInput = {
  /** Selects one stopped SIGKILL fault-boundary material wrapper. */
  readonly materialKind: 'fault-boundary'
  /** Parent-persisted authenticated boundary-material evidence wrapper. */
  readonly persistedMaterialEvidence: unknown
  /** Exact independently reviewed fault plan selected by the manifest. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact durable authenticated rate prefix captured at the boundary. */
  readonly boundaryRateSegmentBytes: Uint8Array
}

/** Response-loss fields accepted by parent authentication and finalization. */
export type WorkspaceSearchMigrationRehearsalFaultCompletionMaterialAuthenticationInput = {
  /** Selects one fully reconciled two-phase response-loss material protocol. */
  readonly materialKind: 'fault-completion'
  /** Parent-persisted authenticated completion-material evidence wrapper. */
  readonly persistedMaterialEvidence: unknown
  /** Parent-persisted authenticated first boundary-material wrapper. */
  readonly persistedBoundaryMaterialEvidence: unknown
  /** Exact independently reviewed response-loss fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact durable authenticated rate prefix captured at the boundary. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Exact durable authenticated final rate segment after reconciliation. */
  readonly finalRateSegmentBytes: Uint8Array
}

/** Strict material-verification union shared by parent and finalizer APIs. */
export type WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput =
  | WorkspaceSearchMigrationRehearsalFaultBoundaryMaterialAuthenticationInput
  | WorkspaceSearchMigrationRehearsalFaultCompletionMaterialAuthenticationInput
  | WorkspaceSearchMigrationRehearsalSuccessMaterialAuthenticationInput

/** Common input for authenticating parent-persisted stage evidence. */
type CreateWorkspaceSearchMigrationRehearsalStageParentAuthenticationInputBase = {
  /** Authenticated selected stage independently made before spawn. */
  readonly selection:
    WorkspaceSearchMigrationRehearsalSupportedSelectedStage
  /** Parent-persisted successful lifecycle evidence document. */
  readonly persistedLifecycleEvidence: unknown
  /** Caller-owned runtime 32-byte material verification key to consume. */
  readonly runtimeAuthenticationKey: Uint8Array
  /** Caller-owned parent-only 32-byte publication key to consume. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Genuine same-process capability proving durable runtime-key cleanup. */
  readonly runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
}

/** Input for authenticating any supported persisted stage material. */
export type CreateWorkspaceSearchMigrationRehearsalStageParentAuthenticationInput =
  CreateWorkspaceSearchMigrationRehearsalStageParentAuthenticationInputBase &
    WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput

/** Common parent-authentication input admitted by publication authorization. */
type AuthenticateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInputBase =
  Omit<
    CreateWorkspaceSearchMigrationRehearsalStageParentAuthenticationInputBase,
    'runtimeKeyCleanupAuthorization'
  > & {
    /** Persisted parent-origin authentication record to reverify. */
    readonly parentAuthentication: unknown
  }

/** Input for proving parent-only authorization over one persisted stage. */
export type AuthenticateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInput =
  AuthenticateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInputBase &
    WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput

/** Evidence-collection phase admitted by the parent-authenticated accessor. */
export type WorkspaceSearchMigrationRehearsalCollectionMode =
  | 'reconcile'
  | 'target-preimage'
  | 'target-restored'

/** Exact parent-persisted byte bundle admitted to collection authentication. */
export type WorkspaceSearchMigrationRehearsalCollectionMaterialBytes = {
  /** Exact canonical reviewed manifest bytes. */
  readonly manifestBytes: Uint8Array
  /** Exact canonical immediate predecessor receipt bytes. */
  readonly previousReceiptBytes: Uint8Array
  /** Exact canonical current parent-persisted material bytes. */
  readonly materialBytes: Uint8Array
  /** Optional canonical first response-loss boundary material bytes. */
  readonly boundaryMaterialBytes?: Uint8Array
  /** Optional canonical independently reviewed fault-plan bytes. */
  readonly faultPlanBytes?: Uint8Array
  /** Optional exact durable boundary rate-segment bytes. */
  readonly boundaryRateSegmentBytes?: Uint8Array
  /** Optional exact durable final response-loss rate-segment bytes. */
  readonly finalRateSegmentBytes?: Uint8Array
  /** Exact canonical parent-persisted lifecycle bytes. */
  readonly lifecycleBytes: Uint8Array
  /** Exact canonical parent-origin authentication bytes. */
  readonly parentAuthenticationBytes: Uint8Array
  /** Exact canonical reviewed control-argument vector bytes. */
  readonly controlArgumentsBytes: Uint8Array
}

/** Material protocols admitted by the collection-context authenticator. */
type WorkspaceSearchMigrationRehearsalCollectionMaterialInput =
  | WorkspaceSearchMigrationRehearsalFaultCompletionMaterialAuthenticationInput
  | WorkspaceSearchMigrationRehearsalSuccessMaterialAuthenticationInput

/** Raw dual-key input for recovering one exact collection context. */
export type AuthenticateWorkspaceSearchMigrationRehearsalCollectionContextInput = {
  /** Selected collection mode used to reject stage replay. */
  readonly mode: WorkspaceSearchMigrationRehearsalCollectionMode
  /** Exact parent-persisted byte bundle to reauthenticate. */
  readonly material: WorkspaceSearchMigrationRehearsalCollectionMaterialBytes
  /** Caller-owned runtime verification key consumed on every path. */
  readonly runtimeVerificationKey: Uint8Array
  /** Caller-owned parent-only publication key consumed on every path. */
  readonly publicationVerificationKey: Uint8Array
}

/** Parent-authenticated facts admitted to one measured collection operation. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext = {
  /** Restricted run identifier retained only in process memory. */
  readonly runId: string
  /** HMAC-derived locator for the exact restricted run identifier. */
  readonly runLocatorDigest: string
  /** Canonical scenario selected by the authenticated manifest. */
  readonly scenario: WorkspaceSearchMigrationRehearsalStageReceipt['scenario']
  /** Exact selected planning or terminal child command. */
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
  /** Digest of the exact prospective or committed close-replan receipt. */
  readonly planningReceiptDigest: string
  /** Digest of the admitted closed-fence execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Digest of the exact closed writer fence protecting the plan. */
  readonly writerFenceDigest: string
  /** Complete FIFO writer-codec-proven authority-adoption chain. */
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Authenticated finite window bounding independent #163 evidence. */
  readonly integrityWindow: {
    /** Inclusive reviewed lower boundary. */
    readonly startedAt: string
    /** Exclusive stage-reservation upper boundary. */
    readonly completedAt: string
  }
  /** Exact rollback terminal for restored/reconciliation collection. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
}

/** Verified stage claim material retained behind one collection-context brand. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim = {
  /** Exact runtime-authenticated reservation owning the selected stage. */
  readonly reservation:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['stageReservation']
  /** Exact independently authenticated manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
}

/** Common input for one production offline stage finalization. */
type FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInputBase = {
  /** Authenticated supported selection independently made before spawn. */
  readonly selection:
    WorkspaceSearchMigrationRehearsalSupportedSelectedStage
  /** Immediate authenticated predecessor receipt, or null at global stage one. */
  readonly previousReceipt: unknown | null
  /** Exact reviewed control arguments used to reselect the stage. */
  readonly controlArguments: readonly string[]
  /** Parent-persisted successful lifecycle evidence document. */
  readonly persistedLifecycleEvidence: unknown
  /** Parent-origin HMAC binding both persisted evidence documents. */
  readonly parentAuthentication: unknown
  /** Command-specific proof containing only indispensable raw evidence. */
  readonly proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof
  /** Caller-owned runtime 32-byte stage authentication key to consume. */
  readonly runtimeAuthenticationKey: Uint8Array
  /** Caller-owned parent-only 32-byte publication key to consume. */
  readonly publicationAuthenticationKey: Uint8Array
}

/** Input for one production offline supported stage finalization. */
export type FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput =
  FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInputBase &
    WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput

/** Stable raw-value-free failure at the offline finalization boundary. */
export class WorkspaceSearchMigrationRehearsalStageFinalizerError
  extends Error {
  /** Stable machine-readable offline finalization failure code. */
  readonly code = 'INVALID_REHEARSAL_STAGE_FINALIZATION'

  /** Creates the sole public finalizer failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_FINALIZATION')
    this.name = 'WorkspaceSearchMigrationRehearsalStageFinalizerError'
  }
}

/** Detached persisted success material plus its parent observation time. */
type PersistedSuccessMaterial = {
  /** Selects ordinary authenticated child material. */
  readonly kind: 'success'
  /** Selection-bound authenticated child material. */
  readonly material: WorkspaceSearchMigrationRehearsalStageChildMaterial
  /** Digest of the exact canonical child material. */
  readonly materialDigest: string
  /** Parent time at which the complete material line was observed. */
  readonly observedAt: string
  /** Digest of the exact normalized persisted material wrapper. */
  readonly materialEvidenceDigest: string
  /** No separate boundary wrapper is used by success material. */
  readonly boundaryMaterialEvidenceDigest: null
  /** Success material carries no reviewed fault plan. */
  readonly faultPlanDigest: null
  /** Success material carries no boundary rate-byte file. */
  readonly boundaryRateSegmentBytesDigest: null
  /** Success material carries no final rate-byte file. */
  readonly finalRateSegmentBytesDigest: null
}

/** Detached persisted stopped-fault boundary evidence. */
type PersistedFaultBoundaryMaterial = {
  /** Selects one stopped-fault boundary. */
  readonly kind: 'fault-boundary'
  /** Selection-, plan-, reservation-, and rate-bound material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Digest of the exact canonical boundary material. */
  readonly materialDigest: string
  /** Parent time at which the complete boundary line was observed. */
  readonly observedAt: string
  /** Digest of the exact normalized persisted boundary wrapper. */
  readonly materialEvidenceDigest: string
  /** Boundary is the primary wrapper rather than a separate dependency. */
  readonly boundaryMaterialEvidenceDigest: null
  /** Digest of the independently reviewed selected fault plan. */
  readonly faultPlanDigest: string
  /** SHA-256 of exact independently authenticated boundary rate bytes. */
  readonly boundaryRateSegmentBytesDigest: string
  /** A stopped boundary has no final rate state. */
  readonly finalRateSegmentBytesDigest: null
}

/** Detached persisted two-phase response-loss completion evidence. */
type PersistedFaultCompletionMaterial = {
  /** Selects one response-loss completion protocol. */
  readonly kind: 'fault-completion'
  /** Final selection-, boundary-, result-, and rate-bound material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
  /** Independently verified first-phase boundary material. */
  readonly boundaryMaterial:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Digest of the exact canonical completion material. */
  readonly materialDigest: string
  /** Digest of the exact canonical boundary material. */
  readonly boundaryMaterialDigest: string
  /** Parent time at which the completion line was observed. */
  readonly observedAt: string
  /** Parent time at which the first boundary line was observed. */
  readonly boundaryObservedAt: string
  /** Digest of the exact normalized completion wrapper. */
  readonly materialEvidenceDigest: string
  /** Digest of the exact normalized boundary wrapper. */
  readonly boundaryMaterialEvidenceDigest: string
  /** Digest of the independently reviewed selected fault plan. */
  readonly faultPlanDigest: string
  /** SHA-256 of exact independently authenticated boundary rate bytes. */
  readonly boundaryRateSegmentBytesDigest: string
  /** SHA-256 of exact independently authenticated final rate bytes. */
  readonly finalRateSegmentBytesDigest: string
}

/** Every normalized authenticated persisted stage-material protocol. */
type PersistedStageMaterial =
  | PersistedFaultBoundaryMaterial
  | PersistedFaultCompletionMaterial
  | PersistedSuccessMaterial

/** Detached normalized parent lifecycle and receipt timestamps. */
type NormalizedStageLifecycle = {
  /** Exact verified successful or fault lifecycle document. */
  readonly source:
    | WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence
  /** Receipt-compatible trusted parent lifecycle projection. */
  readonly receiptLifecycle:
    WorkspaceSearchMigrationRehearsalStageProcessLifecycle
  /** Trusted child-stage beginning used by the receipt. */
  readonly startedAt: string
  /** Trusted child completion observation used by the receipt. */
  readonly completedAt: string
}

/** Strict derived stage evidence paired with its writer-fence identity. */
type DerivedStageEvidence = {
  /** Exact durable stage evidence derived from authenticated material. */
  readonly evidence: WorkspaceSearchMigrationRehearsalStageEvidence
  /** Exact durable writer-fence record digest for this stage. */
  readonly writerFenceDigest: string
  /** Latest authenticated process or external-evidence completion time. */
  readonly evidenceCompletedAt: string
}

/** Complete internally derived receipt projection for one material protocol. */
type DerivedStageReceiptState = DerivedStageEvidence & {
  /** Digest of the exact trusted control or fault material output line. */
  readonly serializedOutputLineDigest: string
  /** Exact authenticated reservation owning this stage. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['stageReservation']
  /** Exact durable head returned by the successful reservation claim. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['claimedStageHead']
  /** Stable identity digest of the lease used by this stage. */
  readonly leaseIdentityDigest: string
  /** Exact cycle-free adapter-proven lease observation. */
  readonly leaseObservation:
    WorkspaceSearchMigrationRehearsalStageLeaseObservation
  /** Exact finite outcome fixed by the authenticated manifest entry. */
  readonly outcome:
    WorkspaceSearchMigrationRehearsalStageManifestEntry['expectedOutcome']
  /** Matching runtime fault receipt digest when the stage encountered a fault. */
  readonly faultReceiptDigest: string | null
  /** Current runtime fault boundary for fault or response-loss stages. */
  readonly faultBoundary:
    WorkspaceSearchMigrationRehearsalFaultStageEvidence | null
  /** Exact predecessor lease expiry for a takeover, otherwise null. */
  readonly predecessorLeaseExpiresAt: string | null
  /** Exact durable successor acquisition time for a takeover, otherwise null. */
  readonly takeoverAcquiredAt: string | null
  /** Durable response-loss reconciliation time, otherwise null. */
  readonly reconciledAt: string | null
  /** Exact durable completion or fault-boundary time for receipt claims. */
  readonly completedAt: string
  /** Exact authenticated rate segment selected for the final receipt. */
  readonly rateSegment:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['rateSegment']
}

/** Authenticated receipt narrowed to a durable successful planning boundary. */
type AuthenticatedPlanningReceipt =
  WorkspaceSearchMigrationRehearsalStageReceipt & {
    /** Exact planning evidence required by downstream derivation. */
    readonly evidence: Extract<WorkspaceSearchMigrationRehearsalStageEvidence, {
      readonly kind: 'planning-sealed'
    }>
  }

/** Outcome-specific lease recovery timestamps derived for receipt claims. */
type DerivedLeaseRecovery = {
  /** Exact predecessor expiry for takeover, otherwise null. */
  readonly predecessorLeaseExpiresAt: string | null
  /** Exact successor acquisition time for takeover, otherwise null. */
  readonly takeoverAcquiredAt: string | null
}

/** Raw run and owner identifiers recovered only from reviewed arguments. */
type ReviewedInvocationIdentifiers = {
  /** Exact reviewed run identifier, retained only until locator derivation. */
  readonly runId: string
  /** Exact reviewed owner identifier, retained only until locator derivation. */
  readonly ownerId: string
}

/** Exact caller key length shared by stage receipt and locator HMACs. */
const stageAuthenticationKeyByteLength = 32

/** HMAC domain separating parent lifecycle authentication from receipts. */
const parentAuthenticationMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-parent-authentication:v1\0'

/** Private collection state retained only behind successful dual-key auth. */
type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionPrivateState = {
  /** Secret-free context exposed to collection callers. */
  readonly context:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext
  /** Exact verified reservation required to re-present the durable claim. */
  readonly reservation:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['stageReservation']
  /** Exact verified stage selection required to re-present the durable claim. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
}

/** Process-local brand for contexts recovered through dual-key parent auth. */
const authenticatedCollectionContexts = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalAuthenticatedCollectionPrivateState
>()

/** Strict guards mapping every malformed boundary to one stable failure. */
const finalizerGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageFinalizer,
)

/** Exact parent-persisted authenticated child-material wrapper fields. */
const persistedMaterialKeys = Object.freeze([
  'evidenceVersion',
  'kind',
  'material',
  'materialDigest',
  'observedAt',
])

/** Exact parent-persisted authenticated fault-material wrapper fields. */
const persistedFaultMaterialKeys = Object.freeze([
  'evidenceVersion',
  'kind',
  'material',
  'materialDigest',
  'observedAt',
])

/** Exact parent-persisted successful lifecycle wrapper fields. */
const persistedLifecycleKeys = Object.freeze([
  'kind',
  'lifecycle',
  'lifecycleSha256',
])

/** Exact generic-success lifecycle fields emitted by the parent runner. */
const successfulLifecycleKeys = Object.freeze([
  'attemptOrdinal',
  'command',
  'exitClass',
  'expectedOutcome',
  'lifecycleVersion',
  'manifestDigest',
  'manifestEntryDigest',
  'materialDigest',
  'materialObservedAt',
  'materialPersistedAt',
  'previousStageReceiptDigest',
  'processExitedAt',
  'runnerStartedAt',
  'scenario',
  'stageOrdinal',
  'stdoutSha256',
])

/** Exact authenticated fault lifecycle fields emitted by the parent runner. */
const faultLifecycleKeys = Object.freeze([
  'attemptOrdinal',
  'boundaryDecisionRecordedAt',
  'boundaryMaterialDigest',
  'boundaryMaterialObservedAt',
  'boundaryMaterialPersistedAt',
  'command',
  'completionDecisionRecordedAt',
  'completionMaterialDigest',
  'completionMaterialObservedAt',
  'completionMaterialPersistedAt',
  'exitClass',
  'expectedOutcome',
  'faultPlanDigest',
  'faultReceiptDigest',
  'lifecycleVersion',
  'manifestDigest',
  'manifestEntryDigest',
  'materialStreamSha256',
  'previousStageReceiptDigest',
  'processExitedAt',
  'runnerStartedAt',
  'scenario',
  'stageOrdinal',
  'stdoutSha256',
])

/** Exact public selected-stage object fields. */
const selectedStageKeys = Object.freeze([
  'entry',
  'manifest',
  'manifestDigest',
  'previousStageReceiptDigest',
])

/** Exact selected manifest-entry fields. */
const selectedEntryKeys = Object.freeze([
  'attemptOrdinal',
  'command',
  'controlArgumentsDigest',
  'expectedOutcome',
  'faultPlanDigest',
  'ordinal',
  'scenario',
  'scenarioStageOrdinal',
])

/** Exact parent-authentication claim fields. */
const parentAuthenticationClaimKeys = Object.freeze([
  'authenticationVersion',
  'boundaryMaterialEvidenceDigest',
  'boundaryRateSegmentBytesDigest',
  'faultPlanDigest',
  'finalRateSegmentBytesDigest',
  'kind',
  'lifecycleEvidenceDigest',
  'manifestDigest',
  'manifestEntryDigest',
  'materialEvidenceDigest',
  'previousStageReceiptDigest',
  'runtimeKeyCleanupAuthorization',
  'stageOrdinal',
])

/** Exact complete parent-authentication fields. */
const parentAuthenticationKeys = Object.freeze([
  ...parentAuthenticationClaimKeys,
  'authenticationMac',
])

/**
 * Narrows an authenticated selection to the currently productionized paths.
 *
 * This is a compile-time convenience only. The finalizer reauthenticates and
 * reselects the manifest entry independently before trusting any field.
 *
 * @param selection - Authenticated stage selection returned by selection API.
 * @returns Whether the entry is an ordinary supported completed stage.
 */
export function isWorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
): selection is WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage {
  const entry = selection.entry
  return entry.expectedOutcome === 'completed' &&
    entry.faultPlanDigest === null &&
    entry.attemptOrdinal === 1 &&
    (
      (entry.scenario === 'happy-path-verified' &&
        (
          entry.command === 'close-replan' ||
          entry.command === 'apply' ||
          entry.command === 'verify' ||
          entry.command === 'release'
        )) ||
      (entry.scenario === 'complete-apply-rollback' &&
        (
          entry.command === 'close-replan' ||
          entry.command === 'apply' ||
          entry.command === 'rollback-complete' ||
          entry.command === 'release'
        ))
    )
}

/**
 * Authenticates parent-persisted material and lifecycle before offline use.
 *
 * This API is called only after the parent runner has observed the final
 * ordinary exit. It reauthenticates child material, validates lifecycle
 * ordering and selection binding, then covers both normalized persisted
 * wrappers with a domain-separated main-key HMAC. Ownership of the supplied
 * key transfers to this invocation and is overwritten on every path.
 *
 * @param input - Supported selection, persisted evidence, and owned main key.
 * @returns Frozen parent-origin authentication record for durable persistence.
 */
export function createWorkspaceSearchMigrationRehearsalStageParentAuthentication(
  input:
    CreateWorkspaceSearchMigrationRehearsalStageParentAuthenticationInput,
): WorkspaceSearchMigrationRehearsalStageParentAuthentication {
  let runtimeAuthenticationKeyValue: unknown
  let publicationAuthenticationKeyValue: unknown
  let workingRuntimeKey: Uint8Array | undefined
  let workingPublicationKey: Uint8Array | undefined
  try {
    const inputRecord = finalizerGuards.requireRecord(input)
    runtimeAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'runtimeAuthenticationKey',
    )
    publicationAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'publicationAuthenticationKey',
    )
    requireStageMaterialInputKeys(inputRecord, [
      'persistedLifecycleEvidence',
      'publicationAuthenticationKey',
      'runtimeKeyCleanupAuthorization',
      'runtimeAuthenticationKey',
      'selection',
    ])
    workingRuntimeKey = consumeOwnedKey(runtimeAuthenticationKeyValue)
    workingPublicationKey = consumeOwnedKey(
      publicationAuthenticationKeyValue,
    )
    const selection = input.selection
    requirePublicationAuthenticationKeyMatchesSelection(
      selection,
      workingPublicationKey,
    )
    const persistedMaterial = readPersistedStageMaterial(
      input,
      selection,
      workingRuntimeKey,
    )
    const lifecycle = readPersistedLifecycle(
      finalizerGuards.readOwn(inputRecord, 'persistedLifecycleEvidence'),
      persistedMaterial,
      selection,
    )
    const runtimeKeyCleanupAuthorization =
      readGenuineRuntimeKeyCleanupAuthorization(
        finalizerGuards.readOwn(
          inputRecord,
          'runtimeKeyCleanupAuthorization',
        ),
        selection,
        persistedMaterial,
        lifecycle,
      )
    const claims = createParentAuthenticationClaims(
      selection,
      persistedMaterial,
      lifecycle,
      runtimeKeyCleanupAuthorization,
    )
    return Object.freeze({
      ...claims,
      authenticationMac: createParentAuthenticationMac(
        claims,
        workingPublicationKey,
      ),
    })
  } catch {
    return failStageFinalizer()
  } finally {
    zeroizeBytes(workingRuntimeKey)
    zeroizeBytes(workingPublicationKey)
    zeroizeBytes(runtimeAuthenticationKeyValue)
    zeroizeBytes(publicationAuthenticationKeyValue)
  }
}

/**
 * Reauthenticates one persisted stage under both runtime and publication keys.
 *
 * The returned object is a process-local branded capability. Its detached
 * binding is available only through the paired reader, so downstream commit
 * code cannot substitute a structurally similar child-forgeable object.
 * Ownership of both supplied keys transfers to this invocation and both are
 * overwritten on every path.
 *
 * @param input - Persisted material, lifecycle, parent HMAC, selection, keys.
 * @returns Opaque parent-only authorization for one exact persisted stage.
 */
export function authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization(
  input:
    AuthenticateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInput,
): WorkspaceSearchMigrationRehearsalStageParentAuthorization {
  let runtimeAuthenticationKeyValue: unknown
  let publicationAuthenticationKeyValue: unknown
  let workingRuntimeKey: Uint8Array | undefined
  let workingPublicationKey: Uint8Array | undefined
  try {
    const inputRecord = finalizerGuards.requireRecord(input)
    runtimeAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'runtimeAuthenticationKey',
    )
    publicationAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'publicationAuthenticationKey',
    )
    requireStageMaterialInputKeys(inputRecord, [
      'parentAuthentication',
      'persistedLifecycleEvidence',
      'publicationAuthenticationKey',
      'runtimeAuthenticationKey',
      'selection',
    ])
    workingRuntimeKey = consumeOwnedKey(runtimeAuthenticationKeyValue)
    workingPublicationKey = consumeOwnedKey(
      publicationAuthenticationKeyValue,
    )
    const selection = input.selection
    requirePublicationAuthenticationKeyMatchesSelection(
      selection,
      workingPublicationKey,
    )
    const persistedMaterial = readPersistedStageMaterial(
      input,
      selection,
      workingRuntimeKey,
    )
    const lifecycle = readPersistedLifecycle(
      finalizerGuards.readOwn(inputRecord, 'persistedLifecycleEvidence'),
      persistedMaterial,
      selection,
    )
    const parentAuthentication = verifyParentAuthentication(
      finalizerGuards.readOwn(inputRecord, 'parentAuthentication'),
      selection,
      persistedMaterial,
      lifecycle,
      undefined,
      workingPublicationKey,
    )
    const binding:
      WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding =
        Object.freeze({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
          authorizationVersion:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
          parentAuthenticationDigest:
            createMigrationDigest(parentAuthentication),
          publicationKeyDigest: selection.manifest.publicationKeyDigest,
          manifestDigest: selection.manifestDigest,
          manifestEntryDigest: createMigrationDigest(selection.entry),
          previousStageReceiptDigest:
            selection.previousStageReceiptDigest,
          stageOrdinal: selection.entry.ordinal,
          materialEvidenceDigest:
            persistedMaterial.materialEvidenceDigest,
          boundaryMaterialEvidenceDigest:
            persistedMaterial.boundaryMaterialEvidenceDigest,
          materialDigest: persistedMaterial.materialDigest,
          stageReservationDigest: createMigrationDigest(
            persistedMaterial.material.stageReservation,
          ),
          claimedStageHeadDigest: createMigrationDigest(
            persistedMaterial.material.claimedStageHead,
          ),
          lifecycleEvidenceDigest: createMigrationDigest({
            kind:
              'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
            lifecycle: lifecycle.source,
            lifecycleSha256: lifecycle.receiptLifecycle.lifecycleDigest,
          }),
          lifecycleDigest: lifecycle.receiptLifecycle.lifecycleDigest,
          faultPlanDigest: persistedMaterial.faultPlanDigest,
          boundaryRateSegmentBytesDigest:
            persistedMaterial.boundaryRateSegmentBytesDigest,
          finalRateSegmentBytesDigest:
            persistedMaterial.finalRateSegmentBytesDigest,
          runtimeKeyCleanupAuthorization:
            parentAuthentication.runtimeKeyCleanupAuthorization,
        })
    return createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
      binding,
      publicationAuthenticationKey: workingPublicationKey,
    })
  } catch {
    return failStageFinalizer()
  } finally {
    zeroizeBytes(workingRuntimeKey)
    zeroizeBytes(workingPublicationKey)
    zeroizeBytes(runtimeAuthenticationKeyValue)
    zeroizeBytes(publicationAuthenticationKeyValue)
  }
}

/**
 * Reauthenticates parent-persisted stage bytes and recovers collection facts.
 *
 * Only a successful close-replan or authoritative terminal child is admitted.
 * Manifest selection, immediate predecessor, child material, lifecycle, and
 * the parent publication HMAC are all verified before run, planning, terminal,
 * and authority-adoption fields become visible. Both supplied keys transfer
 * to this invocation and are overwritten on every path.
 *
 * @param input - Exact persisted byte bundle, mode, and owned dual keys.
 * @returns Branded frozen context for target or reconciliation collection.
 */
export function authenticateWorkspaceSearchMigrationRehearsalCollectionContext(
  input: AuthenticateWorkspaceSearchMigrationRehearsalCollectionContextInput,
): WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext {
  let runtimeVerificationKeyValue: unknown
  let publicationVerificationKeyValue: unknown
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const inputRecord = finalizerGuards.requireRecord(input)
    finalizerGuards.requireExactKeys(inputRecord, [
      'material',
      'mode',
      'publicationVerificationKey',
      'runtimeVerificationKey',
    ])
    runtimeVerificationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'runtimeVerificationKey',
    )
    publicationVerificationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'publicationVerificationKey',
    )
    runtimeKey = consumeOwnedKey(runtimeVerificationKeyValue)
    publicationKey = consumeOwnedKey(publicationVerificationKeyValue)
    const mode = readCollectionMode(
      finalizerGuards.readOwn(inputRecord, 'mode'),
    )
    const materialBytes = finalizerGuards.requireRecord(
      finalizerGuards.readOwn(inputRecord, 'material'),
    )
    const materialInput = readCollectionMaterialInput(materialBytes)
    const manifest = parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(materialBytes, 'manifestBytes'),
    )
    const previousReceiptValue = parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(materialBytes, 'previousReceiptBytes'),
    )
    const persistedLifecycleEvidence = parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(materialBytes, 'lifecycleBytes'),
    )
    const parentAuthentication = parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(
        materialBytes,
        'parentAuthenticationBytes',
      ),
    )
    const controlArguments = readControlArguments(
      parseCanonicalCollectionDocument(
        finalizerGuards.readOwn(materialBytes, 'controlArgumentsBytes'),
      ),
    )
    const selection = selectWorkspaceSearchMigrationRehearsalStage({
      manifest,
      verificationKey: runtimeKey,
      previousReceipt: previousReceiptValue,
      controlArguments,
      faultPlanDigest: readStageMaterialFaultPlanDigest(materialInput),
    })
    requirePublicationAuthenticationKeyMatchesSelection(
      selection,
      publicationKey,
    )
    const previousReceipt =
      verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        previousReceiptValue,
        runtimeKey,
      )
    requirePreviousReceipt(selection, previousReceipt)
    const persistedMaterial = readPersistedStageMaterial(
      materialInput,
      selection,
      runtimeKey,
    )
    if (persistedMaterial.kind === 'fault-boundary') {
      return failStageFinalizer()
    }
    if (materialInput.materialKind !== persistedMaterial.kind) {
      return failStageFinalizer()
    }
    const lifecycle = readPersistedLifecycle(
      persistedLifecycleEvidence,
      persistedMaterial,
      selection,
    )
    verifyParentAuthentication(
      parentAuthentication,
      selection,
      persistedMaterial,
      lifecycle,
      undefined,
      publicationKey,
    )
    if (
      Date.parse(lifecycle.startedAt) <=
        Date.parse(previousReceipt.completedAt) ||
      Date.parse(lifecycle.startedAt) <=
        Date.parse(previousReceipt.processLifecycle.processExitedAt)
    ) return failStageFinalizer()
    const identifiers = readReviewedInvocationIdentifiers(controlArguments)
    const runLocatorDigest =
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'run',
        identifiers.runId,
        runtimeKey,
      )
    if (previousReceipt.scenario === selection.entry.scenario) {
      if (previousReceipt.runLocatorDigest !== runLocatorDigest) {
        return failStageFinalizer()
      }
    }
    const expectedAuthorities = requireCumulativeAuthorityChain(
      selection,
      previousReceipt,
      persistedMaterial.material.authorityAdoptionObservations,
    )
    const coordinator = persistedMaterial.material.mutationResult.coordinator
    let planningReceiptDigest: string
    let executionBoundaryDigest: string
    let sealedPlanningAuthorityDigest: string
    let planDigest: string
    let writerFenceDigest: string
    let terminal:
      WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
    if (coordinator.mode === 'close-replan') {
      if (
        mode !== 'target-preimage' ||
        (selection.entry.scenario !== 'partial-apply-rollback' &&
          selection.entry.scenario !== 'complete-apply-rollback')
      ) return failStageFinalizer()
      const planning = coordinator.planning
      if (planning === undefined) return failStageFinalizer()
      const receipt = finalizeWorkspaceSearchMigrationRehearsalStageReceipt({
        ...materialInput,
        selection,
        previousReceipt,
        controlArguments,
        persistedLifecycleEvidence,
        parentAuthentication,
        proof: Object.freeze({ kind: 'planning' }),
        runtimeAuthenticationKey: new Uint8Array(runtimeKey),
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })
      planningReceiptDigest = createMigrationDigest(receipt)
      executionBoundaryDigest = planning.executionBoundaryDigest
      sealedPlanningAuthorityDigest =
        planning.sealedPlanningAuthorityDigest
      planDigest = planning.planDigest
      writerFenceDigest = planning.closedWriterFenceRecordDigest
      terminal = null
    } else if (
      coordinator.mode === 'verify' ||
      coordinator.mode === 'rollback-complete' ||
      coordinator.mode === 'rollback-partial'
    ) {
      if (mode === 'target-preimage') return failStageFinalizer()
      const terminalEvidence = coordinator.terminal
      if (terminalEvidence === undefined) return failStageFinalizer()
      planningReceiptDigest = previousReceipt.previousStageReceiptDigest ??
        failStageFinalizer()
      executionBoundaryDigest = terminalEvidence.executionBoundaryDigest
      sealedPlanningAuthorityDigest =
        terminalEvidence.sealedPlanningAuthorityDigest
      planDigest = terminalEvidence.planDigest
      writerFenceDigest = terminalEvidence.closedWriterFenceRecordDigest
      if (coordinator.mode === 'verify') {
        if (mode === 'target-restored') return failStageFinalizer()
        terminal = null
      } else {
        if (coordinator.mode === 'rollback-partial') {
          if (selection.entry.scenario !== 'partial-apply-rollback') {
            return failStageFinalizer()
          }
          terminal = Object.freeze({
            scenario: 'partial-apply-rollback',
            kind: 'rolled-back',
            version: 2,
            rootDigest: terminalEvidence.terminalRootDigest,
            applyStartedAt: previousReceipt.startedAt,
            terminalAt: terminalEvidence.terminalAt,
          })
        } else {
          if (selection.entry.scenario !== 'complete-apply-rollback') {
            return failStageFinalizer()
          }
          terminal = Object.freeze({
            scenario: 'complete-apply-rollback',
            kind: 'rolled-back',
            version: 1,
            rootDigest: terminalEvidence.terminalRootDigest,
            applyStartedAt: previousReceipt.startedAt,
            terminalAt: terminalEvidence.terminalAt,
          })
        }
      }
      if (mode === 'reconcile' && expectedAuthorities.length === 0) {
        return failStageFinalizer()
      }
    } else {
      return failStageFinalizer()
    }
    const context:
      WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext =
        Object.freeze({
          runId: identifiers.runId,
          runLocatorDigest,
          scenario: selection.entry.scenario,
          command: coordinator.mode,
          permitDigest: selection.manifest.permitDigest,
          requestedResourcesBinding:
            selection.manifest.requestedResourcesBinding,
          configurationBindingDigest:
            selection.manifest.configurationBindingDigest,
          policyVersion: selection.manifest.policyVersion,
          manifestDigest: selection.manifestDigest,
          planningReceiptDigest,
          executionBoundaryDigest,
          sealedPlanningAuthorityDigest,
          planDigest,
          writerFenceDigest,
          expectedAuthorities,
          integrityWindow: Object.freeze({
            startedAt: selection.manifest.reviewedAt,
            completedAt: persistedMaterial.material.stageReservation.expiresAt,
          }),
          terminal,
        })
    authenticatedCollectionContexts.set(context, Object.freeze({
      context,
      reservation: persistedMaterial.material.stageReservation,
      selection,
    }))
    return context
  } catch {
    return failStageFinalizer()
  } finally {
    zeroizeBytes(runtimeKey)
    zeroizeBytes(publicationKey)
    zeroizeBytes(runtimeVerificationKeyValue)
    zeroizeBytes(publicationVerificationKeyValue)
  }
}

/**
 * Returns an aliases-free snapshot only for a genuine authenticated context.
 *
 * @param value - Candidate context returned by the dual-key authenticator.
 * @returns Frozen exact collection context detached from caller references.
 */
export function snapshotWorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext {
  const record = finalizerGuards.requireRecord(value)
  const state = authenticatedCollectionContexts.get(record) ??
    failStageFinalizer()
  const context = state.context
  return Object.freeze({
    ...context,
    expectedAuthorities: Object.freeze(
      context.expectedAuthorities.map((authority) =>
        Object.freeze({ ...authority })
      ),
    ),
    integrityWindow: Object.freeze({ ...context.integrityWindow }),
    terminal: context.terminal === null
      ? null
      : Object.freeze({ ...context.terminal }),
  })
}

/**
 * Re-presents the verified durable stage claim behind a genuine context brand.
 *
 * The returned outer record is immutable and intentionally excludes all key
 * bytes. Its reservation and selection were independently authenticated by
 * the same dual-key operation that created the supplied context. Callers must
 * add a fresh invocation-owned runtime-key copy only at the identity boundary.
 *
 * @param value - Genuine branded collection context, never a structural copy.
 * @returns Frozen exact reservation and independently verified selection.
 */
export function readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim {
  const record = finalizerGuards.requireRecord(value)
  const state = authenticatedCollectionContexts.get(record) ??
    failStageFinalizer()
  return Object.freeze({
    reservation: state.reservation,
    selection: state.selection,
  })
}

/**
 * Finalizes any authenticated stage in the fixed 36-stage rehearsal chain.
 *
 * The main key and every dedicated audit key are ownership-transferred and
 * overwritten on all paths. Manifest selection, predecessor chaining,
 * persisted child material, parent lifecycle, reviewed run/owner identifiers,
 * coordinator evidence, and applicable raw external audits are independently
 * authenticated before receipt claims are constructed internally.
 *
 * @param input - Selection, persisted trusted material, and raw audit files.
 * @returns Frozen HMAC-authenticated stage receipt.
 */
export function finalizeWorkspaceSearchMigrationRehearsalStageReceipt(
  input: FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  let runtimeAuthenticationKeyValue: unknown
  let publicationAuthenticationKeyValue: unknown
  let proofValue: unknown
  let workingRuntimeKey: Uint8Array | undefined
  let workingPublicationKey: Uint8Array | undefined
  try {
    const inputRecord = finalizerGuards.requireRecord(input)
    runtimeAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'runtimeAuthenticationKey',
    )
    publicationAuthenticationKeyValue = finalizerGuards.readOwn(
      inputRecord,
      'publicationAuthenticationKey',
    )
    proofValue = finalizerGuards.readOwn(inputRecord, 'proof')
    requireStageMaterialInputKeys(inputRecord, [
      'controlArguments',
      'persistedLifecycleEvidence',
      'parentAuthentication',
      'previousReceipt',
      'proof',
      'publicationAuthenticationKey',
      'runtimeAuthenticationKey',
      'selection',
    ])
    workingRuntimeKey = consumeOwnedKey(runtimeAuthenticationKeyValue)
    workingPublicationKey = consumeOwnedKey(
      publicationAuthenticationKeyValue,
    )
    const controlArguments = readControlArguments(
      finalizerGuards.readOwn(inputRecord, 'controlArguments'),
    )
    const previousReceiptValue = finalizerGuards.readOwn(
      inputRecord,
      'previousReceipt',
    )
    const providedSelection = finalizerGuards.requireRecord(
      finalizerGuards.readOwn(inputRecord, 'selection'),
    )
    finalizerGuards.requireExactKeys(providedSelection, selectedStageKeys)
    const faultPlanDigest = readStageMaterialFaultPlanDigest(input)
    const selection = selectWorkspaceSearchMigrationRehearsalStage({
      manifest: finalizerGuards.readOwn(providedSelection, 'manifest'),
      verificationKey: workingRuntimeKey,
      previousReceipt: previousReceiptValue,
      controlArguments,
      faultPlanDigest,
    })
    requireProvidedSelectionMatches(providedSelection, selection)
    requirePublicationAuthenticationKeyMatchesSelection(
      selection,
      workingPublicationKey,
    )
    const previousReceipt = previousReceiptValue === null
      ? null
      : verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        previousReceiptValue,
        workingRuntimeKey,
      )
    requirePreviousReceipt(selection, previousReceipt)
    const persistedMaterial = readPersistedStageMaterial(
      input,
      selection,
      workingRuntimeKey,
    )
    const lifecycle = readPersistedLifecycle(
      finalizerGuards.readOwn(inputRecord, 'persistedLifecycleEvidence'),
      persistedMaterial,
      selection,
    )
    verifyParentAuthentication(
      finalizerGuards.readOwn(inputRecord, 'parentAuthentication'),
      selection,
      persistedMaterial,
      lifecycle,
      undefined,
      workingPublicationKey,
    )
    if (
      previousReceipt !== null &&
      (Date.parse(lifecycle.startedAt) <=
          Date.parse(previousReceipt.completedAt) ||
        Date.parse(lifecycle.startedAt) <=
          Date.parse(previousReceipt.processLifecycle.processExitedAt))
    ) return failStageFinalizer()
    const identifiers = readReviewedInvocationIdentifiers(controlArguments)
    const runLocatorDigest =
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'run',
        identifiers.runId,
        workingRuntimeKey,
      )
    const attemptLocatorDigest =
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'attempt',
        serializeCanonicalJson({
          runId: identifiers.runId,
          attemptOrdinal: selection.entry.attemptOrdinal,
        }),
        workingRuntimeKey,
      )
    const ownerLocatorDigest =
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'owner',
        identifiers.ownerId,
        workingRuntimeKey,
      )
    requireLocatorContinuity(
      selection,
      previousReceipt,
      runLocatorDigest,
      attemptLocatorDigest,
      ownerLocatorDigest,
    )
    const derived = deriveStageReceiptState(
      selection,
      persistedMaterial,
      lifecycle,
      previousReceipt,
      proofValue,
      workingRuntimeKey,
      workingPublicationKey,
      runLocatorDigest,
    )
    if (
      Date.parse(derived.completedAt) >=
        Date.parse(derived.stageReservation.expiresAt) ||
      Date.parse(derived.evidenceCompletedAt) >=
        Date.parse(derived.stageReservation.expiresAt)
    ) return failStageFinalizer()
    requireLeaseObservationContinuity(
      selection,
      derived,
      lifecycle,
      previousReceipt,
    )
    requireRateSegmentContinuity(
      derived.rateSegment,
      previousReceipt,
    )
    const expectedAuthorities = requireCumulativeAuthorityChain(
      selection,
      previousReceipt,
      persistedMaterial.material.authorityAdoptionObservations,
    )
    return createWorkspaceSearchMigrationRehearsalStageReceipt({
      claims: {
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
        receiptVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
        stage: 'non-production',
        scenario: selection.entry.scenario,
        stageOrdinal: selection.entry.ordinal,
        scenarioStageOrdinal: selection.entry.scenarioStageOrdinal,
        command: selection.entry.command,
        controlArgumentsDigest: selection.entry.controlArgumentsDigest,
        serializedOutputLineDigest: derived.serializedOutputLineDigest,
        manifestDigest: selection.manifestDigest,
        manifestEntryDigest: createMigrationDigest(selection.entry),
        permitDigest: selection.manifest.permitDigest,
        commit: selection.manifest.commit,
        requestedResourcesBinding:
          selection.manifest.requestedResourcesBinding,
        integrityResourceIdentityScheme:
          selection.manifest.integrityResourceIdentityScheme,
        integrityResourceIdentities:
          selection.manifest.integrityResourceIdentities,
        integrityResourceIdentityDigest:
          selection.manifest.integrityResourceIdentityDigest,
        configurationBindingDigest:
          selection.manifest.configurationBindingDigest,
        policyVersion: selection.manifest.policyVersion,
        runLocatorDigest,
        attemptOrdinal: selection.entry.attemptOrdinal,
        attemptLocatorDigest,
        ownerLocatorDigest,
        leaseIdentityDigest: derived.leaseIdentityDigest,
        leaseObservation: derived.leaseObservation,
        expectedAuthorities,
        writerFenceDigest: derived.writerFenceDigest,
        previousStageReceiptDigest:
          selection.previousStageReceiptDigest,
        stageReservationDigest: createMigrationDigest(
          derived.stageReservation,
        ),
        stageReservationClaimRevision:
          derived.claimedStageHead.revision,
        stageReservationCommitRevision:
          derived.claimedStageHead.revision + 1,
        stageReservationAbandonmentCount:
          derived.claimedStageHead.abandonmentCount,
        stageReservationAbandonmentRootDigest:
          derived.claimedStageHead.abandonmentRootDigest,
        startedAt: lifecycle.startedAt,
        completedAt: derived.completedAt,
        processLifecycle: lifecycle.receiptLifecycle,
        outcome: derived.outcome,
        faultReceiptDigest: derived.faultReceiptDigest,
        faultBoundary: derived.faultBoundary,
        predecessorLeaseExpiresAt: derived.predecessorLeaseExpiresAt,
        takeoverAcquiredAt: derived.takeoverAcquiredAt,
        reconciledAt: derived.reconciledAt,
        evidence: derived.evidence,
        rateSegment: derived.rateSegment,
      },
      signingKey: workingRuntimeKey,
    })
  } catch {
    return failStageFinalizer()
  } finally {
    zeroizeBytes(workingRuntimeKey)
    zeroizeBytes(workingPublicationKey)
    zeroizeBytes(runtimeAuthenticationKeyValue)
    zeroizeBytes(publicationAuthenticationKeyValue)
    zeroizeProofKeys(proofValue)
  }
}

/** Requires the supplied detached selection to equal fresh reselection. */
function requireProvidedSelectionMatches(
  provided: object,
  selected: WorkspaceSearchMigrationRehearsalSelectedStage,
): void {
  const entry = finalizerGuards.requireRecord(
    finalizerGuards.readOwn(provided, 'entry'),
  )
  finalizerGuards.requireExactKeys(entry, selectedEntryKeys)
  if (
    finalizerGuards.readDigest(
      finalizerGuards.readOwn(provided, 'manifestDigest'),
    ) !== selected.manifestDigest ||
    readNullableDigest(
      finalizerGuards.readOwn(provided, 'previousStageReceiptDigest'),
    ) !== selected.previousStageReceiptDigest ||
    createMigrationDigest(entry) !== createMigrationDigest(selected.entry)
  ) return failStageFinalizer()
}

/** Requires the immediate predecessor shape for a supported stage. */
function requirePreviousReceipt(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): void {
  if (selection.entry.ordinal === 1) {
    if (previous !== null) return failStageFinalizer()
    return
  }
  const previousEntry = selection.manifest.entries[selection.entry.ordinal - 2]
  if (
    previous === null ||
    previousEntry === undefined ||
    createMigrationDigest(previous) !== selection.previousStageReceiptDigest ||
    previous.stageOrdinal + 1 !== selection.entry.ordinal ||
    previous.stageOrdinal !== previousEntry.ordinal ||
    previous.scenario !== previousEntry.scenario ||
    previous.scenarioStageOrdinal !== previousEntry.scenarioStageOrdinal ||
    previous.command !== previousEntry.command ||
    previous.controlArgumentsDigest !== previousEntry.controlArgumentsDigest ||
    previous.attemptOrdinal !== previousEntry.attemptOrdinal ||
    previous.outcome !== previousEntry.expectedOutcome ||
    previous.manifestDigest !== selection.manifestDigest ||
    previous.manifestEntryDigest !== createMigrationDigest(previousEntry) ||
    previous.permitDigest !== selection.manifest.permitDigest ||
    previous.commit !== selection.manifest.commit ||
    previous.requestedResourcesBinding !==
      selection.manifest.requestedResourcesBinding ||
    previous.configurationBindingDigest !==
      selection.manifest.configurationBindingDigest ||
    previous.policyVersion !== selection.manifest.policyVersion
  ) return failStageFinalizer()
}

/** Reads the material discriminator and requires its exact top-level fields. */
function requireStageMaterialInputKeys(
  record: object,
  commonKeys: readonly string[],
): void {
  const materialKind = finalizerGuards.readOwn(record, 'materialKind')
  const materialKeys = materialKind === 'success'
    ? ['materialKind', 'persistedMaterialEvidence']
    : materialKind === 'fault-boundary'
    ? [
        'boundaryRateSegmentBytes',
        'faultPlan',
        'materialKind',
        'persistedMaterialEvidence',
      ]
    : materialKind === 'fault-completion'
    ? [
        'boundaryRateSegmentBytes',
        'faultPlan',
        'finalRateSegmentBytes',
        'materialKind',
        'persistedBoundaryMaterialEvidence',
        'persistedMaterialEvidence',
      ]
    : failStageFinalizer()
  finalizerGuards.requireExactKeys(record, [
    ...commonKeys,
    ...materialKeys,
  ])
}

/** Derives the selection fault-plan digest solely from the strict material arm. */
function readStageMaterialFaultPlanDigest(
  input: WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput,
): string | null {
  if (input.materialKind === 'success') return null
  return createMigrationDigest(
    snapshotWorkspaceSearchMigrationRehearsalFaultPlan(input.faultPlan),
  )
}

/** Dispatches and reauthenticates one exact persisted material protocol. */
function readPersistedStageMaterial(
  input: WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  verificationKey: Uint8Array,
): PersistedStageMaterial {
  if (input.materialKind === 'success') {
    return readPersistedSuccessMaterial(
      input.persistedMaterialEvidence,
      selection,
      verificationKey,
    )
  }
  const faultPlan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
    input.faultPlan,
  )
  const boundaryRateSegmentBytes = copyStageFinalizerEvidenceBytes(
    input.boundaryRateSegmentBytes,
  )
  if (input.materialKind === 'fault-boundary') {
    return readPersistedFaultBoundaryMaterial(
      input.persistedMaterialEvidence,
      selection,
      faultPlan,
      boundaryRateSegmentBytes,
      verificationKey,
    )
  }
  const finalRateSegmentBytes = copyStageFinalizerEvidenceBytes(
    input.finalRateSegmentBytes,
  )
  return readPersistedFaultCompletionMaterial(
    input.persistedMaterialEvidence,
    input.persistedBoundaryMaterialEvidence,
    selection,
    faultPlan,
    boundaryRateSegmentBytes,
    finalRateSegmentBytes,
    verificationKey,
  )
}

/** Verifies the exact persisted child-material wrapper and HMAC. */
function readPersistedSuccessMaterial(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  verificationKey: Uint8Array,
): PersistedSuccessMaterial {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, persistedMaterialKeys)
  if (
    finalizerGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence' ||
    finalizerGuards.readOwn(record, 'evidenceVersion') !== 1
  ) return failStageFinalizer()
  const materialDigest = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'materialDigest'),
  )
  const observedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'observedAt'),
  )
  const material =
    verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
      material: finalizerGuards.readOwn(record, 'material'),
      selection,
      verificationKey,
    })
  if (createMigrationDigest(material) !== materialDigest) {
    return failStageFinalizer()
  }
  const wrapper = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
    evidenceVersion: 1,
    material,
    materialDigest,
    observedAt,
  })
  return Object.freeze({
    kind: 'success',
    material,
    materialDigest,
    observedAt,
    materialEvidenceDigest: createMigrationDigest(wrapper),
    boundaryMaterialEvidenceDigest: null,
    faultPlanDigest: null,
    boundaryRateSegmentBytesDigest: null,
    finalRateSegmentBytesDigest: null,
  })
}

/** Detached exact persisted fault-material wrapper before HMAC verification. */
type PersistedFaultMaterialWrapper = {
  /** Exact untrusted nested material candidate. */
  readonly materialValue: unknown
  /** Claimed digest of the nested material candidate. */
  readonly materialDigest: string
  /** Parent time at which the complete material line was observed. */
  readonly observedAt: string
  /** Exact evidence discriminator used to reconstruct the wrapper. */
  readonly kind:
    | 'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
    | 'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
}

/** Reads one exact persisted fault wrapper without trusting nested material. */
function readPersistedFaultMaterialWrapper(
  value: unknown,
  expectedKind: PersistedFaultMaterialWrapper['kind'],
): PersistedFaultMaterialWrapper {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, persistedFaultMaterialKeys)
  if (
    finalizerGuards.readOwn(record, 'kind') !== expectedKind ||
    finalizerGuards.readOwn(record, 'evidenceVersion') !== 1
  ) return failStageFinalizer()
  return Object.freeze({
    kind: expectedKind,
    materialValue: finalizerGuards.readOwn(record, 'material'),
    materialDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'materialDigest'),
    ),
    observedAt: finalizerGuards.readTimestamp(
      finalizerGuards.readOwn(record, 'observedAt'),
    ),
  })
}

/** Verifies one persisted SIGKILL boundary against plan and rate bytes. */
function readPersistedFaultBoundaryMaterial(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  boundaryRateSegmentBytes: Uint8Array,
  verificationKey: Uint8Array,
): PersistedFaultBoundaryMaterial {
  const wrapper = readPersistedFaultMaterialWrapper(
    value,
    'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
  )
  const material =
    verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
      material: wrapper.materialValue,
      selection,
      faultPlan,
      rateSegmentBytes: boundaryRateSegmentBytes,
      verificationKey,
    })
  if (createMigrationDigest(material) !== wrapper.materialDigest) {
    return failStageFinalizer()
  }
  const evidence = Object.freeze({
    kind: wrapper.kind,
    evidenceVersion: 1,
    material,
    materialDigest: wrapper.materialDigest,
    observedAt: wrapper.observedAt,
  })
  return Object.freeze({
    kind: 'fault-boundary',
    material,
    materialDigest: wrapper.materialDigest,
    observedAt: wrapper.observedAt,
    materialEvidenceDigest: createMigrationDigest(evidence),
    boundaryMaterialEvidenceDigest: null,
    faultPlanDigest: createMigrationDigest(faultPlan),
    boundaryRateSegmentBytesDigest:
      hashStageFinalizerEvidenceBytes(boundaryRateSegmentBytes),
    finalRateSegmentBytesDigest: null,
  })
}

/** Verifies persisted response-loss boundary and completion as one protocol. */
function readPersistedFaultCompletionMaterial(
  completionValue: unknown,
  boundaryValue: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  boundaryRateSegmentBytes: Uint8Array,
  finalRateSegmentBytes: Uint8Array,
  verificationKey: Uint8Array,
): PersistedFaultCompletionMaterial {
  const boundaryWrapper = readPersistedFaultMaterialWrapper(
    boundaryValue,
    'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
  )
  const boundaryMaterial =
    verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
      material: boundaryWrapper.materialValue,
      selection,
      faultPlan,
      rateSegmentBytes: boundaryRateSegmentBytes,
      verificationKey,
    })
  if (createMigrationDigest(boundaryMaterial) !==
    boundaryWrapper.materialDigest) return failStageFinalizer()
  const completionWrapper = readPersistedFaultMaterialWrapper(
    completionValue,
    'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence',
  )
  const material =
    verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
      material: completionWrapper.materialValue,
      selection,
      faultPlan,
      boundaryMaterial,
      boundaryRateSegmentBytes,
      finalRateSegmentBytes,
      verificationKey,
    })
  if (createMigrationDigest(material) !== completionWrapper.materialDigest) {
    return failStageFinalizer()
  }
  const boundaryEvidence = Object.freeze({
    kind: boundaryWrapper.kind,
    evidenceVersion: 1,
    material: boundaryMaterial,
    materialDigest: boundaryWrapper.materialDigest,
    observedAt: boundaryWrapper.observedAt,
  })
  const completionEvidence = Object.freeze({
    kind: completionWrapper.kind,
    evidenceVersion: 1,
    material,
    materialDigest: completionWrapper.materialDigest,
    observedAt: completionWrapper.observedAt,
  })
  return Object.freeze({
    kind: 'fault-completion',
    material,
    boundaryMaterial,
    materialDigest: completionWrapper.materialDigest,
    boundaryMaterialDigest: boundaryWrapper.materialDigest,
    observedAt: completionWrapper.observedAt,
    boundaryObservedAt: boundaryWrapper.observedAt,
    materialEvidenceDigest: createMigrationDigest(completionEvidence),
    boundaryMaterialEvidenceDigest: createMigrationDigest(boundaryEvidence),
    faultPlanDigest: createMigrationDigest(faultPlan),
    boundaryRateSegmentBytesDigest:
      hashStageFinalizerEvidenceBytes(boundaryRateSegmentBytes),
    finalRateSegmentBytesDigest:
      hashStageFinalizerEvidenceBytes(finalRateSegmentBytes),
  })
}

/** Reads, binds, and normalizes one persisted parent lifecycle. */
function readPersistedLifecycle(
  value: unknown,
  persistedMaterial: PersistedStageMaterial,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
): NormalizedStageLifecycle {
  const wrapper = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(wrapper, persistedLifecycleKeys)
  if (
    finalizerGuards.readOwn(wrapper, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence'
  ) return failStageFinalizer()
  const lifecycleSha256 = finalizerGuards.readDigest(
    finalizerGuards.readOwn(wrapper, 'lifecycleSha256'),
  )
  const record = finalizerGuards.requireRecord(
    finalizerGuards.readOwn(wrapper, 'lifecycle'),
  )
  return persistedMaterial.kind === 'success'
    ? readPersistedSuccessLifecycle(
        record,
        lifecycleSha256,
        persistedMaterial,
        selection,
      )
    : readPersistedFaultLifecycle(
        record,
        lifecycleSha256,
        persistedMaterial,
        selection,
      )
}

/** Reads one ordinary or takeover-completed successful lifecycle. */
function readPersistedSuccessLifecycle(
  record: object,
  lifecycleSha256: string,
  persistedMaterial: PersistedSuccessMaterial,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
): NormalizedStageLifecycle {
  finalizerGuards.requireExactKeys(record, successfulLifecycleKeys)
  if (
    finalizerGuards.readOwn(record, 'lifecycleVersion') !== 1 ||
    finalizerGuards.readOwn(record, 'manifestDigest') !==
      selection.manifestDigest ||
    finalizerGuards.readOwn(record, 'manifestEntryDigest') !==
      createMigrationDigest(selection.entry) ||
    finalizerGuards.readOwn(record, 'previousStageReceiptDigest') !==
      selection.previousStageReceiptDigest ||
    finalizerGuards.readOwn(record, 'stageOrdinal') !==
      selection.entry.ordinal ||
    finalizerGuards.readOwn(record, 'scenario') !==
      selection.entry.scenario ||
    finalizerGuards.readOwn(record, 'command') !== selection.entry.command ||
    finalizerGuards.readOwn(record, 'attemptOrdinal') !==
      selection.entry.attemptOrdinal ||
    finalizerGuards.readOwn(record, 'expectedOutcome') !==
      selection.entry.expectedOutcome ||
    (
      selection.entry.expectedOutcome !== 'completed' &&
      selection.entry.expectedOutcome !== 'takeover-completed'
    ) ||
    selection.entry.faultPlanDigest !== null ||
    finalizerGuards.readOwn(record, 'materialDigest') !==
      persistedMaterial.materialDigest ||
    finalizerGuards.readOwn(record, 'exitClass') !== 'successful-no-fault'
  ) return failStageFinalizer()
  const stdoutSha256 = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'stdoutSha256'),
  )
  const runnerStartedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'runnerStartedAt'),
  )
  const materialObservedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'materialObservedAt'),
  )
  const materialPersistedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'materialPersistedAt'),
  )
  const processExitedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'processExitedAt'),
  )
  if (
    materialObservedAt !== persistedMaterial.observedAt ||
    Date.parse(materialObservedAt) < Date.parse(runnerStartedAt) ||
    Date.parse(materialPersistedAt) < Date.parse(materialObservedAt) ||
    Date.parse(processExitedAt) < Date.parse(materialPersistedAt)
  ) return failStageFinalizer()
  const source: WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence =
    Object.freeze({
      lifecycleVersion: 1,
      manifestDigest: selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(selection.entry),
      previousStageReceiptDigest: selection.previousStageReceiptDigest,
      stageOrdinal: selection.entry.ordinal,
      scenario: selection.entry.scenario,
      command: selection.entry.command,
      attemptOrdinal: selection.entry.attemptOrdinal,
      expectedOutcome: selection.entry.expectedOutcome,
      materialDigest: persistedMaterial.materialDigest,
      stdoutSha256,
      runnerStartedAt,
      materialObservedAt,
      materialPersistedAt,
      processExitedAt,
      exitClass: 'successful-no-fault',
    })
  if (createMigrationDigest(source) !== lifecycleSha256) {
    return failStageFinalizer()
  }
  const receiptLifecycle = Object.freeze({
    lifecycleDigest: lifecycleSha256,
    runnerStartedAt,
    receiptObservedAt: materialObservedAt,
    receiptPersistedAt: materialPersistedAt,
    parentDecisionRecordedAt: null,
    processExitedAt,
    exitClass: 'successful-no-fault',
  })
  return Object.freeze({
    source,
    receiptLifecycle,
    startedAt: runnerStartedAt,
    completedAt: materialObservedAt,
  })
}

/** Reads one stopped-boundary or response-loss authenticated fault lifecycle. */
function readPersistedFaultLifecycle(
  record: object,
  lifecycleSha256: string,
  persistedMaterial:
    PersistedFaultBoundaryMaterial | PersistedFaultCompletionMaterial,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
): NormalizedStageLifecycle {
  finalizerGuards.requireExactKeys(record, faultLifecycleKeys)
  const boundaryMaterial = persistedMaterial.kind === 'fault-boundary'
    ? persistedMaterial.material
    : persistedMaterial.boundaryMaterial
  const expectedOutcome = persistedMaterial.kind === 'fault-boundary'
    ? 'fault-reached'
    : 'response-loss-reconciled'
  const expectedExitClass = persistedMaterial.kind === 'fault-boundary'
    ? 'confirmed-sigkill'
    : 'successful-response-loss'
  if (
    finalizerGuards.readOwn(record, 'lifecycleVersion') !== 1 ||
    finalizerGuards.readOwn(record, 'manifestDigest') !==
      selection.manifestDigest ||
    finalizerGuards.readOwn(record, 'manifestEntryDigest') !==
      createMigrationDigest(selection.entry) ||
    finalizerGuards.readOwn(record, 'previousStageReceiptDigest') !==
      selection.previousStageReceiptDigest ||
    finalizerGuards.readOwn(record, 'stageOrdinal') !==
      selection.entry.ordinal ||
    finalizerGuards.readOwn(record, 'scenario') !==
      selection.entry.scenario ||
    finalizerGuards.readOwn(record, 'command') !== selection.entry.command ||
    finalizerGuards.readOwn(record, 'attemptOrdinal') !==
      selection.entry.attemptOrdinal ||
    finalizerGuards.readOwn(record, 'expectedOutcome') !== expectedOutcome ||
    selection.entry.expectedOutcome !== expectedOutcome ||
    finalizerGuards.readOwn(record, 'faultPlanDigest') !==
      persistedMaterial.faultPlanDigest ||
    finalizerGuards.readOwn(record, 'faultReceiptDigest') !==
      boundaryMaterial.faultReceiptDigest ||
    finalizerGuards.readOwn(record, 'boundaryMaterialDigest') !==
      (persistedMaterial.kind === 'fault-boundary'
        ? persistedMaterial.materialDigest
        : persistedMaterial.boundaryMaterialDigest) ||
    finalizerGuards.readOwn(record, 'completionMaterialDigest') !==
      (persistedMaterial.kind === 'fault-completion'
        ? persistedMaterial.materialDigest
        : null) ||
    finalizerGuards.readOwn(record, 'exitClass') !== expectedExitClass
  ) return failStageFinalizer()
  const stdoutSha256 = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'stdoutSha256'),
  )
  const materialStreamSha256 = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'materialStreamSha256'),
  )
  const runnerStartedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'runnerStartedAt'),
  )
  const boundaryMaterialObservedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'boundaryMaterialObservedAt'),
  )
  const boundaryMaterialPersistedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'boundaryMaterialPersistedAt'),
  )
  const boundaryDecisionRecordedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'boundaryDecisionRecordedAt'),
  )
  const completionMaterialObservedAt = readNullableTimestamp(
    finalizerGuards.readOwn(record, 'completionMaterialObservedAt'),
  )
  const completionMaterialPersistedAt = readNullableTimestamp(
    finalizerGuards.readOwn(record, 'completionMaterialPersistedAt'),
  )
  const completionDecisionRecordedAt = readNullableTimestamp(
    finalizerGuards.readOwn(record, 'completionDecisionRecordedAt'),
  )
  const processExitedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'processExitedAt'),
  )
  const expectedBoundaryObservedAt =
    persistedMaterial.kind === 'fault-completion'
      ? persistedMaterial.boundaryObservedAt
      : persistedMaterial.observedAt
  if (
    boundaryMaterialObservedAt !== expectedBoundaryObservedAt ||
    Date.parse(boundaryMaterialObservedAt) < Date.parse(runnerStartedAt) ||
    Date.parse(boundaryMaterialPersistedAt) <
      Date.parse(boundaryMaterialObservedAt) ||
    Date.parse(boundaryDecisionRecordedAt) <
      Date.parse(boundaryMaterialPersistedAt)
  ) return failStageFinalizer()
  if (persistedMaterial.kind === 'fault-boundary') {
    if (
      completionMaterialObservedAt !== null ||
      completionMaterialPersistedAt !== null ||
      completionDecisionRecordedAt !== null ||
      Date.parse(processExitedAt) < Date.parse(boundaryDecisionRecordedAt)
    ) return failStageFinalizer()
  } else if (
    completionMaterialObservedAt !== persistedMaterial.observedAt ||
    completionMaterialPersistedAt === null ||
    completionDecisionRecordedAt === null ||
    Date.parse(completionMaterialObservedAt) <
      Date.parse(boundaryDecisionRecordedAt) ||
    Date.parse(completionMaterialPersistedAt) <
      Date.parse(completionMaterialObservedAt) ||
    Date.parse(completionDecisionRecordedAt) <
      Date.parse(completionMaterialPersistedAt) ||
    Date.parse(processExitedAt) < Date.parse(completionDecisionRecordedAt)
  ) return failStageFinalizer()
  const source:
    WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence =
    Object.freeze({
      lifecycleVersion: 1,
      manifestDigest: selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(selection.entry),
      previousStageReceiptDigest: selection.previousStageReceiptDigest,
      stageOrdinal: selection.entry.ordinal,
      scenario: selection.entry.scenario,
      command: selection.entry.command,
      attemptOrdinal: selection.entry.attemptOrdinal,
      expectedOutcome,
      faultPlanDigest: persistedMaterial.faultPlanDigest,
      faultReceiptDigest: boundaryMaterial.faultReceiptDigest,
      boundaryMaterialDigest: persistedMaterial.kind === 'fault-boundary'
        ? persistedMaterial.materialDigest
        : persistedMaterial.boundaryMaterialDigest,
      completionMaterialDigest: persistedMaterial.kind === 'fault-completion'
        ? persistedMaterial.materialDigest
        : null,
      stdoutSha256,
      materialStreamSha256,
      runnerStartedAt,
      boundaryMaterialObservedAt,
      boundaryMaterialPersistedAt,
      boundaryDecisionRecordedAt,
      completionMaterialObservedAt,
      completionMaterialPersistedAt,
      completionDecisionRecordedAt,
      processExitedAt,
      exitClass: expectedExitClass,
    })
  if (createMigrationDigest(source) !== lifecycleSha256) {
    return failStageFinalizer()
  }
  const primaryObservedAt = completionMaterialObservedAt ??
    boundaryMaterialObservedAt
  const primaryPersistedAt = completionMaterialPersistedAt ??
    boundaryMaterialPersistedAt
  const primaryDecisionAt = completionDecisionRecordedAt ??
    boundaryDecisionRecordedAt
  return Object.freeze({
    source,
    receiptLifecycle: Object.freeze({
      lifecycleDigest: lifecycleSha256,
      runnerStartedAt,
      receiptObservedAt: primaryObservedAt,
      receiptPersistedAt: primaryPersistedAt,
      parentDecisionRecordedAt: primaryDecisionAt,
      processExitedAt,
      exitClass: expectedExitClass,
    }),
    startedAt: runnerStartedAt,
    completedAt: primaryObservedAt,
  })
}

/** Creates the exact parent-authentication claims from normalized evidence. */
function createParentAuthenticationClaims(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  persistedMaterial: PersistedStageMaterial,
  lifecycle: NormalizedStageLifecycle,
  runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding,
): WorkspaceSearchMigrationRehearsalStageParentAuthenticationClaims {
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_KIND,
    authenticationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_VERSION,
    manifestDigest: selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(selection.entry),
    previousStageReceiptDigest: selection.previousStageReceiptDigest,
    stageOrdinal: selection.entry.ordinal,
    materialEvidenceDigest: persistedMaterial.materialEvidenceDigest,
    boundaryMaterialEvidenceDigest:
      persistedMaterial.boundaryMaterialEvidenceDigest,
    faultPlanDigest: persistedMaterial.faultPlanDigest,
    boundaryRateSegmentBytesDigest:
      persistedMaterial.boundaryRateSegmentBytesDigest,
    finalRateSegmentBytesDigest:
      persistedMaterial.finalRateSegmentBytesDigest,
    lifecycleEvidenceDigest: createMigrationDigest({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
      lifecycle: lifecycle.source,
      lifecycleSha256: lifecycle.receiptLifecycle.lifecycleDigest,
    }),
    runtimeKeyCleanupAuthorization,
  })
}

/**
 * Requires a valid parent-origin HMAC over both persisted evidence files.
 *
 * @param value - Candidate complete parent-authentication record.
 * @param selection - Runtime-authenticated exact selected stage.
 * @param persistedMaterial - Reauthenticated persisted child material.
 * @param lifecycle - Reauthenticated normalized parent lifecycle.
 * @param authenticationKey - Parent-only publication verification key.
 * @returns Frozen canonical parent-authentication record.
 */
function verifyParentAuthentication(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  persistedMaterial: PersistedStageMaterial,
  lifecycle: NormalizedStageLifecycle,
  expectedRuntimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding |
    undefined,
  authenticationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageParentAuthentication {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, parentAuthenticationKeys)
  const claims = readParentAuthenticationClaims(record)
  requireRuntimeKeyCleanupAuthorizationMatchesStage(
    claims.runtimeKeyCleanupAuthorization,
    selection,
    persistedMaterial,
    lifecycle,
  )
  if (
    expectedRuntimeKeyCleanupAuthorization !== undefined &&
    serializeCanonicalJson(claims.runtimeKeyCleanupAuthorization) !==
      serializeCanonicalJson(expectedRuntimeKeyCleanupAuthorization)
  ) return failStageFinalizer()
  const expectedClaims = createParentAuthenticationClaims(
    selection,
    persistedMaterial,
    lifecycle,
    claims.runtimeKeyCleanupAuthorization,
  )
  const authenticationMac = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'authenticationMac'),
  )
  if (
    serializeCanonicalJson(claims) !== serializeCanonicalJson(expectedClaims) ||
    !safeDigestEqual(
      authenticationMac,
      createParentAuthenticationMac(claims, authenticationKey),
    )
  ) return failStageFinalizer()
  return Object.freeze({
    ...claims,
    authenticationMac,
  })
}

/** Reads exact detached parent-authentication claims. */
function readParentAuthenticationClaims(
  record: object,
): WorkspaceSearchMigrationRehearsalStageParentAuthenticationClaims {
  if (
    finalizerGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_KIND ||
    finalizerGuards.readOwn(record, 'authenticationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_VERSION
  ) return failStageFinalizer()
  const stageOrdinal = finalizerGuards.readOwn(record, 'stageOrdinal')
  if (
    typeof stageOrdinal !== 'number' ||
    !Number.isSafeInteger(stageOrdinal) ||
    stageOrdinal <= 0
  ) return failStageFinalizer()
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_KIND,
    authenticationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_VERSION,
    manifestDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'manifestDigest'),
    ),
    manifestEntryDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'manifestEntryDigest'),
    ),
    previousStageReceiptDigest: readNullableDigest(
      finalizerGuards.readOwn(record, 'previousStageReceiptDigest'),
    ),
    stageOrdinal,
    materialEvidenceDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'materialEvidenceDigest'),
    ),
    boundaryMaterialEvidenceDigest: readNullableDigest(
      finalizerGuards.readOwn(record, 'boundaryMaterialEvidenceDigest'),
    ),
    faultPlanDigest: readNullableDigest(
      finalizerGuards.readOwn(record, 'faultPlanDigest'),
    ),
    boundaryRateSegmentBytesDigest: readNullableDigest(
      finalizerGuards.readOwn(record, 'boundaryRateSegmentBytesDigest'),
    ),
    finalRateSegmentBytesDigest: readNullableDigest(
      finalizerGuards.readOwn(record, 'finalRateSegmentBytesDigest'),
    ),
    lifecycleEvidenceDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'lifecycleEvidenceDigest'),
    ),
    runtimeKeyCleanupAuthorization:
      readRuntimeKeyCleanupAuthorizationBinding(
        finalizerGuards.readOwn(
          record,
          'runtimeKeyCleanupAuthorization',
        ),
      ),
  })
}

/** Exact fields retained from one genuine cleanup authorization binding. */
const runtimeKeyCleanupAuthorizationBindingKeys = Object.freeze([
  'authorizationBindingDigest',
  'cleanupCompletionDigest',
  'cleanupIntentDigest',
  'completedAt',
  'manifestDigest',
  'parentLivenessProtocol',
  'permitDigest',
  'preparedAt',
  'requestedResourcesBinding',
  'reservationDigest',
  'runtimeFileIdentityDigest',
  'runtimeKeyFingerprint',
  'stageOrdinal',
])

/**
 * Reads one genuine cleanup capability and binds it to this exact stage.
 *
 * @param value - Candidate same-process cleanup authorization capability.
 * @param selection - Runtime-authenticated reviewed stage selection.
 * @param persistedMaterial - Reauthenticated exact child material.
 * @param lifecycle - Parent-observed child lifecycle.
 * @returns Detached cleanup binding safe to persist under the parent HMAC.
 */
function readGenuineRuntimeKeyCleanupAuthorization(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  persistedMaterial: PersistedStageMaterial,
  lifecycle: NormalizedStageLifecycle,
): WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding {
  const binding =
    readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
      value,
    )
  const result = Object.freeze({
    ...binding,
    authorizationBindingDigest: createMigrationDigest(binding),
  })
  requireRuntimeKeyCleanupAuthorizationMatchesStage(
    result,
    selection,
    persistedMaterial,
    lifecycle,
  )
  return result
}

/** Reads strict parent-authenticated cleanup claims from persisted material. */
function readRuntimeKeyCleanupAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(
    record,
    runtimeKeyCleanupAuthorizationBindingKeys,
  )
  const stageOrdinalValue = finalizerGuards.readOwn(record, 'stageOrdinal')
  if (
    typeof stageOrdinalValue !== 'number' ||
    !Number.isSafeInteger(stageOrdinalValue) ||
    stageOrdinalValue <= 0
  ) return failStageFinalizer()
  if (
    finalizerGuards.readOwn(record, 'parentLivenessProtocol') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failStageFinalizer()
  const preparedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'preparedAt'),
  )
  const completedAt = finalizerGuards.readTimestamp(
    finalizerGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(preparedAt) > Date.parse(completedAt)) {
    return failStageFinalizer()
  }
  const binding = Object.freeze({
    reservationDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'reservationDigest'),
    ),
    manifestDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'manifestDigest'),
    ),
    permitDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    stageOrdinal: stageOrdinalValue,
    parentLivenessProtocol:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
    runtimeKeyFingerprint: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'runtimeKeyFingerprint'),
    ),
    runtimeFileIdentityDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'runtimeFileIdentityDigest'),
    ),
    cleanupIntentDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'cleanupIntentDigest'),
    ),
    cleanupCompletionDigest: finalizerGuards.readDigest(
      finalizerGuards.readOwn(record, 'cleanupCompletionDigest'),
    ),
    preparedAt,
    completedAt,
  })
  const authorizationBindingDigest = finalizerGuards.readDigest(
    finalizerGuards.readOwn(record, 'authorizationBindingDigest'),
  )
  if (
    authorizationBindingDigest !== createMigrationDigest(binding) ||
    binding.cleanupIntentDigest === binding.cleanupCompletionDigest
  ) return failStageFinalizer()
  return Object.freeze({ ...binding, authorizationBindingDigest })
}

/** Requires a cleanup binding to name this exact stage and lifecycle. */
function requireRuntimeKeyCleanupAuthorizationMatchesStage(
  cleanup:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  persistedMaterial: PersistedStageMaterial,
  lifecycle: NormalizedStageLifecycle,
): void {
  const reservation = persistedMaterial.material.stageReservation
  if (
    cleanup.authorizationBindingDigest !==
      createMigrationDigest(removeCleanupAuthorizationBindingDigest(cleanup)) ||
    cleanup.reservationDigest !== createMigrationDigest(reservation) ||
    cleanup.manifestDigest !== selection.manifestDigest ||
    cleanup.manifestDigest !== reservation.manifestDigest ||
    cleanup.permitDigest !== selection.manifest.permitDigest ||
    cleanup.permitDigest !== reservation.permitDigest ||
    cleanup.requestedResourcesBinding !==
      selection.manifest.requestedResourcesBinding ||
    cleanup.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    cleanup.stageOrdinal !== selection.entry.ordinal ||
    cleanup.stageOrdinal !== reservation.stageOrdinal ||
    cleanup.parentLivenessProtocol !== reservation.parentLivenessProtocol ||
    Date.parse(cleanup.preparedAt) < Date.parse(lifecycle.completedAt) ||
    Date.parse(cleanup.preparedAt) <
      Date.parse(lifecycle.receiptLifecycle.processExitedAt) ||
    Date.parse(cleanup.preparedAt) <
      Date.parse(lifecycle.receiptLifecycle.receiptPersistedAt) ||
    (lifecycle.receiptLifecycle.parentDecisionRecordedAt !== null &&
      Date.parse(cleanup.preparedAt) <
        Date.parse(lifecycle.receiptLifecycle.parentDecisionRecordedAt)) ||
    Date.parse(cleanup.completedAt) < Date.parse(cleanup.preparedAt) ||
    Date.parse(cleanup.completedAt) >= Date.parse(reservation.expiresAt)
  ) return failStageFinalizer()
}

/** Removes the outer digest from a persisted cleanup authorization binding. */
function removeCleanupAuthorizationBindingDigest(
  cleanup:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding {
  return Object.freeze({
    reservationDigest: cleanup.reservationDigest,
    manifestDigest: cleanup.manifestDigest,
    permitDigest: cleanup.permitDigest,
    requestedResourcesBinding: cleanup.requestedResourcesBinding,
    stageOrdinal: cleanup.stageOrdinal,
    parentLivenessProtocol: cleanup.parentLivenessProtocol,
    runtimeKeyFingerprint: cleanup.runtimeKeyFingerprint,
    runtimeFileIdentityDigest: cleanup.runtimeFileIdentityDigest,
    cleanupIntentDigest: cleanup.cleanupIntentDigest,
    cleanupCompletionDigest: cleanup.cleanupCompletionDigest,
    preparedAt: cleanup.preparedAt,
    completedAt: cleanup.completedAt,
  })
}

/** Creates the domain-separated parent-authentication HMAC. */
function createParentAuthenticationMac(
  claims: WorkspaceSearchMigrationRehearsalStageParentAuthenticationClaims,
  authenticationKey: Uint8Array,
): string {
  return createHmac('sha256', authenticationKey)
    .update(parentAuthenticationMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/**
 * Requires the parent-only key to match the authenticated manifest digest.
 *
 * @param selection - Runtime-authenticated exact stage selection.
 * @param publicationKey - Parent-only key supplied for publication HMACs.
 */
function requirePublicationAuthenticationKeyMatchesSelection(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  publicationKey: Uint8Array,
): void {
  const observedDigest = createHash('sha256')
    .update(publicationKey)
    .digest('hex')
  if (observedDigest !== selection.manifest.publicationKeyDigest) {
    return failStageFinalizer()
  }
}

/** Compares fixed-size lowercase digest bytes without string timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Dispatches one authenticated material protocol into complete receipt state. */
function deriveStageReceiptState(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  persistedMaterial: PersistedStageMaterial,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  proofValue: unknown,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
  runLocatorDigest: string,
): DerivedStageReceiptState {
  if (persistedMaterial.kind === 'fault-boundary') {
    if (
      selection.entry.expectedOutcome !== 'fault-reached' ||
      selection.entry.faultPlanDigest !== persistedMaterial.faultPlanDigest
    ) return failStageFinalizer()
    const faultBoundary = deriveFaultBoundaryEvidence(
      selection,
      persistedMaterial.material,
      lifecycle,
      previous,
      proofValue,
      runtimeAuthenticationKey,
      publicationAuthenticationKey,
      runLocatorDigest,
    )
    const writerFenceDigest =
      deriveFaultBoundaryWriterFence(
        persistedMaterial.material,
        previous,
      )
    return Object.freeze({
      evidence: faultBoundary,
      writerFenceDigest,
      evidenceCompletedAt: lifecycle.receiptLifecycle.processExitedAt,
      serializedOutputLineDigest: persistedMaterial.materialDigest,
      stageReservation: persistedMaterial.material.stageReservation,
      claimedStageHead: persistedMaterial.material.claimedStageHead,
      leaseIdentityDigest: persistedMaterial.material.leaseIdentityDigest,
      leaseObservation: snapshotStageLeaseObservation(
        persistedMaterial.material.leaseAcquisitionObservation,
      ),
      outcome: 'fault-reached',
      faultReceiptDigest: faultBoundary.faultReceiptDigest,
      faultBoundary,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: null,
      completedAt: lifecycle.receiptLifecycle.processExitedAt,
      rateSegment: persistedMaterial.material.rateSegment,
    })
  }
  if (persistedMaterial.kind === 'fault-completion') {
    if (
      selection.entry.expectedOutcome !== 'response-loss-reconciled' ||
      selection.entry.faultPlanDigest !== persistedMaterial.faultPlanDigest
    ) return failStageFinalizer()
    const faultBoundary = deriveFaultBoundaryEvidence(
      selection,
      persistedMaterial.boundaryMaterial,
      lifecycle,
      previous,
      proofValue,
      runtimeAuthenticationKey,
      publicationAuthenticationKey,
      runLocatorDigest,
    )
    const derived = derivePlanningStageEvidence(
      persistedMaterial.material.mutationResult.coordinator,
      lifecycle,
      previous,
      proofValue,
    )
    if (
      faultBoundary.failpoint !==
        'planning-page-transaction-response-lost' ||
      derived.evidence.kind !== 'planning-sealed' ||
      persistedMaterial.material.faultObservation.kind !== 'planning-page' ||
      derived.writerFenceDigest !==
        persistedMaterial.material.faultObservation
          .closedWriterFenceRecordDigest
    ) return failStageFinalizer()
    return Object.freeze({
      ...derived,
      serializedOutputLineDigest:
        persistedMaterial.material.serializedOutputLineDigest,
      stageReservation: persistedMaterial.material.stageReservation,
      claimedStageHead: persistedMaterial.material.claimedStageHead,
      leaseIdentityDigest: persistedMaterial.material.leaseIdentityDigest,
      leaseObservation: snapshotStageLeaseObservation(
        persistedMaterial.material.leaseAcquisitionObservation,
      ),
      outcome: 'response-loss-reconciled',
      faultReceiptDigest: faultBoundary.faultReceiptDigest,
      faultBoundary,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: derived.evidence.sealedAt,
      completedAt: lifecycle.receiptLifecycle.processExitedAt,
      rateSegment: persistedMaterial.material.rateSegment,
    })
  }
  if (
    selection.entry.faultPlanDigest !== null ||
    (selection.entry.expectedOutcome !== 'completed' &&
      selection.entry.expectedOutcome !== 'takeover-completed')
  ) return failStageFinalizer()
  const derived = deriveSuccessfulStageEvidence(
    selection,
    persistedMaterial.material,
    lifecycle,
    previous,
    proofValue,
    runtimeAuthenticationKey,
    publicationAuthenticationKey,
    runLocatorDigest,
  )
  const takeover = selection.entry.expectedOutcome === 'takeover-completed'
  if (
    takeover &&
    (previous?.outcome !== 'fault-reached' ||
      previous.faultReceiptDigest === null)
  ) return failStageFinalizer()
  const leaseRecovery = deriveLeaseRecovery(
    takeover,
    persistedMaterial.material,
    lifecycle,
    previous,
  )
  return Object.freeze({
    ...derived,
    serializedOutputLineDigest:
      persistedMaterial.material.serializedOutputLineDigest,
    stageReservation: persistedMaterial.material.stageReservation,
    claimedStageHead: persistedMaterial.material.claimedStageHead,
    leaseIdentityDigest: persistedMaterial.material.leaseIdentityDigest,
    leaseObservation: snapshotStageLeaseObservation(
      persistedMaterial.material.leaseAcquisitionObservation,
    ),
    outcome: selection.entry.expectedOutcome,
    faultReceiptDigest: takeover
      ? previous?.faultReceiptDigest ?? failStageFinalizer()
      : null,
    faultBoundary: null,
    ...leaseRecovery,
    reconciledAt: null,
    completedAt: derived.evidenceCompletedAt,
    rateSegment: persistedMaterial.material.rateSegment,
  })
}

/** Snapshots the cycle-free adapter lease observation for durable receipts. */
function snapshotStageLeaseObservation(
  observation:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['leaseAcquisitionObservation'],
): WorkspaceSearchMigrationRehearsalStageLeaseObservation {
  return observation.kind === 'acquired'
    ? Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest:
          observation.predecessorLeaseIdentityDigest,
        predecessorLeaseExpiresAt: observation.predecessorLeaseExpiresAt,
        acquiredAt: observation.acquiredAt,
        successorLeaseIdentityDigest:
          observation.successorLeaseIdentityDigest,
        successorLeaseExpiresAt: observation.successorLeaseExpiresAt,
      })
    : Object.freeze({
        kind: 'reused-active',
        currentLeaseIdentityDigest: observation.currentLeaseIdentityDigest,
        evaluatedAt: observation.evaluatedAt,
        currentLeaseExpiresAt: observation.currentLeaseExpiresAt,
      })
}

/** Derives and validates strict takeover recovery against the killed boundary. */
function deriveLeaseRecovery(
  takeover: boolean,
  material: WorkspaceSearchMigrationRehearsalStageChildMaterial,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): DerivedLeaseRecovery {
  if (!takeover) {
    return Object.freeze({
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
    })
  }
  const observation = material.leaseAcquisitionObservation
  if (
    observation.kind !== 'acquired' ||
    observation.predecessorLeaseIdentityDigest === null ||
    observation.predecessorLeaseExpiresAt === null ||
    previous?.faultBoundary === null ||
    previous?.faultBoundary === undefined ||
    previous.faultBoundary.leaseIdentityDigest !==
      observation.predecessorLeaseIdentityDigest ||
    previous.leaseIdentityDigest !==
      observation.predecessorLeaseIdentityDigest ||
    material.leaseIdentityDigest !==
      observation.successorLeaseIdentityDigest ||
    Date.parse(observation.predecessorLeaseExpiresAt) <=
      Date.parse(previous.processLifecycle.processExitedAt) ||
    Date.parse(lifecycle.startedAt) <
      Date.parse(observation.predecessorLeaseExpiresAt) ||
    Date.parse(observation.acquiredAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(observation.acquiredAt) >= Date.parse(lifecycle.completedAt)
  ) return failStageFinalizer()
  return Object.freeze({
    predecessorLeaseExpiresAt: observation.predecessorLeaseExpiresAt,
    takeoverAcquiredAt: observation.acquiredAt,
  })
}

/** Requires adapter-observed lease identity and chronology across receipts. */
function requireLeaseObservationContinuity(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  derived: DerivedStageReceiptState,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): void {
  const observation = derived.leaseObservation
  const currentIdentity = observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
  const observedAt = observation.kind === 'acquired'
    ? observation.acquiredAt
    : observation.evaluatedAt
  if (
    derived.leaseIdentityDigest !== currentIdentity ||
    Date.parse(observedAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(observedAt) >= Date.parse(lifecycle.completedAt)
  ) return failStageFinalizer()
  if (previous === null) {
    if (selection.entry.ordinal !== 1 || observation.kind !== 'acquired') {
      return failStageFinalizer()
    }
    return
  }
  if (observation.kind === 'reused-active') {
    if (
      previous.scenario !== selection.entry.scenario ||
      previous.attemptOrdinal !== selection.entry.attemptOrdinal ||
      observation.currentLeaseIdentityDigest !== previous.leaseIdentityDigest
    ) return failStageFinalizer()
    return
  }
  if (
    observation.predecessorLeaseIdentityDigest !==
      previous.leaseIdentityDigest ||
    observation.predecessorLeaseExpiresAt === null ||
    Date.parse(observation.predecessorLeaseExpiresAt) <=
      Date.parse(previous.processLifecycle.processExitedAt) ||
    Date.parse(observation.predecessorLeaseExpiresAt) >
      Date.parse(observation.acquiredAt)
  ) return failStageFinalizer()
  const takeover = selection.entry.expectedOutcome === 'takeover-completed'
  if (
    takeover !==
      (previous.scenario === selection.entry.scenario &&
        previous.attemptOrdinal + 1 === selection.entry.attemptOrdinal)
  ) return failStageFinalizer()
}

/** Derives one cursor-free fault projection from authenticated boundary material. */
function deriveFaultBoundaryEvidence(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  material: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  proofValue: unknown,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
  runLocatorDigest: string,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  const receipt = material.faultReceipt
  const observation = material.faultObservation
  if (
    Date.parse(receipt.reachedAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(receipt.reachedAt) > Date.parse(lifecycle.completedAt) ||
    observation.leaseIdentityDigest !== material.leaseIdentityDigest
  ) return failStageFinalizer()
  const appliedOperationCount = observation.durableAppliedOperationCount
  const sealedPlanOperationCount = observation.sealedPlanOperationCount
  let targetPreimageArtifactContentDigest: string | null = null
  if (
    receipt.failpoint ===
      'apply-checkpoint-cursor-captured-before-commit' ||
    receipt.failpoint ===
      'apply-checkpoint-cursor-committed-before-return' ||
    receipt.failpoint === 'apply-operation-committed-before-return'
  ) {
    const proof = readApplyProof(proofValue)
    if (
      previous?.evidence.kind !== 'planning-sealed' ||
      proof.planningReceipt !== null ||
      sealedPlanOperationCount !==
        previous.evidence.sealedPlanOperationCount
    ) return failStageFinalizer()
    if (receipt.failpoint === 'apply-operation-committed-before-return') {
      if (
        receipt.target.kind !== 'apply-operation' ||
        observation.kind !== 'apply-operation'
      ) {
        return failStageFinalizer()
      }
      const preimage = readPreimageTargetAudit(
        proof.targetPreimageAudit,
        selection,
        snapshotPlanningReceipt(previous),
        runLocatorDigest,
        runtimeAuthenticationKey,
        publicationAuthenticationKey,
      )
      if (
        Date.parse(preimage.observedAt) < Date.parse(previous.completedAt) ||
        Date.parse(preimage.observedAt) >= Date.parse(lifecycle.startedAt) ||
        preimage.contentDigest !==
          material.stageReservation
            .expectedTargetPreimageArtifactContentDigest ||
        appliedOperationCount !== receipt.target.planSequence ||
        sealedPlanOperationCount === null ||
        appliedOperationCount >= sealedPlanOperationCount
      ) return failStageFinalizer()
      targetPreimageArtifactContentDigest = preimage.contentDigest
    } else {
      if (
        receipt.target.kind !== 'apply-checkpoint' ||
        observation.kind !== 'apply-checkpoint' ||
        proof.targetPreimageAudit !== null ||
        appliedOperationCount !== sealedPlanOperationCount
      ) return failStageFinalizer()
    }
  } else {
    if (
      appliedOperationCount !== 0 ||
      sealedPlanOperationCount !== null ||
      (receipt.failpoint ===
          'planning-page-artifact-uploaded-before-checkpoint-commit' ||
        receipt.failpoint === 'planning-page-transaction-response-lost') !==
        (observation.kind === 'planning-page') ||
      (receipt.failpoint === 'lease-acquired-before-first-heartbeat') !==
        (observation.kind === 'lease')
    ) return failStageFinalizer()
    requireProofKind(proofValue, 'planning')
  }
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint: receipt.failpoint,
    targetDigest: createMigrationDigest(receipt.target),
    faultReceiptDigest: material.faultReceiptDigest,
    faultObservationDigest: createMigrationDigest(observation),
    faultObservation: observation,
    leaseIdentityDigest: material.leaseIdentityDigest,
    appliedOperationCount,
    sealedPlanOperationCount,
    targetPreimageArtifactContentDigest,
    reachedAt: receipt.reachedAt,
  })
}

/**
 * Derives a fault-stage writer fence from adapter-authenticated observation.
 *
 * @param material - Verified boundary material carrying durable fault state.
 * @param previous - Immediate authenticated receipt when one exists.
 * @returns Exact writer-fence digest valid at the observed boundary.
 */
function deriveFaultBoundaryWriterFence(
  material: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): string {
  const observation = material.faultObservation
  if (observation.kind === 'planning-page') {
    if (
      observation.failpoint !==
        'planning-page-artifact-uploaded-before-checkpoint-commit' ||
      observation.closedWriterFenceRecordDigest === previous?.writerFenceDigest
    ) return failStageFinalizer()
    return observation.closedWriterFenceRecordDigest
  }
  if (observation.kind === 'lease') {
    return previous?.writerFenceDigest ?? failStageFinalizer()
  }
  if (
    previous === null ||
    observation.closedWriterFenceRecordDigest !== previous.writerFenceDigest
  ) return failStageFinalizer()
  return observation.closedWriterFenceRecordDigest
}

/** Derives command-specific successful evidence from trusted child material. */
function deriveSuccessfulStageEvidence(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  material: WorkspaceSearchMigrationRehearsalStageChildMaterial,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  proofValue: unknown,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
  runLocatorDigest: string,
): DerivedStageEvidence {
  if (material.mutationResult.coordinator.mode !== selection.entry.command) {
    return failStageFinalizer()
  }
  if (selection.entry.command === 'close-replan') {
    return derivePlanningStageEvidence(
      material.mutationResult.coordinator,
      lifecycle,
      previous,
      proofValue,
    )
  }
  if (selection.entry.command === 'apply') {
    const proof = readApplyProof(proofValue)
    const planning = previous?.evidence.kind === 'planning-sealed'
      ? snapshotPlanningReceipt(previous)
      : verifyHistoricalPlanningReceipt(
          proof.planningReceipt,
          selection,
          runtimeAuthenticationKey,
        )
    if (
      previous?.evidence.kind === 'planning-sealed'
        ? proof.planningReceipt !== null
        : previous?.evidence.kind !== 'fault-boundary' ||
          selection.entry.expectedOutcome !== 'takeover-completed' ||
          previous.previousStageReceiptDigest !== createMigrationDigest(planning)
    ) return failStageFinalizer()
    const coordinator = material.mutationResult.coordinator
    if (coordinator.mode !== 'apply') return failStageFinalizer()
    const application = coordinator.application
    if (
      application.planDigest !== planning.evidence.planDigest ||
      application.sealedPlanOperationCount !==
        planning.evidence.sealedPlanOperationCount ||
      Date.parse(application.appliedAt) < Date.parse(lifecycle.startedAt) ||
      Date.parse(application.appliedAt) > Date.parse(lifecycle.completedAt)
    ) return failStageFinalizer()
    let targetPreimageArtifactContentDigest: string | null = null
    if (selection.entry.scenario === 'complete-apply-rollback') {
      const target = readPreimageTargetAudit(
        proof.targetPreimageAudit,
        selection,
        planning,
        runLocatorDigest,
        runtimeAuthenticationKey,
        publicationAuthenticationKey,
      )
      if (Date.parse(target.observedAt) >= Date.parse(lifecycle.startedAt)) {
        return failStageFinalizer()
      }
      if (
        target.contentDigest !==
          material.stageReservation
            .expectedTargetPreimageArtifactContentDigest
      ) return failStageFinalizer()
      targetPreimageArtifactContentDigest = target.contentDigest
    } else if (proof.targetPreimageAudit !== null) {
      return failStageFinalizer()
    }
    return Object.freeze({
      evidence: Object.freeze({
        kind: 'apply-complete',
        executionRunDigest: application.executionRunDigest,
        planDigest: application.planDigest,
        sealedPlanOperationCount: application.sealedPlanOperationCount,
        appliedOperationCount: application.appliedOperationCount,
        appliedRootDigest: application.appliedRootDigest,
        targetPreimageArtifactContentDigest,
        appliedAt: application.appliedAt,
      }),
      writerFenceDigest: planning.writerFenceDigest,
      evidenceCompletedAt: lifecycle.receiptLifecycle.processExitedAt,
    })
  }
  if (
    selection.entry.command === 'verify' ||
    selection.entry.command === 'rollback-complete' ||
    selection.entry.command === 'rollback-partial'
  ) {
    const proof = readTerminalProof(proofValue)
    return deriveTerminalEvidence(
      selection,
      material,
      lifecycle,
      previous,
      proof,
      runtimeAuthenticationKey,
      publicationAuthenticationKey,
      runLocatorDigest,
    )
  }
  requireProofKind(proofValue, 'release')
  if (previous?.evidence.kind !== 'terminal') return failStageFinalizer()
  const release = material.mutationResult.coordinator
  if (
    release.mode !== 'release' ||
    release.terminalKind !== previous.evidence.terminalKind ||
    release.terminalPersistenceVersion !==
      previous.evidence.terminalPersistenceVersion ||
    release.terminalRootDigest !== previous.evidence.terminalRootDigest ||
    release.writerFenceRecordDigest === previous.writerFenceDigest ||
    Date.parse(release.releasedAt) <
      Date.parse(previous.evidence.terminalAt) ||
    Date.parse(release.releasedAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(release.releasedAt) > Date.parse(lifecycle.completedAt)
  ) return failStageFinalizer()
  return Object.freeze({
    evidence: Object.freeze({
      kind: 'released',
      terminalKind: release.terminalKind,
      terminalPersistenceVersion: release.terminalPersistenceVersion,
      terminalRootDigest: release.terminalRootDigest,
      releasedWriterFenceRecordDigest: release.writerFenceRecordDigest,
      releasedAt: release.releasedAt,
    }),
    writerFenceDigest: release.writerFenceRecordDigest,
    evidenceCompletedAt: lifecycle.receiptLifecycle.processExitedAt,
  })
}

/** Derives one sealed planning projection from a trusted coordinator result. */
function derivePlanningStageEvidence(
  coordinator:
    WorkspaceSearchMigrationRehearsalStageChildMaterial['mutationResult']['coordinator'],
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  proofValue: unknown,
): DerivedStageEvidence {
  requireProofKind(proofValue, 'planning')
  if (coordinator.mode !== 'close-replan') return failStageFinalizer()
  const planning = coordinator.planning
  if (
    planning === undefined ||
    planning.planOperationCount <= 0 ||
    (previous !== null &&
      planning.closedWriterFenceRecordDigest === previous.writerFenceDigest) ||
    Date.parse(planning.closedAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(planning.sealedAt) > Date.parse(lifecycle.completedAt)
  ) return failStageFinalizer()
  return Object.freeze({
    evidence: Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: planning.executionBoundaryDigest,
      closedWriterFenceRecordDigest: planning.closedWriterFenceRecordDigest,
      sealedPlanningAuthorityDigest: planning.sealedPlanningAuthorityDigest,
      planDigest: planning.planDigest,
      sealedPlanOperationCount: planning.planOperationCount,
      sourceOperationCount: planning.sourceOperationCount,
      orphanOperationCount: planning.orphanOperationCount,
      closedAt: planning.closedAt,
      drainStartedAt: planning.drainStartedAt,
      drainCompletedAt: planning.drainCompletedAt,
      admittedAt: planning.admittedAt,
      planCreatedAt: planning.planCreatedAt,
      sealedAt: planning.sealedAt,
    }),
    writerFenceDigest: planning.closedWriterFenceRecordDigest,
    evidenceCompletedAt: lifecycle.receiptLifecycle.processExitedAt,
  })
}

/** Detached strict terminal proof after shape validation. */
type ReadTerminalProof = {
  /** Untrusted planning receipt candidate authenticated with the main key. */
  readonly planningReceipt: unknown
  /** Exact actual reconciliation artifact bytes used as the context source. */
  readonly reconciliationArtifactBytes: Uint8Array
}

/** Reads one exact apply proof without authenticating an optional audit yet. */
function readApplyProof(
  value: unknown,
): WorkspaceSearchMigrationRehearsalApplyFinalizationProof {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, [
    'kind',
    'planningReceipt',
    'targetPreimageAudit',
  ])
  if (finalizerGuards.readOwn(record, 'kind') !== 'apply') {
    return failStageFinalizer()
  }
  const targetPreimageAudit = finalizerGuards.readOwn(
    record,
    'targetPreimageAudit',
  )
  const planningReceipt = finalizerGuards.readOwn(record, 'planningReceipt')
  if (targetPreimageAudit === null) {
    return Object.freeze({
      kind: 'apply',
      planningReceipt,
      targetPreimageAudit: null,
    })
  }
  const audit = finalizerGuards.requireRecord(targetPreimageAudit)
  finalizerGuards.requireExactKeys(audit, ['artifactBytes', 'verificationKey'])
  const artifactBytes = readByteArray(
    finalizerGuards.readOwn(audit, 'artifactBytes'),
  )
  const verificationKey = readOwnedKeyReference(
    finalizerGuards.readOwn(audit, 'verificationKey'),
  )
  return Object.freeze({
    kind: 'apply',
    planningReceipt,
    targetPreimageAudit: Object.freeze({ artifactBytes, verificationKey }),
  })
}

/** Reads one exact terminal proof and rejects all extra binding objects. */
function readTerminalProof(value: unknown): ReadTerminalProof {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, [
    'kind',
    'planningReceipt',
    'reconciliationArtifactBytes',
  ])
  if (finalizerGuards.readOwn(record, 'kind') !== 'terminal') {
    return failStageFinalizer()
  }
  const reconciliationArtifactBytes = readByteArray(
    finalizerGuards.readOwn(record, 'reconciliationArtifactBytes'),
  )
  return Object.freeze({
    planningReceipt: finalizerGuards.readOwn(record, 'planningReceipt'),
    reconciliationArtifactBytes,
  })
}

/** Reauthenticates the unique latest successful planning receipt in a scenario. */
function verifyHistoricalPlanningReceipt(
  value: unknown,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  authenticationKey: Uint8Array,
): AuthenticatedPlanningReceipt {
  const planning = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
    value,
    authenticationKey,
  )
  let expectedEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry |
    undefined
  for (let index = selection.entry.ordinal - 2; index >= 0; index -= 1) {
    const candidate = selection.manifest.entries[index]
    if (
      candidate?.scenario === selection.entry.scenario &&
      candidate.command === 'close-replan' &&
      candidate.expectedOutcome !== 'fault-reached'
    ) {
      expectedEntry = candidate
      break
    }
  }
  if (
    expectedEntry === undefined ||
    planning.evidence.kind !== 'planning-sealed' ||
    planning.stageOrdinal !== expectedEntry.ordinal ||
    planning.scenario !== expectedEntry.scenario ||
    planning.scenarioStageOrdinal !== expectedEntry.scenarioStageOrdinal ||
    planning.command !== expectedEntry.command ||
    planning.controlArgumentsDigest !== expectedEntry.controlArgumentsDigest ||
    planning.attemptOrdinal !== expectedEntry.attemptOrdinal ||
    planning.outcome !== expectedEntry.expectedOutcome ||
    planning.manifestDigest !== selection.manifestDigest ||
    planning.manifestEntryDigest !== createMigrationDigest(expectedEntry) ||
    planning.permitDigest !== selection.manifest.permitDigest ||
    planning.commit !== selection.manifest.commit ||
    planning.requestedResourcesBinding !==
      selection.manifest.requestedResourcesBinding ||
    planning.configurationBindingDigest !==
      selection.manifest.configurationBindingDigest ||
    planning.policyVersion !== selection.manifest.policyVersion
  ) return failStageFinalizer()
  return snapshotPlanningReceipt(planning)
}

/** Snapshots one already-authenticated receipt with narrowed planning evidence. */
function snapshotPlanningReceipt(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): AuthenticatedPlanningReceipt {
  if (receipt.evidence.kind !== 'planning-sealed') {
    return failStageFinalizer()
  }
  return Object.freeze({ ...receipt, evidence: receipt.evidence })
}

/** Derives terminal receipt evidence after authenticating every raw artifact. */
function deriveTerminalEvidence(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  material: WorkspaceSearchMigrationRehearsalStageChildMaterial,
  lifecycle: NormalizedStageLifecycle,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  proof: ReadTerminalProof,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
  runLocatorDigest: string,
): DerivedStageEvidence {
  const planning = verifyHistoricalPlanningReceipt(
    proof.planningReceipt,
    selection,
    runtimeAuthenticationKey,
  )
  const coordinator = material.mutationResult.coordinator
  if (
    coordinator.mode !== 'verify' &&
    coordinator.mode !== 'rollback-complete' &&
    coordinator.mode !== 'rollback-partial'
  ) return failStageFinalizer()
  const command = selection.entry.command
  if (
    (command !== 'verify' &&
      command !== 'rollback-complete' &&
      command !== 'rollback-partial') ||
    command !== coordinator.mode
  ) return failStageFinalizer()
  const terminal = coordinator.terminal
  const partial = command === 'rollback-partial'
  const applyStartedAt = previous?.startedAt ?? failStageFinalizer()
  let targetPreimageArtifactContentDigest: string | null
  if (partial) {
    if (
      previous?.evidence.kind !== 'fault-boundary' ||
      previous.evidence.failpoint !==
        'apply-operation-committed-before-return' ||
      previous.previousStageReceiptDigest !== createMigrationDigest(planning)
    ) return failStageFinalizer()
    targetPreimageArtifactContentDigest =
      previous.evidence.targetPreimageArtifactContentDigest
  } else {
    if (previous?.evidence.kind !== 'apply-complete') {
      return failStageFinalizer()
    }
    targetPreimageArtifactContentDigest =
      previous.evidence.targetPreimageArtifactContentDigest
  }
  if (
    terminal === undefined ||
    terminal.executionBoundaryDigest !==
      planning.evidence.executionBoundaryDigest ||
    terminal.closedWriterFenceRecordDigest !== planning.writerFenceDigest ||
    terminal.sealedPlanningAuthorityDigest !==
      planning.evidence.sealedPlanningAuthorityDigest ||
    terminal.planDigest !== planning.evidence.planDigest ||
    terminal.planOperationCount !==
      planning.evidence.sealedPlanOperationCount ||
    Date.parse(terminal.terminalAt) < Date.parse(lifecycle.startedAt) ||
    Date.parse(terminal.terminalAt) > Date.parse(lifecycle.completedAt)
  ) return failStageFinalizer()
  const verified = selection.entry.command === 'verify'
  if (
    verified !== (terminal.terminalKind === 'verified') ||
    terminal.terminalPersistenceVersion !== (partial ? 2 : 1) ||
    (partial
      ? previous?.evidence.kind !== 'fault-boundary' ||
        terminal.appliedOperationCount !==
          previous.evidence.appliedOperationCount ||
        terminal.appliedOperationCount >= terminal.planOperationCount
      : previous?.evidence.kind !== 'apply-complete' ||
        terminal.executionRunDigest !== previous.evidence.executionRunDigest ||
        terminal.appliedOperationCount !==
          previous.evidence.appliedOperationCount ||
        terminal.applyBoundaryDigest !== previous.evidence.appliedRootDigest ||
        terminal.appliedOperationCount !== terminal.planOperationCount)
  ) return failStageFinalizer()
  const reconciliation =
    authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
      proof.reconciliationArtifactBytes,
      new Uint8Array(runtimeAuthenticationKey),
      new Uint8Array(publicationAuthenticationKey),
    )
  requireReconciliationArtifactMatchesTerminal(
    reconciliation,
    selection,
    material,
    lifecycle,
    terminal,
    runLocatorDigest,
  )
  const integrityPurpose = selection.entry.scenario ===
      'partial-apply-rollback'
    ? 'partial-rollback'
    : selection.entry.scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : 'verified'
  let targetRollbackArtifactContentDigest: string | null = null
  let targetRollbackObservationDigest: string | null = null
  if (command === 'verify') {
    if (
      targetPreimageArtifactContentDigest !== null ||
      reconciliation.targetAudits !== null ||
      reconciliation.integrity.kind !== 'verified-result'
    ) return failStageFinalizer()
  } else {
    const targetAudits = reconciliation.targetAudits
    const integrity = reconciliation.integrity
    if (
      targetPreimageArtifactContentDigest === null ||
      targetAudits === null ||
      integrity.kind !== 'rollback-comparison' ||
      integrity.purpose !== integrityPurpose ||
      targetAudits.preimage.contentDigest !==
        targetPreimageArtifactContentDigest ||
      targetAudits.preimage.aggregateDigest !==
        targetAudits.restored.aggregateDigest ||
      targetAudits.preimage.aggregateDigest !==
        integrity.targetPreimageAggregateDigest ||
      targetAudits.restored.aggregateDigest !==
        integrity.targetRestoredAggregateDigest ||
      Date.parse(targetAudits.preimage.observedAt) >=
        Date.parse(applyStartedAt) ||
      Date.parse(targetAudits.preimage.rate.completedAt) >=
        Date.parse(applyStartedAt) ||
      Date.parse(targetAudits.restored.observedAt) <=
        Date.parse(terminal.terminalAt) ||
      Date.parse(targetAudits.restored.rate.completedAt) >
        Date.parse(reconciliation.checkedAt) ||
      Date.parse(integrity.before.checkedAt) >=
        Date.parse(applyStartedAt) ||
      Date.parse(integrity.after.checkedAt) <=
        Date.parse(terminal.terminalAt) ||
      Date.parse(targetAudits.restored.observedAt) >
        Date.parse(integrity.completedAt) ||
      serializeCanonicalJson(targetAudits.restored.rate.successor) !==
        serializeCanonicalJson(reconciliation.rate.predecessor)
    ) return failStageFinalizer()
    targetRollbackArtifactContentDigest =
      targetAudits.restored.contentDigest
    targetRollbackObservationDigest =
      targetAudits.restored.observationDigest
  }
  const reconciliationIntegrity = reconciliation.integrity
  const integrityBeforeResultDigest =
    reconciliationIntegrity.kind === 'verified-result'
      ? null
      : reconciliationIntegrity.before.resultDigest
  const integrityAfterResultDigest =
    reconciliationIntegrity.kind === 'verified-result'
      ? reconciliationIntegrity.result.result.resultDigest
      : reconciliationIntegrity.after.resultDigest
  const integrityComparisonDigest =
    reconciliationIntegrity.kind === 'verified-result'
      ? null
      : reconciliationIntegrity.comparisonDigest
  const integrityContextDigest =
    reconciliationIntegrity.kind === 'verified-result'
      ? reconciliationIntegrity.resultContextDigest
      : reconciliationIntegrity.comparisonContextDigest
  const reconciliationContext =
    createReconciliationContextFromArtifact(reconciliation)
  const reconciliationAuditDigest =
    createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
      scenario: selection.entry.scenario,
      terminalRootDigest: terminal.terminalRootDigest,
      integrityContextDigest,
      targetPreimageArtifactContentDigest:
        targetPreimageArtifactContentDigest,
      targetRollbackArtifactContentDigest,
      targetRollbackObservationDigest,
      duplicateApplyCount: 0,
      lostItemCount: 0,
      orphanAuthorityCount: 0,
    })
  return Object.freeze({
    evidence: Object.freeze({
      kind: 'terminal',
      command,
      terminalKind: terminal.terminalKind,
      terminalPersistenceVersion: terminal.terminalPersistenceVersion,
      terminalRootDigest: terminal.terminalRootDigest,
      executionBoundaryDigest: terminal.executionBoundaryDigest,
      sealedPlanningAuthorityDigest:
        terminal.sealedPlanningAuthorityDigest,
      executionRunDigest: terminal.executionRunDigest,
      planDigest: terminal.planDigest,
      sealedPlanOperationCount: terminal.planOperationCount,
      appliedOperationCount: terminal.appliedOperationCount,
      integrityPurpose,
      integrityBeforeResultDigest,
      integrityAfterResultDigest,
      integrityComparisonDigest,
      integrityContextDigest,
      targetRollbackArtifactContentDigest,
      targetRollbackObservationDigest,
      duplicateApplyCount: 0,
      lostItemCount: 0,
      orphanAuthorityCount: 0,
      reconciliationContext,
      reconciliationArtifactBindingDigest:
        createMigrationDigest(reconciliation),
      reconciliationArtifactContentDigest: reconciliation.contentDigest,
      reconciliationArtifactByteLength: reconciliation.byteLength,
      reconciliationArtifactAuditDigest: reconciliation.auditDigest,
      reconciliationRate: reconciliation.rate,
      reconciliationAuditDigest,
      terminalAt: terminal.terminalAt,
    }),
    writerFenceDigest: terminal.closedWriterFenceRecordDigest,
    evidenceCompletedAt: reconciliation.rate.completedAt,
  })
}

/**
 * Requires an actual authenticated artifact to prove this child terminal.
 *
 * @param reconciliation - Dual-key-authenticated actual artifact binding.
 * @param selection - Exact reviewed terminal-stage selection.
 * @param material - Runtime-authenticated terminal child material.
 * @param lifecycle - Parent-authenticated terminal child lifecycle.
 * @param terminal - Authoritative terminal returned by the child coordinator.
 * @param runLocatorDigest - Parent-derived restricted run locator.
 */
function requireReconciliationArtifactMatchesTerminal(
  reconciliation:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  material: WorkspaceSearchMigrationRehearsalStageChildMaterial,
  lifecycle: NormalizedStageLifecycle,
  terminal: WorkspaceSearchMigrationControlExecutionTerminalEvidence,
  runLocatorDigest: string,
): void {
  const verified = selection.entry.command === 'verify'
  const integrityResults = reconciliation.integrity.kind === 'verified-result'
    ? [reconciliation.integrity.result.result]
    : [reconciliation.integrity.before, reconciliation.integrity.after]
  if (
    reconciliation.scenario !== selection.entry.scenario ||
    reconciliation.runLocatorDigest !== runLocatorDigest ||
    reconciliation.configurationBindingDigest !==
      selection.manifest.configurationBindingDigest ||
    reconciliation.policyVersion !== selection.manifest.policyVersion ||
    reconciliation.integrityResourceIdentityDigest !==
      selection.manifest.integrityResourceIdentityDigest ||
    reconciliation.sealedPlanningAuthorityDigest !==
      terminal.sealedPlanningAuthorityDigest ||
    reconciliation.executionRunDigest !== terminal.executionRunDigest ||
    reconciliation.planDigest !== terminal.planDigest ||
    reconciliation.applyBoundaryDigest !== terminal.applyBoundaryDigest ||
    reconciliation.terminalRootKind !== terminal.terminalKind ||
    reconciliation.terminalRootVersion !==
      terminal.terminalPersistenceVersion ||
    reconciliation.terminalRootDigest !== terminal.terminalRootDigest ||
    reconciliation.sealedPlanOperationCount !== terminal.planOperationCount ||
    reconciliation.appliedOperationCount !==
      terminal.appliedOperationCount ||
    reconciliation.terminalAt !== terminal.terminalAt ||
    Date.parse(reconciliation.checkedAt) <= Date.parse(terminal.terminalAt) ||
    Date.parse(reconciliation.checkedAt) <
      Date.parse(lifecycle.receiptLifecycle.processExitedAt) ||
    Date.parse(reconciliation.rate.completedAt) <
      Date.parse(lifecycle.receiptLifecycle.processExitedAt) ||
    Date.parse(reconciliation.rate.completedAt) >=
      Date.parse(material.stageReservation.expiresAt) ||
    reconciliation.duplicateApplyCount !== 0 ||
    reconciliation.lostItemCount !== 0 ||
    reconciliation.orphanAuthorityCount !== 0 ||
    reconciliation.markerSummary.duplicateCount !== 0 ||
    reconciliation.markerSummary.missingCount !== 0 ||
    reconciliation.markerSummary.unexpectedCount !== 0 ||
    reconciliation.authoritySummary.missingCount !== 0 ||
    reconciliation.authoritySummary.orphanCount !== 0 ||
    reconciliation.sourceTargetSummary.lostCount !== 0 ||
    reconciliation.sourceTargetSummary.unexpectedCount !== 0 ||
    reconciliation.integrity.terminalRootDigest !==
      terminal.terminalRootDigest ||
    integrityResults.some((result) =>
      result.resourceIdentityScheme !==
        selection.manifest.integrityResourceIdentityScheme ||
      serializeCanonicalJson(result.resourceIdentities) !==
        serializeCanonicalJson(
          selection.manifest.integrityResourceIdentities,
        ) ||
      result.resourceIdentityDigest !==
        selection.manifest.integrityResourceIdentityDigest
    ) ||
    verified !== (reconciliation.integrity.kind === 'verified-result') ||
    verified !== (reconciliation.targetAudits === null) ||
    reconciliation.rate.link.configurationBindingDigest !==
      selection.manifest.configurationBindingDigest ||
    (verified &&
      serializeCanonicalJson(reconciliation.rate.predecessor) !==
        serializeCanonicalJson(material.rateSegment))
  ) return failStageFinalizer()
}

/** Creates receipt context exclusively from an authenticated artifact. */
function createReconciliationContextFromArtifact(
  reconciliation:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
) {
  return snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext({
    scenario: reconciliation.scenario,
    runLocatorDigest: reconciliation.runLocatorDigest,
    configurationBindingDigest: reconciliation.configurationBindingDigest,
    policyVersion: reconciliation.policyVersion,
    integrityResourceIdentityDigest:
      reconciliation.integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest:
      reconciliation.sealedPlanningAuthorityDigest,
    executionRunDigest: reconciliation.executionRunDigest,
    planDigest: reconciliation.planDigest,
    applyBoundaryDigest: reconciliation.applyBoundaryDigest,
    terminalRootKind: reconciliation.terminalRootKind,
    terminalRootVersion: reconciliation.terminalRootVersion,
    terminalRootDigest: reconciliation.terminalRootDigest,
    sealedPlanOperationCount: reconciliation.sealedPlanOperationCount,
    appliedOperationCount: reconciliation.appliedOperationCount,
    terminalAt: reconciliation.terminalAt,
    checkedAt: reconciliation.checkedAt,
    integrity: reconciliation.integrity,
    targetAudits: reconciliation.targetAudits,
  })
}

/** Authenticates the preimage artifact used by complete apply. */
function readPreimageTargetAudit(
  value: WorkspaceSearchMigrationRehearsalStagePreimageAuditInput | null,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  planning: AuthenticatedPlanningReceipt,
  runLocatorDigest: string,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding {
  if (value === null) return failStageFinalizer()
  const scenario = planning.scenario
  if (
    scenario !== 'complete-apply-rollback' &&
    scenario !== 'partial-apply-rollback'
  ) return failStageFinalizer()
  if (selection.entry.scenario !== scenario) return failStageFinalizer()
  const context = createTargetAuditContext(
    selection,
    planning,
    runLocatorDigest,
  )
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    runtimeKey = new Uint8Array(runtimeAuthenticationKey)
    publicationKey = new Uint8Array(publicationAuthenticationKey)
    const binding = scenario === 'complete-apply-rollback'
      ? authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
          artifactBytes: value.artifactBytes,
          expectedContext: context,
          purpose: 'complete-rollback-preimage',
          terminal: null,
        }, runtimeKey, publicationKey)
      : authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
          artifactBytes: value.artifactBytes,
          expectedContext: context,
          purpose: 'partial-rollback-preimage',
          terminal: null,
        }, runtimeKey, publicationKey)
    requireTargetAuditManifestBinding(binding, selection.manifest)
    return binding
  } finally {
    zeroizeBytes(runtimeKey)
    zeroizeBytes(publicationKey)
  }
}

/**
 * Builds one exact target-audit context from an authenticated selection.
 *
 * @param selection - Exact current rollback stage selection.
 * @param planning - Authenticated close-replan receipt for this scenario.
 * @param runLocatorDigest - Runtime-key-derived restricted run locator.
 * @returns Frozen context required by both independent target observations.
 */
function createTargetAuditContext(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  planning: AuthenticatedPlanningReceipt,
  runLocatorDigest: string,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  const scenario = selection.entry.scenario
  if (
    (scenario !== 'complete-apply-rollback' &&
      scenario !== 'partial-apply-rollback') ||
    planning.scenario !== scenario ||
    planning.manifestDigest !== selection.manifestDigest
  ) return failStageFinalizer()
  return createTargetAuditContextFromValues(
    scenario,
    selection.manifest,
    selection.manifestDigest,
    planning,
    runLocatorDigest,
  )
}

/**
 * Constructs target-audit context fields shared by apply and terminal stages.
 *
 * @param scenario - Exact rollback scenario owning both observations.
 * @param manifest - Runtime-authenticated reviewed stage manifest.
 * @param manifestDigest - Digest of the exact authenticated manifest.
 * @param planning - Authenticated close-replan receipt for the scenario.
 * @param runLocatorDigest - Runtime-key-derived restricted run locator.
 * @returns Frozen exact context authenticated inside each audit artifact.
 */
function createTargetAuditContextFromValues(
  scenario: 'complete-apply-rollback' | 'partial-apply-rollback',
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestDigest: string,
  planning: AuthenticatedPlanningReceipt,
  runLocatorDigest: string,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  if (
    planning.scenario !== scenario ||
    planning.runLocatorDigest !== runLocatorDigest ||
    planning.manifestDigest !== manifestDigest ||
    planning.permitDigest !== manifest.permitDigest ||
    planning.requestedResourcesBinding !==
      manifest.requestedResourcesBinding ||
    planning.configurationBindingDigest !==
      manifest.configurationBindingDigest ||
    planning.policyVersion !== manifest.policyVersion
  ) return failStageFinalizer()
  return Object.freeze({
    scenario,
    runLocatorDigest,
    manifestDigest,
    permitDigest: manifest.permitDigest,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
    integrityResourceIdentityDigest:
      manifest.integrityResourceIdentityDigest,
    planningReceiptDigest: createMigrationDigest(planning),
    executionBoundaryDigest: planning.evidence.executionBoundaryDigest,
    sealedPlanningAuthorityDigest:
      planning.evidence.sealedPlanningAuthorityDigest,
    planDigest: planning.evidence.planDigest,
    writerFenceDigest: planning.writerFenceDigest,
  })
}

/** Requires one authenticated target audit to match the reviewed manifest. */
function requireTargetAuditManifestBinding(
  binding: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
): void {
  if (
    binding.commit !== manifest.commit ||
    binding.configurationHash !== manifest.configurationBindingDigest ||
    binding.sourceResourceBindingDigest !==
      manifest.requestedResourcesBinding
  ) return failStageFinalizer()
}

/** Requires one proof with no fields beyond its exact discriminator. */
function requireProofKind(
  value: unknown,
  kind: 'planning' | 'release',
): void {
  const record = finalizerGuards.requireRecord(value)
  finalizerGuards.requireExactKeys(record, ['kind'])
  if (finalizerGuards.readOwn(record, 'kind') !== kind) {
    return failStageFinalizer()
  }
}

/** Extracts unique safe run and owner identifiers from reviewed arguments. */
function readReviewedInvocationIdentifiers(
  controlArguments: readonly string[],
): ReviewedInvocationIdentifiers {
  return Object.freeze({
    runId: readUniqueIdentifierFlag(controlArguments, '--run-id'),
    ownerId: readUniqueIdentifierFlag(controlArguments, '--owner-id'),
  })
}

/**
 * Reads one exact all-or-nothing collection material byte profile.
 *
 * Generic-success stages omit all four response-loss documents. A reconciled
 * response-loss stage must supply the boundary wrapper, reviewed fault plan,
 * and both exact rate-segment files together. Every document is parsed or
 * copied only after descriptor-safe exact-key validation.
 *
 * @param record - Candidate parent-persisted byte bundle.
 * @returns Exact success or response-loss material authentication input.
 */
function readCollectionMaterialInput(
  record: object,
): WorkspaceSearchMigrationRehearsalCollectionMaterialInput {
  const commonKeys = [
    'controlArgumentsBytes',
    'lifecycleBytes',
    'manifestBytes',
    'materialBytes',
    'parentAuthenticationBytes',
    'previousReceiptBytes',
  ]
  const responseLossKeys = [
    'boundaryMaterialBytes',
    'boundaryRateSegmentBytes',
    'faultPlanBytes',
    'finalRateSegmentBytes',
  ]
  const responseLossFieldCount = responseLossKeys.reduce(
    (count, key) => count + (hasOwnCollectionDataProperty(record, key) ? 1 : 0),
    0,
  )
  if (responseLossFieldCount === 0) {
    finalizerGuards.requireExactKeys(record, commonKeys)
    return Object.freeze({
      materialKind: 'success',
      persistedMaterialEvidence: parseCanonicalCollectionDocument(
        finalizerGuards.readOwn(record, 'materialBytes'),
      ),
    })
  }
  if (responseLossFieldCount !== responseLossKeys.length) {
    return failStageFinalizer()
  }
  finalizerGuards.requireExactKeys(record, [
    ...commonKeys,
    ...responseLossKeys,
  ])
  const faultPlan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
    parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(record, 'faultPlanBytes'),
    ),
  )
  return Object.freeze({
    materialKind: 'fault-completion',
    persistedMaterialEvidence: parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(record, 'materialBytes'),
    ),
    persistedBoundaryMaterialEvidence: parseCanonicalCollectionDocument(
      finalizerGuards.readOwn(record, 'boundaryMaterialBytes'),
    ),
    faultPlan,
    boundaryRateSegmentBytes: copyStageFinalizerEvidenceBytes(
      finalizerGuards.readOwn(record, 'boundaryRateSegmentBytes'),
    ),
    finalRateSegmentBytes: copyStageFinalizerEvidenceBytes(
      finalizerGuards.readOwn(record, 'finalRateSegmentBytes'),
    ),
  })
}

/**
 * Checks one optional collection field without invoking accessors.
 *
 * @param record - Descriptor-safe ordinary material byte record.
 * @param key - Optional response-loss field to inspect.
 * @returns Whether the record owns one ordinary data property for the field.
 */
function hasOwnCollectionDataProperty(record: object, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined) return false
    if (!Object.hasOwn(descriptor, 'value')) return failStageFinalizer()
    return true
  } catch {
    return failStageFinalizer()
  }
}

/** Reads one exact finite collection-mode discriminator. */
function readCollectionMode(
  value: unknown,
): WorkspaceSearchMigrationRehearsalCollectionMode {
  if (
    value !== 'reconcile' &&
    value !== 'target-preimage' &&
    value !== 'target-restored'
  ) return failStageFinalizer()
  return value
}

/** Parses one bounded exact canonical JSON byte vector. */
function parseCanonicalCollectionDocument(value: unknown): unknown {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength === 0 ||
    value.byteLength > 2 * 1_024 * 1_024
  ) return failStageFinalizer()
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value)
    const parsed: unknown = JSON.parse(text)
    if (serializeCanonicalJson(parsed) !== text) return failStageFinalizer()
    return parsed
  } catch {
    return failStageFinalizer()
  }
}

/** Reads one exact unique safe identifier flag from reviewed arguments. */
function readUniqueIdentifierFlag(
  controlArguments: readonly string[],
  flag: '--owner-id' | '--run-id',
): string {
  let found: string | undefined
  for (let index = 0; index < controlArguments.length; index += 1) {
    if (controlArguments[index] !== flag) continue
    const value = controlArguments[index + 1]
    if (
      found !== undefined ||
      typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
    ) return failStageFinalizer()
    found = value
  }
  return found ?? failStageFinalizer()
}

/** Requires locator continuity across stages in the same logical attempt. */
function requireLocatorContinuity(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  runLocatorDigest: string,
  attemptLocatorDigest: string,
  ownerLocatorDigest: string,
): void {
  if (previous === null || previous.scenario !== selection.entry.scenario) {
    return
  }
  const sameAttempt = previous.attemptOrdinal === selection.entry.attemptOrdinal
  if (
    previous.runLocatorDigest !== runLocatorDigest ||
    (sameAttempt &&
      (previous.attemptLocatorDigest !== attemptLocatorDigest ||
        previous.ownerLocatorDigest !== ownerLocatorDigest)) ||
    (!sameAttempt &&
      (selection.entry.attemptOrdinal !== previous.attemptOrdinal + 1 ||
        previous.attemptLocatorDigest === attemptLocatorDigest ||
        previous.ownerLocatorDigest === ownerLocatorDigest))
  ) return failStageFinalizer()
}

/**
 * Requires child-observed authority adoptions to extend the scenario chain.
 *
 * @param selection - Exact authenticated stage owning the current material.
 * @param previous - Immediate authenticated predecessor receipt.
 * @param observed - Complete FIFO chain authenticated inside child material.
 * @returns Frozen cumulative chain for the new receipt.
 */
function requireCumulativeAuthorityChain(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  observed:
    WorkspaceSearchMigrationRehearsalStageReceipt['expectedAuthorities'],
): WorkspaceSearchMigrationRehearsalStageReceipt['expectedAuthorities'] {
  if (previous === null || previous.scenario !== selection.entry.scenario) {
    return observed
  }
  if (observed.length === 0) return previous.expectedAuthorities
  if (observed.length < previous.expectedAuthorities.length) {
    return failStageFinalizer()
  }
  for (let index = 0; index < previous.expectedAuthorities.length; index += 1) {
    const expected = previous.expectedAuthorities[index]
    const actual = observed[index]
    if (
      expected === undefined ||
      actual === undefined ||
      expected.maintenanceEvidenceRenewalCount !==
        actual.maintenanceEvidenceRenewalCount ||
      expected.receiptDigest !== actual.receiptDigest
    ) return failStageFinalizer()
  }
  return observed
}

/** Requires one authenticated child segment to be fresh and forward-moving. */
function requireRateSegmentContinuity(
  segment: WorkspaceSearchMigrationRehearsalStageChildMaterial['rateSegment'],
  previous: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): void {
  if (
    previous !== null &&
    (previous.rateSegment.authenticationKeyFingerprint !==
        segment.authenticationKeyFingerprint ||
      previous.rateSegment.segmentOrdinal >= segment.segmentOrdinal ||
      previous.rateSegment.segmentLocatorDigest ===
        segment.segmentLocatorDigest ||
      previous.rateSegment.segmentDigest === segment.segmentDigest ||
      previous.rateSegment.terminalRecordMac === segment.terminalRecordMac ||
      segment.firstEventSequence <
        previous.rateSegment.firstEventSequence +
          previous.rateSegment.eventCount)
  ) return failStageFinalizer()
}

/** Reads a bounded detached control argument vector. */
function readControlArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return failStageFinalizer()
  }
  if (value.length === 0 || value.length > 512) return failStageFinalizer()
  const snapshot: string[] = []
  for (const argument of value) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > 8_192 ||
      argument.includes('\0')
    ) return failStageFinalizer()
    snapshot.push(argument)
  }
  return Object.freeze(snapshot)
}

/** Reads a nullable conventional lowercase digest. */
function readNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return finalizerGuards.readDigest(value)
}

/** Reads one nullable canonical timestamp. */
function readNullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  return finalizerGuards.readTimestamp(value)
}

/** Narrows one ordinary non-Proxy unshared Uint8Array. */
function readByteArray(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength === 0
  ) return failStageFinalizer()
  return value
}

/** Copies one finite exact persisted evidence byte vector. */
function copyStageFinalizerEvidenceBytes(value: unknown): Uint8Array {
  const bytes = readByteArray(value)
  try {
    return new Uint8Array(bytes)
  } catch {
    return failStageFinalizer()
  }
}

/** Returns SHA-256 over one exact authenticated persisted byte vector. */
function hashStageFinalizerEvidenceBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Reads one exact ordinary caller-owned key without copying it. */
function readOwnedKeyReference(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== stageAuthenticationKeyByteLength
  ) return failStageFinalizer()
  return value
}

/** Copies and immediately overwrites one transferred exact key. */
function consumeOwnedKey(value: unknown): Uint8Array {
  const owned = readOwnedKeyReference(value)
  let working: Uint8Array
  try {
    working = new Uint8Array(owned)
  } catch {
    zeroizeBytes(owned)
    return failStageFinalizer()
  }
  zeroizeBytes(owned)
  return working
}

/** Best-effort overwrite of an ordinary non-shared byte buffer. */
function zeroizeBytes(value: unknown): void {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer)
  ) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Best effort only; invalid exotic buffers fail at the trust boundary.
  }
}

/** Overwrites the apply-preimage proof key even when validation fails early. */
function zeroizeProofKeys(value: unknown): void {
  const proof = readDataRecordIfPresent(value)
  if (proof === undefined) return
  const preimage = readDataRecordIfPresent(readDataValue(proof, 'targetPreimageAudit'))
  zeroizeBytes(readDataValue(preimage, 'verificationKey'))
}

/** Reads an ordinary object only for final best-effort key cleanup. */
function readDataRecordIfPresent(value: unknown): object | undefined {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)
    ) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Reads an own data property without ever invoking an accessor. */
function readDataValue(
  record: object | undefined,
  key: string,
): unknown {
  if (record === undefined) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

/** Raises the stable raw-value-free stage-finalizer failure. */
function failStageFinalizer(): never {
  throw new WorkspaceSearchMigrationRehearsalStageFinalizerError()
}
