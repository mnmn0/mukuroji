import {
  constants as fsConstants,
  type BigIntStats,
} from 'node:fs'
import {
  link,
  lstat,
  open,
  unlink,
} from 'node:fs/promises'
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-manifest'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Fixed short-lived runtime-key filename shared with the process parent. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME =
  '.stage-runtime.key'

/** Durable cleanup intent created before the first runtime-key byte is zeroed. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME =
  '.stage-runtime-key-cleanup-intent.json'

/** Durable cleanup completion proving fsynced zeroization and directory unlink. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME =
  'stage-runtime-key-cleanup-completion.json'

/** Stable discriminator for one publication-authenticated cleanup intent. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-runtime-key-cleanup-intent'

/** First durable runtime-key cleanup intent contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_VERSION =
  1

/** Stable discriminator for one publication-authenticated cleanup completion. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-runtime-key-cleanup-completion'

/** First durable runtime-key cleanup completion contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_VERSION =
  1

/** Stable discriminator for a genuine same-process cleanup capability. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-runtime-key-cleanup-authorization'

/** First opaque runtime-key cleanup authorization contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_VERSION =
  1

/** Exact runtime-key bytes admitted by the cleanup protocol. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES = 32

/** Maximum canonical bytes accepted for either durable cleanup artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_MAX_BYTES =
  16 * 1_024

/** Domain separating runtime-key fingerprints from every artifact MAC. */
const runtimeKeyFingerprintDomain =
  'mukuroji:workspace-search-migration:rehearsal-runtime-key-fingerprint:v1'

/** Domain separating durable cleanup intent MACs. */
const cleanupIntentMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-runtime-key-cleanup-intent:v1'

/** Domain separating durable cleanup completion MACs. */
const cleanupCompletionMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-runtime-key-cleanup-completion:v1'

/** Security-relevant fixed runtime-file identity hashed into both artifacts. */
type WorkspaceSearchMigrationRehearsalRuntimeFileIdentity = {
  /** Canonical unsigned decimal device identifier from bigint stat. */
  readonly device: string
  /** Canonical unsigned decimal inode identifier from bigint stat. */
  readonly inode: string
  /** Canonical unsigned decimal owner identifier from bigint stat. */
  readonly userId: string
  /** Canonical unsigned decimal permission mode, fixed to 0600. */
  readonly mode: '384'
  /** Canonical unsigned decimal byte size, fixed to 32. */
  readonly size: '32'
  /** Canonical unsigned decimal link count, fixed to one. */
  readonly linkCount: '1'
}

/** Exact publication-authenticated claims written before destructive cleanup. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntentClaims = {
  /** Fixed cleanup-intent discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_KIND
  /** Cleanup-intent schema version. */
  readonly intentVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_VERSION
  /** Digest of the exact runtime-authenticated active reservation. */
  readonly reservationDigest: string
  /** Digest of the exact authenticated stage manifest. */
  readonly manifestDigest: string
  /** Digest of the exact authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Authenticated binding of all requested non-production resources. */
  readonly requestedResourcesBinding: string
  /** Exact global stage ordinal whose key is being erased. */
  readonly stageOrdinal: number
  /** Exact silent parent-liveness protocol bound by the reservation. */
  readonly parentLivenessProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  /** Domain-separated fingerprint of the expected runtime key. */
  readonly runtimeKeyFingerprint: string
  /** Digest of bigint inode identity plus owner, mode, size, and link count. */
  readonly runtimeFileIdentityDigest: string
  /** Canonical trusted time fixed before the first zero write. */
  readonly preparedAt: string
}

/** Complete publication-authenticated durable cleanup intent. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent =
  WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntentClaims & {
    /** Parent-publication-key HMAC over the exact canonical intent claims. */
    readonly intentMac: string
  }

/** Exact publication-authenticated claims written after durable unlink. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletionClaims = {
  /** Fixed cleanup-completion discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_KIND
  /** Cleanup-completion schema version. */
  readonly completionVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_VERSION
  /** Digest of the exact durable cleanup intent. */
  readonly intentDigest: string
  /** Digest of the exact runtime-authenticated active reservation. */
  readonly reservationDigest: string
  /** Digest of the exact authenticated stage manifest. */
  readonly manifestDigest: string
  /** Digest of the exact authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Authenticated binding of all requested non-production resources. */
  readonly requestedResourcesBinding: string
  /** Exact global stage ordinal whose key was erased. */
  readonly stageOrdinal: number
  /** Exact silent parent-liveness protocol used for containment. */
  readonly parentLivenessProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  /** Domain-separated fingerprint of the erased runtime key. */
  readonly runtimeKeyFingerprint: string
  /** Digest of the exact inode identity erased and unlinked. */
  readonly runtimeFileIdentityDigest: string
  /** Canonical trusted time after zero fsync and directory unlink fsync. */
  readonly completedAt: string
}

/** Complete publication-authenticated durable cleanup completion. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletion =
  WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletionClaims & {
    /** Parent-publication-key HMAC over exact canonical completion claims. */
    readonly completionMac: string
  }

/** Secret-free facts retained behind one genuine cleanup capability. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding = {
  /** Digest of the exact authenticated active reservation. */
  readonly reservationDigest: string
  /** Digest of the exact authenticated stage manifest. */
  readonly manifestDigest: string
  /** Digest of the exact authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Authenticated binding of all requested non-production resources. */
  readonly requestedResourcesBinding: string
  /** Exact global stage ordinal owning the erased runtime key. */
  readonly stageOrdinal: number
  /** Exact silent parent-liveness protocol used for containment. */
  readonly parentLivenessProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  /** Domain-separated fingerprint of the erased runtime key. */
  readonly runtimeKeyFingerprint: string
  /** Digest of the exact erased runtime-file inode identity. */
  readonly runtimeFileIdentityDigest: string
  /** Digest of the exact publication-authenticated cleanup intent. */
  readonly cleanupIntentDigest: string
  /** Digest of the exact publication-authenticated cleanup completion. */
  readonly cleanupCompletionDigest: string
  /** Canonical trusted preparation time. */
  readonly preparedAt: string
  /** Canonical trusted durable-completion time. */
  readonly completedAt: string
}

