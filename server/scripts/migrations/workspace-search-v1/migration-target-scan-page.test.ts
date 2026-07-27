import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  MigrationDigestAccumulator,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createEmptyWorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type ReduceWorkspaceSearchMigrationTargetScanPageInput,
} from './migration-target-scan-page'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

describe('Workspace Search migration target Scan page', () => {
  test('reduces owned, ignored, and invalid target rows without join outcomes', () => {
    const result = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([
        createOwnedDocumentItem('owned'),
        createIgnoredItem('ignored'),
        createInvalidItem('invalid'),
      ]),
    )

    expect(result.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        scanned: 3,
        owned: 1,
        ignored: 1,
        invalid: 1,
        pageCount: 1,
      },
    })
    expect(Object.keys(result.checkpoint.aggregate).sort()).toEqual([
      'contentDigest',
      'ignored',
      'invalid',
      'keyDigest',
      'owned',
      'pageCount',
      'scanned',
    ])
    expect(result.targetRows.map(({ classification }) => classification))
      .toEqual(['owned', 'ignored'])
    expect(result.invalidRows).toHaveLength(1)
    expect(result.invalidRows[0]?.reasonCode).toBe('INVALID_TARGET_ROW')
    expect(result.observedTargetBindings).toEqual([
      {
        targetKeyDigest: result.targetRows[0]?.targetKeyDigest,
        targetItemDigest: result.targetRows[0]?.targetItemDigest,
      },
    ])
  })

  test('completes an empty terminal page and rejects an empty cursor page', () => {
    const terminal = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([]),
    )
    expect(terminal.checkpoint).toMatchObject({
      completed: true,
      aggregate: { scanned: 0, pageCount: 1 },
    })
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(
          createInput([], createCursor('next')),
        ),
      'INVALID_STATE',
    )
  })

  test('resumes digest state independently of page and row order', () => {
    const firstItem = createOwnedDocumentItem('first')
    const secondItem = createIgnoredItem('second')
    const first = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([firstItem], createItemCursor(firstItem)),
    )
    const resumed = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([secondItem], undefined, first.checkpoint),
    )
    const reversed = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([secondItem, firstItem]),
    )

    expect(resumed.checkpoint.aggregate).toEqual({
      ...reversed.checkpoint.aggregate,
      pageCount: 2,
    })
    expect(resumed.checkpoint.keyDigestState)
      .toEqual(reversed.checkpoint.keyDigestState)
    expect(resumed.checkpoint.contentDigestState)
      .toEqual(reversed.checkpoint.contentDigestState)
  })

  test('binds key and content digests for recognized ignored rows', () => {
    const item = createIgnoredItem('digest')
    const original = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([item]),
    )
    const modified = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([{
        ...item,
        payload: { S: 'changed' },
      }]),
    )

    expect(original.targetRows[0]?.targetKeyDigest)
      .toBe(modified.targetRows[0]?.targetKeyDigest)
    expect(original.targetRows[0]?.targetItemDigest)
      .not.toBe(modified.targetRows[0]?.targetItemDigest)
    expect(original.checkpoint.aggregate.keyDigest)
      .toBe(modified.checkpoint.aggregate.keyDigest)
    expect(original.checkpoint.aggregate.contentDigest)
      .not.toBe(modified.checkpoint.aggregate.contentDigest)
  })

  test('accepts one hundred rows and rejects oversized or sparse pages', () => {
    const hundred = Array.from(
      { length: 100 },
      (_, index) => createIgnoredItem(`row-${index}`),
    )
    expect(
      reduceWorkspaceSearchMigrationTargetScanPage(createInput(hundred))
        .checkpoint.aggregate.scanned,
    ).toBe(100)
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(
          createInput([...hundred, createIgnoredItem('row-100')]),
        ),
      'INVALID_ARGUMENT',
    )

    const sparse = [createIgnoredItem('sparse')]
    delete sparse[0]
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(createInput(sparse)),
      'INVALID_ARGUMENT',
    )
  })

  test('rejects cursor mismatch, repetition, and duplicate physical keys', () => {
    const item = createIgnoredItem('cursor')
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(
          createInput([item], createCursor('different')),
        ),
      'INVALID_STATE',
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(
          createInput([item, structuredClone(item)]),
        ),
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )

    const first = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([item], createItemCursor(item)),
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(
          createInput(
            [item],
            createItemCursor(item),
            first.checkpoint,
          ),
        ),
      'INVALID_STATE',
    )
  })

  test('detaches caller-owned rows, cursor, and predecessor checkpoint', () => {
    const item = createIgnoredItem('detached')
    const cursor = createItemCursor(item)
    const previous =
      createEmptyWorkspaceSearchMigrationTargetScanCheckpoint()
    const result = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([item], cursor, previous),
    )
    const expected = structuredClone(result)

    item.payload = { S: 'mutated' }
    cursor.workspaceId = { S: 'mutated' }
    Reflect.set(previous.aggregate, 'pageCount', 99)

    expect(result).toEqual(expected)
  })

  test('replaces hostile page failures without exposing raw values', () => {
    const canary = 'RAW-TARGET-PAGE-CANARY-DO-NOT-LEAK'
    const input = createInput([])
    const page = input.page
    Object.defineProperty(page, 'items', {
      enumerable: true,
      get() {
        throw new Error(canary)
      },
    })

    const failure = captureFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage({
          ...input,
          page,
        }),
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).not.toContain(canary)
  })

  test('rejects configuration and predecessor substitution before reduction', () => {
    const hashMismatch = createInput([])
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage({
          ...hashMismatch,
          configurationHash: 'f'.repeat(64),
        }),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const checkpointMismatch = createInput([])
    Reflect.set(
      checkpointMismatch.previousCheckpoint.aggregate,
      'pageCount',
      1,
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationTargetScanPage(checkpointMismatch),
      'INVALID_STATE',
    )

    const wrongCursor = createInput([])
    Reflect.set(wrongCursor.previousCheckpoint, 'cursor', {
      workspaceId: { S: 'workspace-1' },
    })
    expectFailure(
      () => reduceWorkspaceSearchMigrationTargetScanPage(wrongCursor),
      'INVALID_STATE',
    )
  })

  test('rejects digest-state substitution without another observed row', () => {
    const item = createIgnoredItem('digest-state')
    const first = reduceWorkspaceSearchMigrationTargetScanPage(
      createInput([item], createItemCursor(item)),
    ).checkpoint
    const substitutedKeyAccumulator = new MigrationDigestAccumulator()
    substitutedKeyAccumulator.add('a'.repeat(64))
    const successor: WorkspaceSearchMigrationTargetScanCheckpoint = {
      completed: true,
      aggregate: {
        ...first.aggregate,
        keyDigest: substitutedKeyAccumulator.digest(),
        pageCount: first.aggregate.pageCount + 1,
      },
      keyDigestState: substitutedKeyAccumulator.exportState(),
      contentDigestState: first.contentDigestState,
    }

    expectFailure(
      () =>
        validateWorkspaceSearchMigrationTargetScanCheckpoint(
          successor,
          first,
        ),
      'INVALID_STATE',
    )
  })
})

