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
  serializeCanonicalJson,
} from './migration-contract'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-manifest'
export {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for a parent-authorized reservation abandonment. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-reservation-abandonment'

/** First parent-authorized reservation-abandonment contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION =
  1

/** Only accepted parent assertion after containment and reservation expiry. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_REASON =
  'contained-after-expiry'

/** Domain separating parent abandonment authorization from all runtime MACs. */
const abandonmentMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-reservation-abandonment:v1'

/** Domain separating cumulative root links from the signed artifact itself. */
const abandonmentRootDomain =
  'mukuroji:workspace-search-migration:rehearsal-stage-reservation-abandonment-root:v1'

/** Exact bytes required for runtime and publication authentication keys. */
const abandonmentKeyBytes = 32

/** Exact authenticated claims for one immutable abandonment transition. */
export type WorkspaceSearchMigrationRehearsalStageReservationAbandonmentClaims = {
  /** Fixed abandonment discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND
  /** Abandonment schema version. */
  readonly abandonmentVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION
  /** Digest of the suite-pinned authenticated manifest. */
  readonly manifestDigest: string
  /** Digest of the authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Authenticated requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Exact abandoned global stage ordinal. */
  readonly stageOrdinal: number
  /** Exact silent parent-liveness protocol bound by the reservation. */
  readonly parentLivenessProtocol:
    WorkspaceSearchMigrationRehearsalStageReservation[
      'parentLivenessProtocol'
    ]
  /** Domain-separated fingerprint of the durably erased runtime key. */
  readonly runtimeKeyFingerprint: string
  /** Digest of the durable cleanup completion authorizing this transition. */
  readonly runtimeKeyCleanupCompletionDigest: string
  /** Digest of the exact reservation removed from the active slot. */
  readonly reservationDigest: string
  /** Durable revision at which the abandoned reservation became active. */
  readonly reservationClaimRevision: number
  /** Cumulative abandonment count before this transition. */
  readonly previousAbandonmentCount: number
  /** Cumulative abandonment root before this transition. */
  readonly previousAbandonmentRootDigest: string
  /** Cumulative abandonment count after this transition. */
  readonly abandonmentCount: number
  /** Cumulative abandonment root after this transition. */
  readonly abandonmentRootDigest: string
  /** Durable head revision produced by this transition. */
  readonly abandonmentRevision: number
  /** Canonical parent authorization time after reservation expiry. */
  readonly abandonedAt: string
  /** Explicit parent assertion that containment completed after expiry. */
  readonly reason:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_REASON
}

/** Complete parent-authenticated immutable abandonment transition. */
export type WorkspaceSearchMigrationRehearsalStageReservationAbandonment =
  WorkspaceSearchMigrationRehearsalStageReservationAbandonmentClaims & {
    /** HMAC-SHA-256 under the parent-only publication key. */
    readonly abandonmentMac: string
  }

/** Input for creating one parent-authorized abandonment transition. */
export type CreateWorkspaceSearchMigrationRehearsalStageReservationAbandonmentInput = {
  /** Exact runtime-authenticated reservation to abandon. */
  readonly reservation: unknown
  /** Independently authenticated manifest selection for the reservation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Durable revision at which the reservation became active. */
  readonly reservationClaimRevision: number
  /** Current cumulative abandonment count. */
  readonly previousAbandonmentCount: number
  /** Current cumulative abandonment root. */
  readonly previousAbandonmentRootDigest: string
  /** Canonical parent authorization time after containment and expiry. */
  readonly abandonedAt: string
  /** Digest of the durable cleanup completion created before authorization. */
  readonly runtimeKeyCleanupCompletionDigest: string
  /** Runtime key used only to verify the reservation and selection. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only publication key used to authenticate the transition. */
  readonly publicationSigningKey: Uint8Array
}

/** Input for verifying one parent-authorized abandonment transition. */
export type VerifyWorkspaceSearchMigrationRehearsalStageReservationAbandonmentInput = {
  /** Untrusted abandonment artifact candidate. */
  readonly abandonment: unknown
  /** Exact runtime-authenticated reservation expected to be abandoned. */
  readonly reservation: unknown
  /** Independently authenticated manifest selection for the reservation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Runtime key used only to verify the reservation and selection. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only publication key used to verify the transition. */
  readonly publicationVerificationKey: Uint8Array
}

/** Stable raw-value-free abandonment validation failure. */
export class WorkspaceSearchMigrationRehearsalStageReservationAbandonmentError
  extends Error {
  /** Creates one stable abandonment validation failure. */
  constructor() {
    super('INVALID_STAGE_RESERVATION_ABANDONMENT')
    this.name =
      'WorkspaceSearchMigrationRehearsalStageReservationAbandonmentError'
  }
}

/** Strict ordinary-record guards for abandonment parsing. */
const abandonmentGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failAbandonment,
)

