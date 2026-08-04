import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { createMigrationDigest } from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import type {
  WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for one in-memory parent publication capability. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-parent-authorization'

/** First in-memory parent publication capability contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION =
  1

/** Parent-authenticated projection of one genuine runtime-key cleanup. */
export type WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding =
  WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding & {
    /** Digest of the complete module-private cleanup authorization binding. */
    readonly authorizationBindingDigest: string
  }

/** Secret-free binding proven by one parent-only publication capability. */
export type WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding = {
  /** Fixed parent-authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND
  /** Parent-authorization binding schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION
  /** Digest of the canonical verified parent-authentication record. */
  readonly parentAuthenticationDigest: string
  /** SHA-256 digest of the parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Digest of the runtime-authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the predecessor receipt, or null at global stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Globally contiguous selected stage ordinal. */
  readonly stageOrdinal: number
  /** Digest of the exact parent-persisted material wrapper. */
  readonly materialEvidenceDigest: string
  /** Digest of the separate persisted boundary wrapper, when present. */
  readonly boundaryMaterialEvidenceDigest: string | null
  /** Digest of the exact authenticated child material. */
  readonly materialDigest: string
  /** Digest of the exact authenticated stage reservation. */
  readonly stageReservationDigest: string
  /** Digest of the exact adapter-proven claimed durable head. */
  readonly claimedStageHeadDigest: string
  /** Digest of the exact parent-persisted lifecycle wrapper. */
  readonly lifecycleEvidenceDigest: string
  /** Digest of the normalized parent lifecycle payload. */
  readonly lifecycleDigest: string
  /** Digest of the reviewed fault plan, when present. */
  readonly faultPlanDigest: string | null
  /** SHA-256 of authenticated boundary rate bytes, when present. */
  readonly boundaryRateSegmentBytesDigest: string | null
  /** SHA-256 of authenticated final rate bytes, when present. */
  readonly finalRateSegmentBytesDigest: string | null
  /** Parent-authenticated durable runtime-key cleanup for this stage. */
  readonly runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding
}

/** Opaque process-local proof that parent publication authorization passed. */
export type WorkspaceSearchMigrationRehearsalStageParentAuthorization = {
  /** Fixed parent-authorization discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND
  /** Parent-authorization capability schema version. */
  readonly authorizationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION
  /** Digest of the privately retained verified authorization binding. */
  readonly bindingDigest: string
}

/** Input for sealing one verified binding behind parent-only key possession. */
export type CreateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInput = {
  /** Candidate complete secret-free binding to validate and detach. */
  readonly binding: unknown
  /** Owned parent-only 32-byte key matching the binding publication digest. */
  readonly publicationAuthenticationKey: Uint8Array
}

/** Stable raw-value-free parent-authorization capability failure. */
export class WorkspaceSearchMigrationRehearsalStageParentAuthorizationError
  extends Error {
  /** Stable machine-readable parent-authorization failure code. */
  readonly code = 'INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION'

  /** Creates the sole public parent-authorization capability failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')
    this.name =
      'WorkspaceSearchMigrationRehearsalStageParentAuthorizationError'
  }
}

/** Exact complete top-level binding fields accepted for detachment. */
const parentAuthorizationBindingKeys = Object.freeze([
  'authorizationVersion',
  'boundaryMaterialEvidenceDigest',
  'boundaryRateSegmentBytesDigest',
  'claimedStageHeadDigest',
  'faultPlanDigest',
  'finalRateSegmentBytesDigest',
  'kind',
  'lifecycleDigest',
  'lifecycleEvidenceDigest',
  'manifestDigest',
  'manifestEntryDigest',
  'materialDigest',
  'materialEvidenceDigest',
  'parentAuthenticationDigest',
  'previousStageReceiptDigest',
  'publicationKeyDigest',
  'runtimeKeyCleanupAuthorization',
  'stageOrdinal',
  'stageReservationDigest',
])

/** Exact nested runtime-key cleanup binding fields accepted for detachment. */
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

/** Strict guards mapping malformed inputs to one capability failure. */
const parentAuthorizationGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(failParentAuthorization)

/** Private brand and detached binding shared by creator and reader. */
const stageParentAuthorizationBindings = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding
>()

/** Exact byte length of the parent-only publication key. */
const publicationAuthenticationKeyByteLength = 32

/**
 * Seals one strict detached binding behind proof of parent-key possession.
 *
 * The publication key is transferred to this invocation and overwritten on
 * every path. The retained binding is reconstructed and deeply frozen, so
 * later caller mutation cannot change the authorization's meaning.
 *
 * @param input - Candidate binding and owned parent-only publication key.
 * @returns Genuine process-local capability for the exact detached binding.
 */
export function createWorkspaceSearchMigrationRehearsalStageParentAuthorization(
  input: CreateWorkspaceSearchMigrationRehearsalStageParentAuthorizationInput,
): WorkspaceSearchMigrationRehearsalStageParentAuthorization {
  let publicationAuthenticationKeyValue = readDataValue(
    readDataRecordIfPresent(input),
    'publicationAuthenticationKey',
  )
  let publicationKey: Uint8Array | undefined
  try {
    const inputRecord = parentAuthorizationGuards.requireRecord(input)
    parentAuthorizationGuards.requireExactKeys(inputRecord, [
      'binding',
      'publicationAuthenticationKey',
    ])
    publicationAuthenticationKeyValue = parentAuthorizationGuards.readOwn(
      inputRecord,
      'publicationAuthenticationKey',
    )
    publicationKey = consumeOwnedPublicationKey(
      publicationAuthenticationKeyValue,
    )
    const binding = readDetachedParentAuthorizationBinding(
      parentAuthorizationGuards.readOwn(inputRecord, 'binding'),
    )
    const observedPublicationKeyDigest = createHash('sha256')
      .update(publicationKey)
      .digest('hex')
    if (observedPublicationKeyDigest !== binding.publicationKeyDigest) {
      return failParentAuthorization()
    }
    const capability:
      WorkspaceSearchMigrationRehearsalStageParentAuthorization =
        Object.freeze({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
          authorizationVersion:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
          bindingDigest: createMigrationDigest(binding),
        })
    stageParentAuthorizationBindings.set(capability, binding)
    return capability
  } catch (error) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageParentAuthorizationError
    ) throw error
    return failParentAuthorization()
  } finally {
    zeroizeBytes(publicationKey)
    zeroizeBytes(publicationAuthenticationKeyValue)
  }
}

