import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MINIMUM_MAINTENANCE_DRAIN_SECONDS,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-manifest'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for one authenticated durable-stage reservation. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-reservation'

/** First authenticated durable-stage reservation contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION = 1

/** Exact entropy bytes required before deriving a public nonce digest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_NONCE_BYTES =
  32

/** Maximum canonical bytes accepted for one reservation document. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES =
  16 * 1_024

/** Recovery window retained inside the authenticated permit after a claim. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS =
  MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000

/** Permit time retained after recovery closes for explicit abandonment. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS =
  15 * 60 * 1_000

/** Fixed lifetime assigned to each production child stage claim. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS =
  6 *
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS

/** Maximum authenticated lifetime accepted for any stage claim. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_MILLISECONDS =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS

/** Domain separating reservation MACs from all other rehearsal artifacts. */
const reservationMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-reservation:v1'

/** Exact raw evidence-key bytes required for reservation authentication. */
const reservationKeyBytes = 32

/** Exact authenticated claims for one manifest-entry execution claim. */
export type WorkspaceSearchMigrationRehearsalStageReservationClaims = {
  /** Fixed reservation discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND
  /** Reservation schema version. */
  readonly reservationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION
  /** Digest of the exact authenticated complete manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the required durable predecessor receipt, or null at stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Exact authenticated rate predecessor selected before child execution. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Exact fresh rate-segment ordinal the claimed child must create. */
  readonly expectedCurrentRateSegmentOrdinal: number
  /** Planning-commit-pinned rollback preimage bytes, or null for other stages. */
  readonly expectedTargetPreimageArtifactContentDigest: string | null
  /** Globally contiguous selected stage ordinal. */
  readonly stageOrdinal: number
  /** Canonical scenario owning the selected stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Contiguous one-based stage ordinal inside the scenario. */
  readonly scenarioStageOrdinal: number
  /** Exact existing mutating command authorized by the manifest. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** One-based process attempt ordinal inside the scenario. */
  readonly attemptOrdinal: number
  /** Exact finite stage outcome authorized by the manifest. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Digest of the exact reviewed control argument vector. */
  readonly controlArgumentsDigest: string
  /** Digest of the authenticated rehearsal permit. */
  readonly permitDigest: string
  /** SHA-256 digest of the runtime-only evidence authentication key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the parent-only publication authentication key. */
  readonly publicationKeyDigest: string
  /** Exact silent parent-liveness protocol required for this claim. */
  readonly parentLivenessProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  /** Exact reviewed implementation commit OID. */
  readonly commit: string
  /** Authenticated requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Reviewed measured configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest. */
  readonly policyVersion: string
  /** SHA-256 digest of fresh process-local reservation entropy. */
  readonly nonceDigest: string
  /** Canonical trusted time at which this claim was created. */
  readonly reservedAt: string
  /** Canonical exclusive time after which explicit recovery may replace it. */
  readonly expiresAt: string
}

/** Complete selection-bound authenticated durable-stage reservation. */
export type WorkspaceSearchMigrationRehearsalStageReservation =
  WorkspaceSearchMigrationRehearsalStageReservationClaims & {
    /** HMAC-SHA-256 over the exact canonical reservation claims. */
    readonly reservationMac: string
  }

/** Secret-free current durable manifest-head projection. */
export type WorkspaceSearchMigrationRehearsalStageHead = {
  /** Digest of the exact authenticated manifest. */
  readonly manifestDigest: string
  /** Highest durably committed global stage ordinal. */
  readonly completedStageOrdinal: number
  /** Digest of the exact current stage receipt, or null at the root. */
  readonly headReceiptDigest: string | null
  /** Digest of the sole active reservation, or null when unclaimed. */
  readonly activeReservationDigest: string | null
  /** Claimed next global stage ordinal, or null when unclaimed. */
  readonly activeStageOrdinal: number | null
  /** Exclusive active-reservation expiry, or null when unclaimed. */
  readonly activeExpiresAt: string | null
  /** Cumulative number of immutable explicit abandonment transitions. */
  readonly abandonmentCount: number
  /** Cumulative digest root authenticating abandonment transition order. */
  readonly abandonmentRootDigest: string
  /** Monotonic exact-predecessor row revision. */
  readonly revision: number
}

