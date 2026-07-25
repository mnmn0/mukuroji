import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  type WorkspaceSearchJournalSegment,
  WorkspaceSearchMigrationFailure,
  zeroHexDigest,
} from './migration-contract'
import {
  createAbsentMigrationItemDigest,
  parseWorkspaceSearchJournalSegment,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'

/**
 * Creates a valid immutable segment for an absent-to-present target mutation.
 *
 * @returns Complete JSON-safe journal fixture.
 */
function createJournalSegment(): WorkspaceSearchJournalSegment {
  const entityId = 'team/core/issue/issue-1'
  const rawTargetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey('work-item', entityId),
    },
  }
  const rawAfter = {
    ...rawTargetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'work-item' },
    entityId: { S: entityId },
    binary: { B: Uint8Array.from([0, 1, 2, 255]) },
    number: { N: '1.00e+2' },
    numberSet: { NS: ['-1', '2.0', '1e+1'] },
    nested: {
      M: Object.fromEntries([
        ['constructor', { S: 'preserved' }],
        ['__proto__', { S: 'preserved-too' }],
      ]),
    },
  }

  return {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId: 'run-2026-07-25',
    configurationHash: createMigrationDigest('configuration'),
    sequence: 1,
    preparedFenceToken: 7,
    operationId: createMigrationDigest('operation'),
    sourceDigest: createMigrationDigest('source'),
    previousHeadDigest: zeroHexDigest(),
    targetKey: encodeAttributeMap(rawTargetKey),
    targetKeyDigest: createAttributeMapDigest(rawTargetKey),
    before: {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    },
    after: {
      exists: true,
      item: encodeAttributeMap(rawAfter),
      digest: createAttributeMapDigest(rawAfter),
    },
    createdAt: '2026-07-25T04:00:00.000Z',
  }
}