/**
 * Reads the detached binding from one genuine process-local authorization.
 *
 * @param value - Candidate capability returned by the paired creator.
 * @returns Deeply frozen secret-free parent authorization binding.
 */
export function readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding {
  const record = parentAuthorizationGuards.requireRecord(value)
  const binding = stageParentAuthorizationBindings.get(record)
  if (binding === undefined) return failParentAuthorization()
  return binding
}

/** Reconstructs and deeply freezes one exact parent authorization binding. */
function readDetachedParentAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding {
  const record = parentAuthorizationGuards.requireRecord(value)
  parentAuthorizationGuards.requireExactKeys(
    record,
    parentAuthorizationBindingKeys,
  )
  if (
    parentAuthorizationGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND ||
    parentAuthorizationGuards.readOwn(record, 'authorizationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION
  ) return failParentAuthorization()
  const stageOrdinal = readPositiveStageOrdinal(
    parentAuthorizationGuards.readOwn(record, 'stageOrdinal'),
  )
  const manifestDigest = parentAuthorizationGuards.readDigest(
    parentAuthorizationGuards.readOwn(record, 'manifestDigest'),
  )
  const runtimeKeyCleanupAuthorization =
    readDetachedRuntimeKeyCleanupAuthorizationBinding(
      parentAuthorizationGuards.readOwn(
        record,
        'runtimeKeyCleanupAuthorization',
      ),
    )
  if (
    runtimeKeyCleanupAuthorization.manifestDigest !== manifestDigest ||
    runtimeKeyCleanupAuthorization.stageOrdinal !== stageOrdinal
  ) return failParentAuthorization()
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
    authorizationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
    parentAuthenticationDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(
        record,
        'parentAuthenticationDigest',
      ),
    ),
    publicationKeyDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'publicationKeyDigest'),
    ),
    manifestDigest,
    manifestEntryDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'manifestEntryDigest'),
    ),
    previousStageReceiptDigest: readNullableDigest(
      parentAuthorizationGuards.readOwn(
        record,
        'previousStageReceiptDigest',
      ),
    ),
    stageOrdinal,
    materialEvidenceDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'materialEvidenceDigest'),
    ),
    boundaryMaterialEvidenceDigest: readNullableDigest(
      parentAuthorizationGuards.readOwn(
        record,
        'boundaryMaterialEvidenceDigest',
      ),
    ),
    materialDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'materialDigest'),
    ),
    stageReservationDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'stageReservationDigest'),
    ),
    claimedStageHeadDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'claimedStageHeadDigest'),
    ),
    lifecycleEvidenceDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'lifecycleEvidenceDigest'),
    ),
    lifecycleDigest: parentAuthorizationGuards.readDigest(
      parentAuthorizationGuards.readOwn(record, 'lifecycleDigest'),
    ),
    faultPlanDigest: readNullableDigest(
      parentAuthorizationGuards.readOwn(record, 'faultPlanDigest'),
    ),
    boundaryRateSegmentBytesDigest: readNullableDigest(
      parentAuthorizationGuards.readOwn(
        record,
        'boundaryRateSegmentBytesDigest',
      ),
    ),
    finalRateSegmentBytesDigest: readNullableDigest(
      parentAuthorizationGuards.readOwn(
        record,
        'finalRateSegmentBytesDigest',
      ),
    ),
    runtimeKeyCleanupAuthorization,
  })
}

