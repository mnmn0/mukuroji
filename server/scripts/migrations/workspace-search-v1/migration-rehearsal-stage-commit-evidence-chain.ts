import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead,
} from './migration-rehearsal-stage-commit-evidence'
import {
  readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding,
  readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_RECOVERY_MAX_ENTRIES,
  type WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding,
} from './migration-rehearsal-stage-reservation-aws'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for a verified full commit-evidence chain projection. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-commit-evidence-chain'

/** First in-memory full commit-evidence chain projection version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_VERSION =
  1

/** Stable discriminator for one branded verified durable commit chain. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-commit-chain-authorization'

/** First process-local durable commit-chain capability contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_VERSION =
  1

/** One fully authenticated stage-to-commit binding in global ordinal order. */
export type WorkspaceSearchMigrationRehearsalStageCommitBinding = {
  /** Fixed isolated deployment class shared by manifest, receipt, and evidence. */
  readonly stage: 'non-production'
  /** Digest of the exact authenticated reviewed full-suite manifest. */
  readonly manifestDigest: string
  /** Digest binding the migration-state location owning this commit. */
  readonly stateTableLocationBindingDigest: string
  /** Digest of the permit-authorized parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Digest of the exact parent-authentication artifact admitted to commit. */
  readonly parentAuthenticationDigest: string
  /** Digest of the complete verified parent-authorization binding. */
  readonly parentAuthorizationBindingDigest: string
  /** Canonical scenario owning this globally ordered stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalStageReceipt['scenario']
  /** Globally contiguous one-based stage ordinal. */
  readonly stageOrdinal: number
  /** Contiguous one-based stage ordinal within the owning scenario run. */
  readonly scenarioStageOrdinal: number
  /** Restricted digest of the authenticated scenario run identifier. */
  readonly runLocatorDigest: string
  /** Digest of the exact authenticated durable stage reservation. */
  readonly stageReservationDigest: string
  /** Durable revision at which the exact reservation became active. */
  readonly stageReservationClaimRevision: number
  /** Durable revision at which the exact receipt replaced that reservation. */
  readonly stageReservationCommitRevision: number
  /** Cumulative explicit abandonment count at the successful claim. */
  readonly stageReservationAbandonmentCount: number
  /** Cumulative abandonment-chain root at the successful claim. */
  readonly stageReservationAbandonmentRootDigest: string
  /** Digest of the exact authenticated stage receipt. */
  readonly receiptDigest: string
  /** Digest of the exact canonical authenticated commit evidence. */
  readonly commitEvidenceDigest: string
  /** Trusted admission time authenticated by the durable commit evidence. */
  readonly commitAdmittedAt: string
  /** Immutable durable fact independent of the transaction response path. */
  readonly durableStatus: 'committed'
  /** Exact inactive durable successor authenticated by the commit evidence. */
  readonly inactiveHead:
    WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead
}

