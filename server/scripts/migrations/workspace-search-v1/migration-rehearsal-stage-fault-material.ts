import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFailpoint,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultObservation,
  verifyWorkspaceSearchMigrationRehearsalFaultObservation,
  WorkspaceSearchMigrationRehearsalStageFaultMaterialError,
  type VerifyWorkspaceSearchMigrationRehearsalFaultObservationInput,
  type WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation,
  type WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
  type WorkspaceSearchMigrationRehearsalLeaseFaultObservation,
  type WorkspaceSearchMigrationRehearsalPlanningFaultObservation,
} from './migration-rehearsal-fault-observation'
import {
  verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations,
  verifyWorkspaceSearchMigrationRehearsalCapturedMutationObservation,
  verifyWorkspaceSearchMigrationRehearsalClaimedStageContext,
  verifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
  type WorkspaceSearchMigrationRehearsalCapturedMutationObservation,
  type WorkspaceSearchMigrationRehearsalChildMutationResult,
  type WorkspaceSearchMigrationRehearsalChildRateSegment,
  type WorkspaceSearchMigrationRehearsalClaimedStageContext,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import type {
  WorkspaceSearchMigrationRehearsalExpectedAuthority,
} from './migration-rehearsal-reconciliation-aws'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-receipt'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

export {
  snapshotWorkspaceSearchMigrationRehearsalFaultObservation,
  verifyWorkspaceSearchMigrationRehearsalFaultObservation,
  WorkspaceSearchMigrationRehearsalStageFaultMaterialError,
  type VerifyWorkspaceSearchMigrationRehearsalFaultObservationInput,
  type WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation,
  type WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
  type WorkspaceSearchMigrationRehearsalLeaseFaultObservation,
  type WorkspaceSearchMigrationRehearsalPlanningFaultObservation,
}

/** Stable discriminator for authenticated fault-boundary material. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_BOUNDARY_MATERIAL_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-fault-boundary-material'

/** Stable discriminator for authenticated response-loss completion material. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_COMPLETION_MATERIAL_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-fault-completion-material'

/** First authenticated fault-material contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_VERSION =
  1

/** Maximum canonical bytes accepted for either dedicated FD3 material line. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES =
  256 * 1_024

/** Exact raw byte length of the shared stage evidence key. */
const faultMaterialKeyBytes = 32

/** Domain separator for fault-boundary material authentication. */
const faultBoundaryMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-fault-boundary-material:v1'

/** Domain separator for response-loss completion authentication. */
const faultCompletionMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-fault-completion-material:v1'

/** Selection claims repeated in both authenticated fault material phases. */
export type WorkspaceSearchMigrationRehearsalStageFaultSelectionClaims = {
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the authenticated predecessor receipt, or null at stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Globally contiguous selected stage ordinal. */
  readonly stageOrdinal: number
  /** Canonical fault scenario owning the stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Contiguous stage ordinal inside the scenario. */
  readonly scenarioStageOrdinal: number
  /** Exact existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** One-based process-attempt ordinal inside the scenario. */
  readonly attemptOrdinal: number
  /** Exact selected fault outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Digest of the exact reviewed control argument vector. */
  readonly controlArgumentsDigest: string
  /** Digest of the exact canonical reviewed fault plan. */
  readonly faultPlanDigest: string
}

/** Authenticated claims emitted while the child is stopped at its fault. */
export type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialClaims =
  WorkspaceSearchMigrationRehearsalStageFaultSelectionClaims & {
    /** Fixed boundary-material discriminator. */
    readonly kind:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_BOUNDARY_MATERIAL_KIND
    /** Fault-material schema version. */
    readonly materialVersion:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_VERSION
    /** Exact validated secret-free runtime fault receipt. */
    readonly faultReceipt: WorkspaceSearchMigrationRehearsalFaultReceipt
    /** Digest of the exact canonical runtime fault receipt. */
    readonly faultReceiptDigest: string
    /** Fresh authenticated reservation durably claimed before mutation. */
    readonly stageReservation:
      WorkspaceSearchMigrationRehearsalClaimedStageContext['stageReservation']
    /** Exact secret-free durable head returned by the successful claim. */
    readonly claimedStageHead:
      WorkspaceSearchMigrationRehearsalClaimedStageContext['claimedStageHead']
    /** Stable identity of the lease generation used by this attempt. */
    readonly leaseIdentityDigest: string
    /** Adapter-proven acquisition that installed this attempt's lease. */
    readonly leaseAcquisitionObservation:
      WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
    /** Complete FIFO authority-adoption chain observed through this boundary. */
    readonly authorityAdoptionObservations:
      readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
    /** Adapter-proven durable runtime state at the exact selected fault. */
    readonly faultObservation:
      WorkspaceSearchMigrationRehearsalFaultObservation
    /** Authenticated durable rate prefix flushed before fault release. */
    readonly rateSegment: WorkspaceSearchMigrationRehearsalChildRateSegment
  }

/** Complete HMAC-authenticated material for one reached fault boundary. */
export type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial =
  WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialClaims & {
    /** HMAC-SHA-256 over the exact canonical boundary claims. */
    readonly materialMac: string
  }

/** Authenticated claims emitted after response-loss reconciliation completes. */
export type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialClaims =
  WorkspaceSearchMigrationRehearsalStageFaultSelectionClaims & {
    /** Fixed response-loss completion discriminator. */
    readonly kind:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_COMPLETION_MATERIAL_KIND
    /** Fault-material schema version. */
    readonly materialVersion:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_VERSION
    /** Digest of the exact persisted and acknowledged boundary material. */
    readonly boundaryMaterialDigest: string
    /** Same exact runtime fault receipt digest proven at the boundary. */
    readonly faultReceiptDigest: string
    /** Same authenticated reservation proven at the fault boundary. */
    readonly stageReservation:
      WorkspaceSearchMigrationRehearsalClaimedStageContext['stageReservation']
    /** Same claimed durable head proven at the fault boundary. */
    readonly claimedStageHead:
      WorkspaceSearchMigrationRehearsalClaimedStageContext['claimedStageHead']
    /** Same stable lease generation identity proven at the boundary. */
    readonly leaseIdentityDigest: string
    /** Same exact adapter acquisition proven at the boundary. */
    readonly leaseAcquisitionObservation:
      WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
    /** Complete FIFO authority-adoption chain observed through completion. */
    readonly authorityAdoptionObservations:
      readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
    /** Same adapter-proven runtime fault state proven at the boundary. */
    readonly faultObservation:
      WorkspaceSearchMigrationRehearsalFaultObservation
    /** Trusted identifier-free reconciliation mutation result. */
    readonly mutationResult: WorkspaceSearchMigrationRehearsalChildMutationResult
    /** Digest of the exact trusted mutation result. */
    readonly mutationResultDigest: string
    /** Digest of the exact canonical stdout line emitted by the child. */
    readonly serializedOutputLineDigest: string
    /** Authenticated final durable rate segment after reconciliation. */
    readonly rateSegment: WorkspaceSearchMigrationRehearsalChildRateSegment
  }

/** Complete HMAC-authenticated response-loss completion material. */
export type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial =
  WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialClaims & {
    /** HMAC-SHA-256 over the exact canonical completion claims. */
    readonly materialMac: string
  }

/** Input for creating one stopped-child fault-boundary material line. */
export type CreateWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialInput = {
  /** Authenticated fault stage selected before session construction. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact reviewed canonical fault plan selected by the manifest. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact secret-free receipt emitted by the runtime fault controller. */
  readonly faultReceipt: WorkspaceSearchMigrationRehearsalFaultReceipt
  /** Exact durable rate prefix returned by the fault callback flush. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Fresh authenticated reservation passed into session construction. */
  readonly stageReservation: unknown
  /** Durable head read immediately after the successful session claim. */
  readonly claimedStageHead: unknown
  /** Exact-once adapter observation for the durable lease acquisition. */
  readonly leaseAcquisitionObservation: unknown
  /** Optional FIFO observations captured no later than the fault boundary. */
  readonly authorityAdoptionObservations?: unknown
  /** Exact-once adapter observation of durable runtime fault state. */
  readonly faultObservation: unknown
  /** Shared 32-byte stage evidence authentication key. */
  readonly authenticationKey: Uint8Array
}

/** Input for independently verifying one boundary material line. */
export type VerifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialInput = {
  /** Untrusted parsed boundary-material candidate. */
  readonly material: unknown
  /** Stage selected independently by the parent. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Reviewed fault plan read independently by the parent. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact stable durable rate-prefix bytes read independently by the parent. */
  readonly rateSegmentBytes: Uint8Array
  /** Shared 32-byte stage evidence verification key. */
  readonly verificationKey: Uint8Array
}

/** Input for creating response-loss completion after final rate close. */
export type CreateWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialInput = {
  /** Authenticated response-loss stage selected before session construction. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact reviewed response-loss fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Previously emitted authenticated boundary material. */
  readonly boundaryMaterial:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Exact rate-prefix bytes used to create the boundary material. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Trusted post-reconciliation pre-stdout mutation observation. */
  readonly observation:
    WorkspaceSearchMigrationRehearsalCapturedMutationObservation
  /** Optional complete FIFO chain including post-boundary observations. */
  readonly authorityAdoptionObservations?: unknown
  /** Exact final durable rate segment returned before runtime close. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Shared 32-byte stage evidence authentication key. */
  readonly authenticationKey: Uint8Array
}

/** Input for independently verifying response-loss completion material. */
export type VerifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialInput = {
  /** Untrusted parsed completion-material candidate. */
  readonly material: unknown
  /** Stage selected independently by the parent. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Reviewed response-loss fault plan read independently by the parent. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Already parsed boundary material persisted before the first ACK. */
  readonly boundaryMaterial:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Stable durable rate-prefix bytes authenticated before the first ACK. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Stable final durable rate bytes read before the final ACK. */
  readonly finalRateSegmentBytes: Uint8Array
  /** Shared 32-byte stage evidence verification key. */
  readonly verificationKey: Uint8Array
}

/** Detached reauthenticated scalar stage selection. */
type FaultMaterialSelection =
  WorkspaceSearchMigrationRehearsalStageFaultSelectionClaims & {
    /** Reviewed measured configuration binding from the manifest. */
    readonly configurationBindingDigest: string
    /** Reviewed DescribeTable rate-policy binding from the manifest. */
    readonly policyVersion: string
  }

/** Strict fault scenario semantics fixed independently of the fault plan. */
type FaultScenarioContract = {
  /** Exact runtime failpoint admitted for the selected scenario. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint
  /** Exact existing control command that owns the failpoint. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Exact manifest outcome required for this fault action. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Exact external parent action required for this failpoint. */
  readonly action: WorkspaceSearchMigrationRehearsalFaultReceipt['action']
}

/** Exact public selected-stage object keys. */
const selectedStageKeys = Object.freeze([
  'entry',
  'manifest',
  'manifestDigest',
  'previousStageReceiptDigest',
])

/** Exact selected manifest-entry keys. */
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

/** Exact rate summary keys carried by both material phases. */
const rateSegmentKeys = Object.freeze([
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

/** Exact committed runtime segment keys accepted while creating material. */
const committedRateSegmentKeys = Object.freeze([
  'canonicalBytes',
  ...rateSegmentKeys,
])

/** Exact boundary material keys. */
const boundaryMaterialKeys = Object.freeze([
  'attemptOrdinal',
  'authorityAdoptionObservations',
  'claimedStageHead',
  'command',
  'controlArgumentsDigest',
  'expectedOutcome',
  'faultObservation',
  'faultPlanDigest',
  'faultReceipt',
  'faultReceiptDigest',
  'kind',
  'leaseAcquisitionObservation',
  'leaseIdentityDigest',
  'manifestDigest',
  'manifestEntryDigest',
  'materialMac',
  'materialVersion',
  'previousStageReceiptDigest',
  'rateSegment',
  'scenario',
  'scenarioStageOrdinal',
  'stageReservation',
  'stageOrdinal',
])

/** Exact response-loss completion material keys. */
const completionMaterialKeys = Object.freeze([
  'attemptOrdinal',
  'authorityAdoptionObservations',
  'boundaryMaterialDigest',
  'claimedStageHead',
  'command',
  'controlArgumentsDigest',
  'expectedOutcome',
  'faultObservation',
  'faultPlanDigest',
  'faultReceiptDigest',
  'kind',
  'leaseAcquisitionObservation',
  'leaseIdentityDigest',
  'manifestDigest',
  'manifestEntryDigest',
  'materialMac',
  'materialVersion',
  'mutationResult',
  'mutationResultDigest',
  'previousStageReceiptDigest',
  'rateSegment',
  'scenario',
  'scenarioStageOrdinal',
  'serializedOutputLineDigest',
  'stageReservation',
  'stageOrdinal',
])

/** Strict guards mapping every malformed value to one stable public failure. */
const faultMaterialGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failFaultMaterial,
)

/**
 * Creates authenticated boundary material only after a durable rate flush.
 *
 * @param input - Selection, reviewed plan, receipt, rate prefix, and key.
 * @returns Frozen canonical fault-boundary material.
 */
export function createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial(
  input: CreateWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialInput,
): WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial {
  const key = copyFaultMaterialKey(input.authenticationKey)
  try {
    const selection = snapshotFaultSelection(input.selection, key)
    const plan = requireSelectedFaultPlan(input.faultPlan, selection)
    const faultReceipt = requireFaultReceipt(
      input.faultReceipt,
      plan,
      selection,
    )
    const claimedStageContext =
      verifyWorkspaceSearchMigrationRehearsalClaimedStageContext({
        stageReservation: input.stageReservation,
        claimedStageHead: input.claimedStageHead,
        selection: input.selection,
        verificationKey: key,
      })
    const rateSegment = authenticateCommittedRateSegment(
      input.committedRateSegment,
      selection,
      claimedStageContext.stageReservation.expectedPreviousRateSegment,
      key,
    )
    const leaseAcquisitionObservation =
      verifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation({
        observation: input.leaseAcquisitionObservation,
        selection: input.selection,
        verificationKey: key,
      })
    const authorityAdoptionObservations =
      snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
        input.authorityAdoptionObservations ?? Object.freeze([]),
      )
    const faultObservation =
      verifyWorkspaceSearchMigrationRehearsalFaultObservation({
        observation: input.faultObservation,
        faultReceipt,
        leaseIdentityDigest:
          readObservedLeaseIdentityDigest(leaseAcquisitionObservation),
      })
    const claims = createBoundaryClaims(
      selection,
      faultReceipt,
      rateSegment,
      claimedStageContext,
      leaseAcquisitionObservation,
      authorityAdoptionObservations,
      faultObservation,
    )
    const material = Object.freeze({
      ...claims,
      materialMac: createFaultMaterialMac(
        faultBoundaryMacDomain,
        claims,
        key,
      ),
    })
    requireBoundedCanonicalMaterial(material)
    return material
  } catch {
    return failFaultMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Verifies boundary material against independent selection, plan, and bytes.
 *
 * @param input - Candidate material and independent parent trust inputs.
 * @returns Frozen detached authenticated boundary material.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial(
  input: VerifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialInput,
): WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial {
  const key = copyFaultMaterialKey(input.verificationKey)
  try {
    const selection = snapshotFaultSelection(input.selection, key)
    const plan = requireSelectedFaultPlan(input.faultPlan, selection)
    const record = requireExactRecord(input.material, boundaryMaterialKeys)
    const faultReceipt = requireFaultReceipt(
      faultMaterialGuards.readOwn(record, 'faultReceipt'),
      plan,
      selection,
    )
    const claimedStageContext =
      verifyWorkspaceSearchMigrationRehearsalClaimedStageContext({
        stageReservation:
          faultMaterialGuards.readOwn(record, 'stageReservation'),
        claimedStageHead:
          faultMaterialGuards.readOwn(record, 'claimedStageHead'),
        selection: input.selection,
        verificationKey: key,
      })
    const rateSegment = authenticateRateSegmentBytes(
      input.rateSegmentBytes,
      selection,
      claimedStageContext.stageReservation.expectedPreviousRateSegment,
      key,
    )
    requireRateSegmentClaim(
      faultMaterialGuards.readOwn(record, 'rateSegment'),
      rateSegment,
    )
    const leaseAcquisitionObservation =
      verifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation({
        observation: faultMaterialGuards.readOwn(
          record,
          'leaseAcquisitionObservation',
        ),
        selection: input.selection,
        verificationKey: key,
      })
    const authorityAdoptionObservations =
      snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
        faultMaterialGuards.readOwn(
          record,
          'authorityAdoptionObservations',
        ),
      )
    const faultObservation =
      verifyWorkspaceSearchMigrationRehearsalFaultObservation({
        observation: faultMaterialGuards.readOwn(
          record,
          'faultObservation',
        ),
        faultReceipt,
        leaseIdentityDigest:
          readObservedLeaseIdentityDigest(leaseAcquisitionObservation),
      })
    const claims = createBoundaryClaims(
      selection,
      faultReceipt,
      rateSegment,
      claimedStageContext,
      leaseAcquisitionObservation,
      authorityAdoptionObservations,
      faultObservation,
    )
    requireBoundaryClaimEquality(record, claims)
    const materialMac = faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'materialMac'),
    )
    if (!safeDigestEqual(
      materialMac,
      createFaultMaterialMac(faultBoundaryMacDomain, claims, key),
    )) return failFaultMaterial()
    const material = Object.freeze({ ...claims, materialMac })
    requireBoundedCanonicalMaterial(material)
    return material
  } catch {
    return failFaultMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Creates final authenticated material after response-loss reconciliation.
 *
 * @param input - Boundary, trusted result, final rate segment, and key.
 * @returns Frozen canonical response-loss completion material.
 */
export function createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial(
  input: CreateWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialInput,
): WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial {
  const key = copyFaultMaterialKey(input.authenticationKey)
  try {
    const selection = snapshotFaultSelection(input.selection, key)
    const plan = requireSelectedFaultPlan(input.faultPlan, selection)
    if (readFaultScenarioContract(selection.scenario).action !== 'response-loss') {
      return failFaultMaterial()
    }
    const boundaryMaterial =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material: input.boundaryMaterial,
        selection: input.selection,
        faultPlan: plan,
        rateSegmentBytes: input.boundaryRateSegmentBytes,
        verificationKey: key,
      })
    const observation =
      verifyWorkspaceSearchMigrationRehearsalCapturedMutationObservation({
        selection: input.selection,
        observation: input.observation,
        verificationKey: key,
      })
    const authorityAdoptionObservations =
      snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
        input.authorityAdoptionObservations ??
          boundaryMaterial.authorityAdoptionObservations,
      )
    const finalRateSegment = authenticateCommittedRateSegment(
      input.committedRateSegment,
      selection,
      boundaryMaterial.stageReservation.expectedPreviousRateSegment,
      key,
    )
    requireRateSegmentExtension(
      input.boundaryRateSegmentBytes,
      input.committedRateSegment.canonicalBytes,
      boundaryMaterial.rateSegment,
      finalRateSegment,
    )
    const claims = createCompletionClaims(
      selection,
      boundaryMaterial,
      observation,
      authorityAdoptionObservations,
      finalRateSegment,
    )
    const material = Object.freeze({
      ...claims,
      materialMac: createFaultMaterialMac(
        faultCompletionMacDomain,
        claims,
        key,
      ),
    })
    requireBoundedCanonicalMaterial(material)
    return material
  } catch {
    return failFaultMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Verifies response-loss completion against both rate states and boundary.
 *
 * @param input - Candidate completion and independent parent trust inputs.
 * @returns Frozen detached authenticated completion material.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial(
  input: VerifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialInput,
): WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial {
  const key = copyFaultMaterialKey(input.verificationKey)
  try {
    const selection = snapshotFaultSelection(input.selection, key)
    const plan = requireSelectedFaultPlan(input.faultPlan, selection)
    if (readFaultScenarioContract(selection.scenario).action !== 'response-loss') {
      return failFaultMaterial()
    }
    const boundaryMaterial =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material: input.boundaryMaterial,
        selection: input.selection,
        faultPlan: plan,
        rateSegmentBytes: input.boundaryRateSegmentBytes,
        verificationKey: key,
      })
    const record = requireExactRecord(input.material, completionMaterialKeys)
    const finalRateSegment = authenticateRateSegmentBytes(
      input.finalRateSegmentBytes,
      selection,
      boundaryMaterial.stageReservation.expectedPreviousRateSegment,
      key,
    )
    requireRateSegmentClaim(
      faultMaterialGuards.readOwn(record, 'rateSegment'),
      finalRateSegment,
    )
    requireRateSegmentExtension(
      input.boundaryRateSegmentBytes,
      input.finalRateSegmentBytes,
      boundaryMaterial.rateSegment,
      finalRateSegment,
    )
    const observation =
      verifyWorkspaceSearchMigrationRehearsalCapturedMutationObservation({
        selection: input.selection,
        observation: Object.freeze({
          result: faultMaterialGuards.readOwn(record, 'mutationResult'),
          serializedOutputLineDigest: faultMaterialGuards.readDigest(
            faultMaterialGuards.readOwn(
              record,
              'serializedOutputLineDigest',
            ),
          ),
        }),
        verificationKey: key,
      })
    const authorityAdoptionObservations =
      snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
        faultMaterialGuards.readOwn(
          record,
          'authorityAdoptionObservations',
        ),
      )
    const claims = createCompletionClaims(
      selection,
      boundaryMaterial,
      observation,
      authorityAdoptionObservations,
      finalRateSegment,
    )
    requireCompletionClaimEquality(record, claims)
    const materialMac = faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'materialMac'),
    )
    if (!safeDigestEqual(
      materialMac,
      createFaultMaterialMac(faultCompletionMacDomain, claims, key),
    )) return failFaultMaterial()
    const material = Object.freeze({ ...claims, materialMac })
    requireBoundedCanonicalMaterial(material)
    return material
  } catch {
    return failFaultMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Parses exact canonical boundary bytes and verifies all nested bindings.
 *
 * @param bytes - Exact FD3 line body without its LF delimiter.
 * @param input - Independent selection, plan, rate bytes, and key.
 * @returns Frozen detached authenticated boundary material.
 */
export function parseWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialDocument(
  bytes: Uint8Array,
  input: Omit<
    VerifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialInput,
    'material'
  >,
): WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial {
  try {
    const text = decodeCanonicalMaterialBytes(bytes)
    const candidate: unknown = JSON.parse(text)
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        ...input,
        material: candidate,
      })
    if (serializeCanonicalJson(material) !== text) return failFaultMaterial()
    return material
  } catch {
    return failFaultMaterial()
  }
}

