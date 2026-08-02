import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationControlCliMutationResultObservation,
} from './migration-control-cli'
import type {
  WorkspaceSearchMigrationControlCoordinatorSummary,
} from './migration-control-coordinator'
import {
  verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
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
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageHead,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'

/** Stable discriminator for authenticated generic-success child material. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-child-material'

/** First authenticated generic-success child-material contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_VERSION =
  1

/** Maximum exact canonical bytes accepted from the dedicated child FD. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES =
  256 * 1_024

/** Domain separator for the child-material HMAC. */
const childMaterialMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-child-material:v1'

/** Exact raw byte length of the shared rehearsal evidence key. */
const childMaterialKeyBytes = 32

/** Identifier-free mutation result retained from the trusted pre-stdout hook. */
export type WorkspaceSearchMigrationRehearsalChildMutationResult = {
  /** Existing control result schema version. */
  readonly schemaVersion: 1
  /** Exact reviewed mutating command selected by the manifest. */
  readonly operation: WorkspaceSearchMigrationRehearsalStageCommand
  /** Mandatory successful control result. */
  readonly status: 'pass'
  /** Reviewed measured configuration digest. */
  readonly configurationHash: string
  /** Reviewed DescribeTable policy digest. */
  readonly policyVersion: string
  /** Strict command-specific identifier-free coordinator projection. */
  readonly coordinator: WorkspaceSearchMigrationControlCoordinatorSummary
  /** Strict identifier-free actual-rate aggregate. */
  readonly rateAggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Trusted observation detached without retaining the raw stdout line. */
export type WorkspaceSearchMigrationRehearsalCapturedMutationObservation = {
  /** Exact identifier-free mutation result captured before stdout. */
  readonly result: WorkspaceSearchMigrationRehearsalChildMutationResult
  /** Digest of the exact serialized line later written unchanged to stdout. */
  readonly serializedOutputLineDigest: string
}

/** Authenticated reservation and the exact durable head claimed by the child. */
export type WorkspaceSearchMigrationRehearsalClaimedStageContext = {
  /** Fresh authenticated reservation durably claimed before measured mutation. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Secret-free durable head returned by the successful reservation CAS. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
}

/** Adapter-proven durable lease observation without raw lease identifiers. */
export type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation =
  | {
      /** Discriminates a newly committed acquisition. */
      readonly kind: 'acquired'
      /** Stable predecessor identity consumed by CAS, or null initially. */
      readonly predecessorLeaseIdentityDigest: string | null
      /** Exact predecessor expiry consumed by CAS, or null initially. */
      readonly predecessorLeaseExpiresAt: string | null
      /** Exact trusted acquisition commit time. */
      readonly acquiredAt: string
      /** Stable newly durable successor identity excluding mutable expiry. */
      readonly successorLeaseIdentityDigest: string
      /** Exact expiry installed by the acquisition transaction. */
      readonly successorLeaseExpiresAt: string
    }
  | {
      /** Discriminates a verified reuse of the matching active lease. */
      readonly kind: 'reused-active'
      /** Stable identity of the matching active lease returned by the adapter. */
      readonly currentLeaseIdentityDigest: string
      /** Exact trusted time at which the adapter evaluated the active lease. */
      readonly evaluatedAt: string
      /** Exact current expiry proven to remain later than evaluation time. */
      readonly currentLeaseExpiresAt: string
    }

/** Durable rate segment closed after the trusted mutation observation. */
export type WorkspaceSearchMigrationRehearsalChildRateSegment = {
  /** Domain-separated fingerprint of the segment authentication key. */
  readonly authenticationKeyFingerprint: string
  /** Opaque authenticated process-segment locator. */
  readonly segmentLocatorDigest: string
  /** Zero-based process segment ordinal. */
  readonly segmentOrdinal: number
  /** Global event sequence allocated by the authenticated segment header. */
  readonly firstEventSequence: number
  /** Number of durably committed DescribeTable events. */
  readonly eventCount: number
  /** First global committed sequence, or null for an empty segment. */
  readonly firstCommittedEventSequence: number | null
  /** Last global committed sequence, or null for an empty segment. */
  readonly lastCommittedEventSequence: number | null
  /** HMAC of the final durable rate record. */
  readonly terminalRecordMac: string
  /** Digest of the exact durable segment prefix. */
  readonly segmentDigest: string
}

/** Canonical authenticated generic-success material claims. */
export type WorkspaceSearchMigrationRehearsalStageChildMaterialClaims = {
  /** Fixed child-material discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_KIND
  /** Child-material schema version. */
  readonly materialVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_VERSION
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the authenticated predecessor receipt, or null at stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Globally contiguous selected stage ordinal. */
  readonly stageOrdinal: number
  /** Canonical scenario owning the selected stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Contiguous stage ordinal within the scenario. */
  readonly scenarioStageOrdinal: number
  /** Exact existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** One-based process-attempt ordinal within the scenario. */
  readonly attemptOrdinal: number
  /** Exact authenticated expected outcome for this invocation. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Digest of the exact control argument vector. */
  readonly controlArgumentsDigest: string
  /** Fresh authenticated reservation durably claimed before mutation. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Exact secret-free durable head returned by the successful claim. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
  /** Stable identity of the lease generation used by this attempt. */
  readonly leaseIdentityDigest: string
  /** Adapter-proven acquisition or active reuse for this attempt's lease. */
  readonly leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
  /** Complete FIFO authority-adoption chain observed by this child session. */
  readonly authorityAdoptionObservations:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Exact trusted identifier-free mutation result. */
  readonly mutationResult: WorkspaceSearchMigrationRehearsalChildMutationResult
  /** Digest of the exact detached mutation result. */
  readonly mutationResultDigest: string
  /** Digest of the exact trusted serialized stdout line. */
  readonly serializedOutputLineDigest: string
  /** Exact durable rate segment closed after the control mutation. */
  readonly rateSegment: WorkspaceSearchMigrationRehearsalChildRateSegment
}

/** Complete domain-separated authenticated generic-success child material. */
export type WorkspaceSearchMigrationRehearsalStageChildMaterial =
  WorkspaceSearchMigrationRehearsalStageChildMaterialClaims & {
    /** HMAC-SHA-256 over the exact canonical child-material claims. */
    readonly materialMac: string
  }

/** Input for capturing the trusted existing control mutation observer. */
export type CaptureWorkspaceSearchMigrationRehearsalChildMutationObservationInput = {
  /** Authenticated unfaulted stage selected before session construction. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte key used to reauthenticate the selection. */
  readonly authenticationKey: Uint8Array
  /** Existing trusted pre-stdout mutation observation. */
  readonly observation:
    WorkspaceSearchMigrationControlCliMutationResultObservation
}

/** Input for revalidating one detached trusted mutation observation. */
export type VerifyWorkspaceSearchMigrationRehearsalCapturedMutationObservationInput = {
  /** Authenticated selected stage owning the observed mutation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Detached observation previously captured by the pre-stdout hook. */
  readonly observation: unknown
  /** Shared 32-byte key used to reauthenticate the selection. */
  readonly verificationKey: Uint8Array
}

/** Input for creating authenticated material after rate-runtime close. */
export type CreateWorkspaceSearchMigrationRehearsalStageChildMaterialInput = {
  /** Authenticated unfaulted stage selected before session construction. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Detached trusted mutation observation captured before stdout. */
  readonly observation:
    WorkspaceSearchMigrationRehearsalCapturedMutationObservation
  /** Exact committed rate segment returned by runtime close. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Fresh authenticated reservation passed into session construction. */
  readonly stageReservation: unknown
  /** Durable head read immediately after the session claimed the reservation. */
  readonly claimedStageHead: unknown
  /** Exact-once adapter observation for acquisition or active reuse. */
  readonly leaseAcquisitionObservation: unknown
  /** Optional FIFO adapter observations for every adoption in this session. */
  readonly authorityAdoptionObservations?: unknown
  /** Shared 32-byte stage-manifest and receipt authentication key. */
  readonly authenticationKey: Uint8Array
}

/** Input for verifying one child material against the parent selection. */
export type VerifyWorkspaceSearchMigrationRehearsalStageChildMaterialInput = {
  /** Untrusted parsed child-material candidate. */
  readonly material: unknown
  /** Authenticated stage selected independently by the parent. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte stage-manifest and receipt verification key. */
  readonly verificationKey: Uint8Array
}

/** Input for independently validating one claimed stage execution context. */
export type VerifyWorkspaceSearchMigrationRehearsalClaimedStageContextInput = {
  /** Untrusted authenticated reservation candidate. */
  readonly stageReservation: unknown
  /** Untrusted secret-free claimed durable head candidate. */
  readonly claimedStageHead: unknown
  /** Independently authenticated selected stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte stage verification key. */
  readonly verificationKey: Uint8Array
}

/** Input for independently validating one adapter lease observation. */
export type VerifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservationInput = {
  /** Untrusted detached adapter observation candidate. */
  readonly observation: unknown
  /** Independently authenticated selected stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte stage verification key. */
  readonly verificationKey: Uint8Array
}

/** Stable raw-free child-material trust-boundary failure. */
export class WorkspaceSearchMigrationRehearsalStageChildMaterialError
  extends Error {
  /** Creates one stable child-material failure. */
  constructor() {
    super('INVALID_STAGE_CHILD_MATERIAL')
    this.name =
      'WorkspaceSearchMigrationRehearsalStageChildMaterialError'
  }
}

/**
 * Captures one trusted mutation observation without retaining raw stdout.
 *
 * @param input - Authenticated selection and existing pre-stdout observation.
 * @returns Frozen identifier-free mutation result and exact output digest.
 */
export function captureWorkspaceSearchMigrationRehearsalChildMutationObservation(
  input: CaptureWorkspaceSearchMigrationRehearsalChildMutationObservationInput,
): WorkspaceSearchMigrationRehearsalCapturedMutationObservation {
  const key = copyChildMaterialKey(input.authenticationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    requireMutationObservationSelection(selection)
    const observation = input.observation
    if (
      typeof observation !== 'object' ||
      observation === null ||
      nodeUtilTypes.isProxy(observation)
    ) return failChildMaterial()
    const serializedOutputLine = observation.serializedOutputLine
    const serializedOutputLineDigest = observation.serializedOutputLineDigest
    if (
      typeof serializedOutputLine !== 'string' ||
      serializedOutputLine.length === 0 ||
      serializedOutputLine.includes('\r') ||
      serializedOutputLine.includes('\n') ||
      readUtf8ByteLength(serializedOutputLine) >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES ||
      !isHexDigest(serializedOutputLineDigest) ||
      createMigrationDigest(serializedOutputLine) !== serializedOutputLineDigest ||
      serializeCanonicalJson(JSON.parse(serializedOutputLine)) !==
        serializedOutputLine
    ) return failChildMaterial()
    const result = readMutationResult(
      observation.result,
      selection.command,
      selection.configurationBindingDigest,
      selection.policyVersion,
    )
    return Object.freeze({ result, serializedOutputLineDigest })
  } catch {
    return failChildMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Revalidates a detached pre-stdout mutation observation against its selection.
 *
 * This shared boundary admits ordinary generic success and the sole
 * response-loss reconciliation stage. Generic child-material creation still
 * rejects every fault-plan-bearing selection.
 *
 * @param input - Detached observation, authenticated selection, and key.
 * @returns Frozen identifier-free mutation result and stdout-line digest.
 */
export function verifyWorkspaceSearchMigrationRehearsalCapturedMutationObservation(
  input: VerifyWorkspaceSearchMigrationRehearsalCapturedMutationObservationInput,
): WorkspaceSearchMigrationRehearsalCapturedMutationObservation {
  const key = copyChildMaterialKey(input.verificationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    requireMutationObservationSelection(selection)
    return readCapturedObservation(input.observation, selection)
  } catch {
    return failChildMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Verifies the fresh reservation and the exact durable head claimed for it.
 *
 * @param input - Candidate reservation, claimed head, selection, and key.
 * @returns Frozen detached reservation and claimed-head execution context.
 */
export function verifyWorkspaceSearchMigrationRehearsalClaimedStageContext(
  input: VerifyWorkspaceSearchMigrationRehearsalClaimedStageContextInput,
): WorkspaceSearchMigrationRehearsalClaimedStageContext {
  const key = copyChildMaterialKey(input.verificationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    return readClaimedStageContext(
      input.stageReservation,
      input.claimedStageHead,
      input.selection,
      selection,
      key,
    )
  } catch {
    return failChildMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Verifies one adapter-proven durable lease observation against stage semantics.
 *
 * @param input - Candidate observation, independent selection, and key.
 * @returns Frozen identifier-free acquisition or active-reuse observation.
 */
export function verifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation(
  input: VerifyWorkspaceSearchMigrationRehearsalLeaseAcquisitionObservationInput,
): WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation {
  const key = copyChildMaterialKey(input.verificationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    return readLeaseAcquisitionObservation(input.observation, selection)
  } catch {
    return failChildMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Snapshots one complete adapter-proven authority-adoption chain.
 *
 * The first renewal is one, every successor is contiguous, and receipt
 * digests are unique. This preserves the exact FIFO sequence later admitted
 * by terminal reconciliation.
 *
 * @param value - Candidate exact authority-adoption observation array.
 * @returns Frozen detached sequential authority-adoption chain.
 */
export function snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > 100_000
  ) return failChildMaterial()
  const keys = Object.keys(value)
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) return failChildMaterial()
  const observations: WorkspaceSearchMigrationRehearsalExpectedAuthority[] = []
  const receiptDigests = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failChildMaterial()
    const record = requireExactRecord(descriptor.value, [
      'maintenanceEvidenceRenewalCount',
      'receiptDigest',
    ])
    const maintenanceEvidenceRenewalCount = readPositiveInteger(
      readOwn(record, 'maintenanceEvidenceRenewalCount'),
    )
    const receiptDigest = readDigest(readOwn(record, 'receiptDigest'))
    if (
      maintenanceEvidenceRenewalCount !== index + 1 ||
      receiptDigests.has(receiptDigest)
    ) return failChildMaterial()
    receiptDigests.add(receiptDigest)
    observations.push(Object.freeze({
      maintenanceEvidenceRenewalCount,
      receiptDigest,
    }))
  }
  return Object.freeze(observations)
}

/**
 * Creates one HMAC-authenticated child material after rate-runtime close.
 *
 * @param input - Selection, detached observation, segment, and shared key.
 * @returns Frozen canonical generic-success child material.
 */
export function createWorkspaceSearchMigrationRehearsalStageChildMaterial(
  input: CreateWorkspaceSearchMigrationRehearsalStageChildMaterialInput,
): WorkspaceSearchMigrationRehearsalStageChildMaterial {
  const key = copyChildMaterialKey(input.authenticationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    if (selection.faultPlanDigest !== null) return failChildMaterial()
    const observation = readCapturedObservation(
      input.observation,
      selection,
    )
    const claimedStageContext = readClaimedStageContext(
      input.stageReservation,
      input.claimedStageHead,
      input.selection,
      selection,
      key,
    )
    const leaseAcquisitionObservation = readLeaseAcquisitionObservation(
      input.leaseAcquisitionObservation,
      selection,
    )
    const authorityAdoptionObservations =
      snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
        input.authorityAdoptionObservations ?? Object.freeze([]),
      )
    const rateSegment = readAuthenticatedRateSegment(
      input.committedRateSegment,
      selection,
      claimedStageContext.stageReservation.expectedPreviousRateSegment,
      key,
    )
    const claims: WorkspaceSearchMigrationRehearsalStageChildMaterialClaims =
      Object.freeze({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_KIND,
        materialVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_VERSION,
        manifestDigest: selection.manifestDigest,
        manifestEntryDigest: selection.manifestEntryDigest,
        previousStageReceiptDigest:
          selection.previousStageReceiptDigest,
        stageOrdinal: selection.stageOrdinal,
        scenario: selection.scenario,
        scenarioStageOrdinal: selection.scenarioStageOrdinal,
        command: selection.command,
        attemptOrdinal: selection.attemptOrdinal,
        expectedOutcome: selection.expectedOutcome,
        controlArgumentsDigest: selection.controlArgumentsDigest,
        ...claimedStageContext,
        leaseIdentityDigest:
          readObservedLeaseIdentityDigest(leaseAcquisitionObservation),
        leaseAcquisitionObservation,
        authorityAdoptionObservations,
        mutationResult: observation.result,
        mutationResultDigest: createMigrationDigest(observation.result),
        serializedOutputLineDigest:
          observation.serializedOutputLineDigest,
        rateSegment,
      })
    const material = Object.freeze({
      ...claims,
      materialMac: createChildMaterialMac(claims, key),
    })
    if (
      readUtf8ByteLength(serializeCanonicalJson(material)) >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES
    ) return failChildMaterial()
    return material
  } finally {
    key.fill(0)
  }
}

/**
 * Verifies one parsed child material and its exact parent-side selection.
 *
 * @param input - Candidate material, independent selection, and shared key.
 * @returns Frozen detached authenticated child material.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageChildMaterial(
  input: VerifyWorkspaceSearchMigrationRehearsalStageChildMaterialInput,
): WorkspaceSearchMigrationRehearsalStageChildMaterial {
  const key = copyChildMaterialKey(input.verificationKey)
  try {
    const selection = snapshotSelection(input.selection, key)
    if (selection.faultPlanDigest !== null) return failChildMaterial()
    const record = requireExactRecord(input.material, [
      'attemptOrdinal',
      'authorityAdoptionObservations',
      'claimedStageHead',
      'command',
      'controlArgumentsDigest',
      'expectedOutcome',
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
    const claims = readMaterialClaims(
      record,
      input.selection,
      selection,
      key,
    )
    const materialMac = readDigest(readOwn(record, 'materialMac'))
    if (!safeDigestEqual(materialMac, createChildMaterialMac(claims, key))) {
      return failChildMaterial()
    }
    return Object.freeze({ ...claims, materialMac })
  } catch {
    return failChildMaterial()
  } finally {
    key.fill(0)
  }
}

/**
 * Parses bounded exact canonical bytes and verifies their selection-bound HMAC.
 *
 * @param bytes - Exact child material bytes without a trailing newline.
 * @param selection - Authenticated stage independently selected by the parent.
 * @param verificationKey - Shared 32-byte stage evidence key.
 * @returns Frozen detached authenticated child material.
 */
export function parseWorkspaceSearchMigrationRehearsalStageChildMaterialDocument(
  bytes: Uint8Array,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageChildMaterial {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES
    ) return failChildMaterial()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
        material: candidate,
        selection,
        verificationKey,
      })
    if (serializeCanonicalJson(material) !== text) return failChildMaterial()
    return material
  } catch {
    return failChildMaterial()
  }
}

/** Detached scalar binding for one authenticated stage selection. */
type ChildMaterialSelection = {
  /** Authenticated manifest digest. */
  readonly manifestDigest: string
  /** Selected entry digest. */
  readonly manifestEntryDigest: string
  /** Authenticated predecessor receipt digest. */
  readonly previousStageReceiptDigest: string | null
  /** Global stage ordinal. */
  readonly stageOrdinal: number
  /** Owning scenario. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Scenario-local stage ordinal. */
  readonly scenarioStageOrdinal: number
  /** Selected control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Process attempt ordinal. */
  readonly attemptOrdinal: number
  /** Selected expected outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Exact control argument digest. */
  readonly controlArgumentsDigest: string
  /** Selected fault-plan digest, which generic success requires to be null. */
  readonly faultPlanDigest: string | null
  /** Reviewed measured configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed rate policy binding. */
  readonly policyVersion: string
}

/** Requires a stage that can produce one successful mutation observation. */
function requireMutationObservationSelection(
  selection: ChildMaterialSelection,
): void {
  if (selection.faultPlanDigest === null) return
  if (
    selection.scenario !== 'transaction-response-loss' ||
    selection.expectedOutcome !== 'response-loss-reconciled'
  ) return failChildMaterial()
}

/** Reauthenticates one selection and snapshots only its scalar head. */
function snapshotSelection(
  value: WorkspaceSearchMigrationRehearsalSelectedStage,
  verificationKey: Uint8Array,
): ChildMaterialSelection {
  try {
    const selectionRecord = requireExactRecord(value, [
      'entry',
      'manifest',
      'manifestDigest',
      'previousStageReceiptDigest',
    ])
    const manifest =
      verifyWorkspaceSearchMigrationRehearsalStageManifest(
        readOwn(selectionRecord, 'manifest'),
        verificationKey,
      )
    const manifestDigest = createMigrationDigest(manifest)
    if (
      readDigest(readOwn(selectionRecord, 'manifestDigest')) !==
        manifestDigest
    ) return failChildMaterial()
    const previousStageReceiptDigest = readNullableDigest(
      readOwn(selectionRecord, 'previousStageReceiptDigest'),
    )
    const candidateEntry = readOwn(selectionRecord, 'entry')
    const candidateEntryRecord = requireExactRecord(candidateEntry, [
      'attemptOrdinal',
      'command',
      'controlArgumentsDigest',
      'expectedOutcome',
      'faultPlanDigest',
      'ordinal',
      'scenario',
      'scenarioStageOrdinal',
    ])
    const ordinal = readPositiveInteger(
      readOwn(candidateEntryRecord, 'ordinal'),
    )
    const entry = manifest.entries[ordinal - 1]
    if (
      entry === undefined ||
      serializeCanonicalJson(candidateEntry) !== serializeCanonicalJson(entry) ||
      (ordinal === 1
        ? previousStageReceiptDigest !== null
        : previousStageReceiptDigest === null)
    ) return failChildMaterial()
    const command = readCommand(entry.command)
    const scenario = readScenario(entry.scenario)
    const attemptOrdinal = readPositiveInteger(entry.attemptOrdinal)
    return Object.freeze({
      manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      previousStageReceiptDigest,
      stageOrdinal: ordinal,
      scenario,
      scenarioStageOrdinal:
        readPositiveInteger(entry.scenarioStageOrdinal),
      command,
      attemptOrdinal,
      expectedOutcome: readOutcome(entry.expectedOutcome),
      controlArgumentsDigest: readDigest(entry.controlArgumentsDigest),
      faultPlanDigest: readNullableDigest(entry.faultPlanDigest),
      configurationBindingDigest:
        readDigest(manifest.configurationBindingDigest),
      policyVersion: readDigest(manifest.policyVersion),
    })
  } catch {
    return failChildMaterial()
  }
}

/** Reads and detaches one captured mutation observation. */
function readCapturedObservation(
  value: unknown,
  selection: ChildMaterialSelection,
): WorkspaceSearchMigrationRehearsalCapturedMutationObservation {
  const record = requireExactRecord(value, [
    'result',
    'serializedOutputLineDigest',
  ])
  return Object.freeze({
    result: readMutationResult(
      readOwn(record, 'result'),
      selection.command,
      selection.configurationBindingDigest,
      selection.policyVersion,
    ),
    serializedOutputLineDigest: readDigest(
      readOwn(record, 'serializedOutputLineDigest'),
    ),
  })
}

/**
 * Reauthenticates one reservation and binds it to the returned durable head.
 *
 * @param reservationValue - Candidate complete authenticated reservation.
 * @param headValue - Candidate secret-free durable claimed head.
 * @param selectedStage - Complete selection used by reservation verification.
 * @param selection - Detached scalar selection used for head comparison.
 * @param verificationKey - Shared stage verification key.
 * @returns Frozen detached reservation and exact claimed durable head.
 */
function readClaimedStageContext(
  reservationValue: unknown,
  headValue: unknown,
  selectedStage: WorkspaceSearchMigrationRehearsalSelectedStage,
  selection: ChildMaterialSelection,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalClaimedStageContext {
  let stageReservation: WorkspaceSearchMigrationRehearsalStageReservation
  try {
    stageReservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: reservationValue,
        selection: selectedStage,
        verificationKey,
      })
  } catch {
    return failChildMaterial()
  }
  const record = requireExactRecord(headValue, [
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
  const claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead =
    Object.freeze({
      manifestDigest: readDigest(readOwn(record, 'manifestDigest')),
      completedStageOrdinal: readNonNegativeInteger(
        readOwn(record, 'completedStageOrdinal'),
      ),
      headReceiptDigest: readNullableDigest(
        readOwn(record, 'headReceiptDigest'),
      ),
      activeReservationDigest: readNullableDigest(
        readOwn(record, 'activeReservationDigest'),
      ),
      activeStageOrdinal: readNullablePositiveInteger(
        readOwn(record, 'activeStageOrdinal'),
      ),
      activeExpiresAt: readNullableTimestamp(
        readOwn(record, 'activeExpiresAt'),
      ),
      abandonmentCount: readNonNegativeInteger(
        readOwn(record, 'abandonmentCount'),
      ),
      abandonmentRootDigest: readDigest(
        readOwn(record, 'abandonmentRootDigest'),
      ),
      revision: readPositiveInteger(readOwn(record, 'revision')),
    })
  if (
    claimedStageHead.manifestDigest !== selection.manifestDigest ||
    claimedStageHead.completedStageOrdinal !== selection.stageOrdinal - 1 ||
    claimedStageHead.headReceiptDigest !==
      selection.previousStageReceiptDigest ||
    claimedStageHead.activeReservationDigest !==
      createMigrationDigest(stageReservation) ||
    claimedStageHead.activeStageOrdinal !== selection.stageOrdinal ||
    claimedStageHead.activeExpiresAt !== stageReservation.expiresAt
  ) return failChildMaterial()
  return Object.freeze({ stageReservation, claimedStageHead })
}

/** Reads one exact adapter-proven lease observation and enforces chronology. */
function readLeaseAcquisitionObservation(
  value: unknown,
  selection: ChildMaterialSelection,
): WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation {
  const candidate = requireRecord(value)
  const kind = readOwn(candidate, 'kind')
  if (kind === 'reused-active') {
    if (selection.expectedOutcome === 'takeover-completed') {
      return failChildMaterial()
    }
    const record = requireExactRecord(candidate, [
      'currentLeaseExpiresAt',
      'currentLeaseIdentityDigest',
      'evaluatedAt',
      'kind',
    ])
    const currentLeaseIdentityDigest = readDigest(
      readOwn(record, 'currentLeaseIdentityDigest'),
    )
    const evaluatedAt = readTimestamp(readOwn(record, 'evaluatedAt'))
    const currentLeaseExpiresAt = readTimestamp(
      readOwn(record, 'currentLeaseExpiresAt'),
    )
    if (
      Date.parse(currentLeaseExpiresAt) <= Date.parse(evaluatedAt)
    ) return failChildMaterial()
    return Object.freeze({
      kind,
      currentLeaseIdentityDigest,
      evaluatedAt,
      currentLeaseExpiresAt,
    })
  }
  if (kind !== 'acquired') return failChildMaterial()
  const record = requireExactRecord(candidate, [
    'acquiredAt',
    'kind',
    'predecessorLeaseExpiresAt',
    'predecessorLeaseIdentityDigest',
    'successorLeaseExpiresAt',
    'successorLeaseIdentityDigest',
  ])
  const predecessorLeaseIdentityDigest = readNullableDigest(
    readOwn(record, 'predecessorLeaseIdentityDigest'),
  )
  const predecessorLeaseExpiresAt = readNullableTimestamp(
    readOwn(record, 'predecessorLeaseExpiresAt'),
  )
  const acquiredAt = readTimestamp(readOwn(record, 'acquiredAt'))
  const successorLeaseIdentityDigest = readDigest(
    readOwn(record, 'successorLeaseIdentityDigest'),
  )
  const successorLeaseExpiresAt = readTimestamp(
    readOwn(record, 'successorLeaseExpiresAt'),
  )
  if (
    (predecessorLeaseIdentityDigest === null) !==
      (predecessorLeaseExpiresAt === null) ||
    (predecessorLeaseExpiresAt !== null &&
      Date.parse(acquiredAt) < Date.parse(predecessorLeaseExpiresAt)) ||
    Date.parse(successorLeaseExpiresAt) <= Date.parse(acquiredAt) ||
    predecessorLeaseIdentityDigest === successorLeaseIdentityDigest ||
    (selection.expectedOutcome === 'takeover-completed' &&
      predecessorLeaseIdentityDigest === null)
  ) return failChildMaterial()
  return Object.freeze({
    kind,
    predecessorLeaseIdentityDigest,
    predecessorLeaseExpiresAt,
    acquiredAt,
    successorLeaseIdentityDigest,
    successorLeaseExpiresAt,
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

/** Reads exact material claims and matches every parent-selected scalar. */
function readMaterialClaims(
  record: object,
  selectedStage: WorkspaceSearchMigrationRehearsalSelectedStage,
  selection: ChildMaterialSelection,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageChildMaterialClaims {
  if (
    readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_KIND ||
    readOwn(record, 'materialVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_VERSION
  ) return failChildMaterial()
  const mutationResult = readMutationResult(
    readOwn(record, 'mutationResult'),
    selection.command,
    selection.configurationBindingDigest,
    selection.policyVersion,
  )
  const claimedStageContext = readClaimedStageContext(
    readOwn(record, 'stageReservation'),
    readOwn(record, 'claimedStageHead'),
    selectedStage,
    selection,
    verificationKey,
  )
  const leaseAcquisitionObservation = readLeaseAcquisitionObservation(
    readOwn(record, 'leaseAcquisitionObservation'),
    selection,
  )
  const authorityAdoptionObservations =
    snapshotWorkspaceSearchMigrationRehearsalAuthorityAdoptionObservations(
      readOwn(record, 'authorityAdoptionObservations'),
    )
  const claims: WorkspaceSearchMigrationRehearsalStageChildMaterialClaims =
    Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_KIND,
      materialVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_VERSION,
      manifestDigest: readDigest(readOwn(record, 'manifestDigest')),
      manifestEntryDigest:
        readDigest(readOwn(record, 'manifestEntryDigest')),
      previousStageReceiptDigest: readNullableDigest(
        readOwn(record, 'previousStageReceiptDigest'),
      ),
      stageOrdinal: readPositiveInteger(readOwn(record, 'stageOrdinal')),
      scenario: readScenario(readOwn(record, 'scenario')),
      scenarioStageOrdinal: readPositiveInteger(
        readOwn(record, 'scenarioStageOrdinal'),
      ),
      command: readCommand(readOwn(record, 'command')),
      attemptOrdinal:
        readPositiveInteger(readOwn(record, 'attemptOrdinal')),
      expectedOutcome: readOutcome(readOwn(record, 'expectedOutcome')),
      controlArgumentsDigest:
        readDigest(readOwn(record, 'controlArgumentsDigest')),
      ...claimedStageContext,
      leaseIdentityDigest:
        readDigest(readOwn(record, 'leaseIdentityDigest')),
      leaseAcquisitionObservation,
      authorityAdoptionObservations,
      mutationResult,
      mutationResultDigest:
        readDigest(readOwn(record, 'mutationResultDigest')),
      serializedOutputLineDigest:
        readDigest(readOwn(record, 'serializedOutputLineDigest')),
      rateSegment: readRateSegment(readOwn(record, 'rateSegment')),
    })
  if (
    claims.manifestDigest !== selection.manifestDigest ||
    claims.manifestEntryDigest !== selection.manifestEntryDigest ||
    claims.previousStageReceiptDigest !==
      selection.previousStageReceiptDigest ||
    claims.stageOrdinal !== selection.stageOrdinal ||
    claims.scenario !== selection.scenario ||
    claims.scenarioStageOrdinal !== selection.scenarioStageOrdinal ||
    claims.command !== selection.command ||
    claims.attemptOrdinal !== selection.attemptOrdinal ||
    claims.expectedOutcome !== selection.expectedOutcome ||
    claims.controlArgumentsDigest !== selection.controlArgumentsDigest ||
    claims.rateSegment.segmentOrdinal !==
      claims.stageReservation.expectedCurrentRateSegmentOrdinal ||
    claims.leaseIdentityDigest !==
      readObservedLeaseIdentityDigest(leaseAcquisitionObservation) ||
    claims.mutationResultDigest !== createMigrationDigest(mutationResult)
  ) return failChildMaterial()
  return claims
}

/** Reads one exact identifier-free successful coordinator mutation result. */
function readMutationResult(
  value: unknown,
  expectedCommand: WorkspaceSearchMigrationRehearsalStageCommand,
  expectedConfigurationHash: string,
  expectedPolicyVersion: string,
): WorkspaceSearchMigrationRehearsalChildMutationResult {
  const record = requireExactRecord(value, [
    'configurationHash',
    'coordinator',
    'operation',
    'policyVersion',
    'rateAggregate',
    'schemaVersion',
    'status',
  ])
  if (
    readOwn(record, 'schemaVersion') !== 1 ||
    readOwn(record, 'status') !== 'pass'
  ) return failChildMaterial()
  const operation = readCommand(readOwn(record, 'operation'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const policyVersion = readDigest(readOwn(record, 'policyVersion'))
  const coordinator = readCoordinatorResult(
    readOwn(record, 'coordinator'),
    operation,
  )
  const rateAggregate = readRateAggregate(
    readOwn(record, 'rateAggregate'),
    policyVersion,
  )
  if (
    operation !== expectedCommand ||
    configurationHash !== expectedConfigurationHash ||
    policyVersion !== expectedPolicyVersion
  ) return failChildMaterial()
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status: 'pass',
    configurationHash,
    policyVersion,
    coordinator,
    rateAggregate,
  })
}

/** Reads the exact command-specific coordinator evidence projection. */
function readCoordinatorResult(
  value: unknown,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
): WorkspaceSearchMigrationControlCoordinatorSummary {
  if (command === 'close-replan') {
    const record = requireExactRecord(value, ['mode', 'phase', 'planning'])
    if (
      readOwn(record, 'mode') !== command ||
      readOwn(record, 'phase') !== 'planning-admitted'
    ) return failChildMaterial()
    return Object.freeze({
      mode: command,
      phase: 'planning-admitted',
      planning: readPlanningEvidence(readOwn(record, 'planning')),
    })
  }
  if (command === 'release') return readReleaseResult(value)
  const record = requireExactRecord(value, [
    ...(command === 'apply' ? ['application'] : ['terminal']),
    'execution',
    'mode',
  ])
  if (readOwn(record, 'mode') !== command) return failChildMaterial()
  if (command === 'apply') {
    return Object.freeze({
      mode: command,
      execution: readExecutionStatus(readOwn(record, 'execution'), command),
      application: readApplicationEvidence(
        readOwn(record, 'application'),
      ),
    })
  }
  const terminal = readTerminalEvidence(readOwn(record, 'terminal'))
  if (
    (command === 'verify' && terminal.terminalKind !== 'verified') ||
    (command !== 'verify' && terminal.terminalKind !== 'rolled-back')
  ) return failChildMaterial()
  return Object.freeze({
    mode: command,
    execution: readExecutionStatus(readOwn(record, 'execution'), command),
    terminal,
  })
}

/** Reads exact close, drain, and sealed-planning evidence. */
function readPlanningEvidence(
  value: unknown,
): NonNullable<
  Extract<
    WorkspaceSearchMigrationControlCoordinatorSummary,
    { readonly mode: 'close-replan' }
  >['planning']
> {
  const record = requireExactRecord(value, [
    'admittedAt',
    'closedAt',
    'closedWriterFenceRecordDigest',
    'drainCompletedAt',
    'drainStartedAt',
    'executionBoundaryDigest',
    'orphanOperationCount',
    'planCreatedAt',
    'planDigest',
    'planOperationCount',
    'sealedAt',
    'sealedPlanningAuthorityDigest',
    'sourceOperationCount',
  ])
  const planOperationCount = readNonNegativeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const sourceOperationCount = readNonNegativeInteger(
    readOwn(record, 'sourceOperationCount'),
  )
  const orphanOperationCount = readNonNegativeInteger(
    readOwn(record, 'orphanOperationCount'),
  )
  if (sourceOperationCount + orphanOperationCount !== planOperationCount) {
    return failChildMaterial()
  }
  return Object.freeze({
    executionBoundaryDigest:
      readDigest(readOwn(record, 'executionBoundaryDigest')),
    closedWriterFenceRecordDigest:
      readDigest(readOwn(record, 'closedWriterFenceRecordDigest')),
    closedAt: readTimestamp(readOwn(record, 'closedAt')),
    drainStartedAt: readTimestamp(readOwn(record, 'drainStartedAt')),
    drainCompletedAt: readTimestamp(readOwn(record, 'drainCompletedAt')),
    admittedAt: readTimestamp(readOwn(record, 'admittedAt')),
    sealedPlanningAuthorityDigest:
      readDigest(readOwn(record, 'sealedPlanningAuthorityDigest')),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount,
    sourceOperationCount,
    orphanOperationCount,
    planCreatedAt: readTimestamp(readOwn(record, 'planCreatedAt')),
    sealedAt: readTimestamp(readOwn(record, 'sealedAt')),
  })
}

/** Reads an exact command-consistent public execution status. */
function readExecutionStatus(
  value: unknown,
  command: 'apply' | 'rollback-complete' | 'rollback-partial' | 'verify',
): Extract<
  WorkspaceSearchMigrationControlCoordinatorSummary,
  { readonly mode: typeof command }
>['execution'] {
  const record = requireExactRecord(value, ['nextAction', 'phase'])
  if (command === 'apply') {
    const choose = requireExactRecord(readOwn(record, 'nextAction'), [
      'kind',
      'options',
    ])
    const candidateOptions = readOwn(choose, 'options')
    if (
      readOwn(record, 'phase') !== 'applied' ||
      readOwn(choose, 'kind') !== 'choose' ||
      !Array.isArray(candidateOptions) ||
      nodeUtilTypes.isProxy(candidateOptions) ||
      candidateOptions.length !== 2 ||
      candidateOptions[0] !== 'verify' ||
      candidateOptions[1] !== 'complete-rollback'
    ) return failChildMaterial()
    const detachedOptions: readonly ['verify', 'complete-rollback'] =
      Object.freeze(['verify', 'complete-rollback'])
    return Object.freeze({
      phase: 'applied',
      nextAction: Object.freeze({
        kind: 'choose',
        options: detachedOptions,
      }),
    })
  }
  const nextAction = requireExactRecord(
    readOwn(record, 'nextAction'),
    ['kind'],
  )
  const expectedPhase = command === 'verify' ? 'verified' : 'rolled-back'
  if (
    readOwn(record, 'phase') !== expectedPhase ||
    readOwn(nextAction, 'kind') !== 'none'
  ) return failChildMaterial()
  return Object.freeze({
    phase: expectedPhase,
    nextAction: Object.freeze({ kind: 'none' }),
  })
}

/** Reads exact immutable applied-root evidence. */
function readApplicationEvidence(
  value: unknown,
): Extract<
  WorkspaceSearchMigrationControlCoordinatorSummary,
  { readonly mode: 'apply' }
>['application'] {
  const record = requireExactRecord(value, [
    'appliedAt',
    'appliedOperationCount',
    'appliedRootDigest',
    'executionRunDigest',
    'planDigest',
    'sealedPlanOperationCount',
  ])
  const sealedPlanOperationCount = readPositiveInteger(
    readOwn(record, 'sealedPlanOperationCount'),
  )
  const appliedOperationCount = readPositiveInteger(
    readOwn(record, 'appliedOperationCount'),
  )
  if (appliedOperationCount !== sealedPlanOperationCount) {
    return failChildMaterial()
  }
  return Object.freeze({
    executionRunDigest: readDigest(readOwn(record, 'executionRunDigest')),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    sealedPlanOperationCount,
    appliedOperationCount,
    appliedRootDigest: readDigest(readOwn(record, 'appliedRootDigest')),
    appliedAt: readTimestamp(readOwn(record, 'appliedAt')),
  })
}

/** Reads exact terminal immutable-graph evidence. */
function readTerminalEvidence(
  value: unknown,
): NonNullable<
  Extract<
    WorkspaceSearchMigrationControlCoordinatorSummary,
    {
      readonly mode: 'rollback-complete' | 'rollback-partial' | 'verify'
    }
  >['terminal']
> {
  const record = requireExactRecord(value, [
    'appliedOperationCount',
    'applyBoundaryDigest',
    'closedWriterFenceRecordDigest',
    'executionBoundaryDigest',
    'executionRunDigest',
    'planDigest',
    'planOperationCount',
    'sealedPlanningAuthorityDigest',
    'terminalAt',
    'terminalKind',
    'terminalPersistenceVersion',
    'terminalRootDigest',
  ])
  const planOperationCount = readPositiveInteger(
    readOwn(record, 'planOperationCount'),
  )
  const appliedOperationCount = readNonNegativeInteger(
    readOwn(record, 'appliedOperationCount'),
  )
  if (appliedOperationCount > planOperationCount) return failChildMaterial()
  return Object.freeze({
    terminalKind: readTerminalKind(readOwn(record, 'terminalKind')),
    terminalPersistenceVersion:
      readTerminalPersistenceVersion(
        readOwn(record, 'terminalPersistenceVersion'),
      ),
    terminalRootDigest: readDigest(readOwn(record, 'terminalRootDigest')),
    terminalAt: readTimestamp(readOwn(record, 'terminalAt')),
    executionBoundaryDigest:
      readDigest(readOwn(record, 'executionBoundaryDigest')),
    closedWriterFenceRecordDigest:
      readDigest(readOwn(record, 'closedWriterFenceRecordDigest')),
    sealedPlanningAuthorityDigest:
      readDigest(readOwn(record, 'sealedPlanningAuthorityDigest')),
    executionRunDigest: readDigest(readOwn(record, 'executionRunDigest')),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount,
    appliedOperationCount,
    applyBoundaryDigest: readDigest(readOwn(record, 'applyBoundaryDigest')),
  })
}

/** Reads exact terminal writer-fence release evidence. */
function readReleaseResult(
  value: unknown,
): Extract<
  WorkspaceSearchMigrationControlCoordinatorSummary,
  { readonly mode: 'release' }
> {
  const record = requireExactRecord(value, [
    'mode',
    'phase',
    'releasedAt',
    'terminalKind',
    'terminalPersistenceVersion',
    'terminalRootDigest',
    'writerFenceRecordDigest',
  ])
  if (
    readOwn(record, 'mode') !== 'release' ||
    readOwn(record, 'phase') !== 'released'
  ) return failChildMaterial()
  return Object.freeze({
    mode: 'release',
    phase: 'released',
    terminalKind: readTerminalKind(readOwn(record, 'terminalKind')),
    terminalPersistenceVersion:
      readTerminalPersistenceVersion(
        readOwn(record, 'terminalPersistenceVersion'),
      ),
    terminalRootDigest: readDigest(readOwn(record, 'terminalRootDigest')),
    writerFenceRecordDigest:
      readDigest(readOwn(record, 'writerFenceRecordDigest')),
    releasedAt: readTimestamp(readOwn(record, 'releasedAt')),
  })
}

/** Reads the exact finite DescribeTable rate aggregate. */
function readRateAggregate(
  value: unknown,
  expectedPolicyVersion: string,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const record = requireExactRecord(value, [
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
  if (
    readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  ) return failChildMaterial()
  const policyVersion = readDigest(readOwn(record, 'policyVersion'))
  if (policyVersion !== expectedPolicyVersion) return failChildMaterial()
  const maximumInFlight = readOwn(record, 'maximumInFlight')
  if (maximumInFlight !== 0 && maximumInFlight !== 1) {
    return failChildMaterial()
  }
  const aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence =
    Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion,
      attemptCount: readNonNegativeInteger(
        readOwn(record, 'attemptCount'),
      ),
      forfeitedAttemptCount:
        readNonNegativeInteger(readOwn(record, 'forfeitedAttemptCount')),
      throttleCount:
        readNonNegativeInteger(readOwn(record, 'throttleCount')),
      awsServiceThrottleCount:
        readNonNegativeInteger(readOwn(record, 'awsServiceThrottleCount')),
      rehearsalInjectedThrottleCount: readNonNegativeInteger(
        readOwn(record, 'rehearsalInjectedThrottleCount'),
      ),
      budgetStopCount:
        readNonNegativeInteger(readOwn(record, 'budgetStopCount')),
      operationalBudgetStopCount: readNonNegativeInteger(
        readOwn(record, 'operationalBudgetStopCount'),
      ),
      awsServiceThrottleBudgetStopCount: readNonNegativeInteger(
        readOwn(record, 'awsServiceThrottleBudgetStopCount'),
      ),
      rehearsalInjectedBudgetStopCount: readNonNegativeInteger(
        readOwn(record, 'rehearsalInjectedBudgetStopCount'),
      ),
      cadenceWaitCount:
        readNonNegativeInteger(readOwn(record, 'cadenceWaitCount')),
      cadenceWaitMilliseconds:
        readNonNegativeInteger(readOwn(record, 'cadenceWaitMilliseconds')),
      maximumInFlight,
    })
  if (
    aggregate.throttleCount !==
      aggregate.awsServiceThrottleCount +
        aggregate.rehearsalInjectedThrottleCount ||
    aggregate.budgetStopCount !==
      aggregate.operationalBudgetStopCount +
        aggregate.awsServiceThrottleBudgetStopCount +
        aggregate.rehearsalInjectedBudgetStopCount
  ) return failChildMaterial()
  return aggregate
}

/** Reauthenticates exact segment bytes and matches their claimed summary. */
function readAuthenticatedRateSegment(
  value: unknown,
  selection: ChildMaterialSelection,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalStageReservation[
      'expectedPreviousRateSegment'
    ],
  authenticationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalChildRateSegment {
  const claimed = readRateSegment(value, true)
  const record = requireRecord(value)
  const canonicalBytes = readOwn(record, 'canonicalBytes')
  if (
    !(canonicalBytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(canonicalBytes)
  ) return failChildMaterial()
  let verified: unknown
  try {
    verified = verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor({
      canonicalBytes,
      authenticationKey,
      expectedPreviousSegment: expectedPreviousRateSegment,
      expectedPolicyVersion: selection.policyVersion,
      expectedConfigurationBindingDigest:
        selection.configurationBindingDigest,
    })
  } catch {
    return failChildMaterial()
  }
  const authenticated = readRateSegment(verified)
  if (
    serializeCanonicalJson(authenticated) !== serializeCanonicalJson(claimed)
  ) return failChildMaterial()
  return authenticated
}

/** Reads one exact rate-segment projection and validates sequence arithmetic. */
function readRateSegment(
  value: unknown,
  allowCanonicalBytes = false,
): WorkspaceSearchMigrationRehearsalChildRateSegment {
  const record = requireExactRecord(value, [
    ...(allowCanonicalBytes ? ['canonicalBytes'] : []),
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
  const eventCount = readNonNegativeInteger(readOwn(record, 'eventCount'))
  const firstEventSequence = readPositiveInteger(
    readOwn(record, 'firstEventSequence'),
  )
  const first = readNullablePositiveInteger(
    readOwn(record, 'firstCommittedEventSequence'),
  )
  const last = readNullablePositiveInteger(
    readOwn(record, 'lastCommittedEventSequence'),
  )
  if (
    (eventCount === 0 && (first !== null || last !== null)) ||
    (
      eventCount > 0 &&
      (first === null ||
        last === null ||
        first !== firstEventSequence ||
        last - first + 1 !== eventCount)
    )
  ) return failChildMaterial()
  const segmentDigest = readDigest(readOwn(record, 'segmentDigest'))
  return Object.freeze({
    authenticationKeyFingerprint: readDigest(
      readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest:
      readDigest(readOwn(record, 'segmentLocatorDigest')),
    segmentOrdinal: readNonNegativeInteger(readOwn(record, 'segmentOrdinal')),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence: first,
    lastCommittedEventSequence: last,
    terminalRecordMac: readDigest(readOwn(record, 'terminalRecordMac')),
    segmentDigest,
  })
}

/** Creates the domain-separated HMAC for exact child-material claims. */
function createChildMaterialMac(
  claims: WorkspaceSearchMigrationRehearsalStageChildMaterialClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(childMaterialMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Copies and validates one exact non-Proxy 32-byte authentication key. */
function copyChildMaterialKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    value.byteLength !== childMaterialKeyBytes
  ) return failChildMaterial()
  return new Uint8Array(value)
}

/** Compares two lowercase digests without timing-sensitive string equality. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex'),
  )
}

/** Requires one ordinary non-Proxy object. */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return failChildMaterial()
  return value
}

/** Requires exact enumerable own data keys, optionally ignoring raw bytes. */
function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): object {
  const record = requireRecord(value)
  const keys = Reflect.ownKeys(record)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) =>
      typeof key !== 'string' || !expectedKeys.includes(key)
    )
  ) return failChildMaterial()
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failChildMaterial()
  }
  return record
}

/** Reads one own enumerable data property without invoking accessors. */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) return failChildMaterial()
  return descriptor.value
}

/** Reads one exact lowercase SHA-256 digest. */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failChildMaterial()
  return value
}

/** Reads a lowercase digest or exact null. */
function readNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return readDigest(value)
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) return failChildMaterial()
  return value
}

/** Reads one non-negative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failChildMaterial()
  return value
}

/** Reads one nullable positive safe integer. */
function readNullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null
  return readPositiveInteger(value)
}