/** Publication-facing projection of all verified commits and terminal head. */
export type WorkspaceSearchMigrationRehearsalStageCommitEvidenceChain = {
  /** Fixed full-chain projection discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_KIND
  /** Full-chain projection schema version. */
  readonly chainVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_VERSION
  /** Fixed isolated deployment class shared by every authenticated artifact. */
  readonly stage: 'non-production'
  /** Digest of the exact authenticated reviewed full-suite manifest. */
  readonly manifestDigest: string
  /** Single migration-state location shared by all 36 durable commits. */
  readonly stateTableLocationBindingDigest: string
  /** Authenticated inclusive permit-validity floor. */
  readonly permitIssuedAt: string
  /** Authenticated exclusive permit-validity ceiling. */
  readonly permitExpiresAt: string
  /** Digest of all 36 authenticated commit evidence records in ordinal order. */
  readonly commitEvidenceChainDigest: string
  /** Exact number of globally contiguous authenticated stage commits. */
  readonly stageCommitCount: number
  /** Every exact authenticated stage-to-commit binding in global order. */
  readonly stageCommits:
    readonly WorkspaceSearchMigrationRehearsalStageCommitBinding[]
  /** Exact stage-36 binding whose successor is the terminal inactive head. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalStageCommitBinding
}

/** Opaque process-local proof of one fully verified durable commit chain. */
export type WorkspaceSearchMigrationRehearsalStageCommitChainAuthorization = {
  /** Fixed durable commit-chain authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_KIND
  /** Durable commit-chain authorization schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_VERSION
  /** Digest of the privately retained complete chain projection. */
  readonly bindingDigest: string
}

/** Untrusted artifacts required to verify one complete commit-evidence chain. */
export type VerifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChainInput = {
  /** Untrusted authenticated non-production permit owning the suite. */
  readonly permit: unknown
  /** Untrusted serialized or in-memory reviewed full-suite manifest. */
  readonly manifest: unknown
  /** Untrusted authenticated receipts in exact global ordinal order. */
  readonly receipts: readonly unknown[]
  /** Strong-read durability capabilities in exact global ordinal order. */
  readonly durabilityAuthorizations: readonly unknown[]
  /** Strong-read proof of the exact immutable abandonment-row set. */
  readonly abandonmentDurabilityAuthorization: unknown
  /** Exact 32-byte runtime key for permit, manifest, and receipt verification. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only key for durable commit-evidence verification. */
  readonly publicationVerificationKey: Uint8Array
}

/** Stable raw-value-free full commit-evidence chain validation failure. */
export class WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError
  extends Error {
  /** Stable machine-readable full-chain validation error code. */
  readonly code = 'INVALID_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN'

  /** Creates the sole stable public full-chain validation failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN')
    this.name =
      'WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError'
  }
}

/** Exact shared authentication-key length accepted by every chain artifact. */
const stageCommitEvidenceChainKeyBytes = 32

/** Strict permit guards mapped to the full-chain failure boundary. */
const commitChainPermitGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageCommitEvidenceChain,
)

/** Private brand storage for complete strong-read commit-chain projections. */
const stageCommitChainAuthorizationBindings = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceChain
>()

/**
 * Verifies every full-suite receipt and commit evidence before projecting it.
 *
 * The verifier authenticates the manifest, all 36 receipts, and all 36 exact
 * canonical commit-evidence documents with separated detached keys. It then
 * requires exact suite, run, stage, receipt, reservation, revision, inactive
 * head, and time-window bindings before returning the stage-36 terminal head.
 *
 * @param input - Untrusted full-suite artifacts and separated verification keys.
 * @returns Frozen full-chain bindings and the exact terminal inactive head.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChain(
  input: VerifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChainInput,
): WorkspaceSearchMigrationRehearsalStageCommitChainAuthorization {
  let permitValue: unknown
  let manifestValue: unknown
  let receiptValues: unknown
  let durabilityAuthorizationValues: unknown
  let abandonmentDurabilityAuthorizationValue: unknown
  let runtimeVerificationKeyValue: unknown
  let publicationVerificationKeyValue: unknown
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    permitValue = input.permit
    manifestValue = input.manifest
    receiptValues = input.receipts
    durabilityAuthorizationValues = input.durabilityAuthorizations
    abandonmentDurabilityAuthorizationValue =
      input.abandonmentDurabilityAuthorization
    runtimeVerificationKeyValue = input.runtimeVerificationKey
    publicationVerificationKeyValue = input.publicationVerificationKey
    const receipts = copyStageCommitEvidenceChainArray(
      receiptValues,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
    )
    const durabilityAuthorizations = copyStageCommitEvidenceChainArray(
      durabilityAuthorizationValues,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
    )
    runtimeKey = copyStageCommitEvidenceChainKey(
      runtimeVerificationKeyValue,
    )
    publicationKey = copyStageCommitEvidenceChainKey(
      publicationVerificationKeyValue,
    )
    return verifyStageCommitEvidenceChainArtifacts(
      permitValue,
      manifestValue,
      receipts,
      durabilityAuthorizations,
      abandonmentDurabilityAuthorizationValue,
      runtimeKey,
      publicationKey,
    )
  } catch {
    return failStageCommitEvidenceChain()
  } finally {
    zeroizeStageCommitEvidenceChainBytes(runtimeKey)
    zeroizeStageCommitEvidenceChainBytes(publicationKey)
  }
}

/**
 * Reads the complete projection behind a genuine commit-chain capability.
 *
 * @param value - Candidate returned by the full durable chain verifier.
 * @returns Frozen complete strong-read commit-chain projection.
 */
export function readWorkspaceSearchMigrationRehearsalStageCommitChainAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceChain {
  const record = commitChainPermitGuards.requireRecord(value)
  const binding = stageCommitChainAuthorizationBindings.get(record)
  if (binding === undefined) return failStageCommitEvidenceChain()
  return binding
}

/**
 * Authenticates detached artifacts and derives the immutable chain projection.
 *
 * @param permitValue - Untrusted authenticated permit candidate.
 * @param manifestValue - Untrusted reviewed manifest candidate.
 * @param receiptValues - Safely detached exact-length receipt values.
 * @param durabilityAuthorizationValues - Exact-length strong-read capabilities.
 * @param abandonmentDurabilityAuthorizationValue - Exact row-set capability.
 * @param runtimeVerificationKey - Owned runtime authentication key.
 * @param publicationVerificationKey - Owned publication authentication key.
 * @returns Frozen fully verified commit-evidence chain projection.
 */
function verifyStageCommitEvidenceChainArtifacts(
  permitValue: unknown,
  manifestValue: unknown,
  receiptValues: readonly unknown[],
  durabilityAuthorizationValues: readonly unknown[],
  abandonmentDurabilityAuthorizationValue: unknown,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitChainAuthorization {
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    manifestValue,
    runtimeVerificationKey,
  )
  const permitClaims = authenticateStageCommitEvidenceChainPermit(
    permitValue,
    manifest,
    runtimeVerificationKey,
    publicationVerificationKey,
  )
  if (
    manifest.entries.length !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  ) return failStageCommitEvidenceChain()
  const manifestDigest = createMigrationDigest(manifest)
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  const receiptDigests: string[] = []
  let previousReceiptDigest: string | null = null
  let previousProcessExitedAt: string | undefined
  let previousCommitRevision = 0
  let previousAbandonmentCount = 0
  let previousAbandonmentRootDigest =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
  const reservationDigests = new Set<string>()
  const scenarioRunLocators = new Map<string, string>()
  const runLocatorScenarios = new Map<string, string>()
  for (let index = 0; index < receiptValues.length; index += 1) {
    const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
      receiptValues[index],
      runtimeVerificationKey,
    )
    const entry = manifest.entries[index]
    if (entry === undefined) return failStageCommitEvidenceChain()
    requireStageCommitReceiptBinding(
      receipt,
      entry,
      manifest,
      manifestDigest,
      previousReceiptDigest,
    )
    requireStageCommitReceiptContinuity(
      receipt,
      previousProcessExitedAt,
      previousCommitRevision,
      previousAbandonmentCount,
      previousAbandonmentRootDigest,
      reservationDigests,
      scenarioRunLocators,
      runLocatorScenarios,
    )
    const receiptDigest = createMigrationDigest(receipt)
    receipts.push(receipt)
    receiptDigests.push(receiptDigest)
    previousReceiptDigest = receiptDigest
    previousProcessExitedAt = receipt.processLifecycle.processExitedAt
    previousCommitRevision = receipt.stageReservationCommitRevision
    previousAbandonmentCount =
      receipt.stageReservationAbandonmentCount
    previousAbandonmentRootDigest =
      receipt.stageReservationAbandonmentRootDigest
  }
  const authenticatedEvidence:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence[] = []
  const rollbackPreimageGates = new Map<
    string,
    Extract<
      WorkspaceSearchMigrationRehearsalStageCommitEvidence['commitGate'],
      { readonly kind: 'target-preimage' }
    >
  >()
  const stageCommits:
    WorkspaceSearchMigrationRehearsalStageCommitBinding[] = []
  let stateTableLocationBindingDigest: string | undefined
  let terminalRootSnapshotDigest: string | undefined
  for (
    let index = 0;
    index < durabilityAuthorizationValues.length;
    index += 1
  ) {
    const receipt = receipts[index]
    const receiptDigest = receiptDigests[index]
    const nextReceipt = receipts[index + 1]
    if (receipt === undefined || receiptDigest === undefined) {
      return failStageCommitEvidenceChain()
    }
    const durabilityBinding =
      readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding(
        durabilityAuthorizationValues[index],
      )
    requireStageCommitDurabilityBinding(
      durabilityBinding,
      receipt,
      receiptDigest,
      index + 1,
    )
    if (
      terminalRootSnapshotDigest !== undefined &&
      durabilityBinding.terminalRootSnapshotDigest !==
        terminalRootSnapshotDigest
    ) return failStageCommitEvidenceChain()
    terminalRootSnapshotDigest =
      durabilityBinding.terminalRootSnapshotDigest
    const evidence =
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
        durabilityBinding.commitEvidence,
        publicationVerificationKey,
      )
    requireStageCommitEvidenceBinding(
      evidence,
      receipt,
      receiptDigest,
      manifestDigest,
      nextReceipt,
      permitClaims,
    )
    requireStageCommitGateBinding(
      evidence,
      receipt,
      nextReceipt,
      rollbackPreimageGates,
    )
    if (
      stateTableLocationBindingDigest !== undefined &&
      evidence.stateTableLocationBindingDigest !==
        stateTableLocationBindingDigest
    ) return failStageCommitEvidenceChain()
    stateTableLocationBindingDigest =
      evidence.stateTableLocationBindingDigest
    authenticatedEvidence.push(evidence)
    stageCommits.push(createStageCommitBinding(
      evidence,
      receipt,
      receiptDigest,
      manifestDigest,
    ))
  }
  if (rollbackPreimageGates.size !== 0) {
    return failStageCommitEvidenceChain()
  }
  const abandonmentDurabilityBinding =
    readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding(
      abandonmentDurabilityAuthorizationValue,
    )
  requireStageAbandonmentDurabilityBinding(
    abandonmentDurabilityBinding,
    receipts,
    manifestDigest,
    manifest.permitDigest,
    manifest.requestedResourcesBinding,
    stateTableLocationBindingDigest,
    terminalRootSnapshotDigest,
  )
  const terminal = stageCommits.at(-1)
  if (
    terminal === undefined ||
    terminal.stageOrdinal !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  ) return failStageCommitEvidenceChain()
  const binding: WorkspaceSearchMigrationRehearsalStageCommitEvidenceChain =
    Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_KIND,
    chainVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_VERSION,
    stage: 'non-production',
    manifestDigest,
    stateTableLocationBindingDigest:
      terminal.stateTableLocationBindingDigest,
    permitIssuedAt: permitClaims.issuedAt,
    permitExpiresAt: permitClaims.expiresAt,
    commitEvidenceChainDigest: createMigrationDigest(authenticatedEvidence),
    stageCommitCount: stageCommits.length,
    stageCommits: Object.freeze(stageCommits),
    terminal,
    })
  const authorization:
    WorkspaceSearchMigrationRehearsalStageCommitChainAuthorization =
      Object.freeze({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_KIND,
        authorizationVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CHAIN_AUTHORIZATION_VERSION,
        bindingDigest: createMigrationDigest(binding),
      })
  stageCommitChainAuthorizationBindings.set(authorization, binding)
  return authorization
}