/**
 * Parses exact canonical completion bytes and verifies both protocol phases.
 *
 * @param bytes - Exact FD3 line body without its LF delimiter.
 * @param input - Independent selection, plan, boundary, rate bytes, and key.
 * @returns Frozen detached authenticated completion material.
 */
export function parseWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialDocument(
  bytes: Uint8Array,
  input: Omit<
    VerifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialInput,
    'material'
  >,
): WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial {
  try {
    const text = decodeCanonicalMaterialBytes(bytes)
    const candidate: unknown = JSON.parse(text)
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        ...input,
        material: candidate,
      })
    if (serializeCanonicalJson(material) !== text) return failFaultMaterial()
    return material
  } catch {
    return failFaultMaterial()
  }
}

/** Reauthenticates and detaches one selected fault stage. */
function snapshotFaultSelection(
  value: WorkspaceSearchMigrationRehearsalSelectedStage,
  verificationKey: Uint8Array,
): FaultMaterialSelection {
  const record = requireExactRecord(value, selectedStageKeys)
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    faultMaterialGuards.readOwn(record, 'manifest'),
    verificationKey,
  )
  const manifestDigest = createMigrationDigest(manifest)
  if (
    faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'manifestDigest'),
    ) !== manifestDigest
  ) return failFaultMaterial()
  const previousStageReceiptDigest = readNullableDigest(
    faultMaterialGuards.readOwn(record, 'previousStageReceiptDigest'),
  )
  const candidateEntry = requireExactRecord(
    faultMaterialGuards.readOwn(record, 'entry'),
    selectedEntryKeys,
  )
  const ordinal = readPositiveInteger(
    faultMaterialGuards.readOwn(candidateEntry, 'ordinal'),
  )
  const entry = manifest.entries[ordinal - 1]
  if (
    entry === undefined ||
    serializeCanonicalJson(candidateEntry) !== serializeCanonicalJson(entry) ||
    (ordinal === 1
      ? previousStageReceiptDigest !== null
      : previousStageReceiptDigest === null) ||
    entry.faultPlanDigest === null
  ) return failFaultMaterial()
  const contract = readFaultScenarioContract(entry.scenario)
  if (
    entry.command !== contract.command ||
    entry.expectedOutcome !== contract.expectedOutcome
  ) return failFaultMaterial()
  return Object.freeze({
    manifestDigest,
    manifestEntryDigest: createMigrationDigest(entry),
    previousStageReceiptDigest,
    stageOrdinal: entry.ordinal,
    scenario: entry.scenario,
    scenarioStageOrdinal: entry.scenarioStageOrdinal,
    command: entry.command,
    attemptOrdinal: entry.attemptOrdinal,
    expectedOutcome: entry.expectedOutcome,
    controlArgumentsDigest: entry.controlArgumentsDigest,
    faultPlanDigest: entry.faultPlanDigest,
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
  })
}