/** Reconstructs and freezes the nested cleanup authorization binding. */
function readDetachedRuntimeKeyCleanupAuthorizationBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageRuntimeKeyCleanupAuthorizationBinding {
  const record = parentAuthorizationGuards.requireRecord(value)
  parentAuthorizationGuards.requireExactKeys(
    record,
    runtimeKeyCleanupAuthorizationBindingKeys,
  )
  const stageOrdinal = readPositiveStageOrdinal(
    parentAuthorizationGuards.readOwn(record, 'stageOrdinal'),
  )
  if (
    parentAuthorizationGuards.readOwn(record, 'parentLivenessProtocol') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
  ) return failParentAuthorization()
  const preparedAt = parentAuthorizationGuards.readTimestamp(
    parentAuthorizationGuards.readOwn(record, 'preparedAt'),
  )
  const completedAt = parentAuthorizationGuards.readTimestamp(
    parentAuthorizationGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(preparedAt) > Date.parse(completedAt)) {
    return failParentAuthorization()
  }
  const cleanupBinding:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding =
      Object.freeze({
        reservationDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(record, 'reservationDigest'),
        ),
        manifestDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(record, 'manifestDigest'),
        ),
        permitDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(record, 'permitDigest'),
        ),
        requestedResourcesBinding: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(
            record,
            'requestedResourcesBinding',
          ),
        ),
        stageOrdinal,
        parentLivenessProtocol:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
        runtimeKeyFingerprint: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(
            record,
            'runtimeKeyFingerprint',
          ),
        ),
        runtimeFileIdentityDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(
            record,
            'runtimeFileIdentityDigest',
          ),
        ),
        cleanupIntentDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(record, 'cleanupIntentDigest'),
        ),
        cleanupCompletionDigest: parentAuthorizationGuards.readDigest(
          parentAuthorizationGuards.readOwn(
            record,
            'cleanupCompletionDigest',
          ),
        ),
        preparedAt,
        completedAt,
      })
  const authorizationBindingDigest = parentAuthorizationGuards.readDigest(
    parentAuthorizationGuards.readOwn(record, 'authorizationBindingDigest'),
  )
  if (
    authorizationBindingDigest !== createMigrationDigest(cleanupBinding) ||
    cleanupBinding.cleanupIntentDigest ===
      cleanupBinding.cleanupCompletionDigest
  ) return failParentAuthorization()
  return Object.freeze({
    ...cleanupBinding,
    authorizationBindingDigest,
  })
}

/** Reads one lowercase digest or explicit null. */
function readNullableDigest(value: unknown): string | null {
  return value === null
    ? null
    : parentAuthorizationGuards.readDigest(value)
}

/** Reads one positive globally contiguous stage ordinal. */
function readPositiveStageOrdinal(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failParentAuthorization()
  return value
}

/** Copies and immediately overwrites one transferred publication key. */
function consumeOwnedPublicationKey(value: unknown): Uint8Array {
  const owned = readOwnedPublicationKey(value)
  let working: Uint8Array
  try {
    working = new Uint8Array(owned)
  } catch {
    zeroizeBytes(owned)
    return failParentAuthorization()
  }
  zeroizeBytes(owned)
  return working
}

/** Reads one exact ordinary non-shared parent publication key. */
function readOwnedPublicationKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== publicationAuthenticationKeyByteLength
  ) return failParentAuthorization()
  return value
}

/** Best-effort overwrite of one ordinary non-shared byte buffer. */
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

/** Reads an own data property without invoking an accessor. */
function readDataValue(record: object | undefined, key: string): unknown {
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

/** Raises the stable raw-value-free parent-authorization failure. */
function failParentAuthorization(): never {
  throw new WorkspaceSearchMigrationRehearsalStageParentAuthorizationError()
}