/**
 * Authenticates the permit and binds its exact validity window to the chain.
 *
 * @param value - Untrusted complete permit candidate.
 * @param manifest - Authenticated reviewed suite manifest.
 * @param verificationKey - Owned runtime verification key.
 * @param publicationVerificationKey - Owned publication verification key.
 * @returns Frozen authenticated permit claims including its validity window.
 */
function authenticateStageCommitEvidenceChainPermit(
  value: unknown,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  verificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): Readonly<WorkspaceSearchMigrationRehearsalPermitClaims> {
  const record = commitChainPermitGuards.requireRecord(value)
  const account = commitChainPermitGuards.readText(
    commitChainPermitGuards.readOwn(record, 'account'),
  )
  const region = commitChainPermitGuards.readText(
    commitChainPermitGuards.readOwn(record, 'region'),
  )
  const issuedAt = commitChainPermitGuards.readTimestamp(
    commitChainPermitGuards.readOwn(record, 'issuedAt'),
  )
  const permitMac = commitChainPermitGuards.readDigest(
    commitChainPermitGuards.readOwn(record, 'permitMac'),
  )
  const claims = verifyWorkspaceSearchMigrationRehearsalPermit({
    permit: value,
    verificationKey,
    account,
    region,
    commit: manifest.commit,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    currentTime: new Date(issuedAt),
  })
  const detachedPermit = Object.freeze({ ...claims, permitMac })
  const verificationKeyDigest = createHash('sha256')
    .update(verificationKey)
    .digest('hex')
  const publicationVerificationKeyDigest = createHash('sha256')
    .update(publicationVerificationKey)
    .digest('hex')
  if (
    createMigrationDigest(detachedPermit) !== manifest.permitDigest ||
    claims.evidenceKeyDigest !== manifest.evidenceKeyDigest ||
    claims.evidenceKeyDigest !== verificationKeyDigest ||
    claims.publicationKeyDigest !== manifest.publicationKeyDigest ||
    claims.publicationKeyDigest !== publicationVerificationKeyDigest ||
    claims.integrityResourceIdentityScheme !==
      manifest.integrityResourceIdentityScheme ||
    serializeCanonicalJson(claims.integrityResourceIdentities) !==
      serializeCanonicalJson(manifest.integrityResourceIdentities) ||
    claims.integrityResourceIdentityDigest !==
      manifest.integrityResourceIdentityDigest ||
    claims.deploymentTrustRootDigest !==
      manifest.deploymentTrustRootDigest
  ) return failStageCommitEvidenceChain()
  return claims
}

