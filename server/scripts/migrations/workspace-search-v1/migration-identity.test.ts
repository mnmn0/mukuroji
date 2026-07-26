import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import type {
  AttributeDefinition,
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandOutput,
  GlobalSecondaryIndexDescription,
  KeySchemaElement,
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import type {
  GetBucketEncryptionOutput,
  GetBucketLoggingOutput,
  GetBucketVersioningOutput,
  GetObjectLockConfigurationOutput,
} from '@aws-sdk/client-s3'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationTableRole,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationIdentityAdapterFailure,
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  measureWorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationIdentityPort,
  type WorkspaceSearchMigrationJournalKeyMetadata,
  type WorkspaceSearchMigrationJournalLookup,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'

const TEST_ACCOUNT = '123456789012'
const OTHER_ACCOUNT = '210987654321'
const TEST_REGION = 'ap-northeast-1'
const TEST_COMMIT = 'a'.repeat(40)
const CALLER_ROLE_ID = 'AROA1234567890ABCDEFG'
const JOURNAL_BUCKET = 'mukuroji-migration-journal-production'
const JOURNAL_KEY_ARN =
  `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/12345678-abcd-4321-abcd-1234567890ab`
const DOCUMENTS_KEY_ARN =
  `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const MIGRATION_STATE_KEY_ARN =
  `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`

const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
  'workspace-search',
  'migration-state',
]

/** Schema fixture used to construct one realistic DynamoDB response. */
type TableSchemaFixture = {
  /** DynamoDB scalar attribute definitions. */
  attributeDefinitions: readonly AttributeDefinition[]
  /** Base-table partition and sort key. */
  keySchema: readonly KeySchemaElement[]
  /** Expected global secondary indexes. */
  globalSecondaryIndexes: readonly GlobalSecondaryIndexDescription[]
  /** TTL attribute, or undefined for a disabled TTL configuration. */
  ttlAttribute?: string
  /** Whether the table uses KMS encryption. */
  kmsEncrypted: boolean
  /** Whether deletion protection is enabled. */
  deletionProtection: boolean
}

/** Mutable fake control-plane adapter for identity-validation tests. */
class FakeIdentityPort implements WorkspaceSearchMigrationIdentityPort {
  /** Digest of the immutable resource selection represented by this fake. */
  private readonly requestedResourcesBinding: string

  /** Unexpected STS failure injected by a boundary-redaction test. */
  callerFailure?: unknown

  /** Unexpected DynamoDB failure injected by a boundary-redaction test. */
  tableFailure?: Error

  /** Unexpected S3 failure injected by a boundary-redaction test. */
  bucketFailure?: Error

  /** Object Lock lookup failure injected by an error-mapping test. */
  objectLockFailure?: Error

  /** Bucket-encryption lookup failure injected by an error-mapping test. */
  bucketEncryptionFailure?: Error

  /** Caller identity returned by the STS fake. */
  callerIdentity = {
    account: TEST_ACCOUNT,
    arn: `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/MigrationOperator/test-session`,
    userId: `${CALLER_ROLE_ID}:test-session`,
  }

  /** Per-name DynamoDB DescribeTable responses. */
  readonly tableOutputs = new Map<string, DescribeTableCommandOutput>()

  /** Per-name DynamoDB PITR responses. */
  readonly backupOutputs =
    new Map<string, DescribeContinuousBackupsCommandOutput>()

  /** Per-name DynamoDB TTL responses. */
  readonly ttlOutputs = new Map<string, DescribeTimeToLiveCommandOutput>()

  /** Account-bound inputs received by all journal bucket lookups. */
  readonly bucketLookups: WorkspaceSearchMigrationJournalLookup[] = []

  /** Journal bucket versioning response. */
  bucketVersioning: GetBucketVersioningOutput = {
    Status: 'Enabled',
  }

  /** Journal bucket Object Lock response. */
  objectLockConfiguration: GetObjectLockConfigurationOutput = {
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: {
        DefaultRetention: {
          Mode: 'COMPLIANCE',
          Days: 30,
        },
      },
    },
  }

  /** Journal bucket encryption response. */
  bucketEncryption: GetBucketEncryptionOutput = {
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: JOURNAL_KEY_ARN,
          },
          BucketKeyEnabled: true,
        },
      ],
    },
  }

  /** Journal KMS key metadata response. */
  journalKeyMetadata: WorkspaceSearchMigrationJournalKeyMetadata = {
    arn: JOURNAL_KEY_ARN,
    awsAccountId: TEST_ACCOUNT,
    keyId: '12345678-abcd-4321-abcd-1234567890ab',
    creationDate: new Date('2026-07-01T00:00:00.000Z'),
    enabled: true,
    keyManager: 'CUSTOMER',
    keyState: 'Enabled',
    keyUsage: 'ENCRYPT_DECRYPT',
    keySpec: 'SYMMETRIC_DEFAULT',
    origin: 'AWS_KMS',
    multiRegion: false,
  }

  /** Journal bucket server-access logging response. */
  bucketLogging: GetBucketLoggingOutput = {
    LoggingEnabled: {
      TargetBucket: 'mukuroji-migration-journal-access-logs-production',
      TargetPrefix: 'workspace-search-migration/',
    },
  }

  /**
   * Creates fake responses for all six requested tables.
   *
   * @param requested - Explicit test resources.
   */
  constructor(requested: WorkspaceSearchMigrationRequestedResources) {
    this.requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
    for (const role of tableRoles) {
      const tableName = requested.tables[role]
      this.tableOutputs.set(
        tableName,
        createDescribeTableOutput(role, tableName),
      )
      this.backupOutputs.set(tableName, createPitrOutput())
      this.ttlOutputs.set(tableName, createTtlOutput(role))
    }
  }

  /**
   * Returns the resource-selection digest represented by this fake.
   *
   * @returns Lowercase SHA-256 binding digest.
   */
  readRequestedResourcesBinding(): string {
    return this.requestedResourcesBinding
  }

  /**
   * Returns the configured fake caller identity.
   *
   * @returns Fake STS caller identity.
   */
  async readCallerIdentity(): Promise<{
    account: string
    arn: string
    userId: string
  }> {
    if (this.callerFailure) throw this.callerFailure
    return this.callerIdentity
  }

  /**
   * Returns one configured table descriptor.
   *
   * @param tableName - Requested table name.
   * @returns Fake DescribeTable response.
   */
  async describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    if (this.tableFailure) throw this.tableFailure
    return requireMapValue(this.tableOutputs, tableName, 'table')
  }

  /**
   * Returns one configured PITR descriptor.
   *
   * @param tableName - Requested table name.
   * @returns Fake DescribeContinuousBackups response.
   */
  async describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return requireMapValue(this.backupOutputs, tableName, 'PITR')
  }

  /**
   * Returns one configured TTL descriptor.
   *
   * @param tableName - Requested table name.
   * @returns Fake DescribeTimeToLive response.
   */
  async describeTimeToLive(
    tableName: string,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    return requireMapValue(this.ttlOutputs, tableName, 'TTL')
  }

  /**
   * Returns the configured journal KMS key metadata.
   *
   * @param keyArn - Requested journal key ARN.
   * @returns Fake DescribeKey metadata.
   */
  async describeJournalKey(
    keyArn: string,
  ): Promise<WorkspaceSearchMigrationJournalKeyMetadata> {
    if (keyArn !== JOURNAL_KEY_ARN) {
      throw new Error('Unexpected journal key lookup.')
    }
    return this.journalKeyMetadata
  }

  /**
   * Returns the configured versioning state.
   *
   * @param lookup - Requested bucket and expected owner.
   * @returns Fake GetBucketVersioning response.
   */
  async getBucketVersioning(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketVersioningOutput> {
    this.bucketLookups.push(lookup)
    if (this.bucketFailure) throw this.bucketFailure
    return this.bucketVersioning
  }

  /**
   * Returns the configured Object Lock state.
   *
   * @param lookup - Requested bucket and expected owner.
   * @returns Fake GetObjectLockConfiguration response.
   */
  async getObjectLockConfiguration(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetObjectLockConfigurationOutput> {
    this.bucketLookups.push(lookup)
    if (this.objectLockFailure) throw this.objectLockFailure
    return this.objectLockConfiguration
  }

  /**
   * Returns the configured bucket encryption state.
   *
   * @param lookup - Requested bucket and expected owner.
   * @returns Fake GetBucketEncryption response.
   */
  async getBucketEncryption(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketEncryptionOutput> {
    this.bucketLookups.push(lookup)
    if (this.bucketEncryptionFailure) throw this.bucketEncryptionFailure
    return this.bucketEncryption
  }

  /**
   * Returns the configured access logging state.
   *
   * @param lookup - Requested bucket and expected owner.
   * @returns Fake GetBucketLogging response.
   */
  async getBucketLogging(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketLoggingOutput> {
    this.bucketLookups.push(lookup)
    return this.bucketLogging
  }
}

describe('Workspace Search migration physical identity', () => {
  test('measures the valid six-table and immutable-journal configuration', async () => {
    const fixture = createIdentityFixture()

    const configuration = await measureFixture(fixture)

    expect(configuration).toMatchObject({
      migrationId: 'workspace-search-maintenance',
      migrationVersion: 1,
      account: TEST_ACCOUNT,
      region: TEST_REGION,
      profile: 'production-operations',
      commit: TEST_COMMIT,
      callerArn: fixture.port.callerIdentity.arn,
      callerRoleId: CALLER_ROLE_ID,
      journalPrefix: 'workspace-search/v1',
      journal: {
        bucketName: JOURNAL_BUCKET,
        keyArn: JOURNAL_KEY_ARN,
        keyCreationTime: '2026-07-01T00:00:00.000Z',
        keyManager: 'CUSTOMER',
        keyState: 'Enabled',
        keyUsage: 'ENCRYPT_DECRYPT',
        keySpec: 'SYMMETRIC_DEFAULT',
        keyOrigin: 'AWS_KMS',
        keyMultiRegion: false,
        versioning: 'Enabled',
        objectLockMode: 'COMPLIANCE',
        defaultRetentionDays: 30,
        encryption: 'aws:kms',
        bucketKeyEnabled: true,
        accessLogBucket:
          'mukuroji-migration-journal-access-logs-production',
        accessLogPrefix: 'workspace-search-migration/',
      },
    })
    expect(Object.keys(configuration.tables).sort()).toEqual(
      [...tableRoles].sort(),
    )
    expect(configuration.tables['project-directory']).toMatchObject({
      role: 'project-directory',
      tableName: fixture.requested.tables['project-directory'],
      tableId: 'table-id-project-directory-v1',
      creationTime: '2026-07-01T00:00:00.000Z',
      billingMode: 'PAY_PER_REQUEST',
      deletionProtection: false,
      encryption: 'AWS_OWNED',
      kmsKeyDigest: null,
      ttl: { status: 'DISABLED' },
      pitr: {
        status: 'ENABLED',
        earliestRestorableTime: '2026-07-01T00:01:00.000Z',
        latestRestorableTime: '2026-07-24T23:59:00.000Z',
      },
    })
    expect(configuration.tables.documents).toMatchObject({
      encryption: 'KMS',
      kmsKeyDigest: createMigrationDigest(DOCUMENTS_KEY_ARN),
      ttl: { status: 'ENABLED', attribute: 'expiresAtEpoch' },
    })
    expect(configuration.tables['migration-state']).toMatchObject({
      encryption: 'KMS',
      kmsKeyDigest: createMigrationDigest(MIGRATION_STATE_KEY_ARN),
      deletionProtection: true,
      key: [
        { name: 'migrationId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ],
    })
    expect(JSON.stringify(configuration.tables)).not.toContain(DOCUMENTS_KEY_ARN)
    expect(JSON.stringify(configuration.tables)).not.toContain(
      MIGRATION_STATE_KEY_ARN,
    )
    expect(fixture.port.bucketLookups).toEqual(
      Array.from({ length: 4 }, () => ({
        bucketName: JOURNAL_BUCKET,
        expectedBucketOwner: TEST_ACCOUNT,
      })),
    )
  })

  test('binds every reviewed request field into the port selection digest', () => {
    const baseline = createIdentityFixture().requested
    const baselineBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(baseline)
    const accountVariant = createIdentityFixture().requested
    accountVariant.account = OTHER_ACCOUNT
    accountVariant.journalKeyArn =
      `arn:aws:kms:${TEST_REGION}:${OTHER_ACCOUNT}:key/12345678-abcd-4321-abcd-1234567890ab`
    const regionVariant = createIdentityFixture().requested
    regionVariant.region = 'us-east-1'
    regionVariant.journalKeyArn =
      `arn:aws:kms:us-east-1:${TEST_ACCOUNT}:key/12345678-abcd-4321-abcd-1234567890ab`
    const profileVariant = createIdentityFixture().requested
    profileVariant.profile = 'production-break-glass'
    const commitVariant = createIdentityFixture().requested
    commitVariant.commit = 'b'.repeat(40)
    const tableVariant = createIdentityFixture().requested
    Reflect.set(
      tableVariant.tables,
      'documents',
      'mukuroji-documents-production-replacement',
    )
    const bucketVariant = createIdentityFixture().requested
    bucketVariant.journalBucket = 'mukuroji-migration-journal-replacement'
    const keyVariant = createIdentityFixture().requested
    keyVariant.journalKeyArn =
      `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    const variants: readonly WorkspaceSearchMigrationRequestedResources[] = [
      accountVariant,
      regionVariant,
      profileVariant,
      commitVariant,
      tableVariant,
      bucketVariant,
      keyVariant,
    ]

    for (const variant of variants) {
      expect(
        createWorkspaceSearchMigrationRequestedResourcesBinding(variant),
      ).not.toBe(baselineBinding)
    }
  })

  test('rejects unsafe operator resource identifiers before discovery', async () => {
    const sharedMessage =
      'Migration account, region, profile, commit, or journal configuration is invalid.'

    await expectInvalidRequestedResources((requested) => {
      requested.account = '123'
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.region = 'ap_northeast_1'
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.profile = '../production'
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.commit = 'ABCDEF'
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.journalBucket = 'Invalid_Journal_Bucket'
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.journalKeyArn =
        `arn:aws:kms:${TEST_REGION}:${OTHER_ACCOUNT}:key/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`
    }, sharedMessage)
    await expectInvalidRequestedResources((requested) => {
      requested.tables = {
        ...requested.tables,
        documents: requested.tables.collaboration,
      }
    }, 'Migration table names must be valid and physically distinct.')
    await expectInvalidRequestedResources((requested) => {
      requested.tables = {
        ...requested.tables,
        documents: 'x',
      }
    }, 'Migration table names must be valid and physically distinct.')
  })

  test('retains exact caller evidence while hashes stay stable across sessions', async () => {
    const firstFixture = createIdentityFixture()
    firstFixture.port.callerIdentity.arn =
      `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/MigrationOperator/session-one`
    firstFixture.port.callerIdentity.userId =
      `${CALLER_ROLE_ID}:session-one`
    const secondFixture = createIdentityFixture()
    secondFixture.port.callerIdentity.arn =
      `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/MigrationOperator/session-two`
    secondFixture.port.callerIdentity.userId =
      `${CALLER_ROLE_ID}:session-two`

    const first = await measureFixture(firstFixture)
    const second = await measureFixture(secondFixture)

    expect(first.callerArn).toBe(firstFixture.port.callerIdentity.arn)
    expect(second.callerArn).toBe(secondFixture.port.callerIdentity.arn)
    expect(second.callerArn).not.toBe(first.callerArn)
    expect(createWorkspaceSearchConfigurationHash(second))
      .toBe(createWorkspaceSearchConfigurationHash(first))

    const replacementFixture = createIdentityFixture()
    replacementFixture.port.callerIdentity.userId =
      'AROA7654321098ZYXWVUT:test-session'
    const replacement = await measureFixture(replacementFixture)
    expect(createWorkspaceSearchConfigurationHash(replacement))
      .not.toBe(createWorkspaceSearchConfigurationHash(first))
  })

  test('rejects IAM users, federated sessions, and path-shaped STS ARNs', async () => {
    const callerArns = [
      `arn:aws:iam::${TEST_ACCOUNT}:user/SensitiveMigrationUser`,
      `arn:aws:sts::${TEST_ACCOUNT}:federated-user/SensitiveFederatedOperator`,
      `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/SensitivePath/MigrationOperator/session`,
    ]

    for (const callerArn of callerArns) {
      const fixture = createIdentityFixture()
      fixture.port.callerIdentity.arn = callerArn

      const failure = await expectMigrationFailure(
        measureFixture(fixture),
        'IDENTITY_MISMATCH',
        'STS caller identity is not a valid assumed migration role.',
      )
      expect(failure.message).not.toContain(callerArn)
      expect(failure.message).not.toContain('Sensitive')
    }
  })

  test('redacts unexpected STS, DynamoDB, and S3 port failures', async () => {
    const callerFixture = createIdentityFixture()
    const callerFailure =
      new Error('sensitive STS failure for arn:aws:sts::123:role/session')
    callerFixture.port.callerFailure = callerFailure
    await expectWrappedPortFailure(
      callerFixture,
      callerFailure,
      'sensitive STS failure',
    )

    const tableFixture = createIdentityFixture()
    const tableFailure =
      new Error('sensitive DynamoDB failure for tenant-table-production')
    tableFixture.port.tableFailure = tableFailure
    await expectWrappedPortFailure(
      tableFixture,
      tableFailure,
      'tenant-table-production',
    )

    const bucketFixture = createIdentityFixture()
    const bucketFailure =
      new Error('sensitive S3 failure for journal-bucket-production')
    bucketFixture.port.bucketFailure = bucketFailure
    await expectWrappedPortFailure(
      bucketFixture,
      bucketFailure,
      'journal-bucket-production',
    )
  })

  test('rejects a port bound to a different valid resource selection', async () => {
    const fixture = createIdentityFixture()
    fixture.requested.profile = 'production-break-glass'

    await expectMigrationFailure(
      measureFixture(fixture),
      'INVALID_ARGUMENT',
      'Migration identity port is not bound to the requested resources.',
    )
    expect(fixture.port.bucketLookups).toHaveLength(0)
  })

  test('preserves only fixed operator-safe adapter failures', async () => {
    const profileFixture = createIdentityFixture()
    profileFixture.port.callerFailure =
      createWorkspaceSearchMigrationIdentityAdapterFailure(
        'INVALID_PROFILE_CREDENTIALS',
      )
    await expectMigrationFailure(
      measureFixture(profileFixture),
      'IDENTITY_MISMATCH',
      'Selected AWS profile credentials are unsupported or invalid.',
    )

    const lookupFixture = createIdentityFixture()
    lookupFixture.port.callerFailure =
      createWorkspaceSearchMigrationIdentityAdapterFailure(
        'OUT_OF_SCOPE_LOOKUP',
      )
    await expectMigrationFailure(
      measureFixture(lookupFixture),
      'INVALID_ARGUMENT',
      'Migration identity lookup is outside the requested resource set.',
    )
  })

  test('redacts forged migration failures and hostile thrown proxies', async () => {
    const forgedFixture = createIdentityFixture()
    const rawForgedMessage = 'RAW-FORGED-MIGRATION-FAILURE'
    forgedFixture.port.callerFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      rawForgedMessage,
    )
    const forgedFailure = await expectMigrationFailure(
      measureFixture(forgedFixture),
      'IDENTITY_MISMATCH',
      'Migration resource identity could not be measured.',
    )
    expect(forgedFailure.message).not.toContain(rawForgedMessage)

    const proxyFixture = createIdentityFixture()
    const rawProxyMessage = 'RAW-PROXY-GET-PROTOTYPE'
    proxyFixture.port.callerFailure = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(rawProxyMessage)
        },
      },
    )
    const proxyFailure = await expectMigrationFailure(
      measureFixture(proxyFixture),
      'IDENTITY_MISMATCH',
      'Migration resource identity could not be measured.',
    )
    expect(proxyFailure.message).not.toContain(rawProxyMessage)
  })

  test('maps absent Object Lock and encryption configurations to drift', async () => {
    const objectLockFixture = createIdentityFixture()
    objectLockFixture.port.objectLockFailure = createNamedError(
      'ObjectLockConfigurationNotFoundError',
      'sensitive absent Object Lock detail',
    )
    const objectLockFailure = await expectMigrationFailure(
      measureFixture(objectLockFixture),
      'CONFIGURATION_DRIFT',
      'The migration journal Object Lock does not satisfy the v1 safety contract.',
    )
    expect(objectLockFailure.message).not.toContain('sensitive')

    const encryptionFixture = createIdentityFixture()
    encryptionFixture.port.bucketEncryptionFailure = createNamedError(
      'ServerSideEncryptionConfigurationNotFoundError',
      'sensitive absent encryption detail',
    )
    const encryptionFailure = await expectMigrationFailure(
      measureFixture(encryptionFixture),
      'CONFIGURATION_DRIFT',
      'The migration journal encryption does not satisfy the v1 safety contract.',
    )
    expect(encryptionFailure.message).not.toContain('sensitive')
  })

  test('fails closed when an owner-bound S3 lookup is denied', async () => {
    const fixture = createIdentityFixture()
    const accessDenied = createNamedError(
      'AccessDenied',
      'sensitive cross-account bucket detail',
    )
    fixture.port.bucketFailure = accessDenied

    await expectWrappedPortFailure(fixture, accessDenied, 'cross-account')
    expect(fixture.port.bucketLookups).toHaveLength(4)
    expect(fixture.port.bucketLookups.every(
      ({ expectedBucketOwner }) => expectedBucketOwner === TEST_ACCOUNT,
    )).toBe(true)
  })

  test('rejects STS and table-ARN account drift with stable codes', async () => {
    const stsFixture = createIdentityFixture()
    stsFixture.port.callerIdentity = {
      account: OTHER_ACCOUNT,
      arn: `arn:aws:sts::${OTHER_ACCOUNT}:assumed-role/Unexpected/operator`,
      userId: `${CALLER_ROLE_ID}:operator`,
    }

    await expectMigrationFailure(
      measureFixture(stsFixture),
      'IDENTITY_MISMATCH',
      'STS caller identity does not match the requested migration account.',
    )

    const tableFixture = createIdentityFixture()
    const table = requireFixtureTable(tableFixture, 'documents')
    table.TableArn = createTableArn(
      OTHER_ACCOUNT,
      TEST_REGION,
      tableFixture.requested.tables.documents,
    )

    await expectMigrationFailure(
      measureFixture(tableFixture),
      'IDENTITY_MISMATCH',
      'The documents table does not match the requested account, region, and name.',
    )
  })

  test('rejects missing TableId and invalid creation time before data access', async () => {
    const idFixture = createIdentityFixture()
    requireFixtureTable(idFixture, 'work-items').TableId = ''

    await expectMigrationFailure(
      measureFixture(idFixture),
      'IDENTITY_MISMATCH',
      'A migration table identity is incomplete or not active.',
    )

    const creationFixture = createIdentityFixture()
    requireFixtureTable(creationFixture, 'collaboration').CreationDateTime =
      new Date(Number.NaN)

    await expectMigrationFailure(
      measureFixture(creationFixture),
      'IDENTITY_MISMATCH',
      'An AWS control-plane timestamp is invalid.',
    )
  })

  test('rejects base-table schema and GSI drift', async () => {
    const schemaFixture = createIdentityFixture()
    requireFixtureTable(schemaFixture, 'documents').KeySchema = [
      { AttributeName: 'workspaceId', KeyType: 'HASH' },
    ]

    await expectMigrationFailure(
      measureFixture(schemaFixture),
      'TABLE_SCHEMA_MISMATCH',
      'The documents table schema or safety settings do not match migration v1.',
    )

    const gsiFixture = createIdentityFixture()
    const index = requireFixtureIndex(gsiFixture, 'project-directory', 0)
    index.IndexStatus = 'UPDATING'

    await expectMigrationFailure(
      measureFixture(gsiFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid global secondary index.',
    )

    const localIndexFixture = createIdentityFixture()
    requireFixtureTable(localIndexFixture, 'collaboration').LocalSecondaryIndexes = [
      {},
    ]

    await expectMigrationFailure(
      measureFixture(localIndexFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an unsupported local secondary index.',
    )
  })

  test('rejects DynamoDB encryption state and family drift', async () => {
    const stateFixture = createIdentityFixture()
    const stateDescription =
      requireFixtureTable(stateFixture, 'documents').SSEDescription
    if (!stateDescription) {
      throw new Error('Missing documents encryption fixture.')
    }
    stateDescription.Status = 'UPDATING'

    await expectMigrationFailure(
      measureFixture(stateFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid encryption state.',
    )

    const downgradedFixture = createIdentityFixture()
    requireFixtureTable(downgradedFixture, 'documents').SSEDescription = {
      Status: 'ENABLED',
      SSEType: 'AES256',
    }

    await expectMigrationFailure(
      measureFixture(downgradedFixture),
      'TABLE_SCHEMA_MISMATCH',
      'The documents table schema or safety settings do not match migration v1.',
    )

    const unexpectedKmsFixture = createIdentityFixture()
    requireFixtureTable(unexpectedKmsFixture, 'workspace-search').SSEDescription = {
      Status: 'ENABLED',
      SSEType: 'KMS',
      KMSMasterKeyArn: DOCUMENTS_KEY_ARN,
    }

    await expectMigrationFailure(
      measureFixture(unexpectedKmsFixture),
      'TABLE_SCHEMA_MISMATCH',
      'The workspace-search table schema or safety settings do not match migration v1.',
    )
  })

  test('rejects TTL drift and transitional TTL state', async () => {
    const disabledFixture = createIdentityFixture()
    const collaborationName =
      disabledFixture.requested.tables.collaboration
    disabledFixture.port.ttlOutputs.set(
      collaborationName,
      createDisabledTtlOutput(),
    )

    await expectMigrationFailure(
      measureFixture(disabledFixture),
      'TABLE_SCHEMA_MISMATCH',
      'The collaboration table schema or safety settings do not match migration v1.',
    )

    const transitionalFixture = createIdentityFixture()
    const documentsName = transitionalFixture.requested.tables.documents
    transitionalFixture.port.ttlOutputs.set(documentsName, {
      TimeToLiveDescription: {
        TimeToLiveStatus: 'ENABLING',
        AttributeName: 'expiresAtEpoch',
      },
      $metadata: {},
    })

    await expectMigrationFailure(
      measureFixture(transitionalFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid or transitional TTL state.',
    )
  })

  test('rejects disabled or incomplete point-in-time recovery', async () => {
    const disabledFixture = createIdentityFixture()
    const sourceName = disabledFixture.requested.tables['project-directory']
    disabledFixture.port.backupOutputs.set(sourceName, {
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: 'DISABLED',
        },
      },
      $metadata: {},
    })

    await expectMigrationFailure(
      measureFixture(disabledFixture),
      'PITR_NOT_READY',
      'The project-directory table does not have usable point-in-time recovery.',
    )

    const incompleteFixture = createIdentityFixture()
    const targetName = incompleteFixture.requested.tables['workspace-search']
    incompleteFixture.port.backupOutputs.set(targetName, {
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: 'ENABLED',
          EarliestRestorableDateTime: new Date('2026-07-01T00:01:00.000Z'),
        },
      },
      $metadata: {},
    })

    await expectMigrationFailure(
      measureFixture(incompleteFixture),
      'PITR_NOT_READY',
      'The workspace-search table does not have usable point-in-time recovery.',
    )
  })

  test('rejects an impossible reversed point-in-time recovery window', async () => {
    const fixture = createIdentityFixture()
    const tableName = fixture.requested.tables.documents
    fixture.port.backupOutputs.set(
      tableName,
      createPitrOutput({
        earliest: new Date('2026-07-25T23:59:00.000Z'),
        latest: new Date('2026-07-24T23:59:00.000Z'),
      }),
    )

    await expectMigrationFailure(
      measureFixture(fixture),
      'PITR_NOT_READY',
      'The documents table does not have usable point-in-time recovery.',
    )
  })

  test('binds the configuration hash to TableId and creation identity', async () => {
    const originalFixture = createIdentityFixture()
    const original = await measureFixture(originalFixture)

    const replacementFixture = createIdentityFixture()
    const replacementTable = requireFixtureTable(
      replacementFixture,
      'workspace-search',
    )
    replacementTable.TableId = 'table-id-workspace-search-v2'
    replacementTable.CreationDateTime =
      new Date('2026-07-20T12:34:56.000Z')
    const replacement = await measureFixture(replacementFixture)

    expect(replacement.tables['workspace-search']).toMatchObject({
      tableId: 'table-id-workspace-search-v2',
      creationTime: '2026-07-20T12:34:56.000Z',
    })
    expect(createWorkspaceSearchConfigurationHash(replacement))
      .not.toBe(createWorkspaceSearchConfigurationHash(original))
  })

  test('binds table identity and configuration hash to a digested KMS key', async () => {
    const originalFixture = createIdentityFixture()
    const original = await measureFixture(originalFixture)

    const replacementFixture = createIdentityFixture()
    const replacementKeyArn =
      `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/cccccccc-cccc-4ccc-8ccc-cccccccccccc`
    const replacementTable = requireFixtureTable(
      replacementFixture,
      'documents',
    )
    if (!replacementTable.SSEDescription) {
      throw new Error('Missing documents encryption fixture.')
    }
    replacementTable.SSEDescription.KMSMasterKeyArn = replacementKeyArn
    const replacement = await measureFixture(replacementFixture)

    expect(replacement.tables.documents.kmsKeyDigest).toBe(
      createMigrationDigest(replacementKeyArn),
    )
    expect(replacement.tables.documents.kmsKeyDigest).not.toBe(
      original.tables.documents.kmsKeyDigest,
    )
    expect(JSON.stringify(replacement.tables.documents)).not.toContain(
      replacementKeyArn,
    )
    expect(createWorkspaceSearchConfigurationHash(replacement))
      .not.toBe(createWorkspaceSearchConfigurationHash(original))
  })

  test('binds the reviewed hash to operator and journal configuration', async () => {
    const original = await measureFixture(createIdentityFixture())
    const originalHash = createWorkspaceSearchConfigurationHash(original)

    const profileFixture = createIdentityFixture()
    profileFixture.requested.profile = 'production-break-glass'
    profileFixture.port = new FakeIdentityPort(profileFixture.requested)
    const profileConfiguration = await measureFixture(profileFixture)

    const commitFixture = createIdentityFixture()
    commitFixture.requested.commit = 'b'.repeat(40)
    commitFixture.port = new FakeIdentityPort(commitFixture.requested)
    const commitConfiguration = await measureFixture(commitFixture)

    const journalFixture = createIdentityFixture()
    journalFixture.port.bucketLogging = {
      LoggingEnabled: {
        TargetBucket: 'mukuroji-migration-journal-access-logs-production',
        TargetPrefix: 'workspace-search-migration-v2/',
      },
    }
    const journalConfiguration = await measureFixture(journalFixture)

    expect(createWorkspaceSearchConfigurationHash(profileConfiguration))
      .not.toBe(originalHash)
    expect(createWorkspaceSearchConfigurationHash(commitConfiguration))
      .not.toBe(originalHash)
    expect(createWorkspaceSearchConfigurationHash(journalConfiguration))
      .not.toBe(originalHash)
  })

  test('rejects a missing or malformed DynamoDB KMS key identity', async () => {
    const missingFixture = createIdentityFixture()
    const missingDescription =
      requireFixtureTable(missingFixture, 'documents').SSEDescription
    if (!missingDescription) {
      throw new Error('Missing documents encryption fixture.')
    }
    missingDescription.KMSMasterKeyArn = undefined

    await expectMigrationFailure(
      measureFixture(missingFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid KMS key identity.',
    )

    const foreignFixture = createIdentityFixture()
    const foreignDescription =
      requireFixtureTable(foreignFixture, 'migration-state').SSEDescription
    if (!foreignDescription) {
      throw new Error('Missing migration-state encryption fixture.')
    }
    foreignDescription.KMSMasterKeyArn =
      `arn:aws:kms:${TEST_REGION}:${OTHER_ACCOUNT}:key/dddddddd-dddd-4ddd-8ddd-dddddddddddd`

    await expectMigrationFailure(
      measureFixture(foreignFixture),
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid KMS key identity.',
    )
  })

  test('keeps the reviewed configuration hash stable as PITR windows advance', async () => {
    const originalFixture = createIdentityFixture()
    const original = await measureFixture(originalFixture)

    const advancedFixture = createIdentityFixture()
    for (const role of tableRoles) {
      advancedFixture.port.backupOutputs.set(
        advancedFixture.requested.tables[role],
        createPitrOutput({
          earliest: new Date('2026-07-02T00:01:00.000Z'),
          latest: new Date('2026-07-25T23:59:00.000Z'),
        }),
      )
    }
    const advanced = await measureFixture(advancedFixture)

    expect(advanced.tables.documents.pitr).not.toEqual(
      original.tables.documents.pitr,
    )
    expect(createWorkspaceSearchConfigurationHash(advanced))
      .toBe(createWorkspaceSearchConfigurationHash(original))
  })

  test('rejects journal versioning drift', async () => {
    const fixture = createIdentityFixture()
    fixture.port.bucketVersioning = {
      Status: 'Suspended',
    }

    await expectMigrationFailure(
      measureFixture(fixture),
      'CONFIGURATION_DRIFT',
      'The migration journal versioning does not satisfy the v1 safety contract.',
    )
  })

  test('rejects journal Object Lock mode, duration, and years drift', async () => {
    const configurations: readonly GetObjectLockConfigurationOutput[] = [
      {
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: {
            DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 },
          },
        },
      },
      {
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: {
            DefaultRetention: { Mode: 'COMPLIANCE', Days: 29 },
          },
        },
      },
      {
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: {
            DefaultRetention: { Mode: 'COMPLIANCE', Years: 1 },
          },
        },
      },
    ]
    for (const configuration of configurations) {
      const fixture = createIdentityFixture()
      fixture.port.objectLockConfiguration = configuration

      await expectMigrationFailure(
        measureFixture(fixture),
        'CONFIGURATION_DRIFT',
        'The migration journal Object Lock does not satisfy the v1 safety contract.',
      )
    }
  })

  test('rejects journal KMS key, algorithm, and bucket-key drift', async () => {
    const observedKeyArn =
      `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/observed-sensitive-key`
    const fixtures = [
      createIdentityFixture(),
      createIdentityFixture(),
      createIdentityFixture(),
    ]
    const keyFixture = fixtures[0]
    const algorithmFixture = fixtures[1]
    const bucketKeyFixture = fixtures[2]
    if (!keyFixture || !algorithmFixture || !bucketKeyFixture) {
      throw new Error('Missing journal encryption test fixture.')
    }
    keyFixture.port.bucketEncryption = createBucketEncryptionOutput({
      keyArn: observedKeyArn,
      algorithm: 'aws:kms',
      bucketKeyEnabled: true,
    })
    algorithmFixture.port.bucketEncryption = createBucketEncryptionOutput({
      keyArn: JOURNAL_KEY_ARN,
      algorithm: 'AES256',
      bucketKeyEnabled: true,
    })
    bucketKeyFixture.port.bucketEncryption = createBucketEncryptionOutput({
      keyArn: JOURNAL_KEY_ARN,
      algorithm: 'aws:kms',
      bucketKeyEnabled: false,
    })

    for (const fixture of fixtures) {
      const failure = await expectMigrationFailure(
        measureFixture(fixture),
        'CONFIGURATION_DRIFT',
        'The migration journal encryption does not satisfy the v1 safety contract.',
      )
      expect(failure.message).not.toContain(observedKeyArn)
      expect(failure.message).not.toContain(JOURNAL_KEY_ARN)
    }
  })

  test('rejects AWS-managed, disabled, and pending-deletion journal keys', async () => {
    const awsManagedFixture = createIdentityFixture()
    awsManagedFixture.port.journalKeyMetadata = {
      ...awsManagedFixture.port.journalKeyMetadata,
      keyManager: 'AWS',
    }
    const disabledFixture = createIdentityFixture()
    disabledFixture.port.journalKeyMetadata = {
      ...disabledFixture.port.journalKeyMetadata,
      enabled: false,
    }
    const pendingDeletionFixture = createIdentityFixture()
    pendingDeletionFixture.port.journalKeyMetadata = {
      ...pendingDeletionFixture.port.journalKeyMetadata,
      enabled: false,
      keyState: 'PendingDeletion',
    }

    for (const fixture of [
      awsManagedFixture,
      disabledFixture,
      pendingDeletionFixture,
    ]) {
      await expectMigrationFailure(
        measureFixture(fixture),
        'CONFIGURATION_DRIFT',
        'The migration journal KMS key does not satisfy the v1 safety contract.',
      )
    }
  })

  test('rejects absent, empty, and self-targeted journal access logging', async () => {
    const absentFixture = createIdentityFixture()
    absentFixture.port.bucketLogging = {}

    await expectMigrationFailure(
      measureFixture(absentFixture),
      'CONFIGURATION_DRIFT',
      'The migration journal access logging does not satisfy the v1 safety contract.',
    )

    const emptyFixture = createIdentityFixture()
    emptyFixture.port.bucketLogging = {
      LoggingEnabled: {
        TargetBucket: 'mukuroji-migration-journal-access-logs-production',
        TargetPrefix: '',
      },
    }

    await expectMigrationFailure(
      measureFixture(emptyFixture),
      'CONFIGURATION_DRIFT',
      'The migration journal access logging does not satisfy the v1 safety contract.',
    )

    const selfTargetFixture = createIdentityFixture()
    selfTargetFixture.port.bucketLogging = {
      LoggingEnabled: {
        TargetBucket: JOURNAL_BUCKET,
        TargetPrefix: 'recursive/',
      },
    }

    await expectMigrationFailure(
      measureFixture(selfTargetFixture),
      'CONFIGURATION_DRIFT',
      'The migration journal access logging does not satisfy the v1 safety contract.',
    )
  })

  test('keeps identity failures stable and free of physical identifiers', async () => {
    const fixture = createIdentityFixture()
    const table = requireFixtureTable(fixture, 'migration-state')
    const physicalTableName = fixture.requested.tables['migration-state']
    const physicalTableId = table.TableId ?? ''
    const callerArn = fixture.port.callerIdentity.arn
    table.TableId = undefined

    const failure = await expectMigrationFailure(
      measureFixture(fixture),
      'IDENTITY_MISMATCH',
      'A migration table identity is incomplete or not active.',
    )

    expect(failure.message).not.toContain(physicalTableName)
    expect(failure.message).not.toContain(physicalTableId)
    expect(failure.message).not.toContain(TEST_ACCOUNT)
    expect(failure.message).not.toContain(callerArn)
  })
})

