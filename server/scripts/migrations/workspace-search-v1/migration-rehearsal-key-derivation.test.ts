import { describe, expect, test } from 'bun:test'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  WorkspaceSearchMigrationRehearsalKeyDerivationError,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'

describe('Workspace Search rehearsal key derivation', () => {
  test('derives stable purpose-separated keys without mutating the master', () => {
    const master = new Uint8Array(32).fill(0x41)
    const original = Uint8Array.from(master)
    const first = deriveWorkspaceSearchMigrationRehearsalKeys(master)
    const second = deriveWorkspaceSearchMigrationRehearsalKeys(master)

    expect(master).toEqual(original)
    expect(first.runtimeKey).toEqual(second.runtimeKey)
    expect(first.publicationKey).toEqual(second.publicationKey)
    expect(first.runtimeKey).not.toEqual(first.publicationKey)
    expect(first.runtimeKeyDigest).not.toBe(first.publicationKeyDigest)

    zeroizeWorkspaceSearchMigrationRehearsalKey(first.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(first.publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(second.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(second.publicationKey)
  })

  test('rejects SharedArrayBuffer-backed and proxied master keys', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(32))
    const proxied = new Proxy(new Uint8Array(32), {})

    expect(() => deriveWorkspaceSearchMigrationRehearsalKeys(shared))
      .toThrow(WorkspaceSearchMigrationRehearsalKeyDerivationError)
    expect(() => deriveWorkspaceSearchMigrationRehearsalKeys(proxied))
      .toThrow(WorkspaceSearchMigrationRehearsalKeyDerivationError)
  })

  test('changes both derived authorities when the master is substituted', () => {
    const first = deriveWorkspaceSearchMigrationRehearsalKeys(
      new Uint8Array(32).fill(0x11),
    )
    const substituted = deriveWorkspaceSearchMigrationRehearsalKeys(
      new Uint8Array(32).fill(0x12),
    )

    expect(first.runtimeKeyDigest).not.toBe(substituted.runtimeKeyDigest)
    expect(first.publicationKeyDigest)
      .not.toBe(substituted.publicationKeyDigest)

    zeroizeWorkspaceSearchMigrationRehearsalKey(first.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(first.publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(substituted.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(
      substituted.publicationKey,
    )
  })
})