/** Opaque same-process authority proving durable runtime-key cleanup. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization = {
  /** Fixed cleanup-authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_KIND
  /** Cleanup-authorization capability schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_VERSION
  /** Digest of the privately retained complete secret-free binding. */
  readonly bindingDigest: string
}

/** Checkpoints exposed only for deterministic crash-recovery tests. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint =
  | 'intent-artifact-temp-durable'
  | 'intent-artifact-linked'
  | 'intent-artifact-link-durable'
  | 'intent-artifact-temp-unlinked'
  | 'intent-durable'
  | 'runtime-key-zero-progress'
  | 'runtime-key-zero-durable'
  | 'completion-artifact-temp-durable'
  | 'completion-artifact-linked'
  | 'completion-artifact-link-durable'
  | 'completion-artifact-temp-unlinked'
  | 'runtime-key-unlinked'
  | 'completion-durable'

/** Optional deterministic I/O controls used by focused cleanup tests. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupDependencies = {
  /** Maximum bytes offered to each positioned zero write. */
  readonly maximumWriteBytes?: number
  /** Optional synchronous crash injector called after durable checkpoints. */
  readonly onCheckpoint?: (
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint,
  ) => void
}

/** Input for creating or recovering one durable runtime-key cleanup proof. */
export type CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput = {
  /** Owner-only evidence directory containing all three fixed paths. */
  readonly evidenceDirectory: string
  /** Exact active runtime-authenticated reservation. */
  readonly reservation: unknown
  /** Independently authenticated manifest selection for that reservation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact expected runtime key, copied and zeroized internally. */
  readonly expectedRuntimeKey: Uint8Array
  /** Parent-only publication key authenticating both durable artifacts. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Trusted clock sampled at intent creation and after durable unlink. */
  readonly now: () => Date
  /** Optional deterministic partial-write and crash controls for tests. */
  readonly dependencies?:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupDependencies
}

