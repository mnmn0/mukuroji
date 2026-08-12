import { describe, expect, test } from 'bun:test'
import type {
  AttributeValue,
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandOutput,
  ScanCommandOutput,
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  compareWorkItemsIntegrityManifests,
  createWorkItemsIntegrityManifest,
  parseWorkItemsIntegrityManifest,
  type SourceCaptureConsistency,
  type WorkItemsIntegrityManifest,
  type WorkItemsIntegrityReadPort,
  type WorkItemsIntegrityRole,
} from './work-items-integrity'

const TEST_ACCOUNT = '123456789012'
const OTHER_ACCOUNT = '210987654321'
const TEST_REGION = 'ap-northeast-1'
const SOURCE_TABLE_NAME = 'mukuroji-work-items-source'
const RESTORE_TABLE_NAME = 'mukuroji-work-items-restore'
const SOURCE_TABLE_ID = 'source-table-id'
const RESTORE_TABLE_ID = 'restore-table-id'
const SOURCE_WINDOW_START = new Date('2026-07-01T00:00:00.000Z')
const SOURCE_WINDOW_END = new Date('2026-07-31T23:59:59.999Z')
const RESTORE_POINT = new Date('2026-07-15T12:00:00.000Z')
const FIXED_NOW = new Date('2026-07-20T00:00:00.000Z')
const DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const OTHER_DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)

/** Optional raw values used to build one canonical DynamoDB Work Item fixture. */
type CanonicalItemOptions = {
  /** Workspace identifier used in the derived team partition key. */
  directoryId?: string
  /** Member email used as both assignee and creator data. */
  email?: string
  /** Work Item primary sort key. */
  issueId?: string
  /** Emits an invalid revision while retaining all raw canary fields. */
  invalidRevision?: boolean
  /** Reverses semantically unordered map and set insertion order. */
  reverseContainers?: boolean
  /** Team identifier used in the derived partition key. */
  teamId?: string
  /** Literal Work Item title. */
  title?: string
}

/** Options for constructing a realistic DescribeTable response. */
type TableFixtureOptions = {
  /** AWS account embedded in the table ARN. */
  account: string
  /** Optional global secondary index projection override. */
  gsiProjection?: 'ALL' | 'KEYS_ONLY'
  /** Optional global secondary index state override. */
  gsiStatus?: 'ACTIVE' | 'UPDATING'
  /** AWS region embedded in the table ARN. */
  region: string
  /** Optional restore point included for restore tables. */
  restoreDateTime?: Date
  /** Source ARN included in DynamoDB restore provenance. */
  restoreSourceArn?: string
  /** Manifest role represented by the table. */
  role: WorkItemsIntegrityRole
  /** Optional ARN override used to test immutable identity validation. */
  tableArn?: string
  /** DynamoDB immutable table identifier. */
  tableId: string
  /** Physical DynamoDB table name. */
  tableName: string
  /** Optional table state override. */
  tableStatus?: 'ACTIVE' | 'UPDATING'
}

/** One recorded call to the paginated scan port. */
type ScanInvocation = {
  /** Opaque cursor passed from the immediately preceding page. */
  exclusiveStartKey?: Record<string, AttributeValue>
  /** Explicit physical table name passed to the port. */
  tableName: string
}

/** Fixed responses used by the in-memory read-only integrity port. */
type FakeReaderOptions = {
  /** Caller account returned by the fake STS operation. */
  callerAccount: string
  /** Point-in-time recovery response. */
  continuousBackups: DescribeContinuousBackupsCommandOutput
  /** Ordered scan pages returned by the port. */
  scanPages: ScanCommandOutput[]
  /** Table metadata response. */
  table: DescribeTableCommandOutput
  /** Time-to-live response. */
  ttl: DescribeTimeToLiveCommandOutput
}

/** Complete options for starting a manifest creation attempt. */
type ManifestFixtureOptions = {
  /** Expected AWS account and default table ARN account. */
  account?: string
  /** Caller account returned before any DynamoDB operation. */
  callerAccount?: string
  /** Digest key supplied to manifest creation. */
  digestKey?: Uint8Array
  /** Optional global secondary index projection override. */
  gsiProjection?: 'ALL' | 'KEYS_ONLY'
  /** Optional global secondary index state override. */
  gsiStatus?: 'ACTIVE' | 'UPDATING'
  /** Items placed on a single default scan page. */
  items?: Record<string, AttributeValue>[]
  /** Whether point-in-time recovery is enabled. */
  pitrEnabled?: boolean
  /** Expected AWS region and default table ARN region. */
  region?: string
  /** Restore point included for a restore manifest. */
  restoreDateTime?: Date
  /** Source table ARN included in restore provenance. */
  restoreSourceArn?: string
  /** Source or restore role. */
  role: WorkItemsIntegrityRole
  /** Explicit scan pages, overriding the single-page items fixture. */
  scanPages?: ScanCommandOutput[]
  /** Source write-isolation declaration. */
  sourceConsistency?: SourceCaptureConsistency
  /** Optional table ARN override. */
  tableArn?: string
  /** DynamoDB immutable table identifier. */
  tableId?: string
  /** Optional DescribeTable fields merged into the canonical table fixture. */
  tableOverrides?: Partial<TableDescription>
  /** Explicit physical table name. */
  tableName?: string
  /** Optional table state override. */
  tableStatus?: 'ACTIVE' | 'UPDATING'
  /** Time-to-live state returned by DynamoDB. */
  ttlStatus?: 'DISABLED' | 'ENABLED'
}