/**
 * Requires one authenticated receipt to match its exact reviewed stage.
 *
 * @param receipt - Authenticated detached stage receipt.
 * @param entry - Authenticated detached manifest entry at the same ordinal.
 * @param manifest - Authenticated reviewed full-suite manifest.
 * @param manifestDigest - Digest of the exact authenticated manifest.
 * @param previousReceiptDigest - Exact preceding receipt digest or null.
 * @returns Nothing after all exact suite and stage bindings match.
 */
function requireStageCommitReceiptBinding(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestDigest: string,
  previousReceiptDigest: string | null,
): void {
  if (
    receipt.stage !== manifest.stage ||
    receipt.stageOrdinal !== entry.ordinal ||
    receipt.scenario !== entry.scenario ||
    receipt.scenarioStageOrdinal !== entry.scenarioStageOrdinal ||
    receipt.command !== entry.command ||
    receipt.controlArgumentsDigest !== entry.controlArgumentsDigest ||
    receipt.attemptOrdinal !== entry.attemptOrdinal ||
    receipt.outcome !== entry.expectedOutcome ||
    receipt.manifestDigest !== manifestDigest ||
    receipt.manifestEntryDigest !== createMigrationDigest(entry) ||
    receipt.permitDigest !== manifest.permitDigest ||
    receipt.commit !== manifest.commit ||
    receipt.requestedResourcesBinding !==
      manifest.requestedResourcesBinding ||
    receipt.configurationBindingDigest !==
      manifest.configurationBindingDigest ||
    receipt.policyVersion !== manifest.policyVersion ||
    receipt.previousStageReceiptDigest !== previousReceiptDigest ||
    (entry.faultPlanDigest !== null) !==
      (receipt.faultBoundary !== null)
  ) return failStageCommitEvidenceChain()
}

/**
 * Requires globally contiguous revisions, chronology, reservations, and runs.
 *
 * @param receipt - Current authenticated stage receipt.
 * @param previousProcessExitedAt - Prior parent-observed process exit.
 * @param previousCommitRevision - Prior inactive-head durable revision.
 * @param previousAbandonmentCount - Prior cumulative abandonment count.
 * @param previousAbandonmentRootDigest - Prior cumulative abandonment root.
 * @param reservationDigests - Previously consumed reservation digests.
 * @param scenarioRunLocators - Canonical run locator assigned per scenario.
 * @param runLocatorScenarios - Canonical scenario assigned per run locator.
 * @returns Nothing after the current receipt extends the exact global chain.
 */
