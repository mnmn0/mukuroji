import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  createWorkspaceSearchMigrationRehearsalStageParentAuthorization,
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
} from './migration-rehearsal-stage-parent-authorization'

/** Returns one deterministic lowercase SHA-256 digest for a fixture label. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns the expected bytes after one 32-byte owned key is consumed. */
function zeroizedKeyBytes(): number[] {
  return Array.from({ length: 32 }, () => 0)
}

/** Creates one mutable complete strict binding for detachment tests. */
function createBinding(publicationKey: Uint8Array) {
  const cleanupBinding = {
    reservationDigest: digest('reservation'),
    manifestDigest: digest('manifest'),
    permitDigest: digest('permit'),
    requestedResourcesBinding: digest('resources'),
    stageOrdinal: 2,
    parentLivenessProtocol:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
    runtimeKeyFingerprint: digest('runtime-key'),
    runtimeFileIdentityDigest: digest('runtime-file'),
    cleanupIntentDigest: digest('cleanup-intent'),
    cleanupCompletionDigest: digest('cleanup-completion'),
    preparedAt: '2026-08-02T00:10:00.000Z',
    completedAt: '2026-08-02T00:10:01.000Z',
  }
  return {
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_KIND,
    authorizationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHORIZATION_VERSION,
    parentAuthenticationDigest: digest('parent-authentication'),
    publicationKeyDigest: createHash('sha256')
      .update(publicationKey)
      .digest('hex'),
    manifestDigest: cleanupBinding.manifestDigest,
    manifestEntryDigest: digest('manifest-entry'),
    previousStageReceiptDigest: digest('previous-receipt'),
    stageOrdinal: cleanupBinding.stageOrdinal,
    materialEvidenceDigest: digest('material-evidence'),
    boundaryMaterialEvidenceDigest: null,
    materialDigest: digest('material'),
    stageReservationDigest: cleanupBinding.reservationDigest,
    claimedStageHeadDigest: digest('claimed-head'),
    lifecycleEvidenceDigest: digest('lifecycle-evidence'),
    lifecycleDigest: digest('lifecycle'),
    faultPlanDigest: null,
    boundaryRateSegmentBytesDigest: null,
    finalRateSegmentBytesDigest: null,
    runtimeKeyCleanupAuthorization: {
      ...cleanupBinding,
      authorizationBindingDigest: createMigrationDigest(cleanupBinding),
    },
  }
}

describe('migration rehearsal stage parent authorization', () => {
  test('seals a deep detached binding and consumes the parent key', () => {
    const publicationKey = new Uint8Array(32).fill(0x31)
    const binding = createBinding(publicationKey)
    const expected = structuredClone(binding)

    const authorization =
      createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        binding,
        publicationAuthenticationKey: publicationKey,
      })

    expect([...publicationKey]).toEqual(zeroizedKeyBytes())
    expect(Object.isFrozen(authorization)).toBe(true)
    binding.materialDigest = digest('mutated-material')
    binding.runtimeKeyCleanupAuthorization.cleanupCompletionDigest =
      digest('mutated-cleanup')
    const detached =
      readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
        authorization,
      )
    expect(serializeCanonicalJson(detached)).toBe(
      serializeCanonicalJson(expected),
    )
    expect(Object.isFrozen(detached)).toBe(true)
    expect(Object.isFrozen(detached.runtimeKeyCleanupAuthorization)).toBe(true)
    expect(authorization.bindingDigest).toBe(createMigrationDigest(detached))
  })

  test('rejects copied, cloned, and proxied capability lookalikes', () => {
    const publicationKey = new Uint8Array(32).fill(0x32)
    const authorization =
      createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        binding: createBinding(publicationKey),
        publicationAuthenticationKey: publicationKey,
      })

    for (const forged of [
      { ...authorization },
      structuredClone(authorization),
      new Proxy(authorization, {}),
    ]) {
      expect(() =>
        readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
          forged,
        )
      ).toThrow('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')
    }
  })

  test('requires the exact parent publication key and zeroizes failures', () => {
    const expectedKey = new Uint8Array(32).fill(0x33)
    const binding = createBinding(expectedKey)
    const wrongKey = new Uint8Array(32).fill(0x34)

    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        binding,
        publicationAuthenticationKey: wrongKey,
      })
    ).toThrow('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')
    expect([...wrongKey]).toEqual(zeroizedKeyBytes())
  })

  test('rejects mutable-shape tricks and inconsistent nested cleanup claims', () => {
    const keyWithExtraField = new Uint8Array(32).fill(0x35)
    const bindingWithExtraField = {
      ...createBinding(keyWithExtraField),
      unexpected: digest('unexpected'),
    }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        binding: bindingWithExtraField,
        publicationAuthenticationKey: keyWithExtraField,
      })
    ).toThrow('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')
    expect([...keyWithExtraField]).toEqual(zeroizedKeyBytes())

    const keyWithInconsistentCleanup = new Uint8Array(32).fill(0x36)
    const bindingWithInconsistentCleanup = createBinding(
      keyWithInconsistentCleanup,
    )
    bindingWithInconsistentCleanup.runtimeKeyCleanupAuthorization = {
      ...bindingWithInconsistentCleanup.runtimeKeyCleanupAuthorization,
      manifestDigest: digest('other-manifest'),
    }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        binding: bindingWithInconsistentCleanup,
        publicationAuthenticationKey: keyWithInconsistentCleanup,
      })
    ).toThrow('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')
    expect([...keyWithInconsistentCleanup]).toEqual(
      zeroizedKeyBytes(),
    )
  })
})