/** A manifest promise paired with its observable fake port. */
type ManifestAttempt = {
  /** Pending manifest creation result. */
  promise: Promise<WorkItemsIntegrityManifest>
  /** Fake reader used by the creation attempt. */
  reader: FakeWorkItemsIntegrityReadPort
}

/** A completed manifest paired with its observable fake port. */
type CreatedManifest = {
  /** Authenticated manifest produced by the core API. */
  manifest: WorkItemsIntegrityManifest
  /** Fake reader used to produce the manifest. */
  reader: FakeWorkItemsIntegrityReadPort
}

/** In-memory implementation of every read-only AWS operation used by the verifier. */
class FakeWorkItemsIntegrityReadPort implements WorkItemsIntegrityReadPort {
  /** Number of caller identity reads. */
  readCallerAccountCallCount = 0
  /** Physical table names passed to DescribeTable. */
  readonly describeTableCalls: string[] = []
  /** Physical table names passed to DescribeContinuousBackups. */
  readonly describeContinuousBackupsCalls: string[] = []
  /** Physical table names passed to DescribeTimeToLive. */
  readonly describeTimeToLiveCalls: string[] = []
  /** Ordered scan calls including their port-level cursors. */
  readonly scanCalls: ScanInvocation[] = []
  /** Caller account returned by the fake. */
  private readonly callerAccount: string
  /** Fixed point-in-time recovery response. */
  private readonly continuousBackups: DescribeContinuousBackupsCommandOutput
  /** Fixed ordered scan pages. */
  private readonly scanPages: ScanCommandOutput[]
  /** Fixed table metadata response. */
  private readonly table: DescribeTableCommandOutput
  /** Fixed time-to-live response. */
  private readonly ttl: DescribeTimeToLiveCommandOutput

  /**
   * Creates an isolated read-only port with deterministic responses.
   *
   * @param options - Responses returned by each fake AWS operation.
   */
  constructor(options: FakeReaderOptions) {
    this.callerAccount = options.callerAccount
    this.continuousBackups = options.continuousBackups
    this.scanPages = options.scanPages
    this.table = options.table
    this.ttl = options.ttl
  }

  /**
   * Returns the configured caller account.
   *
   * @returns Fake caller account.
   */
  async readCallerAccount(): Promise<string> {
    this.readCallerAccountCallCount += 1
    return this.callerAccount
  }

  /**
   * Returns the configured table metadata.
   *
   * @param tableName - Explicit table requested by the core.
   * @returns Fake DescribeTable response.
   */
  async describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    this.describeTableCalls.push(tableName)
    return this.table
  }

  /**
   * Returns the configured recovery state.
   *
   * @param tableName - Explicit table requested by the core.
   * @returns Fake DescribeContinuousBackups response.
   */
  async describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    this.describeContinuousBackupsCalls.push(tableName)
    return this.continuousBackups
  }

  /**
   * Returns the configured time-to-live state.
   *
   * @param tableName - Explicit table requested by the core.
   * @returns Fake DescribeTimeToLive response.
   */
  async describeTimeToLive(
    tableName: string,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    this.describeTimeToLiveCalls.push(tableName)
    return this.ttl
  }

  /**
   * Returns the next configured scan page and records the supplied cursor.
   *
   * @param tableName - Explicit table requested by the core.
   * @param exclusiveStartKey - Cursor from the preceding port response.
   * @returns Next fake scan page.
   */
  async scanPage(
    tableName: string,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput> {
    const pageIndex = this.scanCalls.length
    this.scanCalls.push(
      exclusiveStartKey === undefined
        ? { tableName }
        : { tableName, exclusiveStartKey },
    )
    return this.scanPages[pageIndex] ?? createScanPage([])
  }
}

/**
 * Creates a DynamoDB string AttributeValue.
 *
 * @param value - Raw string.
 * @returns Low-level string attribute.
 */
function stringAttribute(value: string): AttributeValue {
  return { S: value }
}

/**
 * Creates a lossless DynamoDB number AttributeValue.
 *
 * @param value - Raw decimal representation.
 * @returns Low-level number attribute.
 */
function numberAttribute(value: string): AttributeValue {
  return { N: value }
}

/**
 * Creates a DynamoDB list AttributeValue.
 *
 * @param values - Ordered child attributes.
 * @returns Low-level list attribute.
 */
function listAttribute(values: AttributeValue[]): AttributeValue {
  return { L: values }
}

/**
 * Creates a DynamoDB map AttributeValue.
 *
 * @param value - Child attribute map.
 * @returns Low-level map attribute.
 */
function mapAttribute(value: Record<string, AttributeValue>): AttributeValue {
  return { M: value }
}

/**
 * Creates a DynamoDB string-set AttributeValue.
 *
 * @param values - Unordered unique set values.
 * @returns Low-level string-set attribute.
 */