/** Inputs for creating one fresh authenticated stage reservation. */
export type CreateWorkspaceSearchMigrationRehearsalStageReservationInput = {
  /** Authenticated manifest selection independently derived before mutation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh exact process-local entropy whose bytes never enter the result. */
  readonly nonce: Uint8Array
  /** Canonical trusted reservation creation time. */
  readonly reservedAt: string
  /** Canonical exclusive reservation expiry within the bounded claim lifetime. */
  readonly expiresAt: string
  /** Exact authenticated predecessor rate summary, or null at stage one. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Exact new rate segment ordinal required from this child. */
  readonly expectedCurrentRateSegmentOrdinal: number
  /** Planning-commit-pinned rollback preimage bytes, or null for other stages. */
  readonly expectedTargetPreimageArtifactContentDigest: string | null
  /** Shared 32-byte manifest and stage authentication key. */
  readonly signingKey: Uint8Array
}

/** Inputs for independently verifying one reservation and its selection. */
export type VerifyWorkspaceSearchMigrationRehearsalStageReservationInput = {
  /** Untrusted parsed reservation candidate. */
  readonly reservation: unknown
  /** Independently authenticated expected stage selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte manifest and stage verification key. */
  readonly verificationKey: Uint8Array
}

/** Stable raw-value-free stage-reservation validation failure. */
export class WorkspaceSearchMigrationRehearsalStageReservationError
  extends Error {
  /** Creates one stable reservation failure. */
  constructor() {
    super('INVALID_STAGE_RESERVATION')
    this.name = 'WorkspaceSearchMigrationRehearsalStageReservationError'
  }
}

/** Strict ordinary-record guards for reservation parsing. */
const reservationGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageReservation,
)

/** Exact canonical reservation claim keys. */
const reservationClaimKeys = Object.freeze([
  'attemptOrdinal',
  'command',
  'commit',
  'configurationBindingDigest',
  'controlArgumentsDigest',
  'expectedOutcome',
  'evidenceKeyDigest',
  'expectedCurrentRateSegmentOrdinal',
  'expectedPreviousRateSegment',
  'expectedTargetPreimageArtifactContentDigest',
  'expiresAt',
  'kind',
  'manifestDigest',
  'manifestEntryDigest',
  'nonceDigest',
  'parentLivenessProtocol',
  'permitDigest',
  'policyVersion',
  'publicationKeyDigest',
  'previousStageReceiptDigest',
  'requestedResourcesBinding',
  'reservationVersion',
  'reservedAt',
  'scenario',
  'scenarioStageOrdinal',
  'stageOrdinal',
])

/** Exact canonical complete reservation keys. */
const reservationKeys = Object.freeze([
  ...reservationClaimKeys,
  'reservationMac',
])

/** Exact independently authenticated rate-summary fields in a reservation. */
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

/** Scalar selection detached from caller-owned nested objects. */
type StageReservationSelection = {
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
  /** Selected command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Selected attempt ordinal. */
  readonly attemptOrdinal: number
  /** Selected expected outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Selected control-argument digest. */
  readonly controlArgumentsDigest: string
  /** Authenticated permit digest. */
  readonly permitDigest: string
  /** Authenticated runtime evidence-key digest. */
  readonly evidenceKeyDigest: string
  /** Authenticated parent publication-key digest. */
  readonly publicationKeyDigest: string
  /** Reviewed implementation commit. */
  readonly commit: string
  /** Authenticated requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Reviewed configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed policy digest. */
  readonly policyVersion: string
}

/**
 * Creates one authenticated reservation from a reauthenticated selection.
 *
 * @param input - Selection, fresh entropy, finite times, and shared key.
 * @returns Frozen selection-bound reservation safe for durable CAS storage.
 */