describe('Workspace Search migration journal', () => {
  test('round-trips a restart-safe target key and lossless after snapshot', () => {
    const segment = createJournalSegment()
    const serialized = serializeWorkspaceSearchJournalSegment(segment)
    const parsed = parseWorkspaceSearchJournalSegment(serialized)

    expect(parsed).toEqual(segment)
    expect(parsed.targetKey).toEqual(segment.targetKey)
    expect(parsed.before).toEqual({
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    })
    if (!parsed.after.exists) {
      throw new Error('Expected a present test snapshot.')
    }
    expect(decodeAttributeMap(parsed.after.item)).toEqual(
      decodeAttributeMap(segment.after.exists ? segment.after.item : {}),
    )
    expect(serialized).toContain('"type":"B","value":"AAEC/w=="')
    expect(serialized).toContain('"type":"N","value":"1.00e+2"')
  })

  test('round-trips an exact binary preimage for reverse restoration', () => {
    const segment = createJournalSegment()
    const rawBefore = {
      workspaceId: { S: 'workspace-1' },
      recordKey: {
        S: createWorkspaceSearchDocumentRecordKey(
          'work-item',
          'team/core/issue/issue-1',
        ),
      },
      entryType: { S: 'search-document' },
      entityType: { S: 'work-item' },
      entityId: { S: 'team/core/issue/issue-1' },
      binarySet: {
        BS: [
          Uint8Array.from([255]),
          Uint8Array.from([0, 1]),
        ],
      },
      exactNumber: { N: '1.00' },
    }
    const withPreimage: WorkspaceSearchJournalSegment = {
      ...segment,
      before: {
        exists: true,
        item: encodeAttributeMap(rawBefore),
        digest: createAttributeMapDigest(rawBefore),
      },
    }

    const parsed = parseWorkspaceSearchJournalSegment(
      serializeWorkspaceSearchJournalSegment(withPreimage),
    )

    expect(parsed.before).toEqual(withPreimage.before)
  })

  test('rejects digest drift, wrong item keys, extra fields, and noncanonical bytes', () => {
    const segment = createJournalSegment()
    const wrongTargetDigest: WorkspaceSearchJournalSegment = {
      ...segment,
      targetKeyDigest: 'f'.repeat(64),
    }
    const wrongRawAfter = {
      workspaceId: { S: 'another-workspace' },
      recordKey: {
        S: createWorkspaceSearchDocumentRecordKey(
          'work-item',
          'team/core/issue/issue-1',
        ),
      },
      entryType: { S: 'search-document' },
      entityType: { S: 'work-item' },
      entityId: { S: 'team/core/issue/issue-1' },
    }
    const wrongItemKey: WorkspaceSearchJournalSegment = {
      ...segment,
      after: {
        exists: true,
        item: encodeAttributeMap(wrongRawAfter),
        digest: createAttributeMapDigest(wrongRawAfter),
      },
    }
    const canonical = serializeWorkspaceSearchJournalSegment(segment)

    expect(() => serializeWorkspaceSearchJournalSegment(wrongTargetDigest))
      .toThrow(WorkspaceSearchMigrationFailure)
    expect(() => serializeWorkspaceSearchJournalSegment(wrongItemKey))
      .toThrow(WorkspaceSearchMigrationFailure)
    expect(() => parseWorkspaceSearchJournalSegment(` ${canonical}`))
      .toThrow(WorkspaceSearchMigrationFailure)
    expect(() => parseWorkspaceSearchJournalSegment(
      canonical.slice(0, -1) + ',"tenant-secret":"canary"}',
    )).toThrow(WorkspaceSearchMigrationFailure)
  })

  test('rejects non-migration and noncanonical target keys with consistent digests', () => {
    for (const recordKey of [
      'VIEW#personal-view',
      'PREFERENCE#member-1#view-1',
      'DEFAULT#member-1',
      createWorkspaceSearchDocumentRecordKey('file', 'file-1'),
      'DOCUMENT#work-item#team%2Fcore%2Fissue%2Fissue-1',
    ]) {
      const segment = createJournalSegment()
      if (!segment.after.exists) {
        throw new Error('Expected a present test snapshot.')
      }
      const rawTargetKey = {
        workspaceId: { S: 'workspace-1' },
        recordKey: { S: recordKey },
      }
      const rawAfter = {
        ...decodeAttributeMap(segment.after.item),
        ...rawTargetKey,
      }
      const wrongNamespace: WorkspaceSearchJournalSegment = {
        ...segment,
        targetKey: encodeAttributeMap(rawTargetKey),
        targetKeyDigest: createAttributeMapDigest(rawTargetKey),
        after: {
          exists: true,
          item: encodeAttributeMap(rawAfter),
          digest: createAttributeMapDigest(rawAfter),
        },
      }

      expect(() => serializeWorkspaceSearchJournalSegment(wrongNamespace))
        .toThrow(WorkspaceSearchMigrationFailure)
    }
  })

  test('rejects a whitespace-normalized target workspace with consistent evidence', () => {
    const segment = createJournalSegment()
    if (!segment.after.exists) {
      throw new Error('Expected a present test snapshot.')
    }
    const rawTargetKey = {
      ...decodeAttributeMap(segment.targetKey),
      workspaceId: { S: ' workspace-1 ' },
    }
    const rawAfter = {
      ...decodeAttributeMap(segment.after.item),
      workspaceId: { S: ' workspace-1 ' },
    }
    const noncanonicalWorkspace: WorkspaceSearchJournalSegment = {
      ...segment,
      targetKey: encodeAttributeMap(rawTargetKey),
      targetKeyDigest: createAttributeMapDigest(rawTargetKey),
      after: {
        exists: true,
        item: encodeAttributeMap(rawAfter),
        digest: createAttributeMapDigest(rawAfter),
      },
    }

    expect(() => serializeWorkspaceSearchJournalSegment(noncanonicalWorkspace))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('rejects an overlong target workspace with consistent evidence', () => {
    const segment = createJournalSegment()
    if (!segment.after.exists) {
      throw new Error('Expected a present test snapshot.')
    }
    const workspaceId = 'w'.repeat(1_025)
    const rawTargetKey = {
      ...decodeAttributeMap(segment.targetKey),
      workspaceId: { S: workspaceId },
    }
    const rawAfter = {
      ...decodeAttributeMap(segment.after.item),
      workspaceId: { S: workspaceId },
    }
    const noncanonicalWorkspace: WorkspaceSearchJournalSegment = {
      ...segment,
      targetKey: encodeAttributeMap(rawTargetKey),
      targetKeyDigest: createAttributeMapDigest(rawTargetKey),
      after: {
        exists: true,
        item: encodeAttributeMap(rawAfter),
        digest: createAttributeMapDigest(rawAfter),
      },
    }

    expect(() => serializeWorkspaceSearchJournalSegment(noncanonicalWorkspace))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('rejects an ambiguous structured entity ID with consistent evidence', () => {
    const segment = createJournalSegment()
    if (!segment.after.exists) {
      throw new Error('Expected a present test snapshot.')
    }
    const entityId = 'team/a/project/b/project/c'
    const rawTargetKey = {
      workspaceId: { S: 'workspace-1' },
      recordKey: {
        S: createWorkspaceSearchDocumentRecordKey('project', entityId),
      },
    }
    const rawAfter = {
      ...decodeAttributeMap(segment.after.item),
      ...rawTargetKey,
      entityType: { S: 'project' },
      entityId: { S: entityId },
    }
    const ambiguousEntity: WorkspaceSearchJournalSegment = {
      ...segment,
      targetKey: encodeAttributeMap(rawTargetKey),
      targetKeyDigest: createAttributeMapDigest(rawTargetKey),
      after: {
        exists: true,
        item: encodeAttributeMap(rawAfter),
        digest: createAttributeMapDigest(rawAfter),
      },
    }

    expect(() => serializeWorkspaceSearchJournalSegment(ambiguousEntity))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('rejects snapshot entity identity that does not match the target key', () => {
    const segment = createJournalSegment()
    if (!segment.after.exists) {
      throw new Error('Expected a present test snapshot.')
    }
    const wrongRawAfter = {
      ...decodeAttributeMap(segment.after.item),
      entityType: { S: 'project' },
      entityId: { S: 'project-1' },
    }
    const wrongIdentity: WorkspaceSearchJournalSegment = {
      ...segment,
      after: {
        exists: true,
        item: encodeAttributeMap(wrongRawAfter),
        digest: createAttributeMapDigest(wrongRawAfter),
      },
    }

    expect(() => serializeWorkspaceSearchJournalSegment(wrongIdentity))
      .toThrow(WorkspaceSearchMigrationFailure)
  })

  test('returns stable raw-value-free journal errors', () => {
    try {
      parseWorkspaceSearchJournalSegment(
        '{"tenant-secret":"raw-secret-canary"}',
      )
      throw new Error('Expected journal parse failure.')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
      expect(error).toMatchObject({
        code: 'INVALID_JOURNAL',
        message: 'Migration journal segment is invalid.',
      })
      expect(String(error)).not.toContain('raw-secret-canary')
    }
  })
})