function stringSetAttribute(values: string[]): AttributeValue {
  return { SS: values }
}

/**
 * Creates a strict canonical Work Item as a raw low-level DynamoDB item.
 *
 * @param options - Optional row and container-order overrides.
 * @returns Canonical raw DynamoDB item.
 */
function createCanonicalItem(
  options: CanonicalItemOptions = {},
): Record<string, AttributeValue> {
  const directoryId = options.directoryId ?? 'workspace-1'
  const teamId = options.teamId ?? 'core'
  const email = options.email ?? 'member@example.com'
  const customFieldValues = options.reverseContainers
    ? {
        labels: listAttribute([
          stringAttribute('backend'),
          stringAttribute('urgent'),
        ]),
        estimate: numberAttribute('3'),
      }
    : {
        estimate: numberAttribute('3'),
        labels: listAttribute([
          stringAttribute('backend'),
          stringAttribute('urgent'),
        ]),
      }
  const integrityMetadata = options.reverseContainers
    ? {
        beta: stringAttribute('second'),
        alpha: stringAttribute('first'),
      }
    : {
        alpha: stringAttribute('first'),
        beta: stringAttribute('second'),
      }
  const integrityTags = options.reverseContainers
    ? ['zeta', 'alpha']
    : ['alpha', 'zeta']

  return {
    schemaVersion: numberAttribute('2'),
    revision: numberAttribute(options.invalidRevision ? '0' : '1'),
    workflowSchemaVersion: numberAttribute('1'),
    directoryId: stringAttribute(directoryId),
    directoryTeamId: stringAttribute(`${directoryId}#team#${teamId}`),
    directoryProjectId: stringAttribute(`${directoryId}#project#platform`),
    teamId: stringAttribute(teamId),
    assignedProjectId: stringAttribute('platform'),
    issueId: stringAttribute(options.issueId ?? 'issue-1'),
    sortOrder: numberAttribute('10'),
    title: stringAttribute(options.title ?? 'Example Work Item'),
    description: stringAttribute('Canonical Work Item'),
    assigneeUserId: stringAttribute(email),
    creatorMemberKey: stringAttribute(email),
    workflowStatusId: stringAttribute('in-progress'),
    statusCategory: stringAttribute('started'),
    customFieldValues: mapAttribute(customFieldValues),
    relationIds: listAttribute([
      stringAttribute('blocks:blocked-item'),
      stringAttribute('related:related-item'),
    ]),
    dueDate: stringAttribute('2026-07-31'),
    schedule: mapAttribute({
      mode: stringAttribute('due-date'),
      dueDate: stringAttribute('2026-07-31'),
      calendarPolicy: mapAttribute({
        timeZone: stringAttribute('UTC'),
        workingWeekdays: listAttribute([
          stringAttribute('monday'),
          stringAttribute('tuesday'),
          stringAttribute('wednesday'),
          stringAttribute('thursday'),
          stringAttribute('friday'),
        ]),
        holidays: listAttribute([]),
      }),
    }),
    priority: stringAttribute('medium'),
    createdAt: stringAttribute('2026-07-01T09:00:00.000Z'),
    updatedAt: stringAttribute('2026-07-12T09:00:00.000Z'),
    integrityMetadata: mapAttribute(integrityMetadata),
    integrityTags: stringSetAttribute(integrityTags),
  }
}

/**
 * Reverses top-level map insertion order without changing any DynamoDB values.
 *
 * @param value - Attribute map to reorder.
 * @returns Semantically identical map with reversed insertion order.
 */
function reverseAttributeMap(
  value: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(value).reverse())
}

/**
 * Creates an opaque scan cursor.
 *
 * @param value - Canary cursor payload.
 * @returns Raw DynamoDB cursor map.
 */
function createCursor(value: string): Record<string, AttributeValue> {
  return {
    directoryTeamId: stringAttribute(value),
    issueId: stringAttribute(`${value}-issue`),
  }
}

/**
 * Creates one fake low-level Scan response.
 *
 * @param items - Raw items on the page.
 * @param lastEvaluatedKey - Optional cursor for a following page.
 * @returns Fake Scan response.
 */
function createScanPage(
  items: Record<string, AttributeValue>[],
  lastEvaluatedKey?: Record<string, AttributeValue>,
): ScanCommandOutput {
  return {
    $metadata: {},
    Items: items,
    LastEvaluatedKey: lastEvaluatedKey,
  }
}

/**
 * Builds the expected Work Items table ARN.
 *
 * @param account - AWS account.
 * @param region - AWS region.
 * @param tableName - Physical table name.
 * @returns DynamoDB table ARN.
 */
function createTableArn(
  account: string,
  region: string,
  tableName: string,
): string {
  return `arn:aws:dynamodb:${region}:${account}:table/${tableName}`
}

/**
 * Creates complete Work Items table metadata including all required indexes.
 *
 * @param options - Table identity, role, and optional invalid descriptor overrides.
 * @returns DynamoDB table description.
 */
