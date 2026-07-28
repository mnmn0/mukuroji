import { describe, expect, test } from 'bun:test'
import type {
  DescribeTableCommand,
  DescribeTableCommandOutput,
  GetItemCommand,
  GetItemCommandOutput,
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceReadMaterial,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  encodeWorkspaceSearchWriterFenceRecord,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceOpenRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from './workspace-search-writer-fence'
import {
  acquireWorkspaceSearchWriterFenceGuardMaterialFromAws,
  createAwsWorkspaceSearchWriterFenceGuardSource,
  WorkspaceSearchWriterFenceUnavailableError,
  type WorkspaceSearchWriterFenceAwsTableNames,
  type WorkspaceSearchWriterFenceAwsTransport,
} from './workspace-search-writer-fence-aws'

const fixtureAccount = '123456789012'
const fixtureRegion = 'ap-northeast-1'
const fixtureCreationTime = new Date('2026-07-29T00:00:00.000Z')

/**
 * Complete focused AWS source fixture.
 */
type WorkspaceSearchWriterFenceAwsFixture = {
  /** Caller-owned configured table names. */
  readonly tableNames: WorkspaceSearchWriterFenceAwsTableNames
  /** Mutable fake DescribeTable responses keyed by configured name. */
  readonly descriptions: Map<string, DescribeTableCommandOutput>
  /** Narrow recording fake transport. */
  readonly transport: RecordingWorkspaceSearchWriterFenceTransport
  /** Binding derived from the fixture's six immutable identities. */
  readonly binding: WorkspaceSearchWriterFenceBinding
  /** Durable open row returned by the initial fake GetItem response. */
  readonly openRecord: WorkspaceSearchWriterFenceOpenRecord
}

/**
 * Recording deterministic low-level DynamoDB transport.
 */
class RecordingWorkspaceSearchWriterFenceTransport
implements WorkspaceSearchWriterFenceAwsTransport {
  /** DescribeTable commands received in call order. */
  readonly describeCommands: DescribeTableCommand[] = []

  /** GetItem commands received in call order. */
  readonly getCommands: GetItemCommand[] = []

  /** Mutable deterministic DescribeTable responses. */
  private readonly descriptions: Map<string, DescribeTableCommandOutput>

  /** Current deterministic GetItem response. */
  private getOutput: GetItemCommandOutput

  /** Optional raw fake transport failure. */
  private failure: Error | undefined

  /**
   * Creates one recording fake transport.
   *
   * @param descriptions - Exact table descriptions keyed by table name.
   * @param getOutput - Initial exact writer-fence read response.
   */
  constructor(
    descriptions: Map<string, DescribeTableCommandOutput>,
    getOutput: GetItemCommandOutput,
  ) {
    this.descriptions = descriptions
    this.getOutput = getOutput
  }

  /**
   * Replaces the deterministic GetItem response.
   *
   * @param output - New fake low-level response.
   */
  setGetOutput(output: GetItemCommandOutput): void {
    this.getOutput = output
  }

  /**
   * Enables one raw transport failure for every subsequent operation.
   *
   * @param failure - Raw fake failure that must not cross the source boundary.
   */
  setFailure(failure: Error): void {
    this.failure = failure
  }

  /**
   * Records and answers one exact DescribeTable command.
   *
   * @param command - Source-owned command.
   * @returns Configured fake description.
   */
  describeTable(
    command: DescribeTableCommand,
  ): Promise<DescribeTableCommandOutput> {
    this.describeCommands.push(command)
    if (this.failure !== undefined) {
      return Promise.reject(this.failure)
    }
    const tableName = command.input.TableName
    const output = tableName === undefined
      ? undefined
      : this.descriptions.get(tableName)
    if (output === undefined) {
      return Promise.reject(new Error('RAW_UNKNOWN_TABLE'))
    }
    return Promise.resolve(output)
  }

  /**
   * Records and answers one exact GetItem command.
   *
   * @param command - Source-owned command.
   * @returns Configured fake low-level item response.
   */
  getItem(command: GetItemCommand): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    if (this.failure !== undefined) {
      return Promise.reject(this.failure)
    }
    return Promise.resolve(this.getOutput)
  }
}

/**
 * Creates detached exact six-table name configuration.
 *
 * @returns Stable caller-owned names.
 */