/** Stable raw-value-free runtime-key cleanup failure. */
export class WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError
  extends Error {
  /** Creates the sole stable cleanup failure. */
  constructor() {
    super('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    this.name = 'WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError'
  }
}

/** Exact canonical cleanup intent keys. */
const cleanupIntentClaimKeys = Object.freeze([
  'intentVersion',
  'kind',
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

/** Exact canonical complete cleanup intent keys. */
const cleanupIntentKeys = Object.freeze([
  ...cleanupIntentClaimKeys,
  'intentMac',
])

/** Exact canonical cleanup completion keys. */
const cleanupCompletionClaimKeys = Object.freeze([
  'completedAt',
  'completionVersion',
  'intentDigest',
  'kind',
  'manifestDigest',
  'parentLivenessProtocol',
  'permitDigest',
  'requestedResourcesBinding',
  'reservationDigest',
  'runtimeFileIdentityDigest',
  'runtimeKeyFingerprint',
  'stageOrdinal',
])

/** Exact canonical complete cleanup completion keys. */
const cleanupCompletionKeys = Object.freeze([
  ...cleanupCompletionClaimKeys,
  'completionMac',
])

/** Strict ordinary-record guards for all cleanup trust boundaries. */
const cleanupGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failRuntimeKeyCleanup,
)

/** Private genuine-capability bindings inaccessible to callers. */
const cleanupAuthorizationBindings = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding
>()

/** Private one-shot consumption state preventing authorization replay. */
const consumedCleanupAuthorizations = new WeakSet<object>()

/** Captured, authenticated cleanup construction. */
type PreparedRuntimeKeyCleanup = {
  /** Absolute owner-only evidence directory. */
  readonly evidenceDirectory: string
  /** Fixed absolute runtime-key path. */
  readonly runtimeKeyPath: string
  /** Fixed absolute durable intent path. */
  readonly intentPath: string
  /** Fixed absolute durable completion path. */
  readonly completionPath: string
  /** Authenticated detached reservation. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Invocation-owned exact expected runtime key. */
  readonly runtimeKey: Uint8Array
  /** Invocation-owned parent publication key. */
  readonly publicationKey: Uint8Array
  /** Domain-separated expected runtime-key fingerprint. */
  readonly runtimeKeyFingerprint: string
  /** Captured direct trusted clock sampled only at durable boundaries. */
  readonly now: () => Date
  /** Maximum positioned bytes per zero write. */
  readonly maximumWriteBytes: number
  /** Optional captured crash-injection callback. */
  readonly onCheckpoint: ((
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint,
  ) => void) | undefined
}

/** Open runtime file plus its stable security identity. */
type OpenRuntimeKeyFile = {
  /** Open no-follow read/write file handle. */
  readonly handle: Awaited<ReturnType<typeof open>>
  /** Security-relevant bigint stat identity. */
  readonly identity: WorkspaceSearchMigrationRehearsalRuntimeFileIdentity
  /** Digest of the exact identity. */
  readonly identityDigest: string
}

/** Existence state for one fixed path without following symlinks. */
type CleanupPathState = 'absent' | 'present'

/**
 * Creates the domain-separated fingerprint for one exact runtime key.
 *
 * @param value - Exact ordinary 32-byte runtime key.
 * @returns Lowercase HMAC-SHA-256 fingerprint containing no raw key bytes.
 */
export function createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
  value: Uint8Array,
): string {
  const key = copyCleanupKey(value)
  try {
    return createHmac('sha256', key)
      .update(runtimeKeyFingerprintDomain, 'utf8')
      .digest('hex')
  } finally {
    zeroizeCleanupKey(key)
  }
}

/**
 * Durably erases one fixed runtime key and returns a genuine local capability.
 *
 * A first attempt accepts only the exact expected key before publishing its
 * intent. A retry requires that authenticated intent and permits only expected
 * or already-zero bytes on the same inode. Missing-path ambiguity never
 * authorizes cleanup; only an authenticated completion plus an absent runtime
 * path can remint a capability after a process crash.
 *
 * @param input - Reservation, split keys, fixed directory, clock, and test I/O.
 * @returns Opaque one-shot authorization bound to the durable completion.
 */
export async function cleanupWorkspaceSearchMigrationRehearsalRuntimeKey(
  input: CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization> {
  const prepared = prepareRuntimeKeyCleanup(input)
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let runtimeFile: OpenRuntimeKeyFile | undefined
  try {
    directoryHandle = await openCleanupDirectory(prepared.evidenceDirectory)
    await recoverCleanupArtifactPublication(
      prepared.intentPath,
      directoryHandle,
    )
    await recoverCleanupArtifactPublication(
      prepared.completionPath,
      directoryHandle,
    )
    const intentState = await readCleanupPathState(prepared.intentPath)
    const completionState = await readCleanupPathState(
      prepared.completionPath,
    )
    const runtimeState = await readCleanupPathState(prepared.runtimeKeyPath)

    if (completionState === 'present') {
      if (intentState !== 'present') return failRuntimeKeyCleanup()
      const intent = await readAndVerifyCleanupIntent(prepared)
      const completion = await readAndVerifyCleanupCompletion(
        prepared,
        intent,
      )
      if (runtimeState === 'present') {
        runtimeFile = await openRuntimeKeyFile(
          prepared.runtimeKeyPath,
          intent.runtimeFileIdentityDigest,
        )
        await requireZeroRuntimeBytes(runtimeFile.handle)
        await requireStableRuntimePath(
          prepared.runtimeKeyPath,
          runtimeFile.identity,
        )
        await unlink(prepared.runtimeKeyPath)
        await directoryHandle.sync()
        runCleanupCheckpoint(prepared, 'runtime-key-unlinked')
      }
      return mintRuntimeKeyCleanupAuthorization(intent, completion)
    }
    if (runtimeState !== 'present') return failRuntimeKeyCleanup()

    let intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent
    if (intentState === 'present') {
      intent = await readAndVerifyCleanupIntent(prepared)
      runtimeFile = await openRuntimeKeyFile(
        prepared.runtimeKeyPath,
        intent.runtimeFileIdentityDigest,
      )
      await requireRetryRuntimeBytes(runtimeFile.handle, prepared.runtimeKey)
    } else {
      runtimeFile = await openRuntimeKeyFile(prepared.runtimeKeyPath)
      await requireInitialRuntimeBytes(runtimeFile.handle, prepared.runtimeKey)
      intent = createCleanupIntent(prepared, runtimeFile.identityDigest)
      await writeCleanupArtifactExclusive(
        prepared,
        'intent',
        prepared.intentPath,
        intent,
        directoryHandle,
      )
      runCleanupCheckpoint(prepared, 'intent-durable')
      await requireStableRuntimePath(
        prepared.runtimeKeyPath,
        runtimeFile.identity,
      )
      await requireRetryRuntimeBytes(runtimeFile.handle, prepared.runtimeKey)
    }

    if (runtimeFile.identityDigest !== intent.runtimeFileIdentityDigest) {
      return failRuntimeKeyCleanup()
    }
    await zeroRuntimeKeyFile(prepared, runtimeFile)
    const completion = createCleanupCompletion(
      prepared,
      intent,
      runtimeFile.identityDigest,
    )
    await writeCleanupArtifactExclusive(
      prepared,
      'completion',
      prepared.completionPath,
      completion,
      directoryHandle,
    )
    runCleanupCheckpoint(prepared, 'completion-durable')
    await requireZeroRuntimeBytes(runtimeFile.handle)
    await requireStableRuntimePath(
      prepared.runtimeKeyPath,
      runtimeFile.identity,
    )
    await unlink(prepared.runtimeKeyPath)
    await directoryHandle.sync()
    runCleanupCheckpoint(prepared, 'runtime-key-unlinked')
    return mintRuntimeKeyCleanupAuthorization(intent, completion)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  } finally {
    if (runtimeFile !== undefined) {
      try {
        await runtimeFile.handle.close()
      } catch {
        // The primary cleanup outcome remains authoritative.
      }
    }
    if (directoryHandle !== undefined) {
      try {
        await directoryHandle.close()
      } catch {
        // The primary cleanup outcome remains authoritative.
      }
    }
    zeroizeCleanupKey(prepared.runtimeKey)
    zeroizeCleanupKey(prepared.publicationKey)
  }
}

/**
 * Reads a genuine unconsumed cleanup capability without consuming it.
 *
 * @param value - Candidate capability returned by the cleanup operation.
 * @returns Frozen secret-free binding retained in the module-private WeakMap.
 */
export function readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding {
  const record = cleanupGuards.requireRecord(value)
  if (consumedCleanupAuthorizations.has(record)) {
    return failRuntimeKeyCleanup()
  }
  const binding = cleanupAuthorizationBindings.get(record)
  if (binding === undefined) return failRuntimeKeyCleanup()
  return binding
}

/**
 * Consumes one genuine cleanup capability at the durable AWS CAS boundary.
 *
 * @param value - Candidate same-process cleanup capability.
 * @returns Frozen secret-free binding exactly once.
 */
export function consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding {
  const record = cleanupGuards.requireRecord(value)
  if (consumedCleanupAuthorizations.has(record)) {
    return failRuntimeKeyCleanup()
  }
  const binding = cleanupAuthorizationBindings.get(record)
  if (binding === undefined) return failRuntimeKeyCleanup()
  consumedCleanupAuthorizations.add(record)
  return binding
}

/** Authenticates and captures every cleanup input before filesystem I/O. */
function prepareRuntimeKeyCleanup(
  input: CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
): PreparedRuntimeKeyCleanup {
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const record = cleanupGuards.requireRecord(input)
    const hasDependencies = Object.keys(record).includes('dependencies')
    cleanupGuards.requireExactKeys(record, hasDependencies
      ? [
          'dependencies',
          'evidenceDirectory',
          'expectedRuntimeKey',
          'now',
          'publicationAuthenticationKey',
          'reservation',
          'selection',
        ]
      : [
          'evidenceDirectory',
          'expectedRuntimeKey',
          'now',
          'publicationAuthenticationKey',
          'reservation',
          'selection',
        ])
    runtimeKey = copyCleanupKey(
      cleanupGuards.readOwn(record, 'expectedRuntimeKey'),
    )
    publicationKey = copyCleanupKey(
      cleanupGuards.readOwn(record, 'publicationAuthenticationKey'),
    )
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: cleanupGuards.readOwn(record, 'reservation'),
        selection: requireCleanupSelection(input.selection),
        verificationKey: runtimeKey,
      })
    requireCleanupKeyBindings(reservation, runtimeKey, publicationKey)
    const evidenceDirectory = readCleanupPath(
      cleanupGuards.readOwn(record, 'evidenceDirectory'),
    )
    const now = readCleanupClock(input.now)
    const dependencies = hasDependencies && input.dependencies !== undefined
      ? readCleanupDependencies(input.dependencies)
      : Object.freeze({
          maximumWriteBytes:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES,
          onCheckpoint: undefined,
        })
    const runtimeKeyFingerprint = createHmac('sha256', runtimeKey)
      .update(runtimeKeyFingerprintDomain, 'utf8')
      .digest('hex')
    const prepared = Object.freeze({
      evidenceDirectory,
      runtimeKeyPath: join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      intentPath: join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
      ),
      completionPath: join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
      ),
      reservation,
      runtimeKey,
      publicationKey,
      runtimeKeyFingerprint,
      now,
      maximumWriteBytes: dependencies.maximumWriteBytes,
      onCheckpoint: dependencies.onCheckpoint,
    })
    runtimeKey = undefined
    publicationKey = undefined
    return prepared
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  } finally {
    zeroizeCleanupKey(runtimeKey)
    zeroizeCleanupKey(publicationKey)
  }
}

