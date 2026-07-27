import { describe, expect, test } from 'bun:test'
import {
  createAttributeMapDigest,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationSourceCandidate,
} from './migration-planner'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type ReduceWorkspaceSearchMigrationSourceScanPageInput,
  type WorkspaceSearchMigrationSourceScanPage,
} from './migration-source-scan-page'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'

describe('Workspace Search migration source scan page', () => {
  test('reduces mapped put, mapped delete, ignored, and invalid rows', () => {
    const input = createInput([
      createTeamItem('active'),
      createTeamItem('archived', '2026-07-25T01:00:00.000Z'),
      createIgnoredItem('ignored'),
      createInvalidItem('invalid'),
    ])
    const result = reduceWorkspaceSearchMigrationSourceScanPage(input)

    expect(result.checkpoint.completed).toBe(true)
    expect(result.checkpoint.cursor).toBeUndefined()
    expect(result.checkpoint.aggregate).toMatchObject({
      scanned: 4,
      mapped: 2,
      ignored: 1,
      invalid: 1,
      projected: 1,
      deleted: 1,
      pageCount: 1,
    })
    expect(result.checkpoint.keyDigestState.count).toBe(4)
    expect(result.checkpoint.contentDigestState.count).toBe(4)
    expect(result.sourceRows.map(({ classification }) => classification))
      .toEqual(['mapped', 'mapped', 'ignored'])
    expect(result.invalidRows).toHaveLength(1)
    expect(result.invalidRows[0]?.reasonCode)
      .toBe('MALFORMED_PROJECT_DIRECTORY_TARGET')
    expect(result.sourceBindings.map(({ targetAction }) => targetAction))
      .toEqual(['put', 'delete'])
  })

  test('selects the exact measured key schema for every source role', () => {
    const workItems = reduceWorkspaceSearchMigrationSourceScanPage(
      createSourceInput('work-items', [{
        directoryTeamId: { S: 'workspace-1#team#team-1' },
        issueId: { S: 'issue-1' },
      }]),
    )
    const collaboration = reduceWorkspaceSearchMigrationSourceScanPage(
      createSourceInput('collaboration', [{
        entityKey: { S: 'workspace-1#work-item#team/team-1/issue/issue-1' },
        recordKey: { S: 'REACTION#reaction-1' },
        entryType: { S: 'reaction' },
      }]),
    )
    const documents = reduceWorkspaceSearchMigrationSourceScanPage(
      createSourceInput('documents', [{
        workspaceId: { S: 'workspace-1' },
        recordKey: { S: 'COMMENT#comment-1' },
        entryType: { S: 'document-comment' },
      }]),
    )

    expect(workItems.checkpoint.aggregate).toMatchObject({
      scanned: 1,
      invalid: 1,
    })
    expect(workItems.invalidRows[0]?.reasonCode)
      .toBe('MALFORMED_WORK_ITEM_TARGET')
    expect(collaboration.checkpoint.aggregate).toMatchObject({
      scanned: 1,
      ignored: 1,
    })
    expect(documents.checkpoint.aggregate).toMatchObject({
      scanned: 1,
      ignored: 1,
    })
  })

  test('reproduces the planner source-row and ownership evidence exactly', () => {
    const item = createTeamItem('planner')
    const input = createInput([item])
    const result = reduceWorkspaceSearchMigrationSourceScanPage(input)
    const candidate = createWorkspaceSearchMigrationSourceCandidate({
      configurationHash: input.configurationHash,
      source: input.source,
      sourceTable: input.configuration.tables[input.source],
      sourceItem: item,
    })
    if (!candidate) throw new Error('Expected one mapped planner candidate.')
    const sourceCondition = candidate.operation.sourceCondition
    if (!sourceCondition.exists) {
      throw new Error('Expected one present planner source condition.')
    }

    expect(result.sourceRows).toEqual([{
      classification: 'mapped',
      sourceKeyDigest: sourceCondition.keyDigest,
      sourceItemDigest: sourceCondition.itemDigest,
    }])
    expect(result.sourceBindings).toEqual([{
      sourceKeyDigest: sourceCondition.keyDigest,
      sourceItemDigest: sourceCondition.itemDigest,
      targetKeyDigest: candidate.operation.targetKeyDigest,
      targetAction: 'put',
    }])
  })

  test('completes an empty terminal page and rejects an empty cursor page', () => {
    const terminal = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([]),
    )
    expect(terminal.checkpoint).toMatchObject({
      completed: true,
      aggregate: { scanned: 0, pageCount: 1 },
    })
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([], createCursor('next')),
        ),
      'INVALID_STATE',
    )
  })

  test('resumes digest state and remains independent of page and row order', () => {
    const firstItem = createTeamItem('first')
    const secondItem = createIgnoredItem('second')
    const firstPage = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([firstItem], createItemCursor(firstItem)),
    )
    const resumed = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([secondItem], undefined, firstPage.checkpoint),
    )
    const reversed = reduceWorkspaceSearchMigrationSourceScanPage(
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

  test('binds key and full low-level content digests including ignored rows', () => {
    const item = createIgnoredItem('digest')
    const changed = {
      ...item,
      payload: { S: 'changed' },
    }
    const original = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([item]),
    )
    const modified = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([changed]),
    )

    expect(original.sourceRows[0]?.sourceKeyDigest)
      .toBe(modified.sourceRows[0]?.sourceKeyDigest)
    expect(original.sourceRows[0]?.sourceItemDigest)
      .not.toBe(modified.sourceRows[0]?.sourceItemDigest)
    expect(original.checkpoint.aggregate.keyDigest)
      .toBe(modified.checkpoint.aggregate.keyDigest)
    expect(original.checkpoint.aggregate.contentDigest)
      .not.toBe(modified.checkpoint.aggregate.contentDigest)
  })

  test('losslessly detaches items, binary values, cursor, and checkpoint', () => {
    const binary = new Uint8Array([1, 2, 3])
    const item: DynamoAttributeMap = {
      ...createIgnoredItem('detached'),
      binary: { B: binary },
      binarySet: { BS: [new Uint8Array([3]), new Uint8Array([2])] },
      stringSet: { SS: ['z', 'a'] },
      numberSet: { NS: ['2', '1'] },
      nested: {
        M: {
          list: {
            L: [{ BOOL: true }, { NULL: true }, { N: '1.25e+2' }],
          },
        },
      },
    }
    const cursor = createItemCursor(item)
    const expectedCursor = structuredClone(cursor)
    const previous = createEmptyWorkspaceSearchMigrationCheckpoint()
    const result = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([item], cursor, previous),
    )
    const evidence = structuredClone(result.sourceRows[0])
    const aggregate = structuredClone(result.checkpoint.aggregate)

    binary[0] = 9
    cursor.directoryId = { S: 'mutated' }
    previous.aggregate.pageCount = 99
    item.payload = { S: 'mutated' }

    expect(result.sourceRows[0]).toEqual(evidence)
    expect(result.checkpoint.aggregate).toEqual(aggregate)
    expect(result.checkpoint.cursor).toEqual(expectedCursor)
    expect(result.sourceRows[0]?.sourceItemDigest)
      .toBe(createAttributeMapDigest({
        ...item,
        payload: { S: 'fixture' },
        binary: { B: new Uint8Array([1, 2, 3]) },
      }))
  })

  test('accepts exactly one hundred rows and rejects larger or noncanonical arrays', () => {
    const hundred = Array.from(
      { length: 100 },
      (_, index) => createIgnoredItem(`row-${index}`),
    )
    expect(
      reduceWorkspaceSearchMigrationSourceScanPage(createInput(hundred))
        .checkpoint.aggregate.scanned,
    ).toBe(100)

    const tooMany = [
      ...hundred,
      createIgnoredItem('row-100'),
    ]
    expectFailure(
      () => reduceWorkspaceSearchMigrationSourceScanPage(createInput(tooMany)),
      'INVALID_ARGUMENT',
    )

    const sparse = [createIgnoredItem('sparse')]
    delete sparse[0]
    expectFailure(
      () => reduceWorkspaceSearchMigrationSourceScanPage(createInput(sparse)),
      'INVALID_ARGUMENT',
    )

    const sideProperty = [createIgnoredItem('side-property')]
    Object.defineProperty(sideProperty, 'extra', {
      enumerable: true,
      value: 'not-an-item',
    })
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput(sideProperty),
        ),
      'INVALID_ARGUMENT',
    )

    const lengthMutatingItems = [
      createIgnoredItem('length-mutation-1'),
      createIgnoredItem('length-mutation-2'),
    ]
    Object.defineProperty(lengthMutatingItems, '0', {
      configurable: true,
      enumerable: true,
      get() {
        lengthMutatingItems.length = 1
        return createIgnoredItem('length-mutation-1')
      },
    })
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput(lengthMutatingItems),
        ),
      'INVALID_ARGUMENT',
    )
  })

  test('rejects malformed, repeated, and schema-mismatched cursors', () => {
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([], {}),
        ),
      'TABLE_SCHEMA_MISMATCH',
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([], {
            ...createCursor('next'),
            extra: { S: 'unexpected' },
          }),
        ),
      'TABLE_SCHEMA_MISMATCH',
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([], {
            directoryId: { N: '1' },
            entryKey: { S: 'next' },
          }),
        ),
      'TABLE_SCHEMA_MISMATCH',
    )

    const mismatchedItem = createIgnoredItem('last-returned')
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput(
            [mismatchedItem],
            createCursor('skipped-ahead'),
          ),
        ),
      'INVALID_STATE',
    )

    const repeatedItem = createIgnoredItem('repeated')
    const repeatedCursor = createItemCursor(repeatedItem)
    const first = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([repeatedItem], repeatedCursor),
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput(
            [repeatedItem],
            repeatedCursor,
            first.checkpoint,
          ),
        ),
      'INVALID_STATE',
    )
  })

  test('rejects malformed or duplicate physical rows and oversized items', () => {
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([{
            ...createIgnoredItem('wrong-key-type'),
            directoryId: { N: '1' },
          }]),
        ),
      'TABLE_SCHEMA_MISMATCH',
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([
            createIgnoredItem('duplicate'),
            {
              ...createIgnoredItem('duplicate'),
              payload: { S: 'different-content' },
            },
          ]),
        ),
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([{
            ...createIgnoredItem('oversized'),
            payload: { S: 'x'.repeat(400 * 1024) },
          }]),
        ),
      'INVALID_STATE',
    )
  })

  test('binds the selected source to the exact reviewed configuration', () => {
    const configuration = createConfiguration()
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage({
          ...createInput([]),
          configuration,
          configurationHash: '0'.repeat(64),
        }),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const mismatched = structuredClone(configuration)
    mismatched.tables['project-directory'].role = 'documents'
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage({
          ...createInput([]),
          configuration: mismatched,
          configurationHash:
            createWorkspaceSearchConfigurationHash(mismatched),
        }),
      'IDENTITY_MISMATCH',
    )

    const missing = structuredClone(configuration)
    const measuredHash = createWorkspaceSearchConfigurationHash(missing)
    Reflect.deleteProperty(missing.tables, 'project-directory')
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage({
          ...createInput([]),
          configuration: missing,
          configurationHash: measuredHash,
        }),
      'TABLE_SCHEMA_MISMATCH',
    )
  })

  test('rejects completed checkpoints and safe-integer overflow', () => {
    const completed = reduceWorkspaceSearchMigrationSourceScanPage(
      createInput([]),
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput([], undefined, completed.checkpoint),
        ),
      'INVALID_STATE',
    )

    const digestState = {
      count: Number.MAX_SAFE_INTEGER,
      sumHex: '0'.repeat(64),
      xorHex: '0'.repeat(64),
    }
    const digest = MigrationDigestAccumulator.fromState(digestState).digest()
    const maximumCheckpoint: MigrationSourceCheckpoint = {
      completed: false,
      cursor: createCursor('maximum'),
      aggregate: {
        scanned: Number.MAX_SAFE_INTEGER,
        mapped: Number.MAX_SAFE_INTEGER,
        ignored: 0,
        invalid: 0,
        projected: Number.MAX_SAFE_INTEGER,
        deleted: 0,
        keyDigest: digest,
        contentDigest: digest,
        pageCount: 1,
      },
      keyDigestState: digestState,
      contentDigestState: digestState,
    }
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage(
          createInput(
            [createTeamItem('overflow')],
            createItemCursor(createTeamItem('overflow')),
            maximumCheckpoint,
          ),
        ),
      'INVALID_STATE',
    )
  })

  test('redacts hostile getter failures behind a fresh fixed error', () => {
    const canary = 'tenant-secret-canary'
    const page: WorkspaceSearchMigrationSourceScanPage = { items: [] }
    Object.defineProperty(page, 'items', {
      enumerable: true,
      get() {
        throw new WorkspaceSearchMigrationFailure(
          'IDENTITY_MISMATCH',
          canary,
        )
      },
    })
    const input = createInput([])
    const failure = captureFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage({
          ...input,
          page,
        }),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).not.toContain(canary)
    expect(failure.message)
      .toBe('Workspace Search source scan page stopped safely (INVALID_STATE).')

    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(canary)
      },
    })
    Object.defineProperty(page, 'items', {
      enumerable: true,
      get() {
        throw hostileThrownValue
      },
    })
    const hostileFailure = captureFailure(
      () =>
        reduceWorkspaceSearchMigrationSourceScanPage({
          ...input,
          page,
        }),
    )
    expect(hostileFailure.code).toBe('INVALID_STATE')
    expect(hostileFailure.message).not.toContain(canary)
  })
})