/** Requires the exact plan selected by the authenticated manifest entry. */
function requireSelectedFaultPlan(
  value: WorkspaceSearchMigrationRehearsalFaultPlan,
  selection: FaultMaterialSelection,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  const plan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(value)
  const contract = readFaultScenarioContract(selection.scenario)
  if (
    createMigrationDigest(plan) !== selection.faultPlanDigest ||
    plan.failpoint !== contract.failpoint
  ) return failFaultMaterial()
  return plan
}

/** Requires one receipt to exactly match the selected plan and scenario. */
function requireFaultReceipt(
  value: unknown,
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  selection: FaultMaterialSelection,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  const receipt = parseWorkspaceSearchMigrationRehearsalFaultReceipt(value)
  const contract = readFaultScenarioContract(selection.scenario)
  if (
    receipt.failpoint !== plan.failpoint ||
    receipt.action !== contract.action ||
    serializeCanonicalJson(receipt.target) !==
      serializeCanonicalJson(plan.target)
  ) return failFaultMaterial()
  return receipt
}

/** Returns the exact failpoint, action, command, and outcome for a scenario. */
function readFaultScenarioContract(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): FaultScenarioContract {
  switch (scenario) {
    case 'cursor-before-commit-kill':
      return Object.freeze({
        failpoint: 'apply-checkpoint-cursor-captured-before-commit',
        command: 'apply',
        expectedOutcome: 'fault-reached',
        action: 'barrier',
      })
    case 'cursor-after-commit-kill':
      return Object.freeze({
        failpoint: 'apply-checkpoint-cursor-committed-before-return',
        command: 'apply',
        expectedOutcome: 'fault-reached',
        action: 'barrier',
      })
    case 'artifact-before-checkpoint-kill':
      return Object.freeze({
        failpoint: 'planning-page-artifact-uploaded-before-checkpoint-commit',
        command: 'close-replan',
        expectedOutcome: 'fault-reached',
        action: 'barrier',
      })
    case 'transaction-response-loss':
      return Object.freeze({
        failpoint: 'planning-page-transaction-response-lost',
        command: 'close-replan',
        expectedOutcome: 'response-loss-reconciled',
        action: 'response-loss',
      })
    case 'lease-expiry-takeover':
      return Object.freeze({
        failpoint: 'lease-acquired-before-first-heartbeat',
        command: 'close-replan',
        expectedOutcome: 'fault-reached',
        action: 'barrier',
      })
    case 'partial-apply-rollback':
      return Object.freeze({
        failpoint: 'apply-operation-committed-before-return',
        command: 'apply',
        expectedOutcome: 'fault-reached',
        action: 'barrier',
      })
    default:
      return failFaultMaterial()
  }
}

