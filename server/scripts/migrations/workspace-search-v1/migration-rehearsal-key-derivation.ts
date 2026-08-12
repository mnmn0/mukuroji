import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'

/** Exact raw byte length of the operator-held rehearsal master key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES = 32

/** Domain separating child/runtime evidence authority from the master key. */
const runtimeKeyDomain =
  'mukuroji:workspace-search-migration:rehearsal-key:runtime:v1'

/** Domain separating parent publication authority from the master key. */
const publicationKeyDomain =
  'mukuroji:workspace-search-migration:rehearsal-key:publication:v1'

/** Fresh purpose-separated rehearsal keys derived from one master key. */
export type WorkspaceSearchMigrationRehearsalDerivedKeys = {
  /** Child-visible key for permits, runtime evidence, manifests, and receipts. */
  readonly runtimeKey: Uint8Array
  /** Digest bound into permits and manifests for runtime-key substitution checks. */
  readonly runtimeKeyDigest: string
  /** Parent-only key for lifecycle authentication and final publication. */
  readonly publicationKey: Uint8Array
  /** Digest bound into permits and manifests for parent-key substitution checks. */
  readonly publicationKeyDigest: string
}

/** Stable failure for malformed master keys or impossible derivation results. */
export class WorkspaceSearchMigrationRehearsalKeyDerivationError
  extends Error {
  /** Creates the sole raw-value-free derivation failure. */
  constructor() {
    super('INVALID_REHEARSAL_MASTER_KEY')
    this.name = 'WorkspaceSearchMigrationRehearsalKeyDerivationError'
  }
}

/**
 * Derives independent runtime and publication keys from one operator master.
 *
 * @param masterKey - Exact non-Proxy 32-byte master key.
 * @returns Fresh mutable key buffers plus their lowercase SHA-256 digests.
 */
export function deriveWorkspaceSearchMigrationRehearsalKeys(
  masterKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalDerivedKeys {
  const master = copyMasterKey(masterKey)
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    runtimeKey = Uint8Array.from(
      createHmac('sha256', master)
        .update(runtimeKeyDomain, 'utf8')
        .digest(),
    )
    publicationKey = Uint8Array.from(
      createHmac('sha256', master)
        .update(publicationKeyDomain, 'utf8')
        .digest(),
    )
    if (
      runtimeKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES ||
      publicationKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES ||
      timingSafeEqual(runtimeKey, publicationKey)
    ) {
      throw new WorkspaceSearchMigrationRehearsalKeyDerivationError()
    }
    return Object.freeze({
      runtimeKey,
      runtimeKeyDigest: createHash('sha256')
        .update(runtimeKey)
        .digest('hex'),
      publicationKey,
      publicationKeyDigest: createHash('sha256')
        .update(publicationKey)
        .digest('hex'),
    })
  } catch (error: unknown) {
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
    if (error instanceof WorkspaceSearchMigrationRehearsalKeyDerivationError) {
      throw error
    }
    throw new WorkspaceSearchMigrationRehearsalKeyDerivationError()
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(master)
  }
}

/**
 * Best-effort zeroizes one owned rehearsal key buffer.
 *
 * @param key - Optional mutable key buffer to erase.
 */
export function zeroizeWorkspaceSearchMigrationRehearsalKey(
  key: Uint8Array | undefined,
): void {
  if (key === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, key, [0])
  } catch {
    // Cleanup must not replace the primary authentication outcome.
  }
}

/** Copies one exact ordinary master key before any cryptographic use. */
function copyMasterKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES
  ) {
    throw new WorkspaceSearchMigrationRehearsalKeyDerivationError()
  }
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(copied) ||
      nodeUtilTypes.isSharedArrayBuffer(copied.buffer) ||
      copied.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES
    ) {
      throw new WorkspaceSearchMigrationRehearsalKeyDerivationError()
    }
    return copied
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalKeyDerivationError) {
      throw error
    }
    throw new WorkspaceSearchMigrationRehearsalKeyDerivationError()
  }
}