/**
 * Creates one canonical reducer input for the Project Directory source.
 *
 * @param items - Exact low-level source items.
 * @param lastEvaluatedKey - Optional next-page cursor.
 * @param previousCheckpoint - Optional cumulative predecessor.
 * @returns Complete reducer input.
 */
function createInput(
  items: readonly DynamoAttributeMap[],
  lastEvaluatedKey?: DynamoAttributeMap,
  previousCheckpoint: MigrationSourceCheckpoint =
    createEmptyWorkspaceSearchMigrationCheckpoint(),
): ReduceWorkspaceSearchMigrationSourceScanPageInput {
  return createSourceInput(
    'project-directory',
    items,
    lastEvaluatedKey,
    previousCheckpoint,
  )
}

/**
 * Creates one canonical reducer input for a selected source.
 *
 * @param source - Logical source whose measured table is scanned.
 * @param items - Exact low-level source items.
 * @param lastEvaluatedKey - Optional next-page cursor.
 * @param previousCheckpoint - Optional cumulative predecessor.
 * @returns Complete reducer input.
 */
function createSourceInput(
  source: WorkspaceSearchMigrationSourceName,
  items: readonly DynamoAttributeMap[],
  lastEvaluatedKey?: DynamoAttributeMap,
  previousCheckpoint: MigrationSourceCheckpoint =
    createEmptyWorkspaceSearchMigrationCheckpoint(),
): ReduceWorkspaceSearchMigrationSourceScanPageInput {
  const configuration = createConfiguration()
  return {
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
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
 * Creates a canonical active or archived Project Directory Team item.
 *
 * @param identifier - Unique key and entity suffix.
 * @param archivedAt - Optional canonical archive timestamp.
 * @returns Exact low-level Team source item.
 */
function createTeamItem(
  identifier: string,
  archivedAt?: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `000001#000000#TEAM#${identifier}` },
    entryType: { S: 'team' },
    teamId: { S: identifier },
    teamSortOrder: { N: '1' },
    nameJa: { S: 'チーム' },
    nameEn: { S: 'Team' },
    expanded: { BOOL: true },
    ...(archivedAt === undefined ? {} : { archivedAt: { S: archivedAt } }),
  }
}