function createTableNames(): WorkspaceSearchWriterFenceAwsTableNames {
  return {
    'project-directory': 'ProjectDirectoryTable',
    'work-items': 'WorkItemsTable',
    collaboration: 'CollaborationTable',
    documents: 'DocumentsTable',
    'workspace-search': 'WorkspaceSearchTable',
    'migration-state': 'WorkspaceSearchMigrationState',
  }
}

/**
 * Creates detached immutable TableIds for all six roles.
 *
 * @returns Stable distinct physical identifiers.
 */
function createTableIds(): WorkspaceSearchWriterFenceTableIds {
  return {
    'project-directory': 'table-id-project-directory',
    'work-items': 'table-id-work-items',
    collaboration: 'table-id-collaboration',
    documents: 'table-id-documents',
    'workspace-search': 'table-id-workspace-search',
    'migration-state': 'table-id-migration-state',
  }
}

/**
 * Builds one strict active DynamoDB description.
 *
 * @param tableName - Exact physical table name.
 * @param tableId - Exact immutable physical TableId.
 * @returns Minimal strict DescribeTable response.
 */
function createTableDescription(
  tableName: string,
  tableId: string,
): DescribeTableCommandOutput {
  return {
    $metadata: {},
    Table: {
      TableStatus: 'ACTIVE',
      TableName: tableName,
      TableArn:
        `arn:aws:dynamodb:${fixtureRegion}:${fixtureAccount}:table/${tableName}`,
      TableId: tableId,
      CreationDateTime: new Date(fixtureCreationTime),
    },
  }
}

/**
 * Creates the binding independently expected from the fake descriptions.
 *
 * @param tableNames - Exact physical names.
 * @param tableIds - Exact immutable physical IDs.
 * @returns Exact shared writer-fence binding.
 */
function createExpectedBinding(
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
  tableIds: WorkspaceSearchWriterFenceTableIds,
): WorkspaceSearchWriterFenceBinding {
  const stateTableName = tableNames['migration-state']
  const stateTableId = tableIds['migration-state']
  const tableArn =
    `arn:aws:dynamodb:${fixtureRegion}:${fixtureAccount}:table/${stateTableName}`
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName,
    stateTableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest({
        role: 'migration-state',
        tableName: stateTableName,
        tableArn,
        tableId: stateTableId,
        creationTime: fixtureCreationTime.toISOString(),
        account: fixtureAccount,
        region: fixtureRegion,
      }),
    tableIds,
  })
}

/**
 * Creates one complete open-row AWS source fixture.
 *
 * @returns Recording transport, descriptions, and expected durable state.
 */
function createFixture(): WorkspaceSearchWriterFenceAwsFixture {
  const tableNames = createTableNames()
  const tableIds = createTableIds()
  const descriptions = new Map<string, DescribeTableCommandOutput>([
    [
      tableNames['project-directory'],
      createTableDescription(
        tableNames['project-directory'],
        tableIds['project-directory'],
      ),
    ],
    [
      tableNames['work-items'],
      createTableDescription(
        tableNames['work-items'],
        tableIds['work-items'],
      ),
    ],
    [
      tableNames.collaboration,
      createTableDescription(
        tableNames.collaboration,
        tableIds.collaboration,
      ),
    ],
    [
      tableNames.documents,
      createTableDescription(
        tableNames.documents,
        tableIds.documents,
      ),
    ],
    [
      tableNames['workspace-search'],
      createTableDescription(
        tableNames['workspace-search'],
        tableIds['workspace-search'],
      ),
    ],
    [
      tableNames['migration-state'],
      createTableDescription(
        tableNames['migration-state'],
        tableIds['migration-state'],
      ),
    ],
  ])
  const binding = createExpectedBinding(tableNames, tableIds)
  const openRecord = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:01:00.000Z'),
  )
  const transport = new RecordingWorkspaceSearchWriterFenceTransport(
    descriptions,
    {
      $metadata: {},
      Item: encodeWorkspaceSearchWriterFenceRecord(openRecord),
    },
  )
  return {
    tableNames,
    descriptions,
    transport,
    binding,
    openRecord,
  }
}

/**
 * Requires one mutable fake TableDescription.
 *
 * @param fixture - Complete test fixture.
 * @param tableName - Exact configured name being mutated.
 * @returns Existing fake table description.
 */