function requireStageCommitReceiptContinuity(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  previousProcessExitedAt: string | undefined,
  previousCommitRevision: number,
  previousAbandonmentCount: number,
  previousAbandonmentRootDigest: string,
  reservationDigests: Set<string>,
  scenarioRunLocators: Map<string, string>,
  runLocatorScenarios: Map<string, string>,
): void {
  const abandonmentDelta =
    receipt.stageReservationAbandonmentCount - previousAbandonmentCount
  if (
    abandonmentDelta < 0 ||
    (abandonmentDelta === 0 &&
      receipt.stageReservationAbandonmentRootDigest !==
        previousAbandonmentRootDigest) ||
    (abandonmentDelta > 0 &&
      receipt.stageReservationAbandonmentRootDigest ===
        previousAbandonmentRootDigest) ||
    (receipt.stageReservationAbandonmentCount === 0 &&
      receipt.stageReservationAbandonmentRootDigest !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST) ||
    (receipt.stageReservationAbandonmentCount > 0 &&
      receipt.stageReservationAbandonmentRootDigest ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST)
  ) return failStageCommitEvidenceChain()
  const expectedClaimRevision =
    previousCommitRevision + abandonmentDelta * 2 + 1
  if (
    receipt.stageReservationClaimRevision !== expectedClaimRevision ||
    receipt.stageReservationCommitRevision !== expectedClaimRevision + 1 ||
    reservationDigests.has(receipt.stageReservationDigest) ||
    (previousProcessExitedAt !== undefined &&
      Date.parse(receipt.startedAt) <= Date.parse(previousProcessExitedAt))
  ) return failStageCommitEvidenceChain()
  const existingRunLocator = scenarioRunLocators.get(receipt.scenario)
  const existingScenario = runLocatorScenarios.get(receipt.runLocatorDigest)
  if (
    (existingRunLocator !== undefined &&
      existingRunLocator !== receipt.runLocatorDigest) ||
    (existingScenario !== undefined &&
      existingScenario !== receipt.scenario)
  ) return failStageCommitEvidenceChain()
  reservationDigests.add(receipt.stageReservationDigest)
  scenarioRunLocators.set(receipt.scenario, receipt.runLocatorDigest)
  runLocatorScenarios.set(receipt.runLocatorDigest, receipt.scenario)
}

/**
 * Requires one process-local capability to prove the exact immutable row.
 *
 * @param binding - Secret-free binding read from the genuine capability.
 * @param receipt - Runtime-authenticated receipt addressed by the row.
 * @param receiptDigest - Digest of the exact authenticated receipt.
 * @param stageOrdinal - Expected global ordinal at this array position.
 */
function requireStageCommitDurabilityBinding(
  binding:
    WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  receiptDigest: string,
  stageOrdinal: number,
): void {
  const evidence = binding.commitEvidence
  if (
    binding.provenance !== 'dynamodb-consistent-read' ||
    binding.stageOrdinal !== stageOrdinal ||
    receipt.stageOrdinal !== stageOrdinal ||
    binding.receiptDigest !== receiptDigest ||
    binding.commitEvidenceDigest !== createMigrationDigest(evidence) ||
    binding.stateTableLocationBindingDigest !==
      evidence.stateTableLocationBindingDigest ||
    createMigrationDigest(binding.commitHead) !==
      createMigrationDigest(evidence.head) ||
    binding.currentHead.completedStageOrdinal < stageOrdinal ||
    binding.currentHead.revision < evidence.commitRevision ||
    (binding.currentHead.completedStageOrdinal === stageOrdinal &&
      createMigrationDigest(binding.currentHead) !==
        createMigrationDigest(evidence.head))
  ) return failStageCommitEvidenceChain()
}

/**
 * Requires a genuine same-root capability for every abandonment row.
 *
 * @param binding - Exact row-set binding read from the genuine capability.
 * @param receipts - Runtime-authenticated complete receipt chain.
 * @param manifestDigest - Digest of the authenticated reviewed manifest.
 * @param permitDigest - Digest of the authenticated suite permit.
 * @param requestedResourcesBinding - Authenticated physical resource binding.
 * @param stateTableLocationBindingDigest - Location proven by commit rows.
 * @param terminalRootSnapshotDigest - Terminal snapshot proven by commit rows.
 */