/**
 * Creates one complete target reducer input.
 *
 * @param items - Exact low-level target rows.
 * @param lastEvaluatedKey - Optional next-page cursor.
 * @param previousCheckpoint - Optional cumulative predecessor.
 * @returns Complete measured target reducer input.
 */
function createInput(
  items: readonly DynamoAttributeMap[],
  lastEvaluatedKey?: DynamoAttributeMap,
  previousCheckpoint: WorkspaceSearchMigrationTargetScanCheckpoint =
    createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(),
): ReduceWorkspaceSearchMigrationTargetScanPageInput {
  const configuration = createConfiguration()
  return {
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    previousCheckpoint,
    page: {
      items,
      ...(lastEvaluatedKey === undefined
        ? {}
        : { lastEvaluatedKey }),
    },
  }
}

/**
 * Creates one migration-owned canonical Search document row.
 *
 * @param identifier - Unique document identifier.
 * @returns Exact low-level target item.
 */
function createOwnedDocumentItem(identifier: string): DynamoAttributeMap {
  return encodeWorkspaceSearchMigrationDocument(
    createWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      entityType: 'document',
      entityId: identifier,
      title: `Document ${identifier}`,
      url: `/documents/${identifier}`,
    }),
  )
}

/**
 * Creates one recognized saved-view target row.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level ignored target item.
 */
function createIgnoredItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one key-valid row with a conflicting target family discriminator.
 *
 * @param identifier - Unique target key suffix.
 * @returns Exact low-level invalid target item.
 */
function createInvalidItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'search-document' },
  }
}

/**
 * Creates one exact target pagination key.
 *
 * @param identifier - Unique target key suffix.
 * @returns Composite low-level target key.
 */
function createCursor(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
  }
}

/**
 * Extracts one exact physical key from a target fixture.
 *
 * @param item - Target item with the measured composite key.
 * @returns Detached low-level target key.
 */
function createItemCursor(item: DynamoAttributeMap): DynamoAttributeMap {
  const workspaceId = item.workspaceId
  const recordKey = item.recordKey
  if (workspaceId === undefined || recordKey === undefined) {
    throw new Error('Expected a complete target fixture key.')
  }
  return structuredClone({ workspaceId, recordKey })
}

/**
 * Captures and validates one public target reducer failure.
 *
 * @param operation - Deferred reducer invocation.
 * @returns Exact safe migration failure.
 */
function captureFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected Workspace Search migration failure.')
}

/**
 * Expects one target reducer invocation to fail with an exact safe code.
 *
 * @param operation - Deferred reducer invocation.
 * @param code - Expected stable failure code.
 */
function expectFailure(
  operation: () => unknown,
  code: WorkspaceSearchMigrationFailure['code'],
): void {
  const failure = captureFailure(operation)
  expect(failure.code).toBe(code)
  expect(failure.message).not.toContain('workspace-1')
}

/**
 * Creates the complete measured migration configuration for target fixtures.
 *
 * @returns Reviewed migration configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source table fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role))
}

/**
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable support table fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
  )
}

/**
 * Creates one stable measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact base-table key descriptor.
 * @returns Complete table identity fixture.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and sort key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}