/**
 * Creates a complete explicit request and matching fake control-plane adapter.
 *
 * @returns Fresh mutable fixture.
 */
function createIdentityFixture(): {
  /** Explicit operator resource selection. */
  requested: WorkspaceSearchMigrationRequestedResources
  /** Matching fake control-plane adapter. */
  port: FakeIdentityPort
} {
  const tables: Readonly<
    Record<WorkspaceSearchMigrationTableRole, string>
  > = {
    'project-directory': 'mukuroji-project-directory-production-sensitive',
    'work-items': 'mukuroji-work-items-production-sensitive',
    collaboration: 'mukuroji-collaboration-production-sensitive',
    documents: 'mukuroji-documents-production-sensitive',
    'workspace-search': 'mukuroji-workspace-search-production-sensitive',
    'migration-state':
      'mukuroji-workspace-search-migration-state-production-sensitive',
  }
  const requested: WorkspaceSearchMigrationRequestedResources = {
    account: TEST_ACCOUNT,
    region: TEST_REGION,
    profile: 'production-operations',
    commit: TEST_COMMIT,
    tables,
    journalBucket: JOURNAL_BUCKET,
    journalKeyArn: JOURNAL_KEY_ARN,
  }
  return {
    requested,
    port: new FakeIdentityPort(requested),
  }
}