function requireStageAbandonmentDurabilityBinding(
  binding:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  manifestDigest: string,
  permitDigest: string,
  requestedResourcesBinding: string,
  stateTableLocationBindingDigest: string | undefined,
  terminalRootSnapshotDigest: string | undefined,
): void {
  const terminalReceipt = receipts.at(-1)
  if (
    terminalReceipt === undefined ||
    stateTableLocationBindingDigest === undefined ||
    terminalRootSnapshotDigest === undefined ||
    binding.provenance !== 'dynamodb-consistent-read' ||
    binding.stateTableLocationBindingDigest !==
      stateTableLocationBindingDigest ||
    binding.terminalRootSnapshotDigest !== terminalRootSnapshotDigest ||
    binding.abandonmentCount !== binding.rows.length ||
    binding.abandonmentCount >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDONMENT_RECOVERY_MAX_ENTRIES ||
    binding.abandonmentCount !==
      terminalReceipt.stageReservationAbandonmentCount ||
    binding.abandonmentRootDigest !==
      terminalReceipt.stageReservationAbandonmentRootDigest
  ) return failStageCommitEvidenceChain()
  let cursor = 0
  let revision = 0
  let count = 0
  let root =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
  for (const receipt of receipts) {
    while (cursor < receipt.stageReservationAbandonmentCount) {
      const row = binding.rows[cursor]
      if (row === undefined) return failStageCommitEvidenceChain()
      const abandonment = row.abandonment
      if (
        row.abandonmentCount !== count + 1 ||
        row.abandonmentCount !== abandonment.abandonmentCount ||
        row.stageOrdinal !== receipt.stageOrdinal ||
        row.stageOrdinal !== abandonment.stageOrdinal ||
        row.reservationDigest !== abandonment.reservationDigest ||
        row.reservationDigest === receipt.stageReservationDigest ||
        row.abandonmentDigest !== createMigrationDigest(abandonment) ||
        abandonment.manifestDigest !== manifestDigest ||
        abandonment.permitDigest !== permitDigest ||
        abandonment.requestedResourcesBinding !==
          requestedResourcesBinding ||
        abandonment.previousAbandonmentCount !== count ||
        abandonment.previousAbandonmentRootDigest !== root ||
        abandonment.reservationClaimRevision !== revision + 1 ||
        abandonment.abandonmentRevision !==
          abandonment.reservationClaimRevision + 1
      ) return failStageCommitEvidenceChain()
      count = abandonment.abandonmentCount
      root = abandonment.abandonmentRootDigest
      revision = abandonment.abandonmentRevision
      cursor += 1
    }
    if (
      receipt.stageReservationAbandonmentCount !== count ||
      receipt.stageReservationAbandonmentRootDigest !== root ||
      receipt.stageReservationClaimRevision !== revision + 1 ||
      receipt.stageReservationCommitRevision !==
        receipt.stageReservationClaimRevision + 1
    ) return failStageCommitEvidenceChain()
    revision = receipt.stageReservationCommitRevision
  }
  if (
    cursor !== binding.rows.length ||
    count !== binding.abandonmentCount ||
    root !== binding.abandonmentRootDigest ||
    (count === 0 &&
      root !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST)
  ) return failStageCommitEvidenceChain()
}

/**
 * Requires one authenticated commit evidence to match its receipt and window.
 *
 * @param evidence - Parsed and HMAC-authenticated commit evidence.
 * @param receipt - Authenticated exact receipt committed by the evidence.
 * @param receiptDigest - Digest of the exact authenticated receipt.
 * @param manifestDigest - Digest of the exact authenticated manifest.
 * @param nextReceipt - Next authenticated receipt or undefined at stage 36.
 * @param permitClaims - Authenticated permit validity and suite bindings.
 * @returns Nothing after every exact commit and chronology binding matches.
 */
function requireStageCommitEvidenceBinding(
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  receiptDigest: string,
  manifestDigest: string,
  nextReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  permitClaims: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
): void {
  const commitAdmittedMilliseconds = Date.parse(evidence.commitAdmittedAt)
  const authenticatedReceiptFloorMilliseconds = Math.max(
    Date.parse(receipt.completedAt),
    Date.parse(receipt.processLifecycle.processExitedAt),
  )
  if (
    evidence.stage !== receipt.stage ||
    evidence.manifestDigest !== manifestDigest ||
    evidence.permitDigest !== receipt.permitDigest ||
    evidence.requestedResourcesBinding !==
      receipt.requestedResourcesBinding ||
    evidence.publicationKeyDigest !== permitClaims.publicationKeyDigest ||
    evidence.stageOrdinal !== receipt.stageOrdinal ||
    evidence.stageReservationDigest !==
      receipt.stageReservationDigest ||
    evidence.stageReservationClaimRevision !==
      receipt.stageReservationClaimRevision ||
    evidence.receiptDigest !== receiptDigest ||
    evidence.commitRevision !==
      receipt.stageReservationCommitRevision ||
    evidence.head.manifestDigest !== manifestDigest ||
    evidence.head.completedStageOrdinal !== receipt.stageOrdinal ||
    evidence.head.headReceiptDigest !== receiptDigest ||
    evidence.head.abandonmentCount !==
      receipt.stageReservationAbandonmentCount ||
    evidence.head.abandonmentRootDigest !==
      receipt.stageReservationAbandonmentRootDigest ||
    evidence.head.revision !== receipt.stageReservationCommitRevision ||
    commitAdmittedMilliseconds < Date.parse(permitClaims.issuedAt) ||
    commitAdmittedMilliseconds >= Date.parse(permitClaims.expiresAt) ||
    commitAdmittedMilliseconds <= authenticatedReceiptFloorMilliseconds ||
    (nextReceipt !== undefined &&
      commitAdmittedMilliseconds > Date.parse(nextReceipt.startedAt))
  ) return failStageCommitEvidenceChain()
}