/** Creates exact boundary claims from already authenticated values. */
function createBoundaryClaims(
  selection: FaultMaterialSelection,
  faultReceipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
  rateSegment: WorkspaceSearchMigrationRehearsalChildRateSegment,
  claimedStageContext: WorkspaceSearchMigrationRehearsalClaimedStageContext,
  leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
  authorityAdoptionObservations:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
  faultObservation: WorkspaceSearchMigrationRehearsalFaultObservation,
): WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialClaims {
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_BOUNDARY_MATERIAL_KIND,
    materialVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_VERSION,
    ...readSelectionClaims(selection),
    ...claimedStageContext,
    leaseIdentityDigest:
      readObservedLeaseIdentityDigest(leaseAcquisitionObservation),
    leaseAcquisitionObservation,
    authorityAdoptionObservations,
    faultObservation,
    faultReceipt,
    faultReceiptDigest: createMigrationDigest(faultReceipt),
    rateSegment,
  })
}

/** Returns the stable current identity from either verified observation kind. */
function readObservedLeaseIdentityDigest(
  observation: WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/** Creates exact completion claims from authenticated protocol state. */
function createCompletionClaims(
  selection: FaultMaterialSelection,
  boundary: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  observation: WorkspaceSearchMigrationRehearsalCapturedMutationObservation,
  authorityAdoptionObservations:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
  rateSegment: WorkspaceSearchMigrationRehearsalChildRateSegment,
): WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialClaims {
  if (
    authorityAdoptionObservations.length <
      boundary.authorityAdoptionObservations.length
  ) return failFaultMaterial()
  for (
    let index = 0;
    index < boundary.authorityAdoptionObservations.length;
    index += 1
  ) {
    const before = boundary.authorityAdoptionObservations[index]
    const after = authorityAdoptionObservations[index]
    if (
      before === undefined ||
      after === undefined ||
      before.maintenanceEvidenceRenewalCount !==
        after.maintenanceEvidenceRenewalCount ||
      before.receiptDigest !== after.receiptDigest
    ) return failFaultMaterial()
  }
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_COMPLETION_MATERIAL_KIND,
    materialVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_VERSION,
    ...readSelectionClaims(selection),
    stageReservation: boundary.stageReservation,
    claimedStageHead: boundary.claimedStageHead,
    leaseIdentityDigest: boundary.leaseIdentityDigest,
    leaseAcquisitionObservation: boundary.leaseAcquisitionObservation,
    authorityAdoptionObservations,
    faultObservation: boundary.faultObservation,
    boundaryMaterialDigest: createMigrationDigest(boundary),
    faultReceiptDigest: boundary.faultReceiptDigest,
    mutationResult: observation.result,
    mutationResultDigest: createMigrationDigest(observation.result),
    serializedOutputLineDigest: observation.serializedOutputLineDigest,
    rateSegment,
  })
}