/** Requires one selected-stage ordinary record without invoking accessors. */
function requireCleanupSelection(
  value: WorkspaceSearchMigrationRehearsalSelectedStage,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const record = cleanupGuards.requireRecord(value)
  cleanupGuards.requireExactKeys(record, [
    'entry',
    'manifest',
    'manifestDigest',
    'previousStageReceiptDigest',
  ])
  return value
}

/** Reads and captures optional deterministic cleanup controls. */
function readCleanupDependencies(
  value: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupDependencies,
): {
  /** Positive positioned-write ceiling. */
  readonly maximumWriteBytes: number
  /** Optional direct crash callback. */
  readonly onCheckpoint: ((
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint,
  ) => void) | undefined
} {
  const record = cleanupGuards.requireRecord(value)
  const keys = Object.keys(record)
  if (
    keys.some((key) =>
      key !== 'maximumWriteBytes' && key !== 'onCheckpoint'
    )
  ) return failRuntimeKeyCleanup()
  cleanupGuards.requireExactKeys(record, keys)
  const maximumWriteBytesValue = keys.includes('maximumWriteBytes')
    ? value.maximumWriteBytes
    : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES
  if (
    typeof maximumWriteBytesValue !== 'number' ||
    !Number.isSafeInteger(maximumWriteBytesValue) ||
    maximumWriteBytesValue <= 0 ||
    maximumWriteBytesValue >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES
  ) return failRuntimeKeyCleanup()
  const onCheckpointValue = keys.includes('onCheckpoint')
    ? value.onCheckpoint
    : undefined
  if (
    onCheckpointValue !== undefined &&
    (typeof onCheckpointValue !== 'function' ||
      nodeUtilTypes.isProxy(onCheckpointValue))
  ) return failRuntimeKeyCleanup()
  return Object.freeze({
    maximumWriteBytes: maximumWriteBytesValue,
    onCheckpoint: onCheckpointValue,
  })
}

/** Requires split keys to match the authenticated reservation digests. */
function requireCleanupKeyBindings(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): void {
  const runtimeDigest = createHash('sha256')
    .update(runtimeKey)
    .digest('hex')
  const publicationDigest = createHash('sha256')
    .update(publicationKey)
    .digest('hex')
  if (
    runtimeDigest !== reservation.evidenceKeyDigest ||
    publicationDigest !== reservation.publicationKeyDigest ||
    reservation.parentLivenessProtocol !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failRuntimeKeyCleanup()
}

/** Opens and validates the fixed owner-only evidence directory. */
async function openCleanupDirectory(
  directoryPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      directoryPath,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    )
    const metadata = await handle.stat({ bigint: true })
    const pathMetadata = await lstat(directoryPath, { bigint: true })
    if (
      !metadata.isDirectory() ||
      !pathMetadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      pathMetadata.isSymbolicLink() ||
      (metadata.mode & 0o7777n) !== 0o700n ||
      !sameInode(metadata, pathMetadata) ||
      !isCurrentOwner(metadata.uid) ||
      metadata.nlink < 1n
    ) return failRuntimeKeyCleanup()
    return handle
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The stable validation failure remains authoritative.
      }
    }
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  }
}

/** Reads path existence without following a final symlink. */
async function readCleanupPathState(
  path: string,
): Promise<CleanupPathState> {
  try {
    await lstat(path, { bigint: true })
    return 'present'
  } catch (error: unknown) {
    if (isFileSystemErrorCode(error, 'ENOENT')) return 'absent'
    return failRuntimeKeyCleanup()
  }
}

/** Opens the fixed runtime key no-follow and validates its exact identity. */
async function openRuntimeKeyFile(
  path: string,
  expectedIdentityDigest?: string,
): Promise<OpenRuntimeKeyFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      path,
      fsConstants.O_NOFOLLOW | fsConstants.O_RDWR,
    )
    const metadata = await handle.stat({ bigint: true })
    const identity = readRuntimeFileIdentity(metadata)
    const identityDigest = createMigrationDigest(identity)
    if (
      expectedIdentityDigest !== undefined &&
      identityDigest !== expectedIdentityDigest
    ) return failRuntimeKeyCleanup()
    await requireStableRuntimePath(path, identity)
    return Object.freeze({ handle, identity, identityDigest })
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The stable validation failure remains authoritative.
      }
    }
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  }
}

