import { describe, expect, test } from 'bun:test'
import {
  createWorkItemWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import { createAttributeMapDigest } from './dynamodb-attribute-codec'
import { WorkspaceSearchMigrationFailure } from './migration-contract'
import { createAbsentMigrationItemDigest } from './migration-journal'
import {
  createWorkspaceSearchMigrationAbsentSnapshot,
  createWorkspaceSearchMigrationDocumentSnapshot,
  createWorkspaceSearchMigrationExistingSnapshot,
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

describe('Workspace Search migration target snapshots', () => {
  test('encodes the exact native writer shape without lossy coercion', () => {
    const document = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Prepare migration',
      body: 'Preserve exact target state.',
      customFields: {
        approved: true,
        estimate: 3,
        labels: ['migration', 'reviewed'],
      },
      relationIds: ['document:one', 'project:two'],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T01:00:00.000Z',
    })

    const encoded = encodeWorkspaceSearchMigrationDocument(document)

    expect(encoded.workspaceId).toEqual({ S: 'workspace-1' })
    expect(encoded.schemaVersion).toEqual({ N: '1' })
    expect(encoded.customFields).toEqual({
      M: {
        approved: { BOOL: true },
        estimate: { N: '3' },
        labels: {
          L: [
            { S: 'migration' },
            { S: 'reviewed' },
          ],
        },
      },
    })
    expect(encoded.relationIds).toEqual({
      L: [
        { S: 'document:one' },
        { S: 'project:two' },
      ],
    })

    const snapshot = createWorkspaceSearchMigrationDocumentSnapshot(document)
    expect(snapshot).toEqual({
      exists: true,
      item: encoded,
      digest: createAttributeMapDigest(encoded),
    })
    expect(createWorkspaceSearchMigrationExistingSnapshot(encoded))
      .toEqual(snapshot)
  })

  test('revalidates the server-owned projection digest before encoding', () => {
    const document = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Prepare migration',
    })
    const forged = {
      ...document,
      projectionDigest: '0'.repeat(64),
    }

    expect(() => encodeWorkspaceSearchMigrationDocument(forged))
      .toThrow(WorkspaceSearchMigrationFailure)

    const missing = { ...document }
    Reflect.deleteProperty(missing, 'projectionDigest')
    expect(() => encodeWorkspaceSearchMigrationDocument(missing))
      .toThrow(WorkspaceSearchMigrationFailure)

    const undefinedDigest = { ...document }
    Object.defineProperty(undefinedDigest, 'projectionDigest', {
      configurable: true,
      enumerable: true,
      value: undefined,
      writable: true,
    })
    expect(() => encodeWorkspaceSearchMigrationDocument(undefinedDigest))
      .toThrow(WorkspaceSearchMigrationFailure)

    const modified = {
      ...document,
      title: 'Changed after the digest was created',
    }
    expect(() => encodeWorkspaceSearchMigrationDocument(modified))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('rejects native numbers that the live DocumentClient cannot marshal', () => {
    const document = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Prepare migration',
      customFields: {
        unsafe: Number.MAX_SAFE_INTEGER + 1,
      },
    })

    expect(() => encodeWorkspaceSearchMigrationDocument(document))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('deep-clones existing target evidence before fixing its digest', () => {
    const binary = Uint8Array.from([1, 2, 3])
    const nested: Record<string, { S: string }> = {
      label: { S: 'original' },
    }
    const item = {
      workspaceId: { S: 'workspace-1' },
      nested: { M: nested },
      binary: { B: binary },
    }
    const snapshot = createWorkspaceSearchMigrationExistingSnapshot(item)
    if (!snapshot.exists) {
      throw new Error('Expected a present snapshot.')
    }
    const originalDigest = snapshot.digest

    Object.defineProperty(item, 'workspaceId', {
      configurable: true,
      enumerable: true,
      value: { S: 'changed' },
      writable: true,
    })
    nested.label = { S: 'changed' }
    binary[0] = 255

    expect(snapshot.item.workspaceId).toEqual({ S: 'workspace-1' })
    expect(snapshot.item.nested).toEqual({
      M: { label: { S: 'original' } },
    })
    expect(snapshot.item.binary).toEqual({ B: Uint8Array.from([1, 2, 3]) })
    expect(snapshot.digest).toBe(originalDigest)
    expect(createAttributeMapDigest(snapshot.item)).toBe(originalDigest)
  })

  test('uses the shared canonical absent-state digest', () => {
    expect(createWorkspaceSearchMigrationAbsentSnapshot()).toEqual({
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    })
  })
})
