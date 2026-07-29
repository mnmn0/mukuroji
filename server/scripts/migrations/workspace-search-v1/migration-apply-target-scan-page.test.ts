import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createWorkspaceSearchConfigurationHash,
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
  createWorkspaceSearchMigrationApplyTargetScanPredecessor,
  reduceWorkspaceSearchMigrationApplyTargetScanPage,
  type ReduceWorkspaceSearchMigrationApplyTargetScanPageInput,
} from './migration-apply-target-scan-page'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

describe('Workspace Search migration apply target Scan page', () => {
  test('maps owned target states to mapped and projected with no deleted rows', () => {
    const result = reduceWorkspaceSearchMigrationApplyTargetScanPage(
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
        mapped: 1,
        ignored: 1,
        invalid: 1,
        projected: 1,
        deleted: 0,
        pageCount: 1,
      },
    })
    expect(
      result.checkpoint.aggregate.mapped +
        result.checkpoint.aggregate.ignored +
        result.checkpoint.aggregate.invalid,
    ).toBe(result.checkpoint.aggregate.scanned)
    expect(
      result.checkpoint.aggregate.projected +
        result.checkpoint.aggregate.deleted,
    ).toBe(result.checkpoint.aggregate.mapped)
  })

  test('translates only representable apply predecessors for the target scanner', () => {
    const firstItem = createOwnedDocumentItem('first')
    const first = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([firstItem], createItemCursor(firstItem)),
    )
    const configuration = createConfiguration()
    const predecessor =
      createWorkspaceSearchMigrationApplyTargetScanPredecessor({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        previousCheckpoint: first.checkpoint,
      })

    expect(predecessor).toMatchObject({
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      completed: false,
      aggregate: {
        scanned: 1,
        owned: 1,
        ignored: 0,
        invalid: 0,
        pageCount: 1,
      },
    })
    expect(predecessor.keyDigestState)
      .toEqual(first.checkpoint.keyDigestState)
    expect(predecessor.contentDigestState)
      .toEqual(first.checkpoint.contentDigestState)

    const deleted = structuredClone(first.checkpoint)
    deleted.aggregate.mapped = 1
    deleted.aggregate.projected = 0
    deleted.aggregate.deleted = 1
    expectFailure(
      () =>
        createWorkspaceSearchMigrationApplyTargetScanPredecessor({
          configuration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(configuration),
          previousCheckpoint: deleted,
        }),
      'INVALID_STATE',
    )
  })

  test('resumes the exact target digest state across one page at a time', () => {
    const firstItem = createOwnedDocumentItem('first')
    const secondItem = createIgnoredItem('second')
    const first = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([firstItem], createItemCursor(firstItem)),
    )
    const resumed = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([secondItem], undefined, first.checkpoint),
    )
    const reversed = reduceWorkspaceSearchMigrationApplyTargetScanPage(
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

  test('accepts an empty terminal page as one transition and rejects reuse', () => {
    const terminal = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([]),
    )
    expect(terminal.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        scanned: 0,
        mapped: 0,
        projected: 0,
        deleted: 0,
        pageCount: 1,
      },
    })

    expectFailure(
      () =>
        createWorkspaceSearchMigrationApplyTargetScanPredecessor({
          configuration: createConfiguration(),
          configurationHash:
            createWorkspaceSearchConfigurationHash(createConfiguration()),
          previousCheckpoint: terminal.checkpoint,
        }),
      'INVALID_STATE',
    )
  })

  test('rejects an empty nonterminal result and an unchanged no-op checkpoint', () => {
    const ongoingItem = createIgnoredItem('ongoing')
    const ongoing = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([ongoingItem], createItemCursor(ongoingItem)),
    )
    const input = createInput(
      [createIgnoredItem('terminal')],
      undefined,
      ongoing.checkpoint,
    )

    const emptyNonterminal = structuredClone(input)
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint,
      'completed',
      false,
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint,
      'cursor',
      createCursor('next-without-row'),
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint.aggregate,
      'scanned',
      ongoing.checkpoint.aggregate.scanned,
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint.aggregate,
      'ignored',
      ongoing.checkpoint.aggregate.ignored,
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint,
      'keyDigestState',
      structuredClone(ongoing.checkpoint.keyDigestState),
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint,
      'contentDigestState',
      structuredClone(ongoing.checkpoint.contentDigestState),
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint.aggregate,
      'keyDigest',
      ongoing.checkpoint.aggregate.keyDigest,
    )
    setFixtureProperty(
      emptyNonterminal.pageResult.checkpoint.aggregate,
      'contentDigest',
      ongoing.checkpoint.aggregate.contentDigest,
    )
    setFixtureProperty(emptyNonterminal.pageResult, 'targetRows', [])
    setFixtureProperty(emptyNonterminal.pageResult, 'invalidRows', [])
    setFixtureProperty(
      emptyNonterminal.pageResult,
      'observedTargetBindings',
      [],
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationApplyTargetScanPage(emptyNonterminal),
      'INVALID_STATE',
    )

    const unchanged = structuredClone(input)
    const targetPredecessor =
      createWorkspaceSearchMigrationApplyTargetScanPredecessor({
        configuration: unchanged.configuration,
        configurationHash: unchanged.configurationHash,
        previousCheckpoint: unchanged.previousCheckpoint,
      })
    setFixtureProperty(
      unchanged.pageResult,
      'checkpoint',
      targetPredecessor,
    )
    setFixtureProperty(unchanged.pageResult, 'targetRows', [])
    setFixtureProperty(unchanged.pageResult, 'invalidRows', [])
    setFixtureProperty(
      unchanged.pageResult,
      'observedTargetBindings',
      [],
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(unchanged),
      'INVALID_STATE',
    )
  })

  test('binds every conversion to the exact measured configuration hash', () => {
    const input = createInput([])
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationApplyTargetScanPage({
          ...input,
          configurationHash: 'f'.repeat(64),
        }),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const wrongIdentity = structuredClone(input)
    wrongIdentity.configuration.tables['workspace-search'].role =
      'migration-state'
    setFixtureProperty(
      wrongIdentity,
      'configurationHash',
      createWorkspaceSearchConfigurationHash(wrongIdentity.configuration),
    )
    setFixtureProperty(
      wrongIdentity.pageResult.checkpoint,
      'configurationHash',
      wrongIdentity.configurationHash,
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationApplyTargetScanPage(wrongIdentity),
      'IDENTITY_MISMATCH',
    )
  })

  test('rejects cursor repetition and transitions consuming other than one page', () => {
    const item = createIgnoredItem('cursor')
    const first = reduceWorkspaceSearchMigrationApplyTargetScanPage(
      createInput([item], createItemCursor(item)),
    )
    const nextItem = createIgnoredItem('next-cursor')
    const repeated = createInput(
      [nextItem],
      createItemCursor(nextItem),
      first.checkpoint,
    )
    setFixtureProperty(
      repeated.pageResult.checkpoint,
      'cursor',
      createItemCursor(item),
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(repeated),
      'INVALID_STATE',
    )

    const twoPages = createInput(
      [createIgnoredItem('next')],
      undefined,
      first.checkpoint,
    )
    setFixtureProperty(
      twoPages.pageResult.checkpoint.aggregate,
      'pageCount',
      twoPages.pageResult.checkpoint.aggregate.pageCount + 1,
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(twoPages),
      'INVALID_STATE',
    )
  })

  test('requires row evidence to reproduce counts, bindings, and digest state', () => {
    const input = createInput([
      createOwnedDocumentItem('owned'),
      createIgnoredItem('ignored'),
      createInvalidItem('invalid'),
    ])

    const missing = structuredClone(input)
    setFixtureProperty(
      missing.pageResult,
      'targetRows',
      missing.pageResult.targetRows.slice(0, -1),
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(missing),
      'INVALID_STATE',
    )

    const wrongBinding = structuredClone(input)
    const binding = wrongBinding.pageResult.observedTargetBindings[0]
    if (binding === undefined) {
      throw new Error('Expected an owned target binding fixture.')
    }
    setFixtureProperty(binding, 'targetItemDigest', 'f'.repeat(64))
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(wrongBinding),
      'INVALID_STATE',
    )

    const changedDigest = structuredClone(input)
    const row = changedDigest.pageResult.targetRows[0]
    if (row === undefined) {
      throw new Error('Expected an owned target row fixture.')
    }
    setFixtureProperty(row, 'targetItemDigest', 'e'.repeat(64))
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(changedDigest),
      'INVALID_STATE',
    )
  })

  test('rejects duplicate target evidence and pages beyond the fixed bound', () => {
    const duplicateInput = createInput([
      createIgnoredItem('first'),
      createIgnoredItem('second'),
    ])
    const firstRow = duplicateInput.pageResult.targetRows[0]
    const secondRow = duplicateInput.pageResult.targetRows[1]
    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('Expected two recognized target rows.')
    }
    setFixtureProperty(
      secondRow,
      'targetKeyDigest',
      firstRow.targetKeyDigest,
    )
    expectFailure(
      () =>
        reduceWorkspaceSearchMigrationApplyTargetScanPage(duplicateInput),
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )

    const hundred = Array.from(
      { length: 100 },
      (_, index) => createIgnoredItem(`row-${index}`),
    )
    expect(
      reduceWorkspaceSearchMigrationApplyTargetScanPage(createInput(hundred))
        .checkpoint.aggregate.scanned,
    ).toBe(100)
  })

  test('detaches configuration, predecessor, result rows, and cursor', () => {
    const item = createIgnoredItem('detached')
    const cursor = createItemCursor(item)
    const input = createInput([item], cursor)
    const result =
      reduceWorkspaceSearchMigrationApplyTargetScanPage(input)
    const expected = structuredClone(result)

    cursor.workspaceId = { S: 'mutated' }
    input.previousCheckpoint.aggregate.pageCount = 99
    setFixtureProperty(
      input.pageResult.checkpoint.aggregate,
      'pageCount',
      99,
    )
    const evidence = input.pageResult.targetRows[0]
    if (evidence !== undefined) {
      setFixtureProperty(evidence, 'targetItemDigest', 'f'.repeat(64))
    }
    input.configuration.tables['workspace-search'].tableId = 'mutated'

    expect(result).toEqual(expected)
  })

  test('rejects proxy, accessor, symbol, cycle, and sparse result graphs safely', () => {
    const proxyInput = createInput([])
    setFixtureProperty(
      proxyInput,
      'pageResult',
      new Proxy(proxyInput.pageResult, {}),
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(proxyInput),
      'INVALID_STATE',
    )

    const canary = 'RAW-APPLY-TARGET-CANARY-DO-NOT-LEAK'
    const accessorInput = createInput([])
    Object.defineProperty(accessorInput.pageResult, 'checkpoint', {
      enumerable: true,
      get() {
        throw new Error(canary)
      },
    })
    const accessorFailure = captureFailure(
      () =>
        reduceWorkspaceSearchMigrationApplyTargetScanPage(accessorInput),
    )
    expect(accessorFailure.code).toBe('INVALID_STATE')
    expect(accessorFailure.message).not.toContain(canary)

    const symbolInput = createInput([])
    Reflect.set(
      symbolInput.pageResult,
      Symbol('raw-symbol-secret'),
      'raw-symbol-secret',
    )
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(symbolInput),
      'INVALID_STATE',
    )

    const cycleInput = createInput([])
    Reflect.set(cycleInput.pageResult, 'cycle', cycleInput.pageResult)
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(cycleInput),
      'INVALID_STATE',
    )

    const sparseInput = createInput([createIgnoredItem('sparse')])
    Reflect.deleteProperty(sparseInput.pageResult.targetRows, '0')
    expectFailure(
      () => reduceWorkspaceSearchMigrationApplyTargetScanPage(sparseInput),
      'INVALID_STATE',
    )
  })
})