/** Reads and validates the exact security identity from bigint fstat. */
function readRuntimeFileIdentity(
  metadata: BigIntStats,
): WorkspaceSearchMigrationRehearsalRuntimeFileIdentity {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev < 0n ||
    metadata.ino <= 0n ||
    metadata.uid < 0n ||
    !isCurrentOwner(metadata.uid) ||
    (metadata.mode & 0o7777n) !== 0o600n ||
    metadata.size !==
      BigInt(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES) ||
    metadata.nlink !== 1n
  ) return failRuntimeKeyCleanup()
  return Object.freeze({
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    userId: metadata.uid.toString(10),
    mode: '384',
    size: '32',
    linkCount: '1',
  })
}

/** Requires the fixed path still names the exact opened runtime inode. */
async function requireStableRuntimePath(
  path: string,
  identity: WorkspaceSearchMigrationRehearsalRuntimeFileIdentity,
): Promise<void> {
  let metadata: BigIntStats
  try {
    metadata = await lstat(path, { bigint: true })
  } catch {
    return failRuntimeKeyCleanup()
  }
  const pathIdentity = readRuntimeFileIdentity(metadata)
  if (
    serializeCanonicalJson(pathIdentity) !== serializeCanonicalJson(identity)
  ) return failRuntimeKeyCleanup()
}

/** Requires a first-attempt runtime file to contain the exact expected key. */
async function requireInitialRuntimeBytes(
  handle: Awaited<ReturnType<typeof open>>,
  expected: Uint8Array,
): Promise<void> {
  const bytes = await readExactRuntimeBytes(handle)
  try {
    if (!timingSafeEqual(bytes, expected)) return failRuntimeKeyCleanup()
  } finally {
    zeroizeCleanupKey(bytes)
  }
}

/** Requires retry bytes to be independently expected or already zero. */
async function requireRetryRuntimeBytes(
  handle: Awaited<ReturnType<typeof open>>,
  expected: Uint8Array,
): Promise<void> {
  const bytes = await readExactRuntimeBytes(handle)
  try {
    for (
      let index = 0;
      index < WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES;
      index += 1
    ) {
      const byte = bytes[index]
      if (byte !== 0 && byte !== expected[index]) {
        return failRuntimeKeyCleanup()
      }
    }
  } finally {
    zeroizeCleanupKey(bytes)
  }
}

/** Requires a completion-backed runtime inode to contain exactly zero bytes. */
async function requireZeroRuntimeBytes(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const bytes = await readExactRuntimeBytes(handle)
  try {
    const zeroes = new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES,
    )
    try {
      if (!timingSafeEqual(bytes, zeroes)) return failRuntimeKeyCleanup()
    } finally {
      zeroizeCleanupKey(zeroes)
    }
  } finally {
    zeroizeCleanupKey(bytes)
  }
}

/** Reads exactly 32 positioned bytes and rejects truncation or drift. */
async function readExactRuntimeBytes(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES,
  )
  let offset = 0
  try {
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (result.bytesRead <= 0) return failRuntimeKeyCleanup()
      offset += result.bytesRead
    }
    const metadata = await handle.stat({ bigint: true })
    readRuntimeFileIdentity(metadata)
    return bytes
  } catch (error: unknown) {
    zeroizeCleanupKey(bytes)
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  }
}

/** Performs the partial-write-safe positioned zeroization and fsync. */
async function zeroRuntimeKeyFile(
  prepared: PreparedRuntimeKeyCleanup,
  runtimeFile: OpenRuntimeKeyFile,
): Promise<void> {
  const zeroes = new Uint8Array(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES,
  )
  let offset = 0
  try {
    while (offset < zeroes.byteLength) {
      const offered = Math.min(
        prepared.maximumWriteBytes,
        zeroes.byteLength - offset,
      )
      const result = await runtimeFile.handle.write(
        zeroes,
        offset,
        offered,
        offset,
      )
      if (result.bytesWritten <= 0 || result.bytesWritten > offered) {
        return failRuntimeKeyCleanup()
      }
      offset += result.bytesWritten
      runCleanupCheckpoint(prepared, 'runtime-key-zero-progress')
    }
    await runtimeFile.handle.sync()
    const metadata = await runtimeFile.handle.stat({ bigint: true })
    const identity = readRuntimeFileIdentity(metadata)
    if (
      serializeCanonicalJson(identity) !==
        serializeCanonicalJson(runtimeFile.identity)
    ) return failRuntimeKeyCleanup()
    await requireStableRuntimePath(
      prepared.runtimeKeyPath,
      runtimeFile.identity,
    )
    runCleanupCheckpoint(prepared, 'runtime-key-zero-durable')
  } finally {
    zeroizeCleanupKey(zeroes)
  }
}

/** Creates one exact intent after the initial expected-key verification. */
function createCleanupIntent(
  prepared: PreparedRuntimeKeyCleanup,
  runtimeFileIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent {
  const claims = Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_KIND,
    intentVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_VERSION,
    reservationDigest: createMigrationDigest(prepared.reservation),
    manifestDigest: prepared.reservation.manifestDigest,
    permitDigest: prepared.reservation.permitDigest,
    requestedResourcesBinding:
      prepared.reservation.requestedResourcesBinding,
    stageOrdinal: prepared.reservation.stageOrdinal,
    parentLivenessProtocol:
      prepared.reservation.parentLivenessProtocol,
    runtimeKeyFingerprint: prepared.runtimeKeyFingerprint,
    runtimeFileIdentityDigest,
    preparedAt: readCleanupBoundaryTime(
      prepared.now,
      prepared.reservation.reservedAt,
    ),
  })
  return Object.freeze({
    ...claims,
    intentMac: createCleanupMac(
      cleanupIntentMacDomain,
      claims,
      prepared.publicationKey,
    ),
  })
}