/** Detaches the public selection claims without internal manifest bindings. */
function readSelectionClaims(
  selection: FaultMaterialSelection,
): WorkspaceSearchMigrationRehearsalStageFaultSelectionClaims {
  return Object.freeze({
    manifestDigest: selection.manifestDigest,
    manifestEntryDigest: selection.manifestEntryDigest,
    previousStageReceiptDigest: selection.previousStageReceiptDigest,
    stageOrdinal: selection.stageOrdinal,
    scenario: selection.scenario,
    scenarioStageOrdinal: selection.scenarioStageOrdinal,
    command: selection.command,
    attemptOrdinal: selection.attemptOrdinal,
    expectedOutcome: selection.expectedOutcome,
    controlArgumentsDigest: selection.controlArgumentsDigest,
    faultPlanDigest: selection.faultPlanDigest,
  })
}

/** Authenticates one committed runtime rate segment and checks its summary. */
function authenticateCommittedRateSegment(
  value: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  selection: FaultMaterialSelection,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalClaimedStageContext[
      'stageReservation'
    ]['expectedPreviousRateSegment'],
  key: Uint8Array,
): WorkspaceSearchMigrationRehearsalChildRateSegment {
  const record = requireExactRecord(value, committedRateSegmentKeys)
  const canonicalBytes = copyRateSegmentBytes(
    faultMaterialGuards.readOwn(record, 'canonicalBytes'),
  )
  const verified = authenticateRateSegmentBytes(
    canonicalBytes,
    selection,
    expectedPreviousRateSegment,
    key,
  )
  requireRateSegmentClaim(record, verified, true)
  return verified
}