export function createWorkspaceSearchMigrationRehearsalStageReservation(
  input: CreateWorkspaceSearchMigrationRehearsalStageReservationInput,
): WorkspaceSearchMigrationRehearsalStageReservation {
  const key = copyReservationKey(input.signingKey)
  let nonce: Uint8Array | undefined
  try {
    const selection = snapshotReservationSelection(input.selection, key)
    nonce = copyReservationNonce(input.nonce)
    const times = readReservationTimes(input.reservedAt, input.expiresAt)
    const expectedRate = readExpectedReservationRateBinding(
      input.expectedPreviousRateSegment,
      input.expectedCurrentRateSegmentOrdinal,
      selection.stageOrdinal,
      key,
    )
    const expectedTargetPreimageArtifactContentDigest =
      readExpectedTargetPreimageArtifactContentDigest(
        input.expectedTargetPreimageArtifactContentDigest,
        selection.command,
        selection.scenario,
      )
    const claims: WorkspaceSearchMigrationRehearsalStageReservationClaims =
      Object.freeze({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND,
        reservationVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION,
        ...selection,
        ...expectedRate,
        expectedTargetPreimageArtifactContentDigest,
        parentLivenessProtocol:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
        nonceDigest: createHash('sha256').update(nonce).digest('hex'),
        reservedAt: times.reservedAt,
        expiresAt: times.expiresAt,
      })
    const reservation = Object.freeze({
      ...claims,
      reservationMac: createReservationMac(claims, key),
    })
    if (
      new TextEncoder().encode(serializeCanonicalJson(reservation))
        .byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES
    ) return failStageReservation()
    return reservation
  } catch {
    return failStageReservation()
  } finally {
    zeroizeReservationBytes(nonce)
    zeroizeReservationBytes(key)
  }
}

/**
 * Verifies one reservation HMAC and every independently selected binding.
 *
 * @param input - Candidate reservation, parent selection, and shared key.
 * @returns Frozen detached authenticated reservation.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageReservation(
  input: VerifyWorkspaceSearchMigrationRehearsalStageReservationInput,
): WorkspaceSearchMigrationRehearsalStageReservation {
  const key = copyReservationKey(input.verificationKey)
  try {
    const selection = snapshotReservationSelection(input.selection, key)
    const record = reservationGuards.requireRecord(input.reservation)
    reservationGuards.requireExactKeys(record, reservationKeys)
    const claims = readReservationClaims(record, key)
    requireReservationMatchesSelection(claims, selection)
    const reservationMac = readReservationDigest(
      reservationGuards.readOwn(record, 'reservationMac'),
    )
    if (!safeReservationDigestEqual(
      reservationMac,
      createReservationMac(claims, key),
    )) return failStageReservation()
    return Object.freeze({ ...claims, reservationMac })
  } catch {
    return failStageReservation()
  } finally {
    zeroizeReservationBytes(key)
  }
}

/**
 * Parses exact canonical reservation bytes and verifies their HMAC.
 *
 * @param bytes - Exact canonical reservation document bytes.
 * @param selection - Independently authenticated expected selection.
 * @param verificationKey - Shared 32-byte stage verification key.
 * @returns Frozen detached authenticated reservation.
 */
export function parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
  bytes: Uint8Array,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReservation {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES
    ) return failStageReservation()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: candidate,
        selection,
        verificationKey,
      })
    if (serializeCanonicalJson(reservation) !== text) {
      return failStageReservation()
    }
    return reservation
  } catch {
    return failStageReservation()
  }
}

/** Reauthenticates and detaches every manifest selection binding. */
function snapshotReservationSelection(
  value: unknown,
  verificationKey: Uint8Array,
): StageReservationSelection {
  const record = reservationGuards.requireRecord(value)
  reservationGuards.requireExactKeys(record, [
    'entry',
    'manifest',
    'manifestDigest',
    'previousStageReceiptDigest',
  ])
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    reservationGuards.readOwn(record, 'manifest'),
    verificationKey,
  )
  const manifestDigest = readReservationDigest(
    reservationGuards.readOwn(record, 'manifestDigest'),
  )
  if (manifestDigest !== createMigrationDigest(manifest)) {
    return failStageReservation()
  }
  const entryRecord = reservationGuards.requireRecord(
    reservationGuards.readOwn(record, 'entry'),
  )
  const ordinal = readReservationPositiveInteger(
    reservationGuards.readOwn(entryRecord, 'ordinal'),
  )
  const manifestEntry = manifest.entries[ordinal - 1]
  if (
    manifestEntry === undefined ||
    createMigrationDigest(manifestEntry) !==
      createMigrationDigest(entryRecord)
  ) return failStageReservation()
  const previousStageReceiptDigest = readReservationNullableDigest(
    reservationGuards.readOwn(record, 'previousStageReceiptDigest'),
  )
  if ((ordinal === 1) !== (previousStageReceiptDigest === null)) {
    return failStageReservation()
  }
  return Object.freeze({
    manifestDigest,
    manifestEntryDigest: createMigrationDigest(manifestEntry),
    previousStageReceiptDigest,
    stageOrdinal: manifestEntry.ordinal,
    scenario: manifestEntry.scenario,
    scenarioStageOrdinal: manifestEntry.scenarioStageOrdinal,
    command: manifestEntry.command,
    attemptOrdinal: manifestEntry.attemptOrdinal,
    expectedOutcome: manifestEntry.expectedOutcome,
    controlArgumentsDigest: manifestEntry.controlArgumentsDigest,
    permitDigest: manifest.permitDigest,
    evidenceKeyDigest: manifest.evidenceKeyDigest,
    publicationKeyDigest: manifest.publicationKeyDigest,
    commit: manifest.commit,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
  })
}