/**
 * Creates one exact new-reducer input by running the existing target reducer.
 *
 * @param items - Exact low-level target rows.
 * @param lastEvaluatedKey - Optional next-page cursor.
 * @param previousCheckpoint - Optional durable apply predecessor.
 * @returns Complete apply target page conversion input.
 */
function createInput(
  items: readonly DynamoAttributeMap[],
  lastEvaluatedKey?: DynamoAttributeMap,
  previousCheckpoint: MigrationSourceCheckpoint =
    createEmptyWorkspaceSearchMigrationCheckpoint(),
): ReduceWorkspaceSearchMigrationApplyTargetScanPageInput {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const targetPredecessor =
    createWorkspaceSearchMigrationApplyTargetScanPredecessor({
      configuration,
      configurationHash,
      previousCheckpoint,
    })
  const pageResult = reduceWorkspaceSearchMigrationTargetScanPage({
    configuration,
    configurationHash,
    previousCheckpoint: targetPredecessor,
    page: {
      items,
      ...(lastEvaluatedKey === undefined
        ? {}
        : { lastEvaluatedKey }),
    },
  })
  return {
    configuration,
    configurationHash,
    previousCheckpoint,
    pageResult,
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
 * Creates one key-valid row with a conflicting target discriminator.
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
 * Mutates one caller-owned fixture while preserving production readonly types.
 *
 * @param target - Fixture object being corrupted for a negative test.
 * @param key - Own property selected for mutation.
 * @param value - Replacement fixture value.
 */
function setFixtureProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  if (!Reflect.set(target, key, value)) {
    throw new Error('Expected fixture mutation to succeed.')
  }
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
 * Expects one conversion to fail with an exact safe code.
 *
 * @param operation - Deferred conversion invocation.
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