/** Authenticates exact durable rate bytes under stage manifest bindings. */
function authenticateRateSegmentBytes(
  value: Uint8Array,
  selection: FaultMaterialSelection,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalClaimedStageContext[
      'stageReservation'
    ]['expectedPreviousRateSegment'],
  key: Uint8Array,
): WorkspaceSearchMigrationRehearsalChildRateSegment {
  const canonicalBytes = copyRateSegmentBytes(value)
  try {
    const verified =
      verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor({
      canonicalBytes,
      authenticationKey: key,
      expectedPreviousSegment: expectedPreviousRateSegment,
      expectedPolicyVersion: selection.policyVersion,
      expectedConfigurationBindingDigest:
        selection.configurationBindingDigest,
      })
    return Object.freeze({ ...verified })
  } catch {
    return failFaultMaterial()
  }
}

/** Requires one claimed summary to equal independently authenticated bytes. */
function requireRateSegmentClaim(
  value: unknown,
  expected: WorkspaceSearchMigrationRehearsalChildRateSegment,
  allowCanonicalBytes = false,
): void {
  const record = requireExactRecord(value, [
    ...(allowCanonicalBytes ? ['canonicalBytes'] : []),
    ...rateSegmentKeys,
  ])
  const candidate = Object.freeze({
    authenticationKeyFingerprint: faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeInteger(
      faultMaterialGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence: readPositiveInteger(
      faultMaterialGuards.readOwn(record, 'firstEventSequence'),
    ),
    eventCount: readNonNegativeInteger(
      faultMaterialGuards.readOwn(record, 'eventCount'),
    ),
    firstCommittedEventSequence: readNullablePositiveInteger(
      faultMaterialGuards.readOwn(record, 'firstCommittedEventSequence'),
    ),
    lastCommittedEventSequence: readNullablePositiveInteger(
      faultMaterialGuards.readOwn(record, 'lastCommittedEventSequence'),
    ),
    terminalRecordMac: faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: faultMaterialGuards.readDigest(
      faultMaterialGuards.readOwn(record, 'segmentDigest'),
    ),
  })
  if (
    serializeCanonicalJson(candidate) !== serializeCanonicalJson(expected)
  ) return failFaultMaterial()
}

/** Requires the final rate bytes to be the same segment and extend its prefix. */
function requireRateSegmentExtension(
  boundaryBytesValue: Uint8Array,
  finalBytesValue: Uint8Array,
  boundary: WorkspaceSearchMigrationRehearsalChildRateSegment,
  final: WorkspaceSearchMigrationRehearsalChildRateSegment,
): void {
  const boundaryBytes = copyRateSegmentBytes(boundaryBytesValue)
  const finalBytes = copyRateSegmentBytes(finalBytesValue)
  if (
    final.authenticationKeyFingerprint !==
      boundary.authenticationKeyFingerprint ||
    final.segmentLocatorDigest !== boundary.segmentLocatorDigest ||
    final.segmentOrdinal !== boundary.segmentOrdinal ||
    final.eventCount < boundary.eventCount ||
    finalBytes.byteLength < boundaryBytes.byteLength
  ) return failFaultMaterial()
  for (let index = 0; index < boundaryBytes.byteLength; index += 1) {
    if (boundaryBytes[index] !== finalBytes[index]) return failFaultMaterial()
  }
}

/** Requires every boundary claim to equal the reconstructed trusted claims. */
function requireBoundaryClaimEquality(
  record: object,
  claims: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialClaims,
): void {
  const candidate = createRecordWithoutMac(record, boundaryMaterialKeys)
  if (serializeCanonicalJson(candidate) !== serializeCanonicalJson(claims)) {
    return failFaultMaterial()
  }
}

/** Requires every completion claim to equal reconstructed trusted claims. */
function requireCompletionClaimEquality(
  record: object,
  claims: WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialClaims,
): void {
  const candidate = createRecordWithoutMac(record, completionMaterialKeys)
  if (serializeCanonicalJson(candidate) !== serializeCanonicalJson(claims)) {
    return failFaultMaterial()
  }
}

/** Copies exact own material properties except the outer MAC. */
function createRecordWithoutMac(
  record: object,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (key !== 'materialMac') {
      result[key] = faultMaterialGuards.readOwn(record, key)
    }
  }
  return Object.freeze(result)
}