/** Reads and validates exact detached reservation claims. */
function readReservationClaims(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReservationClaims {
  const record = reservationGuards.requireRecord(value)
  reservationGuards.requireExactKeys(
    record,
    Object.keys(record).includes('reservationMac')
      ? reservationKeys
      : reservationClaimKeys,
  )
  const kind = reservationGuards.readOwn(record, 'kind')
  const reservationVersion = reservationGuards.readOwn(
    record,
    'reservationVersion',
  )
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND ||
    reservationVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION
  ) return failStageReservation()
  const times = readReservationTimes(
    reservationGuards.readOwn(record, 'reservedAt'),
    reservationGuards.readOwn(record, 'expiresAt'),
  )
  const stageOrdinal = readReservationPositiveInteger(
    reservationGuards.readOwn(record, 'stageOrdinal'),
  )
  const previousStageReceiptDigest = readReservationNullableDigest(
    reservationGuards.readOwn(record, 'previousStageReceiptDigest'),
  )
  if ((stageOrdinal === 1) !== (previousStageReceiptDigest === null)) {
    return failStageReservation()
  }
  const expectedRate = readExpectedReservationRateBinding(
    reservationGuards.readOwn(record, 'expectedPreviousRateSegment'),
    reservationGuards.readOwn(record, 'expectedCurrentRateSegmentOrdinal'),
    stageOrdinal,
    verificationKey,
  )
  const scenario = readReservationScenario(
    reservationGuards.readOwn(record, 'scenario'),
  )
  const command = readReservationCommand(
    reservationGuards.readOwn(record, 'command'),
  )
  const expectedTargetPreimageArtifactContentDigest =
    readExpectedTargetPreimageArtifactContentDigest(
      reservationGuards.readOwn(
        record,
        'expectedTargetPreimageArtifactContentDigest',
      ),
      command,
      scenario,
    )
  return Object.freeze({
    kind,
    reservationVersion,
    manifestDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'manifestDigest'),
    ),
    manifestEntryDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'manifestEntryDigest'),
    ),
    previousStageReceiptDigest,
    ...expectedRate,
    expectedTargetPreimageArtifactContentDigest,
    stageOrdinal,
    scenario,
    scenarioStageOrdinal: readReservationPositiveInteger(
      reservationGuards.readOwn(record, 'scenarioStageOrdinal'),
    ),
    command,
    attemptOrdinal: readReservationPositiveInteger(
      reservationGuards.readOwn(record, 'attemptOrdinal'),
    ),
    expectedOutcome: readReservationOutcome(
      reservationGuards.readOwn(record, 'expectedOutcome'),
    ),
    controlArgumentsDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'controlArgumentsDigest'),
    ),
    permitDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'permitDigest'),
    ),
    evidenceKeyDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'evidenceKeyDigest'),
    ),
    publicationKeyDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'publicationKeyDigest'),
    ),
    parentLivenessProtocol: readParentLivenessProtocol(
      reservationGuards.readOwn(record, 'parentLivenessProtocol'),
    ),
    commit: readReservationCommit(
      reservationGuards.readOwn(record, 'commit'),
    ),
    requestedResourcesBinding: readReservationDigest(
      reservationGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    configurationBindingDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion: readReservationDigest(
      reservationGuards.readOwn(record, 'policyVersion'),
    ),
    nonceDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'nonceDigest'),
    ),
    reservedAt: times.reservedAt,
    expiresAt: times.expiresAt,
  })
}