/**
 * Requires one authenticated segment summary to immediately follow another.
 *
 * @param predecessor - Exact earlier child or auxiliary rate segment.
 * @param successor - Exact immediate child or auxiliary successor.
 */
function requireImmediateStageCommitRateSuccessor(
  predecessor: WorkspaceSearchMigrationRehearsalStageReceipt['rateSegment'],
  successor: WorkspaceSearchMigrationRehearsalStageReceipt['rateSegment'],
): void {
  if (
    predecessor.authenticationKeyFingerprint !==
      successor.authenticationKeyFingerprint ||
    successor.segmentOrdinal !== predecessor.segmentOrdinal + 1 ||
    predecessor.segmentLocatorDigest === successor.segmentLocatorDigest ||
    predecessor.segmentDigest === successor.segmentDigest ||
    predecessor.terminalRecordMac === successor.terminalRecordMac ||
    successor.firstEventSequence !==
      predecessor.firstEventSequence + predecessor.eventCount
  ) return failStageCommitEvidenceChain()
}

/**
 * Requires every durable commit gate to match its receipt and global rate slot.
 *
 * @param evidence - Parsed parent-authenticated durable commit evidence.
 * @param receipt - Runtime-authenticated receipt committed by the evidence.
 * @param nextReceipt - Next authenticated child receipt when present.
 * @param rollbackPreimageGates - Pending rollback planning gates by scenario.
 */
function requireStageCommitGateBinding(
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  nextReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  rollbackPreimageGates: Map<
    string,
    Extract<
      WorkspaceSearchMigrationRehearsalStageCommitEvidence['commitGate'],
      { readonly kind: 'target-preimage' }
    >
  >,
): void {
  const gate = evidence.commitGate
  const rollbackPlanning =
    receipt.command === 'close-replan' &&
    receipt.evidence.kind === 'planning-sealed' &&
    (receipt.scenario === 'partial-apply-rollback' ||
      receipt.scenario === 'complete-apply-rollback')
  if (rollbackPlanning) {
    const expectedPurpose = receipt.scenario === 'partial-apply-rollback'
      ? 'partial-rollback-preimage'
      : 'complete-rollback-preimage'
    if (
      gate.kind !== 'target-preimage' ||
      gate.purpose !== expectedPurpose ||
      Date.parse(gate.commitGateObservedAt) < Date.parse(receipt.completedAt) ||
      Date.parse(gate.commitGateObservedAt) >
        Date.parse(evidence.commitAdmittedAt) ||
      Date.parse(gate.rateCompletedAt) > Date.parse(receipt.completedAt) ||
      nextReceipt === undefined ||
      nextReceipt.scenario !== receipt.scenario ||
      nextReceipt.command !== 'apply' ||
      rollbackPreimageGates.has(receipt.scenario)
    ) return failStageCommitEvidenceChain()
    requireImmediateStageCommitRateSuccessor(
      receipt.rateSegment,
      gate.rateSuccessor,
    )
    requireImmediateStageCommitRateSuccessor(
      gate.rateSuccessor,
      nextReceipt.rateSegment,
    )
    rollbackPreimageGates.set(receipt.scenario, gate)
    return
  }
  if (receipt.evidence.kind === 'terminal') {
    const terminal = receipt.evidence
    const nextRelease = nextReceipt !== undefined &&
      nextReceipt.scenario === receipt.scenario &&
      nextReceipt.command === 'release'
    if (
      gate.kind !== 'terminal-reconciliation' ||
      !nextRelease ||
      gate.artifactBindingDigest !==
        terminal.reconciliationArtifactBindingDigest ||
      gate.contentDigest !==
        terminal.reconciliationArtifactContentDigest ||
      gate.byteLength !== terminal.reconciliationArtifactByteLength ||
      gate.scenario !== receipt.scenario ||
      gate.auditDigest !== terminal.reconciliationArtifactAuditDigest ||
      gate.contextDigest !==
        createMigrationDigest(terminal.reconciliationContext) ||
      serializeCanonicalJson(gate.rateSuccessor) !==
        serializeCanonicalJson(terminal.reconciliationRate.successor) ||
      gate.rateAggregateDigest !==
        terminal.reconciliationRate.aggregateDigest ||
      gate.rateCompletedAt !== terminal.reconciliationRate.completedAt
    ) return failStageCommitEvidenceChain()
    const restored = terminal.reconciliationContext.targetAudits?.restored
    const reconciliationPredecessor = restored === undefined
      ? receipt.rateSegment
      : restored.rate.successor
    if (
      serializeCanonicalJson(terminal.reconciliationRate.predecessor) !==
        serializeCanonicalJson(reconciliationPredecessor)
    ) return failStageCommitEvidenceChain()
    if (restored !== undefined) {
      requireImmediateStageCommitRateSuccessor(
        receipt.rateSegment,
        restored.rate.successor,
      )
    }
    requireImmediateStageCommitRateSuccessor(
      reconciliationPredecessor,
      gate.rateSuccessor,
    )
    requireImmediateStageCommitRateSuccessor(
      gate.rateSuccessor,
      nextReceipt.rateSegment,
    )
    const preimage = terminal.reconciliationContext.targetAudits?.preimage
    const preimageGate = rollbackPreimageGates.get(receipt.scenario)
    if (preimage === undefined) {
      if (preimageGate !== undefined) return failStageCommitEvidenceChain()
      return
    }
    if (
      preimageGate === undefined ||
      preimageGate.purpose !== preimage.purpose ||
      preimageGate.contentDigest !== preimage.contentDigest ||
      preimageGate.byteLength !== preimage.byteLength ||
      preimageGate.contextDigest !== preimage.contextDigest ||
      preimageGate.observationDigest !== preimage.observationDigest ||
      preimageGate.aggregateDigest !== preimage.aggregateDigest ||
      serializeCanonicalJson(preimageGate.rateSuccessor) !==
        serializeCanonicalJson(preimage.rate.successor) ||
      preimageGate.rateAggregateDigest !== preimage.rate.aggregateDigest ||
      preimageGate.rateCompletedAt !== preimage.rate.completedAt
    ) return failStageCommitEvidenceChain()
    rollbackPreimageGates.delete(receipt.scenario)
    return
  }
  if (gate.kind !== 'none') return failStageCommitEvidenceChain()
}