/** Creates one domain-separated HMAC over exact canonical claims. */
function createFaultMaterialMac(
  domain: string,
  claims:
    | WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialClaims
    | WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Decodes one bounded nonempty canonical material line body. */
function decodeCanonicalMaterialBytes(value: Uint8Array): string {
  const bytes = copyRateSegmentBytes(value)
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES
  ) return failFaultMaterial()
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\r') || text.includes('\n')) return failFaultMaterial()
    return text
  } catch {
    return failFaultMaterial()
  }
}

/** Requires one created material to stay within the FD3 byte ceiling. */
function requireBoundedCanonicalMaterial(value: unknown): void {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES
  ) return failFaultMaterial()
}

/** Copies one exact non-Proxy 32-byte authentication key. */
function copyFaultMaterialKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    value.byteLength !== faultMaterialKeyBytes
  ) return failFaultMaterial()
  return new Uint8Array(value)
}

/** Copies one finite nonempty non-Proxy durable rate byte vector. */
function copyRateSegmentBytes(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    value.byteLength === 0
  ) return failFaultMaterial()
  return new Uint8Array(value)
}

/** Requires one ordinary exact-key data record. */
function requireExactRecord(
  value: unknown,
  keys: readonly string[],
): object {
  const record = faultMaterialGuards.requireRecord(value)
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) {
    return failFaultMaterial()
  }
  faultMaterialGuards.requireExactKeys(record, keys)
  return record
}

/** Reads one nullable lowercase SHA-256 digest. */
function readNullableDigest(value: unknown): string | null {
  return value === null ? null : faultMaterialGuards.readDigest(value)
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) return failFaultMaterial()
  return value
}

/** Reads one non-negative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failFaultMaterial()
  return value
}

/** Reads one nullable positive safe integer. */
function readNullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : readPositiveInteger(value)
}

/** Compares conventional digests without timing-sensitive string equality. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex'),
  )
}

/** Raises the sole stable fault-material validation failure. */
function failFaultMaterial(): never {
  throw new WorkspaceSearchMigrationRehearsalStageFaultMaterialError()
}