/**
 * Requires only rollback apply stages to pin planning-authenticated preimage bytes.
 *
 * @param value - Untrusted nullable content digest.
 * @param command - Authenticated selected stage command.
 * @param scenario - Authenticated selected stage scenario.
 * @returns Exact lowercase digest or null for a non-rollback-apply stage.
 */
function readExpectedTargetPreimageArtifactContentDigest(
  value: unknown,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): string | null {
  const digest = readReservationNullableDigest(value)
  const requiresPreimage = command === 'apply' &&
    (scenario === 'complete-apply-rollback' ||
      scenario === 'partial-apply-rollback')
  if ((digest !== null) !== requiresPreimage) return failStageReservation()
  return digest
}

/** Reads the rate predecessor and exact new segment ordinal as one invariant. */
function readExpectedReservationRateBinding(
  previousValue: unknown,
  currentOrdinalValue: unknown,
  stageOrdinal: number,
  verificationKey: Uint8Array | undefined,
): {
  /** Detached exact authenticated predecessor summary. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Exact ordinal required from the new process segment. */
  readonly expectedCurrentRateSegmentOrdinal: number
} {
  const expectedPreviousRateSegment = previousValue === null
    ? null
    : readReservationVerifiedRateSegment(previousValue)
  const expectedCurrentRateSegmentOrdinal =
    readReservationNonNegativeInteger(currentOrdinalValue)
  if (
    (stageOrdinal === 1 &&
      (expectedPreviousRateSegment !== null ||
        expectedCurrentRateSegmentOrdinal !== 0)) ||
    (stageOrdinal > 1 &&
      (expectedPreviousRateSegment === null ||
        expectedCurrentRateSegmentOrdinal !==
          expectedPreviousRateSegment.segmentOrdinal + 1)) ||
    (verificationKey !== undefined &&
      expectedPreviousRateSegment !== null &&
      expectedPreviousRateSegment.authenticationKeyFingerprint !==
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          verificationKey,
        ))
  ) return failStageReservation()
  return Object.freeze({
    expectedPreviousRateSegment,
    expectedCurrentRateSegmentOrdinal,
  })
}