/** Creates one exact completion after durable zeroization and unlink. */
function createCleanupCompletion(
  prepared: PreparedRuntimeKeyCleanup,
  intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent,
  runtimeFileIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletion {
  if (runtimeFileIdentityDigest !== intent.runtimeFileIdentityDigest) {
    return failRuntimeKeyCleanup()
  }
  const claims = Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_KIND,
    completionVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_VERSION,
    intentDigest: createMigrationDigest(intent),
    reservationDigest: intent.reservationDigest,
    manifestDigest: intent.manifestDigest,
    permitDigest: intent.permitDigest,
    requestedResourcesBinding: intent.requestedResourcesBinding,
    stageOrdinal: intent.stageOrdinal,
    parentLivenessProtocol: intent.parentLivenessProtocol,
    runtimeKeyFingerprint: intent.runtimeKeyFingerprint,
    runtimeFileIdentityDigest,
    completedAt: readCleanupBoundaryTime(
      prepared.now,
      intent.preparedAt,
    ),
  })
  if (Date.parse(claims.completedAt) < Date.parse(intent.preparedAt)) {
    return failRuntimeKeyCleanup()
  }
  return Object.freeze({
    ...claims,
    completionMac: createCleanupMac(
      cleanupCompletionMacDomain,
      claims,
      prepared.publicationKey,
    ),
  })
}

/** Reads, parses, authenticates, and reservation-binds a durable intent. */
async function readAndVerifyCleanupIntent(
  prepared: PreparedRuntimeKeyCleanup,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent> {
  const candidate = await readCanonicalCleanupArtifact(prepared.intentPath)
  const record = cleanupGuards.requireRecord(candidate)
  cleanupGuards.requireExactKeys(record, cleanupIntentKeys)
  const claims = readCleanupIntentClaims(record)
  requireIntentMatchesPrepared(claims, prepared)
  const intentMac = cleanupGuards.readDigest(
    cleanupGuards.readOwn(record, 'intentMac'),
  )
  if (!safeCleanupDigestEqual(
    intentMac,
    createCleanupMac(
      cleanupIntentMacDomain,
      claims,
      prepared.publicationKey,
    ),
  )) return failRuntimeKeyCleanup()
  return Object.freeze({ ...claims, intentMac })
}

/** Reads and validates exact cleanup intent claims. */
function readCleanupIntentClaims(
  value: object,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntentClaims {
  const kind = cleanupGuards.readOwn(value, 'kind')
  const intentVersion = cleanupGuards.readOwn(value, 'intentVersion')
  if (
    kind !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_KIND ||
    intentVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_VERSION
  ) return failRuntimeKeyCleanup()
  return Object.freeze({
    kind,
    intentVersion,
    reservationDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'reservationDigest'),
    ),
    manifestDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'manifestDigest'),
    ),
    permitDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'permitDigest'),
    ),
    requestedResourcesBinding: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'requestedResourcesBinding'),
    ),
    stageOrdinal: readCleanupPositiveInteger(
      cleanupGuards.readOwn(value, 'stageOrdinal'),
    ),
    parentLivenessProtocol: readCleanupParentLivenessProtocol(
      cleanupGuards.readOwn(value, 'parentLivenessProtocol'),
    ),
    runtimeKeyFingerprint: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'runtimeKeyFingerprint'),
    ),
    runtimeFileIdentityDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'runtimeFileIdentityDigest'),
    ),
    preparedAt: cleanupGuards.readTimestamp(
      cleanupGuards.readOwn(value, 'preparedAt'),
    ),
  })
}

/** Requires every durable intent binding to match this invocation. */
function requireIntentMatchesPrepared(
  intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntentClaims,
  prepared: PreparedRuntimeKeyCleanup,
): void {
  const reservation = prepared.reservation
  if (
    intent.reservationDigest !== createMigrationDigest(reservation) ||
    intent.manifestDigest !== reservation.manifestDigest ||
    intent.permitDigest !== reservation.permitDigest ||
    intent.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    intent.stageOrdinal !== reservation.stageOrdinal ||
    intent.parentLivenessProtocol !== reservation.parentLivenessProtocol ||
    intent.runtimeKeyFingerprint !== prepared.runtimeKeyFingerprint
  ) return failRuntimeKeyCleanup()
}

/** Reads, authenticates, and intent-binds one durable completion. */
async function readAndVerifyCleanupCompletion(
  prepared: PreparedRuntimeKeyCleanup,
  intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletion> {
  const candidate = await readCanonicalCleanupArtifact(
    prepared.completionPath,
  )
  const record = cleanupGuards.requireRecord(candidate)
  cleanupGuards.requireExactKeys(record, cleanupCompletionKeys)
  const claims = readCleanupCompletionClaims(record)
  requireCompletionMatchesIntent(claims, intent)
  const completionMac = cleanupGuards.readDigest(
    cleanupGuards.readOwn(record, 'completionMac'),
  )
  if (!safeCleanupDigestEqual(
    completionMac,
    createCleanupMac(
      cleanupCompletionMacDomain,
      claims,
      prepared.publicationKey,
    ),
  )) return failRuntimeKeyCleanup()
  return Object.freeze({ ...claims, completionMac })
}

/** Reads and validates exact cleanup-completion claims. */
function readCleanupCompletionClaims(
  value: object,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletionClaims {
  const kind = cleanupGuards.readOwn(value, 'kind')
  const completionVersion = cleanupGuards.readOwn(
    value,
    'completionVersion',
  )
  if (
    kind !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_KIND ||
    completionVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_VERSION
  ) return failRuntimeKeyCleanup()
  return Object.freeze({
    kind,
    completionVersion,
    intentDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'intentDigest'),
    ),
    reservationDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'reservationDigest'),
    ),
    manifestDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'manifestDigest'),
    ),
    permitDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'permitDigest'),
    ),
    requestedResourcesBinding: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'requestedResourcesBinding'),
    ),
    stageOrdinal: readCleanupPositiveInteger(
      cleanupGuards.readOwn(value, 'stageOrdinal'),
    ),
    parentLivenessProtocol: readCleanupParentLivenessProtocol(
      cleanupGuards.readOwn(value, 'parentLivenessProtocol'),
    ),
    runtimeKeyFingerprint: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'runtimeKeyFingerprint'),
    ),
    runtimeFileIdentityDigest: cleanupGuards.readDigest(
      cleanupGuards.readOwn(value, 'runtimeFileIdentityDigest'),
    ),
    completedAt: cleanupGuards.readTimestamp(
      cleanupGuards.readOwn(value, 'completedAt'),
    ),
  })
}