/**
 * Measures one fixture.
 *
 * @param fixture - Request and fake control-plane adapter.
 * @returns Validated configuration.
 */
function measureFixture(
  fixture: ReturnType<typeof createIdentityFixture>,
) {
  return measureWorkspaceSearchMigrationConfiguration({
    requested: fixture.requested,
    port: fixture.port,
  })
}

/**
 * Mutates one explicit resource request and asserts fail-fast validation.
 *
 * @param mutate - Mutation that makes the operator request invalid.
 * @param message - Expected operator-safe validation message.
 */
async function expectInvalidRequestedResources(
  mutate: (requested: WorkspaceSearchMigrationRequestedResources) => void,
  message: string,
): Promise<void> {
  const fixture = createIdentityFixture()
  mutate(fixture.requested)
  await expectMigrationFailure(
    measureFixture(fixture),
    'INVALID_ARGUMENT',
    message,
  )
  expect(fixture.port.bucketLookups).toHaveLength(0)
}

/**
 * Builds a realistic active DynamoDB table response.
 *
 * @param role - Logical migration role.
 * @param tableName - Physical table name.
 * @returns Fake DescribeTable response.
 */
function createDescribeTableOutput(
  role: WorkspaceSearchMigrationTableRole,
  tableName: string,
): DescribeTableCommandOutput {
  const schema = readTableSchemaFixture(role)
  const table: TableDescription = {
    AttributeDefinitions: [...schema.attributeDefinitions],
    TableName: tableName,
    KeySchema: [...schema.keySchema],
    TableStatus: 'ACTIVE',
    CreationDateTime: new Date('2026-07-01T00:00:00.000Z'),
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    TableArn: createTableArn(TEST_ACCOUNT, TEST_REGION, tableName),
    TableId: `table-id-${role}-v1`,
    GlobalSecondaryIndexes: [...schema.globalSecondaryIndexes],
    DeletionProtectionEnabled: schema.deletionProtection,
  }
  if (schema.kmsEncrypted) {
    table.SSEDescription = {
      Status: 'ENABLED',
      SSEType: 'KMS',
      KMSMasterKeyArn: readFixtureTableKmsKeyArn(role),
    }
  }
  return {
    Table: table,
    $metadata: {},
  }
}