/** Strictly reconstructs one complete verified predecessor rate summary. */
function readReservationVerifiedRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = reservationGuards.requireRecord(value)
  reservationGuards.requireExactKeys(record, verifiedRateSegmentKeys)
  const eventCount = readReservationNonNegativeInteger(
    reservationGuards.readOwn(record, 'eventCount'),
  )
  const firstCommittedEventSequence = readReservationNullablePositiveInteger(
    reservationGuards.readOwn(record, 'firstCommittedEventSequence'),
  )
  const lastCommittedEventSequence = readReservationNullablePositiveInteger(
    reservationGuards.readOwn(record, 'lastCommittedEventSequence'),
  )
  const firstEventSequence = readReservationPositiveInteger(
    reservationGuards.readOwn(record, 'firstEventSequence'),
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
  ) return failStageReservation()
  return Object.freeze({
    authenticationKeyFingerprint: readReservationDigest(
      reservationGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readReservationNonNegativeInteger(
      reservationGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: readReservationDigest(
      reservationGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: readReservationDigest(
      reservationGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Requires the sole reviewed silent parent-liveness protocol. */
function readParentLivenessProtocol(
  value: unknown,
): typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL {
  if (
    value !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failStageReservation()
  return value
}

/** Requires exact equality between reservation claims and parent selection. */
function requireReservationMatchesSelection(
  claims: WorkspaceSearchMigrationRehearsalStageReservationClaims,
  selection: StageReservationSelection,
): void {
  for (const key of [
    'manifestDigest',
    'manifestEntryDigest',
    'previousStageReceiptDigest',
    'stageOrdinal',
    'scenario',
    'scenarioStageOrdinal',
    'command',
    'attemptOrdinal',
    'expectedOutcome',
    'controlArgumentsDigest',
    'permitDigest',
    'evidenceKeyDigest',
    'publicationKeyDigest',
    'commit',
    'requestedResourcesBinding',
    'configurationBindingDigest',
    'policyVersion',
  ]) {
    const claimsDescriptor = Object.getOwnPropertyDescriptor(claims, key)
    const selectionDescriptor = Object.getOwnPropertyDescriptor(selection, key)
    if (
      claimsDescriptor === undefined ||
      selectionDescriptor === undefined ||
      !Object.hasOwn(claimsDescriptor, 'value') ||
      !Object.hasOwn(selectionDescriptor, 'value') ||
      claimsDescriptor.value !== selectionDescriptor.value
    ) return failStageReservation()
  }
}

/** Reads and validates the finite reservation interval. */
function readReservationTimes(
  reservedAtValue: unknown,
  expiresAtValue: unknown,
): {
  /** Canonical inclusive reservation creation time. */
  readonly reservedAt: string
  /** Canonical exclusive reservation expiry time. */
  readonly expiresAt: string
} {
  if (
    !isCanonicalTimestamp(reservedAtValue) ||
    !isCanonicalTimestamp(expiresAtValue)
  ) return failStageReservation()
  const reservedAtMilliseconds = Date.parse(reservedAtValue)
  const expiresAtMilliseconds = Date.parse(expiresAtValue)
  if (
    expiresAtMilliseconds <= reservedAtMilliseconds ||
    expiresAtMilliseconds - reservedAtMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_MILLISECONDS
  ) return failStageReservation()
  return Object.freeze({
    reservedAt: reservedAtValue,
    expiresAt: expiresAtValue,
  })
}

/** Creates the domain-separated HMAC for exact reservation claims. */
function createReservationMac(
  claims: WorkspaceSearchMigrationRehearsalStageReservationClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(reservationMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Copies and validates one exact non-Proxy 32-byte stage key. */
function copyReservationKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== reservationKeyBytes
  ) return failStageReservation()
  try {
    const copied: unknown = Reflect.apply(Uint8Array.prototype.slice, value, [])
    if (
      !(copied instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(copied) ||
      nodeUtilTypes.isSharedArrayBuffer(copied.buffer)
    ) {
      return failStageReservation()
    }
    return copied
  } catch {
    return failStageReservation()
  }
}

/** Copies and validates exact fresh process-local reservation entropy. */
function copyReservationNonce(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_NONCE_BYTES
  ) return failStageReservation()
  try {
    const copied: unknown = Reflect.apply(Uint8Array.prototype.slice, value, [])
    if (
      !(copied instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(copied) ||
      nodeUtilTypes.isSharedArrayBuffer(copied.buffer)
    ) {
      return failStageReservation()
    }
    return copied
  } catch {
    return failStageReservation()
  }
}

/** Best-effort zeroizes invocation-owned reservation bytes. */
function zeroizeReservationBytes(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Cleanup must not replace the primary reservation outcome.
  }
}

/** Reads one strict lowercase SHA-256 digest. */
function readReservationDigest(value: unknown): string {
  if (!isHexDigest(value)) return failStageReservation()
  return value
}

/** Reads one strict nullable lowercase SHA-256 digest. */
function readReservationNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return readReservationDigest(value)
}

/** Reads one positive safe integer. */
function readReservationPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) {
    return failStageReservation()
  }
  return value
}

/** Reads one non-negative safe integer. */
function readReservationNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    return failStageReservation()
  }
  return value
}

/** Reads one positive safe integer or explicit null. */
function readReservationNullablePositiveInteger(
  value: unknown,
): number | null {
  return value === null ? null : readReservationPositiveInteger(value)
}

/** Reads one canonical scenario. */
function readReservationScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failStageReservation()
}

/** Reads one existing mutating stage command. */
function readReservationCommand(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommand {
  switch (value) {
    case 'apply':
    case 'close-replan':
    case 'release':
    case 'rollback-complete':
    case 'rollback-partial':
    case 'verify':
      return value
    default:
      return failStageReservation()
  }
}

/** Reads one finite manifest stage outcome. */
function readReservationOutcome(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageOutcome {
  switch (value) {
    case 'completed':
    case 'fault-reached':
    case 'response-loss-reconciled':
    case 'takeover-completed':
      return value
    default:
      return failStageReservation()
  }
}

/** Reads one exact lowercase 40-character implementation commit OID. */
function readReservationCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failStageReservation()
  }
  return value
}

/** Compares two validated equal-length digests without timing leakage. */
function safeReservationDigestEqual(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, 'hex')
    const rightBytes = Buffer.from(right, 'hex')
    return leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(leftBytes, rightBytes)
  } catch {
    return false
  }
}

/** Raises the stable raw-value-free reservation failure. */
function failStageReservation(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationError()
}