/** Requires one completion to be the exact successor of its durable intent. */
function requireCompletionMatchesIntent(
  completion:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletionClaims,
  intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent,
): void {
  if (
    completion.intentDigest !== createMigrationDigest(intent) ||
    completion.reservationDigest !== intent.reservationDigest ||
    completion.manifestDigest !== intent.manifestDigest ||
    completion.permitDigest !== intent.permitDigest ||
    completion.requestedResourcesBinding !==
      intent.requestedResourcesBinding ||
    completion.stageOrdinal !== intent.stageOrdinal ||
    completion.parentLivenessProtocol !== intent.parentLivenessProtocol ||
    completion.runtimeKeyFingerprint !== intent.runtimeKeyFingerprint ||
    completion.runtimeFileIdentityDigest !==
      intent.runtimeFileIdentityDigest ||
    Date.parse(completion.completedAt) < Date.parse(intent.preparedAt)
  ) return failRuntimeKeyCleanup()
}

/**
 * Publishes one canonical artifact without exposing a partial final path.
 *
 * The fixed sibling temporary path is fsynced before an exclusive hard-link
 * publication. Both the link addition and temporary-link removal are directory
 * synced, so every interruption leaves either a removable temporary inode or a
 * complete final inode that recovery can normalize without trusting its bytes.
 */
async function writeCleanupArtifactExclusive(
  prepared: PreparedRuntimeKeyCleanup,
  artifactKind: 'intent' | 'completion',
  path: string,
  artifact: unknown,
  directoryHandle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(artifact))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_MAX_BYTES
  ) return failRuntimeKeyCleanup()
  const temporaryPath = cleanupArtifactTemporaryPath(path)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    const metadata = await handle.stat({ bigint: true })
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !isCurrentOwner(metadata.uid) ||
      (metadata.mode & 0o7777n) !== 0o600n ||
      metadata.nlink !== 1n ||
      metadata.size !== 0n
    ) return failRuntimeKeyCleanup()
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (result.bytesWritten <= 0) return failRuntimeKeyCleanup()
      offset += result.bytesWritten
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    runCleanupArtifactCheckpoint(
      prepared,
      artifactKind,
      'temp-durable',
    )
    await link(temporaryPath, path)
    runCleanupArtifactCheckpoint(prepared, artifactKind, 'linked')
    await directoryHandle.sync()
    runCleanupArtifactCheckpoint(
      prepared,
      artifactKind,
      'link-durable',
    )
    await unlink(temporaryPath)
    runCleanupArtifactCheckpoint(
      prepared,
      artifactKind,
      'temp-unlinked',
    )
    await directoryHandle.sync()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  } finally {
    zeroizeCleanupKey(bytes)
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The stable artifact-publication failure remains authoritative.
      }
    }
  }
}

/**
 * Normalizes the only recoverable fixed temporary-publication states.
 *
 * A temporary-only inode was never visible at the final path and is safe to
 * discard. A final-plus-temporary pair must be the same complete two-link inode;
 * removing the temporary name completes the already atomic publication.
 */
async function recoverCleanupArtifactPublication(
  path: string,
  directoryHandle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const temporaryPath = cleanupArtifactTemporaryPath(path)
  const finalState = await readCleanupPathState(path)
  const temporaryState = await readCleanupPathState(temporaryPath)
  if (temporaryState === 'absent') return

  let temporaryMetadata: BigIntStats
  try {
    temporaryMetadata = await lstat(temporaryPath, { bigint: true })
  } catch {
    return failRuntimeKeyCleanup()
  }
  requireCleanupArtifactPublicationMetadata(temporaryMetadata)

  if (finalState === 'absent') {
    if (temporaryMetadata.nlink !== 1n) return failRuntimeKeyCleanup()
    await unlink(temporaryPath)
    await directoryHandle.sync()
    return
  }

  let finalMetadata: BigIntStats
  try {
    finalMetadata = await lstat(path, { bigint: true })
  } catch {
    return failRuntimeKeyCleanup()
  }
  requireCleanupArtifactPublicationMetadata(finalMetadata)
  if (
    temporaryMetadata.nlink !== 2n ||
    finalMetadata.nlink !== 2n ||
    !sameInode(temporaryMetadata, finalMetadata) ||
    !sameCompleteStat(temporaryMetadata, finalMetadata)
  ) return failRuntimeKeyCleanup()
  await unlink(temporaryPath)
  await directoryHandle.sync()
}

/** Requires secure bounded metadata for a cleanup publication inode. */
function requireCleanupArtifactPublicationMetadata(
  metadata: BigIntStats,
): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !isCurrentOwner(metadata.uid) ||
    (metadata.mode & 0o7777n) !== 0o600n ||
    metadata.size < 0n ||
    metadata.size >
      BigInt(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_MAX_BYTES,
      ) ||
    (metadata.nlink !== 1n && metadata.nlink !== 2n)
  ) return failRuntimeKeyCleanup()
}

/** Returns the fixed sibling temporary path reserved by this protocol. */
function cleanupArtifactTemporaryPath(path: string): string {
  return `${path}.tmp`
}

/** Calls the exact artifact-phase crash checkpoint without dynamic casting. */
function runCleanupArtifactCheckpoint(
  prepared: PreparedRuntimeKeyCleanup,
  artifactKind: 'intent' | 'completion',
  phase: 'temp-durable' | 'linked' | 'link-durable' | 'temp-unlinked',
): void {
  if (artifactKind === 'intent') {
    if (phase === 'temp-durable') {
      runCleanupCheckpoint(prepared, 'intent-artifact-temp-durable')
    } else if (phase === 'linked') {
      runCleanupCheckpoint(prepared, 'intent-artifact-linked')
    } else if (phase === 'link-durable') {
      runCleanupCheckpoint(prepared, 'intent-artifact-link-durable')
    } else {
      runCleanupCheckpoint(prepared, 'intent-artifact-temp-unlinked')
    }
    return
  }
  if (phase === 'temp-durable') {
    runCleanupCheckpoint(prepared, 'completion-artifact-temp-durable')
  } else if (phase === 'linked') {
    runCleanupCheckpoint(prepared, 'completion-artifact-linked')
  } else if (phase === 'link-durable') {
    runCleanupCheckpoint(prepared, 'completion-artifact-link-durable')
  } else {
    runCleanupCheckpoint(prepared, 'completion-artifact-temp-unlinked')
  }
}