function createTableDescription(options: TableFixtureOptions): TableDescription {
  return {
    TableName: options.tableName,
    TableArn: options.tableArn ??
      createTableArn(options.account, options.region, options.tableName),
    TableId: options.tableId,
    CreationDateTime: new Date('2026-01-01T00:00:00.000Z'),
    TableStatus: options.tableStatus ?? 'ACTIVE',
    AttributeDefinitions: [
      { AttributeName: 'directoryProjectId', AttributeType: 'S' },
      { AttributeName: 'directoryTeamId', AttributeType: 'S' },
      { AttributeName: 'issueId', AttributeType: 'S' },
      { AttributeName: 'sortOrder', AttributeType: 'N' },
      { AttributeName: 'updatedAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
      { AttributeName: 'issueId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'AssignedProjectIssueIndex',
        IndexStatus: options.gsiStatus ?? 'ACTIVE',
        KeySchema: [
          { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
          { AttributeName: 'sortOrder', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: options.gsiProjection ?? 'ALL' },
      },
      {
        IndexName: 'TeamIssueSortOrderIndex',
        IndexStatus: 'ACTIVE',
        KeySchema: [
          { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
          { AttributeName: 'sortOrder', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'TeamIssueUpdatedAtIndex',
        IndexStatus: 'ACTIVE',
        KeySchema: [
          { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    SSEDescription: { Status: 'ENABLED', SSEType: 'AES256' },
    LocalSecondaryIndexes: [],
    RestoreSummary: options.role === 'restore'
      ? {
          SourceTableArn: options.restoreSourceArn,
          RestoreDateTime: options.restoreDateTime,
          RestoreInProgress: false,
        }
      : undefined,
  }
}

/**
 * Creates a fake point-in-time recovery response.
 *
 * @param enabled - Whether PITR is enabled for this table.
 * @returns Complete backup description.
 */
function createContinuousBackups(
  enabled: boolean,
): DescribeContinuousBackupsCommandOutput {
  return {
    $metadata: {},
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: 'ENABLED',
      PointInTimeRecoveryDescription: enabled
        ? {
            PointInTimeRecoveryStatus: 'ENABLED',
            EarliestRestorableDateTime: SOURCE_WINDOW_START,
            LatestRestorableDateTime: SOURCE_WINDOW_END,
          }
        : {
            PointInTimeRecoveryStatus: 'DISABLED',
          },
    },
  }
}

/**
 * Creates a fake DynamoDB TTL response.
 *
 * @param status - TTL status exposed by DynamoDB.
 * @returns Complete TTL description.
 */
function createTtlDescription(
  status: 'DISABLED' | 'ENABLED',
): DescribeTimeToLiveCommandOutput {
  return {
    $metadata: {},
    TimeToLiveDescription: {
      TimeToLiveStatus: status,
    },
  }
}

/**
 * Starts manifest creation and exposes the fake port before the promise settles.
 *
 * @param options - Role, identity, descriptor, and scan fixtures.
 * @returns Pending manifest and observable fake reader.
 */
function startManifestCreation(options: ManifestFixtureOptions): ManifestAttempt {
  const account = options.account ?? TEST_ACCOUNT
  const region = options.region ?? TEST_REGION
  const tableName = options.tableName ??
    (options.role === 'source' ? SOURCE_TABLE_NAME : RESTORE_TABLE_NAME)
  const tableId = options.tableId ??
    (options.role === 'source' ? SOURCE_TABLE_ID : RESTORE_TABLE_ID)
  const sourceArn = options.restoreSourceArn ??
    createTableArn(account, region, SOURCE_TABLE_NAME)
  const table: TableDescription = {
    ...createTableDescription({
      account,
      gsiProjection: options.gsiProjection,
      gsiStatus: options.gsiStatus,
      region,
      restoreDateTime: options.restoreDateTime ?? RESTORE_POINT,
      restoreSourceArn: sourceArn,
      role: options.role,
      tableArn: options.tableArn,
      tableId,
      tableName,
      tableStatus: options.tableStatus,
    }),
    ...options.tableOverrides,
  }
  const scanPages = options.scanPages ??
    [createScanPage(options.items ?? [createCanonicalItem()])]
  const reader = new FakeWorkItemsIntegrityReadPort({
    callerAccount: options.callerAccount ?? account,
    continuousBackups: createContinuousBackups(
      options.pitrEnabled ?? options.role === 'source',
    ),
    scanPages,
    table: {
      $metadata: {},
      Table: table,
    },
    ttl: createTtlDescription(options.ttlStatus ?? 'DISABLED'),
  })
  const promise = createWorkItemsIntegrityManifest({
    account,
    digestKey: options.digestKey ?? DIGEST_KEY,
    now: () => FIXED_NOW,
    profile: 'integrity-read-only',
    reader,
    region,
    role: options.role,
    sourceConsistency: options.role === 'source'
      ? options.sourceConsistency ?? 'writer-fenced'
      : undefined,
    tableName,
  })
  return { promise, reader }
}

/**
 * Creates a manifest and retains its fake call trace.
 *
 * @param options - Role, identity, descriptor, and scan fixtures.
 * @returns Completed manifest and fake reader.
 */
async function createManifestFixture(
  options: ManifestFixtureOptions,
): Promise<CreatedManifest> {
  const attempt = startManifestCreation(options)
  return {
    manifest: await attempt.promise,
    reader: attempt.reader,
  }
}

/**
 * Captures a rejected promise without narrowing or serializing its raw cause.
 *
 * @param promise - Promise expected to reject.
 * @returns Rejection value, or a synthetic failure when the promise resolved.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  return new Error('Expected promise to reject')
}

describe('Work Items integrity manifest core', () => {
  test('passes an exact writer-fenced source and isolated restore comparison', async () => {
    const items = [
      createCanonicalItem({ issueId: 'issue-1' }),
      createCanonicalItem({
        directoryId: 'workspace-2',
        issueId: 'issue-2',
        teamId: 'platform',
      }),
    ]
    const source = await createManifestFixture({
      role: 'source',
      items,
      sourceConsistency: 'writer-fenced',
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items,
      restoreSourceArn: source.manifest.observed.tableArn,
    })

    expect(source.manifest.scan.captureContext).toBe('writer-fenced')
    expect(source.manifest.scan.snapshotIsolation).toBe(false)
    expect(source.manifest.scan.consistentRead).toBe(true)
    expect(restore.manifest.scan.captureContext).toBe('isolated-restore')
    expect(restore.manifest.pitr).toEqual({
      status: 'DISABLED',
      earliestRestorableTime: null,
      latestRestorableTime: null,
    })
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'pass',
      failureCodes: [],
    })
  })

  test('accepts partition-specific AWS region shapes consistently with the CLI', async () => {
    const source = await createManifestFixture({
      role: 'source',
      region: 'us-iso-east-1',
    })

    expect(source.manifest.requested.region).toBe('us-iso-east-1')
  })

  test('fails exact comparison for a live source observation', async () => {
    const item = createCanonicalItem()
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
      sourceConsistency: 'live-observation',
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [item],
      restoreSourceArn: source.manifest.observed.tableArn,
    })

    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: ['SOURCE_NOT_WRITER_FENCED'],
    })
  })

  test('fails comparison when source and restore manifest roles are reversed', async () => {
    const item = createCanonicalItem()
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [item],
      restoreSourceArn: source.manifest.observed.tableArn,
    })

    const comparison = compareWorkItemsIntegrityManifests(
      restore.manifest,
      source.manifest,
      DIGEST_KEY,
    )

    expect(comparison.status).toBe('fail')
    expect(comparison.failureCodes).toContain('MANIFEST_ROLE_MISMATCH')
  })

  test('is stable across item order, page boundaries, empty pages, maps, and sets', async () => {
    const firstCursor = createCursor('cursor-page-one')
    const secondCursor = createCursor('cursor-page-two')
    const restoreCursor = createCursor('cursor-restore-page')
    const firstItem = createCanonicalItem({ issueId: 'issue-a' })
    const secondItem = createCanonicalItem({
      directoryId: 'workspace-2',
      issueId: 'issue-b',
      teamId: 'platform',
    })
    const source = await createManifestFixture({
      role: 'source',
      scanPages: [
        createScanPage([firstItem], firstCursor),
        createScanPage([], secondCursor),
        createScanPage([secondItem]),
      ],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      restoreSourceArn: source.manifest.observed.tableArn,
      scanPages: [
        createScanPage([
          reverseAttributeMap(createCanonicalItem({
            directoryId: 'workspace-2',
            issueId: 'issue-b',
            reverseContainers: true,
            teamId: 'platform',
          })),
        ], restoreCursor),
        createScanPage([
          reverseAttributeMap(createCanonicalItem({
            issueId: 'issue-a',
            reverseContainers: true,
          })),
        ]),
      ],
    })

    expect(source.manifest.scan.pageCount).toBe(3)
    expect(restore.manifest.scan.pageCount).toBe(2)
    expect(source.reader.scanCalls).toEqual([
      { tableName: SOURCE_TABLE_NAME },
      { tableName: SOURCE_TABLE_NAME, exclusiveStartKey: firstCursor },
      { tableName: SOURCE_TABLE_NAME, exclusiveStartKey: secondCursor },
    ])
    expect(restore.reader.scanCalls).toEqual([
      { tableName: RESTORE_TABLE_NAME },
      { tableName: RESTORE_TABLE_NAME, exclusiveStartKey: restoreCursor },
    ])
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'pass',
      failureCodes: [],
    })
  })

  test('uses a pinned locale-independent digest for non-ASCII map keys', async () => {
    const item = createCanonicalItem()
    item.integrityMetadata = mapAttribute({
      ä: stringAttribute('umlaut'),
      z: stringAttribute('ascii'),
      あ: stringAttribute('hiragana'),
    })
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
    })

    expect(source.manifest.digest.contentDigest)
      .toBe('c583cc3b7f5bf04447e86e287983d82e7d97ad697d8e03ff93cd19d3fd738d10')
  })

  test('rejects string sets where canonical Work Item arrays require lists', async () => {
    const relationSetItem = createCanonicalItem()
    relationSetItem.relationIds = stringSetAttribute([
      'blocks:blocked-item',
      'related:related-item',
    ])
    const relationAttempt = startManifestCreation({
      role: 'source',
      items: [relationSetItem],
    })

    await expect(relationAttempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })

    const customFieldSetItem = createCanonicalItem()
    customFieldSetItem.customFieldValues = mapAttribute({
      labels: stringSetAttribute(['backend', 'urgent']),
    })
    const customFieldAttempt = startManifestCreation({
      role: 'source',
      items: [customFieldSetItem],
    })

    await expect(customFieldAttempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })
  })

  test('requires schema-v2 schedules whose derived due-date projection matches', async () => {
    const legacyItem = createCanonicalItem()
    legacyItem.schemaVersion = numberAttribute('1')
    delete legacyItem.schedule
    const legacyAttempt = startManifestCreation({
      role: 'source',
      items: [legacyItem],
    })

    await expect(legacyAttempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })

    const missingScheduleItem = createCanonicalItem()
    delete missingScheduleItem.schedule
    const missingScheduleAttempt = startManifestCreation({
      role: 'source',
      items: [missingScheduleItem],
    })

    await expect(missingScheduleAttempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })

    const mismatchedProjectionItem = createCanonicalItem()
    mismatchedProjectionItem.dueDate = stringAttribute('2026-08-01')
    const mismatchedProjectionAttempt = startManifestCreation({
      role: 'source',
      items: [mismatchedProjectionItem],
    })

    await expect(mismatchedProjectionAttempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })
  })

  test('rejects an account mismatch before any DynamoDB operation or scan', async () => {
    const attempt = startManifestCreation({
      role: 'source',
      callerAccount: OTHER_ACCOUNT,
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'ACCOUNT_MISMATCH',
    })
    expect(attempt.reader.readCallerAccountCallCount).toBe(1)
    expect(attempt.reader.describeTableCalls).toEqual([])
    expect(attempt.reader.describeContinuousBackupsCalls).toEqual([])
    expect(attempt.reader.describeTimeToLiveCalls).toEqual([])
    expect(attempt.reader.scanCalls).toEqual([])
  })

  test('rejects digest keys shorter or longer than 32 bytes before any read', async () => {
    for (const byteLength of [31, 33]) {
      const attempt = startManifestCreation({
        role: 'source',
        digestKey: new Uint8Array(byteLength),
      })

      await expect(attempt.promise).rejects.toMatchObject({
        code: 'DIGEST_KEY_INVALID',
      })
      expect(attempt.reader.readCallerAccountCallCount).toBe(0)
      expect(attempt.reader.describeTableCalls).toEqual([])
      expect(attempt.reader.describeContinuousBackupsCalls).toEqual([])
      expect(attempt.reader.describeTimeToLiveCalls).toEqual([])
      expect(attempt.reader.scanCalls).toEqual([])
    }
  })

  test('requires source PITR but allows PITR to be disabled on an isolated restore', async () => {
    const sourceAttempt = startManifestCreation({
      role: 'source',
      pitrEnabled: false,
    })

    await expect(sourceAttempt.promise).rejects.toMatchObject({
      code: 'PITR_SOURCE_NOT_READY',
    })
    expect(sourceAttempt.reader.scanCalls).toEqual([])

    const restore = await createManifestFixture({
      role: 'restore',
      pitrEnabled: false,
    })
    expect(restore.manifest.pitr).toEqual({
      status: 'DISABLED',
      earliestRestorableTime: null,
      latestRestorableTime: null,
    })
    expect(restore.reader.scanCalls).toHaveLength(1)
  })

  test('rejects wrong identity, inactive table, invalid GSI, and enabled TTL before scan', async () => {
    const wrongIdentity = startManifestCreation({
      role: 'source',
      tableArn: createTableArn(TEST_ACCOUNT, TEST_REGION, 'wrong-table-name'),
    })
    await expect(wrongIdentity.promise).rejects.toMatchObject({
      code: 'TABLE_IDENTITY_INVALID',
    })
    expect(wrongIdentity.reader.scanCalls).toEqual([])

    const inactive = startManifestCreation({
      role: 'source',
      tableStatus: 'UPDATING',
    })
    await expect(inactive.promise).rejects.toMatchObject({
      code: 'TABLE_NOT_ACTIVE',
    })
    expect(inactive.reader.scanCalls).toEqual([])

    const invalidGsi = startManifestCreation({
      role: 'source',
      gsiStatus: 'UPDATING',
      gsiProjection: 'KEYS_ONLY',
    })
    await expect(invalidGsi.promise).rejects.toMatchObject({
      code: 'GLOBAL_SECONDARY_INDEX_MISMATCH',
    })
    expect(invalidGsi.reader.scanCalls).toEqual([])

    const enabledTtl = startManifestCreation({
      role: 'source',
      ttlStatus: 'ENABLED',
    })
    await expect(enabledTtl.promise).rejects.toMatchObject({
      code: 'TTL_STATE_MISMATCH',
    })
    expect(enabledTtl.reader.scanCalls).toEqual([])
  })

  test('rejects unsupported table descriptor states before scan', async () => {
    const unexpectedLocalIndex = startManifestCreation({
      role: 'source',
      tableOverrides: {
        LocalSecondaryIndexes: [
          {
            IndexName: 'UnexpectedLocalIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      },
    })
    await expect(unexpectedLocalIndex.promise).rejects.toMatchObject({
      code: 'LOCAL_SECONDARY_INDEX_UNEXPECTED',
    })
    expect(unexpectedLocalIndex.reader.scanCalls).toEqual([])

    const invalidAttributes = startManifestCreation({
      role: 'source',
      tableOverrides: {
        AttributeDefinitions: [],
      },
    })
    await expect(invalidAttributes.promise).rejects.toMatchObject({
      code: 'ATTRIBUTE_DEFINITION_MISMATCH',
    })
    expect(invalidAttributes.reader.scanCalls).toEqual([])

    const invalidBillingMode = startManifestCreation({
      role: 'source',
      tableOverrides: {
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
      },
    })
    await expect(invalidBillingMode.promise).rejects.toMatchObject({
      code: 'BILLING_MODE_MISMATCH',
    })
    expect(invalidBillingMode.reader.scanCalls).toEqual([])

    const invalidEncryptionState = startManifestCreation({
      role: 'source',
      tableOverrides: {
        SSEDescription: { Status: 'DISABLED', SSEType: 'AES256' },
      },
    })
    await expect(invalidEncryptionState.promise).rejects.toMatchObject({
      code: 'ENCRYPTION_STATE_INVALID',
    })
    expect(invalidEncryptionState.reader.scanCalls).toEqual([])
  })

  test('rejects a restore without DynamoDB provenance before scan', async () => {
    const attempt = startManifestCreation({
      role: 'restore',
      tableOverrides: {
        RestoreSummary: undefined,
      },
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'RESTORE_SUMMARY_MISSING',
    })
    expect(attempt.reader.scanCalls).toEqual([])
  })

  test('fails closed for an invalid canonical row after scanning all pages', async () => {
    const attempt = startManifestCreation({
      role: 'source',
      items: [
        createCanonicalItem({ issueId: 'valid' }),
        createCanonicalItem({ invalidRevision: true, issueId: 'invalid' }),
      ],
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'INVALID_WORK_ITEM_RECORD',
    })
    expect(attempt.reader.scanCalls).toHaveLength(1)
  })

  test('rejects duplicate primary keys after scanning the table', async () => {
    const attempt = startManifestCreation({
      role: 'source',
      items: [
        createCanonicalItem({ title: 'First duplicate' }),
        createCanonicalItem({ title: 'Second duplicate' }),
      ],
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'DUPLICATE_PRIMARY_KEY',
    })
    expect(attempt.reader.scanCalls).toHaveLength(1)
  })

  test('counts malformed rows toward the hard item limit', async () => {
    const malformedItem: Record<string, AttributeValue> = {}
    const overLimitItems = Array.from(
      { length: 1_000_001 },
      () => malformedItem,
    )
    const attempt = startManifestCreation({
      role: 'source',
      items: overLimitItems,
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'INTEGRITY_LIMIT_EXCEEDED',
    })
    expect(attempt.reader.scanCalls).toHaveLength(1)
  })

  test('rejects a repeated opaque pagination cursor', async () => {
    const repeatedCursor = createCursor('repeated-cursor')
    const attempt = startManifestCreation({
      role: 'source',
      scanPages: [
        createScanPage([createCanonicalItem({ issueId: 'first' })], repeatedCursor),
        createScanPage([createCanonicalItem({ issueId: 'second' })], repeatedCursor),
      ],
    })

    await expect(attempt.promise).rejects.toMatchObject({
      code: 'CURSOR_LOOP',
    })
    expect(attempt.reader.scanCalls).toEqual([
      { tableName: SOURCE_TABLE_NAME },
      { tableName: SOURCE_TABLE_NAME, exclusiveStartKey: repeatedCursor },
    ])
  })

  test('distinguishes content, primary key, and added or removed row mismatches', async () => {
    const first = createCanonicalItem({ issueId: 'issue-1' })
    const second = createCanonicalItem({ issueId: 'issue-2' })
    const source = await createManifestFixture({
      role: 'source',
      items: [first, second],
    })

    const contentChanged = await createManifestFixture({
      role: 'restore',
      restoreSourceArn: source.manifest.observed.tableArn,
      items: [
        createCanonicalItem({ issueId: 'issue-1', title: 'Changed title' }),
        second,
      ],
    })
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      contentChanged.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: ['CONTENT_DIGEST_MISMATCH'],
    })

    const keyChanged = await createManifestFixture({
      role: 'restore',
      restoreSourceArn: source.manifest.observed.tableArn,
      items: [
        createCanonicalItem({ issueId: 'issue-renamed' }),
        second,
      ],
    })
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      keyChanged.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: [
        'CONTENT_DIGEST_MISMATCH',
        'KEY_SET_DIGEST_MISMATCH',
      ],
    })

    const rowRemoved = await createManifestFixture({
      role: 'restore',
      restoreSourceArn: source.manifest.observed.tableArn,
      items: [first],
    })
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      rowRemoved.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: [
        'CONTENT_DIGEST_MISMATCH',
        'ITEM_COUNT_MISMATCH',
        'KEY_SET_DIGEST_MISMATCH',
      ],
    })

    const smallerSource = await createManifestFixture({
      role: 'source',
      items: [first],
    })
    const rowAdded = await createManifestFixture({
      role: 'restore',
      restoreSourceArn: smallerSource.manifest.observed.tableArn,
      items: [first, second],
    })
    expect(compareWorkItemsIntegrityManifests(
      smallerSource.manifest,
      rowAdded.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: [
        'CONTENT_DIGEST_MISMATCH',
        'ITEM_COUNT_MISMATCH',
        'KEY_SET_DIGEST_MISMATCH',
      ],
    })
  })

  test('reports restore source, reused table identity, and PITR window mismatches', async () => {
    const item = createCanonicalItem()
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [item],
      restoreDateTime: new Date('2026-08-01T00:00:00.000Z'),
      restoreSourceArn: createTableArn(
        TEST_ACCOUNT,
        TEST_REGION,
        'different-source',
      ),
      tableId: source.manifest.observed.tableId,
    })

    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: [
        'RESTORE_POINT_OUTSIDE_WINDOW',
        'RESTORE_SOURCE_MISMATCH',
        'TABLE_ID_REUSED',
      ],
    })
  })

  test('rejects comparison with a different digest key', async () => {
    const item = createCanonicalItem()
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [item],
      restoreSourceArn: source.manifest.observed.tableArn,
    })

    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      OTHER_DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: [
        'KEY_FINGERPRINT_MISMATCH',
        'MANIFEST_AUTHENTICATION_FAILED',
      ],
    })
  })

  test('strictly parses manifests and authenticates their MAC during comparison', async () => {
    const item = createCanonicalItem()
    const source = await createManifestFixture({
      role: 'source',
      items: [item],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [item],
      restoreSourceArn: source.manifest.observed.tableArn,
    })
    const parsedSource = parseWorkItemsIntegrityManifest(
      JSON.parse(JSON.stringify(source.manifest)),
    )
    expect(parsedSource).toEqual(source.manifest)

    expect(() => parseWorkItemsIntegrityManifest({
      ...source.manifest,
      unexpectedField: true,
    })).toThrow('INVALID_MANIFEST')
    expect(() => parseWorkItemsIntegrityManifest({
      ...source.manifest,
      manifestVersion: 2,
    })).toThrow('INVALID_MANIFEST')
    expect(() => parseWorkItemsIntegrityManifest({
      ...source.manifest,
      scan: {
        ...source.manifest.scan,
        captureContext: 'isolated-restore',
      },
    })).toThrow('INVALID_MANIFEST')
    expect(() => parseWorkItemsIntegrityManifest({
      ...source.manifest,
      digest: {
        ...source.manifest.digest,
        version: 99,
      },
    })).toThrow('INVALID_MANIFEST')

    const tamperedRestore = parseWorkItemsIntegrityManifest({
      ...restore.manifest,
      manifestMac: '0'.repeat(64),
    })
    expect(compareWorkItemsIntegrityManifests(
      source.manifest,
      tamperedRestore,
      DIGEST_KEY,
    )).toEqual({
      status: 'fail',
      failureCodes: ['MANIFEST_AUTHENTICATION_FAILED'],
    })
  })

  test('never serializes tenant identifiers, titles, emails, cursors, or primary keys', async () => {
    const tenantCanary = 'TENANT-CANARY-DO-NOT-LEAK'
    const titleCanary = 'TITLE-CANARY-DO-NOT-LEAK'
    const emailCanary = 'EMAIL-CANARY-DO-NOT-LEAK@example.com'
    const cursorCanary = 'CURSOR-CANARY-DO-NOT-LEAK'
    const primaryKeyCanary = 'PRIMARY-KEY-CANARY-DO-NOT-LEAK'
    const canaries = [
      tenantCanary,
      titleCanary,
      emailCanary,
      cursorCanary,
      primaryKeyCanary,
    ]
    const item = createCanonicalItem({
      directoryId: tenantCanary,
      email: emailCanary,
      issueId: primaryKeyCanary,
      title: titleCanary,
    })
    const cursor = createCursor(cursorCanary)
    const source = await createManifestFixture({
      role: 'source',
      scanPages: [
        createScanPage([item], cursor),
        createScanPage([]),
      ],
    })
    const restore = await createManifestFixture({
      role: 'restore',
      items: [reverseAttributeMap(item)],
      restoreSourceArn: source.manifest.observed.tableArn,
    })
    const comparison = compareWorkItemsIntegrityManifests(
      source.manifest,
      restore.manifest,
      DIGEST_KEY,
    )
    const invalidAttempt = startManifestCreation({
      role: 'source',
      scanPages: [
        createScanPage([
          createCanonicalItem({
            directoryId: tenantCanary,
            email: emailCanary,
            invalidRevision: true,
            issueId: primaryKeyCanary,
            title: titleCanary,
          }),
        ], cursor),
        createScanPage([]),
      ],
    })
    const failure = await captureRejection(invalidAttempt.promise)
    const serializedEvidence = [
      JSON.stringify(source.manifest),
      JSON.stringify(restore.manifest),
      JSON.stringify(comparison),
      JSON.stringify(failure),
    ]

    expect(comparison.status).toBe('pass')
    for (const serialized of serializedEvidence) {
      for (const canary of canaries) {
        expect(serialized).not.toContain(canary)
      }
    }
  })
})