/**
 * Creates one recognized non-target Project Directory item.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored source item.
 */
function createIgnoredItem(identifier: string): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
    entryType: { S: 'workspace-member' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one key-valid source item rejected by the mapper.
 *
 * @param identifier - Unique key and entity suffix.
 * @returns Exact low-level invalid source item.
 */
function createInvalidItem(identifier: string): DynamoAttributeMap {
  return {
    ...createTeamItem(identifier),
    nameEn: { N: '1' },
  }
}

/**
 * Creates one exact Project Directory pagination cursor.
 *
 * @param identifier - Unique cursor suffix.
 * @returns Exact low-level table key.
 */
function createCursor(identifier: string): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `CURSOR#${identifier}` },
  }
}

/**
 * Creates the exact Project Directory key for one complete fixture item.
 *
 * @param item - Project Directory source item with a composite string key.
 * @returns Detached exact low-level table key.
 */
function createItemCursor(item: DynamoAttributeMap): DynamoAttributeMap {
  const directoryId = item.directoryId
  const entryKey = item.entryKey
  if (directoryId === undefined || entryKey === undefined) {
    throw new Error('Expected a complete Project Directory fixture key.')
  }
  return structuredClone({
    directoryId,
    entryKey,
  })
}

/**
 * Captures and validates one public reducer failure.
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
 * Expects one reducer invocation to fail with an exact safe code.
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
 * Creates the complete measured configuration bound to reducer fixtures.
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
 * @returns Stable source identity fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
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
    key: sourceKeyDescriptors(role),
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: false,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? createMigrationDigest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
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
    key: role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
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
 * @returns Ordered partition and optional sort key descriptors.
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