/** Securely reads one canonical owner-only cleanup artifact. */
async function readCanonicalCleanupArtifact(
  path: string,
): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let bytes: Uint8Array | undefined
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    const metadata = await handle.stat({ bigint: true })
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !isCurrentOwner(metadata.uid) ||
      (metadata.mode & 0o7777n) !== 0o600n ||
      metadata.nlink !== 1n ||
      metadata.size <= 0n ||
      metadata.size >
        BigInt(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_MAX_BYTES,
        )
    ) return failRuntimeKeyCleanup()
    const pathMetadata = await lstat(path, { bigint: true })
    if (!sameInode(metadata, pathMetadata)) return failRuntimeKeyCleanup()
    const byteLength = Number(metadata.size)
    bytes = new Uint8Array(byteLength)
    let offset = 0
    while (offset < byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        byteLength - offset,
        offset,
      )
      if (result.bytesRead <= 0) return failRuntimeKeyCleanup()
      offset += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(path, { bigint: true })
    if (
      !sameCompleteStat(metadata, after) ||
      !sameInode(after, afterPath)
    ) return failRuntimeKeyCleanup()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    if (serializeCanonicalJson(candidate) !== text) {
      return failRuntimeKeyCleanup()
    }
    return candidate
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError) {
      throw error
    }
    return failRuntimeKeyCleanup()
  } finally {
    zeroizeCleanupKey(bytes)
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The stable artifact-read outcome remains authoritative.
      }
    }
  }
}

/** Creates and registers a new genuine unconsumed cleanup capability. */
function mintRuntimeKeyCleanupAuthorization(
  intent: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupIntent,
  completion: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCompletion,
): WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization {
  const binding = Object.freeze({
    reservationDigest: completion.reservationDigest,
    manifestDigest: completion.manifestDigest,
    permitDigest: completion.permitDigest,
    requestedResourcesBinding: completion.requestedResourcesBinding,
    stageOrdinal: completion.stageOrdinal,
    parentLivenessProtocol: completion.parentLivenessProtocol,
    runtimeKeyFingerprint: completion.runtimeKeyFingerprint,
    runtimeFileIdentityDigest: completion.runtimeFileIdentityDigest,
    cleanupIntentDigest: completion.intentDigest,
    cleanupCompletionDigest: createMigrationDigest(completion),
    preparedAt: intent.preparedAt,
    completedAt: completion.completedAt,
  })
  const authorization = Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_KIND,
    authorizationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_AUTHORIZATION_VERSION,
    bindingDigest: createMigrationDigest(binding),
  })
  cleanupAuthorizationBindings.set(authorization, binding)
  return authorization
}

/** Creates one domain-separated HMAC over exact canonical artifact claims. */
function createCleanupMac(
  domain: string,
  claims: unknown,
  publicationKey: Uint8Array,
): string {
  return createHmac('sha256', publicationKey)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Calls an optional deterministic crash checkpoint directly. */
function runCleanupCheckpoint(
  prepared: PreparedRuntimeKeyCleanup,
  checkpoint: WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint,
): void {
  const callback = prepared.onCheckpoint
  if (callback !== undefined) Reflect.apply(callback, undefined, [checkpoint])
}

/** Reads one bounded path and resolves it before fixed-name construction. */
function readCleanupPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.length > 4_096
  ) return failRuntimeKeyCleanup()
  const path = resolve(value)
  if (dirname(join(path, 'child')) !== path) return failRuntimeKeyCleanup()
  return path
}

/** Captures one direct trusted cleanup clock before filesystem I/O. */
function readCleanupClock(value: () => Date): () => Date {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failRuntimeKeyCleanup()
  }
  return value
}

/** Samples one trusted boundary time and enforces a monotonic floor. */
function readCleanupBoundaryTime(
  now: () => Date,
  inclusiveFloor: string,
): string {
  let value: unknown
  try {
    value = Reflect.apply(now, undefined, [])
  } catch {
    return failRuntimeKeyCleanup()
  }
  if (
    !(value instanceof Date) ||
    nodeUtilTypes.isProxy(value) ||
    !Number.isFinite(value.getTime())
  ) return failRuntimeKeyCleanup()
  const timestamp = value.toISOString()
  if (Date.parse(timestamp) < Date.parse(inclusiveFloor)) {
    return failRuntimeKeyCleanup()
  }
  return timestamp
}

/** Reads one positive safe integer. */
function readCleanupPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failRuntimeKeyCleanup()
  return value
}

/** Requires the sole reviewed parent-liveness protocol. */
function readCleanupParentLivenessProtocol(
  value: unknown,
): typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL {
  if (
    value !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failRuntimeKeyCleanup()
  return value
}

/** Copies one exact ordinary non-shared 32-byte cleanup key. */
function copyCleanupKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES
  ) return failRuntimeKeyCleanup()
  try {
    const copied: unknown = Reflect.apply(Uint8Array.prototype.slice, value, [])
    if (
      !(copied instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(copied) ||
      nodeUtilTypes.isSharedArrayBuffer(copied.buffer) ||
      copied.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_BYTES
    ) return failRuntimeKeyCleanup()
    return copied
  } catch {
    return failRuntimeKeyCleanup()
  }
}

/** Best-effort zeroizes one invocation-owned byte buffer. */
function zeroizeCleanupKey(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Cleanup must not replace the primary operation outcome.
  }
}

/** Requires one bigint stat owner to equal the current effective user. */
function isCurrentOwner(userId: bigint): boolean {
  if (typeof process.getuid !== 'function') return false
  return userId === BigInt(process.getuid())
}

/** Compares the inode identity of two bigint stat snapshots. */
function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Compares every security-sensitive stat field across one stable read. */
function sameCompleteStat(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
}

/** Compares two validated fixed-length lowercase digests. */
function safeCleanupDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) {
    return failRuntimeKeyCleanup()
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Checks one ordinary filesystem error code without surfacing raw paths. */
function isFileSystemErrorCode(error: unknown, code: string): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === code
}

/** Throws the stable raw-value-free runtime-key cleanup error. */
function failRuntimeKeyCleanup(): never {
  throw new WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupError()
}