/**
 * Creates one detached immutable stage-to-commit projection.
 *
 * @param evidence - Parsed authenticated commit evidence.
 * @param receipt - Authenticated receipt exactly bound to the evidence.
 * @param receiptDigest - Digest of the exact authenticated receipt.
 * @param manifestDigest - Digest of the exact authenticated manifest.
 * @returns Frozen publication-facing stage-to-commit binding.
 */
function createStageCommitBinding(
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  receiptDigest: string,
  manifestDigest: string,
): WorkspaceSearchMigrationRehearsalStageCommitBinding {
  return Object.freeze({
    stage: 'non-production',
    manifestDigest,
    stateTableLocationBindingDigest:
      evidence.stateTableLocationBindingDigest,
    publicationKeyDigest: evidence.publicationKeyDigest,
    parentAuthenticationDigest: evidence.parentAuthenticationDigest,
    parentAuthorizationBindingDigest:
      evidence.parentAuthorizationBindingDigest,
    scenario: receipt.scenario,
    stageOrdinal: receipt.stageOrdinal,
    scenarioStageOrdinal: receipt.scenarioStageOrdinal,
    runLocatorDigest: receipt.runLocatorDigest,
    stageReservationDigest: receipt.stageReservationDigest,
    stageReservationClaimRevision:
      receipt.stageReservationClaimRevision,
    stageReservationCommitRevision:
      receipt.stageReservationCommitRevision,
    stageReservationAbandonmentCount:
      receipt.stageReservationAbandonmentCount,
    stageReservationAbandonmentRootDigest:
      receipt.stageReservationAbandonmentRootDigest,
    receiptDigest,
    commitEvidenceDigest: createMigrationDigest(evidence),
    commitAdmittedAt: evidence.commitAdmittedAt,
    durableStatus: evidence.durableStatus,
    inactiveHead: Object.freeze({ ...evidence.head }),
  })
}

/**
 * Copies one exact-length ordinary array without invoking element accessors.
 *
 * @param value - Untrusted array candidate.
 * @param expectedLength - Sole accepted dense array length.
 * @returns Frozen detached element-value array.
 */
function copyStageCommitEvidenceChainArray(
  value: unknown,
  expectedLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expectedLength ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== expectedLength + 1
  ) return failStageCommitEvidenceChain()
  const copy: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failStageCommitEvidenceChain()
    const element: unknown = descriptor.value
    copy.push(element)
  }
  return Object.freeze(copy)
}

/**
 * Copies one ordinary exact-length shared authentication key.
 *
 * @param value - Untrusted shared verification-key candidate.
 * @returns Owned exact 32-byte key copy.
 */
function copyStageCommitEvidenceChainKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== stageCommitEvidenceChainKeyBytes
  ) return failStageCommitEvidenceChain()
  return new Uint8Array(value)
}

/**
 * Best-effort overwrites one owned authentication key copy.
 *
 * @param value - Owned key bytes or undefined before successful validation.
 * @returns Nothing after best-effort overwrite.
 */
function zeroizeStageCommitEvidenceChainBytes(
  value: Uint8Array | undefined,
): void {
  if (value === undefined) return
  try {
    value.fill(0)
  } catch {
    // The owned buffer was already detached or otherwise inaccessible.
  }
}

/**
 * Raises the sole stable raw-value-free full-chain validation failure.
 *
 * @returns Never returns because validation always fails closed.
 */
function failStageCommitEvidenceChain(): never {
  throw new WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError()
}