/**
 * Returns the stable KMS key ARN used by one encrypted table fixture.
 *
 * @param role - Logical migration table role.
 * @returns Valid KMS key ARN for an encrypted fixture table.
 */
function readFixtureTableKmsKeyArn(
  role: WorkspaceSearchMigrationTableRole,
): string {
  if (role === 'documents') return DOCUMENTS_KEY_ARN
  if (role === 'migration-state') return MIGRATION_STATE_KEY_ARN
  throw new Error(`The ${role} fixture does not use KMS encryption.`)
}

/**
 * Returns the exact expected table fixture for one migration role.
 *
 * @param role - Logical migration table role.
 * @returns Expected schema and safety fixture.
 */
function readTableSchemaFixture(
  role: WorkspaceSearchMigrationTableRole,
): TableSchemaFixture {
  if (role === 'project-directory') {
    return {
      attributeDefinitions: [
        stringAttribute('directoryId'),
        stringAttribute('entryKey'),
        stringAttribute('webhookAuthorizationKey'),
        stringAttribute('webhookAuthorizationSortKey'),
      ],
      keySchema: [
        hashKey('directoryId'),
        rangeKey('entryKey'),
      ],
      globalSecondaryIndexes: [
        {
          IndexName: 'WebhookAuthorizationIndex',
          KeySchema: [
            hashKey('webhookAuthorizationKey'),
            rangeKey('webhookAuthorizationSortKey'),
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          IndexStatus: 'ACTIVE',
        },
      ],
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'work-items') {
    return {
      attributeDefinitions: [
        stringAttribute('directoryTeamId'),
        stringAttribute('issueId'),
        stringAttribute('directoryProjectId'),
        numberAttribute('sortOrder'),
        stringAttribute('updatedAt'),
      ],
      keySchema: [
        hashKey('directoryTeamId'),
        rangeKey('issueId'),
      ],
      globalSecondaryIndexes: [
        {
          IndexName: 'AssignedProjectIssueIndex',
          KeySchema: [
            hashKey('directoryProjectId'),
            rangeKey('sortOrder'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
        {
          IndexName: 'TeamIssueSortOrderIndex',
          KeySchema: [
            hashKey('directoryTeamId'),
            rangeKey('sortOrder'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
        {
          IndexName: 'TeamIssueUpdatedAtIndex',
          KeySchema: [
            hashKey('directoryTeamId'),
            rangeKey('updatedAt'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
      ],
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'collaboration') {
    return {
      attributeDefinitions: [
        stringAttribute('entityKey'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('entityKey'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      ttlAttribute: 'expiresAt',
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'documents') {
    return {
      attributeDefinitions: [
        stringAttribute('workspaceId'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('workspaceId'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      ttlAttribute: 'expiresAtEpoch',
      kmsEncrypted: true,
      deletionProtection: false,
    }
  }
  if (role === 'workspace-search') {
    return {
      attributeDefinitions: [
        stringAttribute('workspaceId'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('workspaceId'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  return {
    attributeDefinitions: [
      stringAttribute('migrationId'),
      stringAttribute('recordKey'),
    ],
    keySchema: [
      hashKey('migrationId'),
      rangeKey('recordKey'),
    ],
    globalSecondaryIndexes: [],
    kmsEncrypted: true,
    deletionProtection: true,
  }
}

/**
 * Creates enabled PITR evidence with canonical timestamps.
 *
 * @param timestamps - Mutable PITR restore-window boundaries.
 * @returns Fake DescribeContinuousBackups response.
 */
function createPitrOutput(
  timestamps: {
    /** Earliest restorable PITR boundary. */
    earliest: Date
    /** Latest restorable PITR boundary. */
    latest: Date
  } = {
    earliest: new Date('2026-07-01T00:01:00.000Z'),
    latest: new Date('2026-07-24T23:59:00.000Z'),
  },
): DescribeContinuousBackupsCommandOutput {
  return {
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: 'ENABLED',
      PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: 'ENABLED',
        EarliestRestorableDateTime: timestamps.earliest,
        LatestRestorableDateTime: timestamps.latest,
      },
    },
    $metadata: {},
  }
}

/**
 * Creates one journal bucket encryption response.
 *
 * @param input - KMS identity and bucket-encryption settings.
 * @returns Fake GetBucketEncryption response.
 */
function createBucketEncryptionOutput(input: {
  /** Configured KMS key ARN. */
  keyArn: string
  /** Configured S3 server-side encryption algorithm. */
  algorithm: 'AES256' | 'aws:kms'
  /** Whether S3 Bucket Keys are enabled. */
  bucketKeyEnabled: boolean
}): GetBucketEncryptionOutput {
  return {
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: input.algorithm,
            KMSMasterKeyID: input.keyArn,
          },
          BucketKeyEnabled: input.bucketKeyEnabled,
        },
      ],
    },
  }
}

/**
 * Creates role-specific TTL evidence.
 *
 * @param role - Logical migration table role.
 * @returns Fake DescribeTimeToLive response.
 */
function createTtlOutput(
  role: WorkspaceSearchMigrationTableRole,
): DescribeTimeToLiveCommandOutput {
  const schema = readTableSchemaFixture(role)
  if (schema.ttlAttribute) {
    return {
      TimeToLiveDescription: {
        TimeToLiveStatus: 'ENABLED',
        AttributeName: schema.ttlAttribute,
      },
      $metadata: {},
    }
  }
  return createDisabledTtlOutput()
}

/**
 * Creates disabled TTL evidence.
 *
 * @returns Fake DescribeTimeToLive response.
 */
function createDisabledTtlOutput(): DescribeTimeToLiveCommandOutput {
  return {
    TimeToLiveDescription: {
      TimeToLiveStatus: 'DISABLED',
    },
    $metadata: {},
  }
}

/**
 * Reads one table from a fixture.
 *
 * @param fixture - Complete identity fixture.
 * @param role - Logical table role.
 * @returns Mutable table descriptor.
 */
function requireFixtureTable(
  fixture: ReturnType<typeof createIdentityFixture>,
  role: WorkspaceSearchMigrationTableRole,
): TableDescription {
  const tableName = fixture.requested.tables[role]
  const table = fixture.port.tableOutputs.get(tableName)?.Table
  if (!table) throw new Error(`Missing ${role} test table fixture.`)
  return table
}

/**
 * Reads one GSI from a fixture.
 *
 * @param fixture - Complete identity fixture.
 * @param role - Logical table role.
 * @param index - Zero-based index position.
 * @returns Mutable GSI descriptor.
 */
function requireFixtureIndex(
  fixture: ReturnType<typeof createIdentityFixture>,
  role: WorkspaceSearchMigrationTableRole,
  index: number,
): GlobalSecondaryIndexDescription {
  const descriptor =
    requireFixtureTable(fixture, role).GlobalSecondaryIndexes?.[index]
  if (!descriptor) throw new Error(`Missing ${role} GSI test fixture.`)
  return descriptor
}

/**
 * Reads a required map fixture without an unsafe type assertion.
 *
 * @param values - Map of fake responses.
 * @param key - Physical resource name.
 * @param label - Secret-free fixture label.
 * @returns Existing fake response.
 */
function requireMapValue<Value>(
  values: ReadonlyMap<string, Value>,
  key: string,
  label: string,
): Value {
  const value = values.get(key)
  if (!value) throw new Error(`Missing ${label} test fixture.`)
  return value
}

/**
 * Creates an Error with one modeled AWS service exception name.
 *
 * @param name - Stable modeled exception name.
 * @param message - Internal diagnostic message.
 * @returns Named test error.
 */
function createNamedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * Asserts that one raw port failure crosses the boundary only as safe metadata.
 *
 * @param fixture - Fixture with an injected port failure.
 * @param cause - Exact raw failure that must not cross the public boundary.
 * @param sensitiveText - Raw text that must not reach code or message.
 */
async function expectWrappedPortFailure(
  fixture: ReturnType<typeof createIdentityFixture>,
  cause: Error,
  sensitiveText: string,
): Promise<void> {
  const failure = await expectMigrationFailure(
    measureFixture(fixture),
    'IDENTITY_MISMATCH',
    'Migration resource identity could not be measured.',
  )
  expect(failure.cause).toBeUndefined()
  expect(failure.code).not.toContain(sensitiveText)
  expect(failure.message).not.toContain(sensitiveText)
  expect(failure.message).not.toContain(cause.message)
  expect(inspect(failure, { depth: 5 })).not.toContain(sensitiveText)
  expect(inspect(failure, { depth: 5 })).not.toContain(cause.message)
}

/**
 * Asserts one stable migration failure and returns it for redaction checks.
 *
 * @param promise - Operation expected to fail.
 * @param code - Expected stable failure code.
 * @param message - Expected operator-safe message.
 * @returns Captured migration failure.
 */
async function expectMigrationFailure(
  promise: Promise<unknown>,
  code: WorkspaceSearchMigrationFailureCode,
  message: string,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof WorkspaceSearchMigrationFailure)) throw error
    expect(error).toMatchObject({ code, message })
    return error
  }
  throw new Error(`Expected migration failure ${code}.`)
}

/**
 * Builds an official DynamoDB table ARN.
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
 * Creates one string attribute definition.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB attribute definition.
 */
function stringAttribute(name: string): AttributeDefinition {
  return { AttributeName: name, AttributeType: 'S' }
}

/**
 * Creates one number attribute definition.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB attribute definition.
 */
function numberAttribute(name: string): AttributeDefinition {
  return { AttributeName: name, AttributeType: 'N' }
}

/**
 * Creates one partition-key element.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB key schema element.
 */
function hashKey(name: string): KeySchemaElement {
  return { AttributeName: name, KeyType: 'HASH' }
}

/**
 * Creates one sort-key element.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB key schema element.
 */
function rangeKey(name: string): KeySchemaElement {
  return { AttributeName: name, KeyType: 'RANGE' }
}