/** Exact canonical abandonment claim keys. */
const abandonmentClaimKeys = Object.freeze([
  'abandonedAt',
  'abandonmentCount',
  'abandonmentRevision',
  'abandonmentRootDigest',
  'abandonmentVersion',
  'kind',
  'manifestDigest',
  'parentLivenessProtocol',
  'permitDigest',
  'previousAbandonmentCount',
  'previousAbandonmentRootDigest',
  'reason',
  'requestedResourcesBinding',
  'reservationClaimRevision',
  'reservationDigest',
  'runtimeKeyCleanupCompletionDigest',
  'runtimeKeyFingerprint',
  'stageOrdinal',
])

/** Exact canonical complete abandonment keys. */
const abandonmentKeys = Object.freeze([
  ...abandonmentClaimKeys,
  'abandonmentMac',
])

/** Claims excluding the derived cumulative root. */
type AbandonmentRootLink = Omit<
  WorkspaceSearchMigrationRehearsalStageReservationAbandonmentClaims,
  'abandonmentRootDigest'
>

/**
 * Creates one parent-signed immutable abandonment transition.
 *
 * @param input - Reservation, current root, trusted time, and separated keys.
 * @returns Frozen transition whose cumulative root advances exactly once.
 */
export function createWorkspaceSearchMigrationRehearsalStageReservationAbandonment(
  input:
    CreateWorkspaceSearchMigrationRehearsalStageReservationAbandonmentInput,
): WorkspaceSearchMigrationRehearsalStageReservationAbandonment {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    runtimeKey = copyAbandonmentKey(input.runtimeVerificationKey)
    publicationKey = copyAbandonmentKey(input.publicationSigningKey)
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: input.reservation,
        selection: input.selection,
        verificationKey: runtimeKey,
      })
    requirePublicationKeyMatchesReservation(reservation, publicationKey)
    const reservationClaimRevision = readPositiveInteger(
      input.reservationClaimRevision,
    )
    const previousAbandonmentCount = readNonNegativeInteger(
      input.previousAbandonmentCount,
    )
    const previousAbandonmentRootDigest = readDigest(
      input.previousAbandonmentRootDigest,
    )
    const abandonedAt = readAbandonmentTime(
      input.abandonedAt,
      reservation,
    )
    const runtimeKeyCleanupCompletionDigest = readDigest(
      input.runtimeKeyCleanupCompletionDigest,
    )
    const rootLink = Object.freeze({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND,
      abandonmentVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION,
      manifestDigest: reservation.manifestDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding: reservation.requestedResourcesBinding,
      stageOrdinal: reservation.stageOrdinal,
      parentLivenessProtocol: reservation.parentLivenessProtocol,
      runtimeKeyFingerprint:
        createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
          runtimeKey,
        ),
      runtimeKeyCleanupCompletionDigest,
      reservationDigest: createMigrationDigest(reservation),
      reservationClaimRevision,
      previousAbandonmentCount,
      previousAbandonmentRootDigest,
      abandonmentCount: previousAbandonmentCount + 1,
      abandonmentRevision: reservationClaimRevision + 1,
      abandonedAt,
      reason:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_REASON,
    })
    const claims = Object.freeze({
      ...rootLink,
      abandonmentRootDigest: createAbandonmentRootDigest(rootLink),
    })
    return Object.freeze({
      ...claims,
      abandonmentMac: createAbandonmentMac(claims, publicationKey),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAbandonmentError
    ) throw error
    return failAbandonment()
  } finally {
    zeroizeKey(runtimeKey)
    zeroizeKey(publicationKey)
  }
}