/** Reads one exact canonical UTC timestamp. */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failChildMaterial()
  return value
}

/** Reads one exact canonical UTC timestamp or exact null. */
function readNullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  return readTimestamp(value)
}

/** Reads one exact terminal graph classification. */
function readTerminalKind(value: unknown): 'rolled-back' | 'verified' {
  if (value !== 'rolled-back' && value !== 'verified') {
    return failChildMaterial()
  }
  return value
}

/** Reads one exact terminal persistence schema version. */
function readTerminalPersistenceVersion(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) return failChildMaterial()
  return value
}

/** Measures the exact UTF-8 byte length of a bounded canonical document. */
function readUtf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength
  } catch {
    return failChildMaterial()
  }
}

/** Reads one exact manifest-admitted control command. */
function readCommand(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommand {
  if (
    value !== 'apply' &&
    value !== 'close-replan' &&
    value !== 'release' &&
    value !== 'rollback-complete' &&
    value !== 'rollback-partial' &&
    value !== 'verify'
  ) return failChildMaterial()
  return value
}

/** Reads one canonical rehearsal scenario. */
function readScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failChildMaterial()
}

/** Reads one exact manifest-admitted process outcome. */
function readOutcome(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageOutcome {
  if (
    value !== 'completed' &&
    value !== 'fault-reached' &&
    value !== 'response-loss-reconciled' &&
    value !== 'takeover-completed'
  ) return failChildMaterial()
  return value
}

/** Raises the stable raw-free child-material failure. */
function failChildMaterial(): never {
  throw new WorkspaceSearchMigrationRehearsalStageChildMaterialError()
}