function requireFixtureTable(
  fixture: WorkspaceSearchWriterFenceAwsFixture,
  tableName: string,
): TableDescription {
  const table = fixture.descriptions.get(tableName)?.Table
  if (table === undefined) throw new Error('INVALID_TEST_FIXTURE')
  return table
}

/**
 * Verifies one operation rejects with only the stable unavailable failure.
 *
 * @param operation - Source operation expected to fail closed.
 */
async function expectUnavailable(
  operation: () => Promise<unknown>,
): Promise<void> {
  let failure: unknown
  try {
    await operation()
  } catch (error: unknown) {
    failure = error
  }
  expect(failure).toBeInstanceOf(
    WorkspaceSearchWriterFenceUnavailableError,
  )
  if (!(failure instanceof WorkspaceSearchWriterFenceUnavailableError)) {
    throw new Error('EXPECTED_UNAVAILABLE_FAILURE')
  }
  expect(failure.name).toBe(
    'WorkspaceSearchWriterFenceUnavailableError',
  )
  expect(failure.message).toBe(
    'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE',
  )
  expect(failure.code).toBe(
    'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE',
  )
  expect(Reflect.has(failure, 'cause')).toBe(false)
  expect(String(failure)).not.toContain('RAW_')
}

describe('Workspace Search writer-fence AWS source', () => {
  test('measures exact six tables, strongly reads the row, and returns the open guard', async () => {
    const fixture = createFixture()

    const guard =
      await acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        fixture.tableNames,
        fixture.transport,
      )

    expect(guard).toEqual(createWorkspaceSearchWriterFenceGuardMaterial(
      { status: 'present', record: fixture.openRecord },
      fixture.binding,
    ))
    expect(
      fixture.transport.describeCommands.map(
        (command) => command.input,
      ),
    ).toEqual([
      { TableName: fixture.tableNames['project-directory'] },
      { TableName: fixture.tableNames['work-items'] },
      { TableName: fixture.tableNames.collaboration },
      { TableName: fixture.tableNames.documents },
      { TableName: fixture.tableNames['workspace-search'] },
      { TableName: fixture.tableNames['migration-state'] },
    ])
    expect(fixture.transport.getCommands).toHaveLength(1)
    expect(fixture.transport.getCommands[0]?.input).toEqual(
      createWorkspaceSearchWriterFenceReadMaterial(fixture.binding),
    )
    expect(fixture.transport.getCommands[0]?.input.ConsistentRead).toBe(
      true,
    )
  })

  test('remeasures on every source acquisition and ignores later caller dependency mutation', async () => {
    const fixture = createFixture()
    const source = createAwsWorkspaceSearchWriterFenceGuardSource(
      fixture.tableNames,
      fixture.transport,
    )
    expect(fixture.transport.describeCommands).toHaveLength(0)
    expect(fixture.transport.getCommands).toHaveLength(0)
    Reflect.set(
      fixture.tableNames,
      'migration-state',
      'CallerMutatedMigrationState',
    )
    Reflect.set(
      fixture.transport,
      'describeTable',
      () => Promise.reject(new Error('RAW_MUTATED_TRANSPORT')),
    )

    const first = await source.acquire()
    const second = await source.acquire()

    expect(second).toEqual(first)
    expect(fixture.transport.describeCommands).toHaveLength(12)
    expect(fixture.transport.getCommands).toHaveLength(2)
    expect(
      fixture.transport.describeCommands.filter(
        (command) =>
          command.input.TableName ===
          'WorkspaceSearchMigrationState',
      ),
    ).toHaveLength(2)
  })

  test('collapses missing, closed, and malformed rows to unavailable', async () => {
    const missing = createFixture()
    missing.transport.setGetOutput({ $metadata: {} })
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        missing.tableNames,
        missing.transport,
      )
    )

    const closed = createFixture()
    const closedRecord =
      createWorkspaceSearchWriterFenceClosedSuccessor(
        closed.openRecord,
        {
          configurationHash: 'a'.repeat(64),
          runId: 'run-01',
          ownerId: 'owner-01',
          leaseFenceToken: 1,
          maintenanceEvidenceReceiptDigest: 'b'.repeat(64),
          maintenanceEvidencePointerRevision: 1,
        },
        new Date('2026-07-29T00:02:00.000Z'),
      )
    closed.transport.setGetOutput({
      $metadata: {},
      Item: encodeWorkspaceSearchWriterFenceRecord(closedRecord),
    })
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        closed.tableNames,
        closed.transport,
      )
    )

    const malformed = createFixture()
    malformed.transport.setGetOutput({
      $metadata: {},
      Item: {
        ...encodeWorkspaceSearchWriterFenceRecord(
          malformed.openRecord,
        ),
        rawUnexpectedValue: { S: 'RAW_SECRET_ROW_VALUE' },
      },
    })
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        malformed.tableNames,
        malformed.transport,
      )
    )
  })

  test('rejects cross-account, cross-region, and duplicate TableId measurements', async () => {
    const crossAccount = createFixture()
    const accountTable = requireFixtureTable(
      crossAccount,
      crossAccount.tableNames.documents,
    )
    accountTable.TableArn =
      `arn:aws:dynamodb:${fixtureRegion}:210987654321:table/${crossAccount.tableNames.documents}`
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        crossAccount.tableNames,
        crossAccount.transport,
      )
    )

    const crossRegion = createFixture()
    const regionTable = requireFixtureTable(
      crossRegion,
      crossRegion.tableNames.collaboration,
    )
    regionTable.TableArn =
      `arn:aws:dynamodb:us-east-1:${fixtureAccount}:table/${crossRegion.tableNames.collaboration}`
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        crossRegion.tableNames,
        crossRegion.transport,
      )
    )

    const duplicate = createFixture()
    const duplicateTable = requireFixtureTable(
      duplicate,
      duplicate.tableNames['work-items'],
    )
    duplicateTable.TableId = createTableIds()['project-directory']
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        duplicate.tableNames,
        duplicate.transport,
      )
    )
  })

  test('strictly rejects inactive or identity-malformed table descriptions', async () => {
    const mutations = [
      (fixture: WorkspaceSearchWriterFenceAwsFixture) => {
        requireFixtureTable(
          fixture,
          fixture.tableNames.documents,
        ).TableStatus = 'UPDATING'
      },
      (fixture: WorkspaceSearchWriterFenceAwsFixture) => {
        requireFixtureTable(
          fixture,
          fixture.tableNames.documents,
        ).TableName = 'DifferentDocumentsTable'
      },
      (fixture: WorkspaceSearchWriterFenceAwsFixture) => {
        requireFixtureTable(
          fixture,
          fixture.tableNames.documents,
        ).TableArn =
          `arn:aws:s3:${fixtureRegion}:${fixtureAccount}:table/${fixture.tableNames.documents}`
      },
      (fixture: WorkspaceSearchWriterFenceAwsFixture) => {
        requireFixtureTable(
          fixture,
          fixture.tableNames.documents,
        ).TableId = 'contains whitespace'
      },
      (fixture: WorkspaceSearchWriterFenceAwsFixture) => {
        requireFixtureTable(
          fixture,
          fixture.tableNames.documents,
        ).CreationDateTime = new Date(Number.NaN)
      },
    ]

    for (const mutate of mutations) {
      const fixture = createFixture()
      mutate(fixture)
      await expectUnavailable(() =>
        acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
          fixture.tableNames,
          fixture.transport,
        )
      )
    }
  })

  test('collapses malformed configuration and raw Describe/Get failures without retaining causes', async () => {
    const malformedConfiguration = createFixture()
    Reflect.set(
      malformedConfiguration.tableNames,
      'unexpected-role',
      'RAW_SECRET_TABLE',
    )
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        malformedConfiguration.tableNames,
        malformedConfiguration.transport,
      )
    )

    const describeFailure = createFixture()
    describeFailure.transport.setFailure(
      new Error('RAW_DESCRIBE_SECRET'),
    )
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        describeFailure.tableNames,
        describeFailure.transport,
      )
    )

    const getFailure = createFixture()
    const originalGetItem = getFailure.transport.getItem
    Reflect.set(
      getFailure.transport,
      'getItem',
      () => Promise.reject(new Error('RAW_GET_SECRET')),
    )
    await expectUnavailable(() =>
      acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
        getFailure.tableNames,
        getFailure.transport,
      )
    )
    Reflect.set(getFailure.transport, 'getItem', originalGetItem)
  })
})