/**
 * Verifies one parent-signed abandonment and its exact reservation binding.
 *
 * @param input - Artifact, reservation, selection, and separated keys.
 * @returns Frozen detached authenticated transition.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment(
  input:
    VerifyWorkspaceSearchMigrationRehearsalStageReservationAbandonmentInput,
): WorkspaceSearchMigrationRehearsalStageReservationAbandonment {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    runtimeKey = copyAbandonmentKey(input.runtimeVerificationKey)
    publicationKey = copyAbandonmentKey(input.publicationVerificationKey)
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: input.reservation,
        selection: input.selection,
        verificationKey: runtimeKey,
      })
    requirePublicationKeyMatchesReservation(reservation, publicationKey)
    const record = abandonmentGuards.requireRecord(input.abandonment)
    abandonmentGuards.requireExactKeys(record, abandonmentKeys)
    const claims = readAbandonmentClaims(record)
    if (
      claims.manifestDigest !== reservation.manifestDigest ||
      claims.permitDigest !== reservation.permitDigest ||
      claims.requestedResourcesBinding !==
        reservation.requestedResourcesBinding ||
      claims.stageOrdinal !== reservation.stageOrdinal ||
      claims.parentLivenessProtocol !==
        reservation.parentLivenessProtocol ||
      claims.runtimeKeyFingerprint !==
        createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
          runtimeKey,
        ) ||
      claims.reservationDigest !== createMigrationDigest(reservation) ||
      Date.parse(claims.abandonedAt) <
        readReservationRecoveryDeadline(reservation)
    ) return failAbandonment()
    const abandonmentMac = readDigest(
      abandonmentGuards.readOwn(record, 'abandonmentMac'),
    )
    if (!safeDigestEqual(
      abandonmentMac,
      createAbandonmentMac(claims, publicationKey),
    )) return failAbandonment()
    return Object.freeze({ ...claims, abandonmentMac })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAbandonmentError
    ) throw error
    return failAbandonment()
  } finally {
    zeroizeKey(runtimeKey)
    zeroizeKey(publicationKey)
  }
}

/** Strictly reads and rederives one abandonment claim set. */
function readAbandonmentClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageReservationAbandonmentClaims {
  const record = abandonmentGuards.requireRecord(value)
  abandonmentGuards.requireExactKeys(
    record,
    Object.keys(record).includes('abandonmentMac')
      ? abandonmentKeys
      : abandonmentClaimKeys,
  )
  const kind = abandonmentGuards.readOwn(record, 'kind')
  const abandonmentVersion = abandonmentGuards.readOwn(
    record,
    'abandonmentVersion',
  )
  const reason = abandonmentGuards.readOwn(record, 'reason')
  if (
    kind !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND ||
    abandonmentVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION ||
    reason !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_REASON
  ) return failAbandonment()
  const previousAbandonmentCount = readNonNegativeInteger(
    abandonmentGuards.readOwn(record, 'previousAbandonmentCount'),
  )
  const abandonmentCount = readPositiveInteger(
    abandonmentGuards.readOwn(record, 'abandonmentCount'),
  )
  const reservationClaimRevision = readPositiveInteger(
    abandonmentGuards.readOwn(record, 'reservationClaimRevision'),
  )
  const abandonmentRevision = readPositiveInteger(
    abandonmentGuards.readOwn(record, 'abandonmentRevision'),
  )
  const rootLink = Object.freeze({
    kind,
    abandonmentVersion,
    manifestDigest: readDigest(
      abandonmentGuards.readOwn(record, 'manifestDigest'),
    ),
    permitDigest: readDigest(
      abandonmentGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: readDigest(
      abandonmentGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    stageOrdinal: readPositiveInteger(
      abandonmentGuards.readOwn(record, 'stageOrdinal'),
    ),
    parentLivenessProtocol: readParentLivenessProtocol(
      abandonmentGuards.readOwn(record, 'parentLivenessProtocol'),
    ),
    runtimeKeyFingerprint: readDigest(
      abandonmentGuards.readOwn(record, 'runtimeKeyFingerprint'),
    ),
    runtimeKeyCleanupCompletionDigest: readDigest(
      abandonmentGuards.readOwn(
        record,
        'runtimeKeyCleanupCompletionDigest',
      ),
    ),
    reservationDigest: readDigest(
      abandonmentGuards.readOwn(record, 'reservationDigest'),
    ),
    reservationClaimRevision,
    previousAbandonmentCount,
    previousAbandonmentRootDigest: readDigest(
      abandonmentGuards.readOwn(record, 'previousAbandonmentRootDigest'),
    ),
    abandonmentCount,
    abandonmentRevision,
    abandonedAt: readTimestamp(
      abandonmentGuards.readOwn(record, 'abandonedAt'),
    ),
    reason,
  })
  const abandonmentRootDigest = readDigest(
    abandonmentGuards.readOwn(record, 'abandonmentRootDigest'),
  )
  if (
    abandonmentCount !== previousAbandonmentCount + 1 ||
    abandonmentRevision !== reservationClaimRevision + 1 ||
    abandonmentRootDigest !== createAbandonmentRootDigest(rootLink)
  ) return failAbandonment()
  return Object.freeze({ ...rootLink, abandonmentRootDigest })
}

/** Requires the exact protocol already authenticated by every reservation. */
function readParentLivenessProtocol(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageReservation[
  'parentLivenessProtocol'
] {
  if (
    value !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failAbandonment()
  return value
}

/** Creates the cumulative abandonment-chain successor digest. */
function createAbandonmentRootDigest(link: AbandonmentRootLink): string {
  return createMigrationDigest({
    domain: abandonmentRootDomain,
    link,
  })
}

/** Creates the parent-only HMAC for one exact claim set. */
function createAbandonmentMac(
  claims: WorkspaceSearchMigrationRehearsalStageReservationAbandonmentClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(abandonmentMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Requires the parent key to match the manifest-bound publication digest. */
function requirePublicationKeyMatchesReservation(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  publicationKey: Uint8Array,
): void {
  const digest = createHash('sha256').update(publicationKey).digest('hex')
  if (digest !== reservation.publicationKeyDigest) return failAbandonment()
}

/** Reads an abandonment time not preceding the inclusive recovery deadline. */
function readAbandonmentTime(
  value: unknown,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): string {
  const timestamp = readTimestamp(value)
  if (Date.parse(timestamp) < readReservationRecoveryDeadline(reservation)) {
    return failAbandonment()
  }
  return timestamp
}

/** Returns the deterministic inclusive recovery deadline for a reservation. */
function readReservationRecoveryDeadline(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): number {
  const deadline = Date.parse(reservation.expiresAt) +
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  if (!Number.isSafeInteger(deadline)) return failAbandonment()
  return deadline
}

/** Copies one exact non-Proxy 32-byte authentication key. */
function copyAbandonmentKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== abandonmentKeyBytes
  ) return failAbandonment()
  try {
    const copied = new Uint8Array(abandonmentKeyBytes)
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
    return copied
  } catch {
    return failAbandonment()
  }
}

/** Zeroizes one invocation-owned key copy. */
function zeroizeKey(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Cleanup must not replace the primary authentication outcome.
  }
}

/** Reads one strict lowercase SHA-256 digest. */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failAbandonment()
  return value
}

/** Reads one canonical timestamp. */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failAbandonment()
  return value
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failAbandonment()
  return value
}

/** Reads one nonnegative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failAbandonment()
  return value
}

/** Compares two validated fixed-length lowercase digests. */
function safeDigestEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex'),
  )
}

/** Throws the stable raw-value-free abandonment validation error. */
function failAbandonment(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReservationAbandonmentError()
}
