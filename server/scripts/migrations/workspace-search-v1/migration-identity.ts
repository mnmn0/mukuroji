import type {
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandOutput,
  GlobalSecondaryIndexDescription,
  KeySchemaElement,
  ScalarAttributeType,
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import type {
  GetBucketEncryptionOutput,
  GetBucketLoggingOutput,
  GetBucketVersioningOutput,
  GetObjectLockConfigurationOutput,
} from '@aws-sdk/client-s3'
import {
  type MigrationGlobalSecondaryIndex,
  type MigrationJournalIdentity,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationTableRole,
  createMigrationDigest,
  serializeCanonicalJson,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'

/** Explicit physical resources selected by an operator before identity discovery. */
export type WorkspaceSearchMigrationRequestedResources = {
  /** Expected AWS account confirmed through STS and resource ARNs. */
  account: string
  /** Explicit AWS region used by every SDK client. */
  region: string
  /** Explicit shared-configuration profile. */
  profile: string
  /** Exact reviewed Git commit OID. */
  commit: string
  /** Physical source, target, and state table names. */
  tables: Readonly<Record<WorkspaceSearchMigrationTableRole, string>>
  /** Dedicated journal bucket name. */
  journalBucket: string
  /** Expected customer-managed KMS key ARN. */
  journalKeyArn: string
}

/** Immutable, detached resource selection used throughout one measurement. */
export type WorkspaceSearchMigrationRequestedResourcesSnapshot =
  Readonly<WorkspaceSearchMigrationRequestedResources>

/** Account-bound S3 lookup required for every journal control-plane read. */
export type WorkspaceSearchMigrationJournalLookup = {
  /** Explicit journal bucket name. */
  readonly bucketName: string
  /** Requested AWS account sent to S3 as ExpectedBucketOwner. */
  readonly expectedBucketOwner: string
}

/** Narrow KMS DescribeKey metadata required by the migration entry gate. */
export type WorkspaceSearchMigrationJournalKeyMetadata = {
  /** Exact KMS key ARN. */
  readonly arn?: string
  /** AWS account that owns the key. */
  readonly awsAccountId?: string
  /** Physical KMS key identifier. */
  readonly keyId?: string
  /** Key creation timestamp. */
  readonly creationDate?: Date
  /** Whether KMS currently permits cryptographic operations. */
  readonly enabled?: boolean
  /** AWS-managed or customer-managed key family. */
  readonly keyManager?: string
  /** Current KMS lifecycle state. */
  readonly keyState?: string
  /** Cryptographic usage family. */
  readonly keyUsage?: string
  /** KMS key specification. */
  readonly keySpec?: string
  /** Source of the key material. */
  readonly origin?: string
  /** Whether the key is multi-region. */
  readonly multiRegion?: boolean
}

/** Narrow identity and control-plane read port used before any tenant row is scanned. */
export interface WorkspaceSearchMigrationIdentityPort {
  /**
   * Returns the digest of the immutable resource selection that configured the
   * port.
   *
   * @returns Lowercase SHA-256 resource-selection digest.
   */
  readRequestedResourcesBinding(): string
  /**
   * Reads the caller account and ARN from STS.
   *
   * @returns Caller identity bound to the explicit profile and region.
   */
  readCallerIdentity(): Promise<{
    /** AWS account returned by STS. */
    account: string
    /** Caller ARN returned by STS. */
    arn: string
    /** Caller unique ID returned by STS. */
    userId: string
  }>
  /**
   * Reads a DynamoDB table descriptor.
   *
   * @param tableName - Explicit physical table name.
   * @returns Raw DescribeTable output.
   */
  describeTable(tableName: string): Promise<DescribeTableCommandOutput>
  /**
   * Reads point-in-time recovery state for one table.
   *
   * @param tableName - Explicit physical table name.
   * @returns Raw DescribeContinuousBackups output.
   */
  describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /**
   * Reads TTL state for one table.
   *
   * @param tableName - Explicit physical table name.
   * @returns Raw DescribeTimeToLive output.
   */
  describeTimeToLive(tableName: string): Promise<DescribeTimeToLiveCommandOutput>
  /**
   * Reads the dedicated journal KMS key metadata.
   *
   * @param keyArn - Exact operator-selected KMS key ARN.
   * @returns Narrow DescribeKey metadata used by the entry gate.
   */
  describeJournalKey(
    keyArn: string,
  ): Promise<WorkspaceSearchMigrationJournalKeyMetadata>
  /**
   * Reads journal bucket versioning.
   *
   * @param lookup - Explicit bucket and required expected owner.
   * @returns Raw GetBucketVersioning output.
   */
  getBucketVersioning(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketVersioningOutput>
  /**
   * Reads journal bucket Object Lock configuration.
   *
   * @param lookup - Explicit bucket and required expected owner.
   * @returns Raw GetObjectLockConfiguration output.
   */
  getObjectLockConfiguration(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetObjectLockConfigurationOutput>
  /**
   * Reads journal bucket default encryption.
   *
   * @param lookup - Explicit bucket and required expected owner.
   * @returns Raw GetBucketEncryption output.
   */
  getBucketEncryption(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketEncryptionOutput>
  /**
   * Reads journal bucket server-access logging.
   *
   * @param lookup - Explicit bucket and required expected owner.
   * @returns Raw GetBucketLogging output.
   */
  getBucketLogging(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketLoggingOutput>
}

/** Expected schema and safety settings for one migration table role. */
type ExpectedTableDescriptor = {
  /** Ordered base-table key descriptor. */
  key: readonly MigrationKeyAttribute[]
  /** Expected global secondary indexes. */
  globalSecondaryIndexes: readonly MigrationGlobalSecondaryIndex[]
  /** Expected TTL state. */
  ttl: MigrationTableIdentity['ttl']
  /** Expected encryption family. */
  encryption: MigrationTableIdentity['encryption']
  /** Expected deletion protection state. */
  deletionProtection: boolean
}

/** Validated DynamoDB encryption identity measured before schema comparison. */
type MeasuredTableEncryption = {
  /** Observed encryption family. */
  encryption: MigrationTableIdentity['encryption']
  /** Canonical digest of the validated KMS key ARN, or null for AWS-owned encryption. */
  kmsKeyDigest: string | null
}

/** Input required to measure one complete migration resource identity. */
type WorkspaceSearchMigrationIdentityInput = {
  /** Explicit resource selection. */
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Control-plane reader bound to the requested profile and region. */
  port: WorkspaceSearchMigrationIdentityPort
}

/** Exact table-role set accepted by the Workspace Search migration entry gate. */
export const WORKSPACE_SEARCH_MIGRATION_TABLE_ROLES:
  readonly WorkspaceSearchMigrationTableRole[] = Object.freeze([
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
    'workspace-search',
    'migration-state',
  ])

/** Fixed operator-safe failure reasons emitted by the production identity adapter. */
export type WorkspaceSearchMigrationIdentityAdapterFailureReason =
  | 'INCOMPLETE_ASSUMED_CREDENTIALS'
  | 'INCOMPLETE_CALLER_IDENTITY'
  | 'INVALID_PROFILE_CREDENTIALS'
  | 'OUT_OF_SCOPE_LOOKUP'

/** Private provenance set for failures created by this validation module. */
const trustedIdentityFailures = new WeakSet<object>()

/** Private provenance set for the adapter's closed failure vocabulary. */
const trustedIdentityAdapterFailures = new WeakSet<object>()

/**
 * Creates one branded failure from the identity adapter's closed, secret-free
 * failure vocabulary.
 *
 * @param reason - Fixed adapter failure reason.
 * @returns Trusted operator-safe failure that may cross the redaction boundary.
 */
export function createWorkspaceSearchMigrationIdentityAdapterFailure(
  reason: WorkspaceSearchMigrationIdentityAdapterFailureReason,
): WorkspaceSearchMigrationFailure {
  switch (reason) {
    case 'INCOMPLETE_ASSUMED_CREDENTIALS':
      return createIdentityAdapterFailure(
        'IDENTITY_MISMATCH',
        'STS role assumption response is incomplete.',
      )
    case 'INCOMPLETE_CALLER_IDENTITY':
      return createIdentityAdapterFailure(
        'IDENTITY_MISMATCH',
        'STS caller identity response is incomplete.',
      )
    case 'INVALID_PROFILE_CREDENTIALS':
      return createIdentityAdapterFailure(
        'IDENTITY_MISMATCH',
        'Selected AWS profile credentials are unsupported or invalid.',
      )
    case 'OUT_OF_SCOPE_LOOKUP':
      return createIdentityAdapterFailure(
        'INVALID_ARGUMENT',
        'Migration identity lookup is outside the requested resource set.',
      )
    default:
      return createIdentityAdapterFailure(
        'IDENTITY_MISMATCH',
        'Migration identity adapter failure is invalid.',
      )
  }
}

/**
 * Checks whether the production adapter created one fixed operator-safe
 * failure.
 *
 * @param error - Unknown adapter dependency failure.
 * @returns Whether the error has private adapter-factory provenance.
 */
export function isWorkspaceSearchMigrationIdentityAdapterFailure(
  error: unknown,
): error is WorkspaceSearchMigrationFailure {
  return typeof error === 'object' &&
    error !== null &&
    trustedIdentityAdapterFailures.has(error)
}

const expectedTableDescriptors = {
  'project-directory': {
    key: [
      keyAttribute('directoryId', 'HASH', 'S'),
      keyAttribute('entryKey', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [
      globalSecondaryIndex(
        'WebhookAuthorizationIndex',
        [
          keyAttribute('webhookAuthorizationKey', 'HASH', 'S'),
          keyAttribute('webhookAuthorizationSortKey', 'RANGE', 'S'),
        ],
        'KEYS_ONLY',
      ),
    ],
    ttl: { status: 'DISABLED' },
    encryption: 'AWS_OWNED',
    deletionProtection: false,
  },
  'work-items': {
    key: [
      keyAttribute('directoryTeamId', 'HASH', 'S'),
      keyAttribute('issueId', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [
      globalSecondaryIndex(
        'AssignedProjectIssueIndex',
        [
          keyAttribute('directoryProjectId', 'HASH', 'S'),
          keyAttribute('sortOrder', 'RANGE', 'N'),
        ],
        'ALL',
      ),
      globalSecondaryIndex(
        'TeamIssueSortOrderIndex',
        [
          keyAttribute('directoryTeamId', 'HASH', 'S'),
          keyAttribute('sortOrder', 'RANGE', 'N'),
        ],
        'ALL',
      ),
      globalSecondaryIndex(
        'TeamIssueUpdatedAtIndex',
        [
          keyAttribute('directoryTeamId', 'HASH', 'S'),
          keyAttribute('updatedAt', 'RANGE', 'S'),
        ],
        'ALL',
      ),
    ],
    ttl: { status: 'DISABLED' },
    encryption: 'AWS_OWNED',
    deletionProtection: false,
  },
  collaboration: {
    key: [
      keyAttribute('entityKey', 'HASH', 'S'),
      keyAttribute('recordKey', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [],
    ttl: { status: 'ENABLED', attribute: 'expiresAt' },
    encryption: 'AWS_OWNED',
    deletionProtection: false,
  },
  documents: {
    key: [
      keyAttribute('workspaceId', 'HASH', 'S'),
      keyAttribute('recordKey', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [],
    ttl: { status: 'ENABLED', attribute: 'expiresAtEpoch' },
    encryption: 'KMS',
    deletionProtection: false,
  },
  'workspace-search': {
    key: [
      keyAttribute('workspaceId', 'HASH', 'S'),
      keyAttribute('recordKey', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [],
    ttl: { status: 'DISABLED' },
    encryption: 'AWS_OWNED',
    deletionProtection: false,
  },
  'migration-state': {
    key: [
      keyAttribute('migrationId', 'HASH', 'S'),
      keyAttribute('recordKey', 'RANGE', 'S'),
    ],
    globalSecondaryIndexes: [],
    ttl: { status: 'DISABLED' },
    encryption: 'KMS',
    deletionProtection: true,
  },
} satisfies Readonly<Record<WorkspaceSearchMigrationTableRole, ExpectedTableDescriptor>>

/**
 * Takes one validated, detached resource snapshot before any asynchronous
 * identity read.
 *
 * @param requested - Candidate caller-owned resource selection.
 * @returns Frozen resource selection safe for one complete measurement.
 */
export function createWorkspaceSearchMigrationRequestedResourcesSnapshot(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): WorkspaceSearchMigrationRequestedResourcesSnapshot {
  const [snapshot, tableRoleKeys] = captureRequestedResources(requested)
  if (!hasExactMigrationTableRoles(tableRoleKeys)) {
    throw createIdentityFailure(
      'INVALID_ARGUMENT',
      'Migration table names must be valid and physically distinct.',
    )
  }
  validateWorkspaceSearchMigrationRequestedResources(snapshot)
  Object.freeze(snapshot.tables)
  return Object.freeze(snapshot)
}

/**
 * Creates the immutable binding checked between a resource request and its
 * control-plane port.
 *
 * @param requested - Candidate resource selection.
 * @returns Lowercase SHA-256 digest of the validated detached selection.
 */
export function createWorkspaceSearchMigrationRequestedResourcesBinding(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): string {
  const snapshot =
    createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  return createRequestedResourcesBindingFromSnapshot(snapshot)
}

/**
 * Reads every caller-owned resource field exactly once inside a redacted error
 * boundary.
 *
 * @param requested - Candidate caller-owned resource selection.
 * @returns Detached resource values and the raw table own-key shape.
 */
function captureRequestedResources(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): readonly [
  WorkspaceSearchMigrationRequestedResourcesSnapshot,
  readonly PropertyKey[],
] {
  try {
    const tables = requested.tables
    const tableRoleKeys = Reflect.ownKeys(tables)
    const snapshot: WorkspaceSearchMigrationRequestedResources = {
      account: requested.account,
      region: requested.region,
      profile: requested.profile,
      commit: requested.commit,
      tables: {
        'project-directory': tables['project-directory'],
        'work-items': tables['work-items'],
        collaboration: tables.collaboration,
        documents: tables.documents,
        'workspace-search': tables['workspace-search'],
        'migration-state': tables['migration-state'],
      },
      journalBucket: requested.journalBucket,
      journalKeyArn: requested.journalKeyArn,
    }
    return [snapshot, tableRoleKeys]
  } catch {
    throw createIdentityFailure(
      'INVALID_ARGUMENT',
      'Migration requested resources are invalid or unreadable.',
    )
  }
}

/**
 * Checks the raw table object before a fixed-role snapshot can discard unknown
 * own keys.
 *
 * @param keys - Raw string and symbol own keys reported by the caller object.
 * @returns Whether every required role, and no other role, is present.
 */
function hasExactMigrationTableRoles(keys: readonly PropertyKey[]): boolean {
  return (
    keys.length === WORKSPACE_SEARCH_MIGRATION_TABLE_ROLES.length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        WORKSPACE_SEARCH_MIGRATION_TABLE_ROLES.some((role) => role === key),
    )
  )
}

/**
 * Hashes one already validated resource snapshot without reading caller-owned
 * values again.
 *
 * @param snapshot - Frozen validated resource selection.
 * @returns Lowercase SHA-256 resource-selection digest.
 */
function createRequestedResourcesBindingFromSnapshot(
  snapshot: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): string {
  return createMigrationDigest(snapshot)
}

/**
 * Measures and validates every immutable resource identity before data-plane work.
 *
 * @param input - Explicit requested resources and narrow control-plane port.
 * @returns Exact measured migration configuration.
 */
export async function measureWorkspaceSearchMigrationConfiguration(
  input: WorkspaceSearchMigrationIdentityInput,
): Promise<WorkspaceSearchMigrationConfiguration> {
  try {
    const requested =
      createWorkspaceSearchMigrationRequestedResourcesSnapshot(input.requested)
    const port = input.port
    if (
      port.readRequestedResourcesBinding() !==
      createRequestedResourcesBindingFromSnapshot(requested)
    ) {
      throw createIdentityFailure(
        'INVALID_ARGUMENT',
        'Migration identity port is not bound to the requested resources.',
      )
    }
    return await measureMigrationConfiguration({ requested, port })
  } catch (error: unknown) {
    if (isTrustedIdentityFailure(error)) throw error
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'Migration resource identity could not be measured.',
    )
  }
}

/**
 * Performs control-plane measurement inside the public redaction boundary.
 *
 * @param input - Explicit requested resources and narrow control-plane port.
 * @returns Exact measured migration configuration.
 */
async function measureMigrationConfiguration(
  input: WorkspaceSearchMigrationIdentityInput,
): Promise<WorkspaceSearchMigrationConfiguration> {
  validateWorkspaceSearchMigrationRequestedResources(input.requested)
  const caller = await input.port.readCallerIdentity()
  if (caller.account !== input.requested.account) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'STS caller identity does not match the requested migration account.',
    )
  }
  const callerSessionArn = readValidatedCallerSessionArn(
    caller.arn,
    input.requested.account,
  )
  const callerRoleId = readValidatedCallerRoleId(
    caller.userId,
    callerSessionArn,
  )

  const tableEntries = await Promise.all(
    Object.entries(input.requested.tables).map(async ([roleValue, tableName]) => {
      const role = readTableRole(roleValue)
      const identity = await measureTableIdentity(
        role,
        tableName,
        input.requested,
        input.port,
      )
      const entry: readonly [
        WorkspaceSearchMigrationTableRole,
        MigrationTableIdentity,
      ] = [role, identity]
      return entry
    }),
  )
  const tables = createTableIdentityRecord(tableEntries)
  const journal = await measureJournalIdentity(input.requested, input.port)

  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: input.requested.account,
    region: input.requested.region,
    profile: input.requested.profile,
    commit: input.requested.commit,
    callerArn: callerSessionArn,
    callerRoleId,
    tables,
    journal,
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Validates an STS assumed-role session ARN.
 *
 * The exact ARN remains audit evidence. Configuration hashing separately
 * excludes the volatile session name because an STS ARN cannot reconstruct an
 * IAM role path. Other caller families fail closed because an IAM user, root
 * principal, or federated-user session is not the migration role identity.
 *
 * @param value - Caller ARN returned by STS GetCallerIdentity.
 * @param expectedAccount - Explicit operator-selected AWS account.
 * @returns Exact validated STS assumed-role session ARN.
 */
function readValidatedCallerSessionArn(
  value: string,
  expectedAccount: string,
): string {
  const parts = value.split(':')
  const partition = parts[1]
  const account = parts[4]
  const resource = parts[5]
  const assumedRolePrefix = 'assumed-role/'
  if (
    parts.length !== 6 ||
    parts[0] !== 'arn' ||
    !isAwsPartition(partition) ||
    parts[2] !== 'sts' ||
    parts[3] !== '' ||
    account !== expectedAccount ||
    !resource?.startsWith(assumedRolePrefix)
  ) {
    throw invalidCallerRoleIdentity()
  }
  const segments = resource.slice(assumedRolePrefix.length).split('/')
  if (
    segments.length !== 2 ||
    !isIamRoleName(segments[0]) ||
    !isRoleSessionName(segments[1])
  ) {
    throw invalidCallerRoleIdentity()
  }
  return value
}

/**
 * Creates a stable caller-role validation failure.
 *
 * @returns Operator-safe identity failure without the raw ARN.
 */
function invalidCallerRoleIdentity(): WorkspaceSearchMigrationFailure {
  return createIdentityFailure(
    'IDENTITY_MISMATCH',
    'STS caller identity is not a valid assumed migration role.',
  )
}

/**
 * Validates and extracts the stable role ID from STS GetCallerIdentity UserId.
 *
 * @param value - Exact STS UserId in role-id/session form.
 * @param callerArn - Validated assumed-role session ARN.
 * @returns Stable IAM role unique ID.
 */
function readValidatedCallerRoleId(value: string, callerArn: string): string {
  const userIdSegments = value.split(':')
  const roleId = userIdSegments[0]
  const sessionName = userIdSegments[1]
  const arnSessionName = callerArn.split('/')[2]
  if (
    userIdSegments.length !== 2 ||
    !roleId ||
    !/^AROA[A-Z0-9]{17}$/u.test(roleId) ||
    !sessionName ||
    sessionName !== arnSessionName
  ) {
    throw invalidCallerRoleIdentity()
  }
  return roleId
}

/**
 * Measures and validates one table against its role-specific descriptor.
 *
 * @param role - Migration table role.
 * @param tableName - Requested physical table name.
 * @param requested - Shared account and region constraints.
 * @param port - Control-plane read port.
 * @returns Exact validated table identity.
 */
async function measureTableIdentity(
  role: WorkspaceSearchMigrationTableRole,
  tableName: string,
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  port: WorkspaceSearchMigrationIdentityPort,
): Promise<MigrationTableIdentity> {
  const [tableOutput, backupOutput, ttlOutput] = await Promise.all([
    port.describeTable(tableName),
    port.describeContinuousBackups(tableName),
    port.describeTimeToLive(tableName),
  ])
  const table = tableOutput.Table
  if (!table) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      `The ${role} table identity is unavailable.`,
    )
  }
  const observed = readPhysicalTableIdentity(table)
  if (
    observed.account !== requested.account ||
    observed.region !== requested.region ||
    observed.tableName !== tableName
  ) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      `The ${role} table does not match the requested account, region, and name.`,
    )
  }
  const measuredEncryption = readEncryption(
    table,
    requested.account,
    requested.region,
  )
  const descriptor = readTableDescriptor(
    table,
    ttlOutput,
    measuredEncryption.encryption,
  )
  const expected = expectedTableDescriptors[role]
  if (serializeCanonicalJson(descriptor) !== serializeCanonicalJson(expected)) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      `The ${role} table schema or safety settings do not match migration v1.`,
    )
  }
  const pitr = readPitrEvidence(backupOutput, role)

  return {
    role,
    tableName,
    tableArn: observed.tableArn,
    tableId: observed.tableId,
    creationTime: observed.creationTime,
    account: observed.account,
    region: observed.region,
    key: descriptor.key,
    globalSecondaryIndexes: descriptor.globalSecondaryIndexes,
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: descriptor.deletionProtection,
    encryption: descriptor.encryption,
    kmsKeyDigest: measuredEncryption.kmsKeyDigest,
    ttl: descriptor.ttl,
    pitr,
  }
}

/**
 * Measures journal versioning, Object Lock, encryption, and access logging.
 *
 * @param requested - Explicit journal bucket and key.
 * @param port - Control-plane read port.
 * @returns Validated journal identity.
 */
async function measureJournalIdentity(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  port: WorkspaceSearchMigrationIdentityPort,
): Promise<MigrationJournalIdentity> {
  const lookup: WorkspaceSearchMigrationJournalLookup = {
    bucketName: requested.journalBucket,
    expectedBucketOwner: requested.account,
  }
  let versioning: GetBucketVersioningOutput
  let objectLock: GetObjectLockConfigurationOutput
  let encryption: GetBucketEncryptionOutput
  let logging: GetBucketLoggingOutput
  let keyMetadata: WorkspaceSearchMigrationJournalKeyMetadata
  try {
    [versioning, objectLock, encryption, logging, keyMetadata] = await Promise.all([
      port.getBucketVersioning(lookup),
      port.getObjectLockConfiguration(lookup),
      port.getBucketEncryption(lookup),
      port.getBucketLogging(lookup),
      port.describeJournalKey(requested.journalKeyArn),
    ])
  } catch (error) {
    if (hasErrorName(error, 'ObjectLockConfigurationNotFoundError')) {
      throw invalidJournalConfiguration('Object Lock')
    }
    if (
      hasErrorName(
        error,
        'ServerSideEncryptionConfigurationNotFoundError',
      )
    ) {
      throw invalidJournalConfiguration('encryption')
    }
    throw error
  }
  const keyIdentity = readJournalKeyIdentity(keyMetadata, requested)
  if (versioning.Status !== 'Enabled') {
    throw invalidJournalConfiguration('versioning')
  }
  const retention = objectLock.ObjectLockConfiguration?.Rule?.DefaultRetention
  if (
    objectLock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled' ||
    retention?.Mode !== 'COMPLIANCE' ||
    !Number.isSafeInteger(retention.Days) ||
    (retention.Days ?? 0) < 30 ||
    retention.Years !== undefined
  ) {
    throw invalidJournalConfiguration('Object Lock')
  }
  const rules = encryption.ServerSideEncryptionConfiguration?.Rules
  if (!rules || rules.length !== 1) {
    throw invalidJournalConfiguration('encryption')
  }
  const encryptionRule = rules[0]
  if (
    encryptionRule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'aws:kms' ||
    encryptionRule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID !==
      requested.journalKeyArn ||
    encryptionRule.BucketKeyEnabled !== true
  ) {
    throw invalidJournalConfiguration('encryption')
  }
  const loggingEnabled = logging.LoggingEnabled
  if (
    !isNonEmptyString(loggingEnabled?.TargetBucket) ||
    !isNonEmptyString(loggingEnabled.TargetPrefix) ||
    loggingEnabled.TargetBucket === requested.journalBucket
  ) {
    throw invalidJournalConfiguration('access logging')
  }

  return {
    bucketName: requested.journalBucket,
    keyArn: requested.journalKeyArn,
    ...keyIdentity,
    versioning: 'Enabled',
    objectLockMode: 'COMPLIANCE',
    defaultRetentionDays: retention.Days ?? 0,
    encryption: 'aws:kms',
    bucketKeyEnabled: true,
    accessLogBucket: loggingEnabled.TargetBucket,
    accessLogPrefix: loggingEnabled.TargetPrefix,
  }
}

/**
 * Validates that the journal key is the exact enabled customer-managed key.
 *
 * @param metadata - Narrow KMS DescribeKey response.
 * @param requested - Explicit account, region, and key selection.
 * @returns Stable KMS identity evidence bound into the configuration hash.
 */
function readJournalKeyIdentity(
  metadata: WorkspaceSearchMigrationJournalKeyMetadata,
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): Pick<
  MigrationJournalIdentity,
  | 'keyCreationTime'
  | 'keyManager'
  | 'keyState'
  | 'keySpec'
  | 'keyUsage'
  | 'keyOrigin'
  | 'keyMultiRegion'
> {
  const keyId = requested.journalKeyArn.split(':')[5]?.slice('key/'.length)
  const creationTime = metadata.creationDate?.getTime()
  if (
    metadata.arn !== requested.journalKeyArn ||
    metadata.awsAccountId !== requested.account ||
    metadata.keyId !== keyId ||
    metadata.enabled !== true ||
    metadata.keyManager !== 'CUSTOMER' ||
    metadata.keyState !== 'Enabled' ||
    metadata.keySpec !== 'SYMMETRIC_DEFAULT' ||
    metadata.keyUsage !== 'ENCRYPT_DECRYPT' ||
    metadata.origin !== 'AWS_KMS' ||
    metadata.multiRegion !== false ||
    typeof creationTime !== 'number' ||
    !Number.isFinite(creationTime)
  ) {
    throw invalidJournalConfiguration('KMS key')
  }
  return {
    keyCreationTime: new Date(creationTime).toISOString(),
    keyManager: 'CUSTOMER',
    keyState: 'Enabled',
    keySpec: 'SYMMETRIC_DEFAULT',
    keyUsage: 'ENCRYPT_DECRYPT',
    keyOrigin: 'AWS_KMS',
    keyMultiRegion: false,
  }
}

/**
 * Reads the exact table identity and validates the ARN shape.
 *
 * @param table - Raw DynamoDB table description.
 * @returns Parsed physical identity.
 */
function readPhysicalTableIdentity(table: TableDescription): {
  /** AWS account parsed from the ARN. */
  account: string
  /** Canonical creation timestamp. */
  creationTime: string
  /** AWS region parsed from the ARN. */
  region: string
  /** Exact table ARN. */
  tableArn: string
  /** Immutable TableId. */
  tableId: string
  /** Exact physical table name. */
  tableName: string
} {
  if (
    table.TableStatus !== 'ACTIVE' ||
    !isNonEmptyString(table.TableArn) ||
    !isNonEmptyString(table.TableId) ||
    !isNonEmptyString(table.TableName) ||
    !table.CreationDateTime
  ) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'A migration table identity is incomplete or not active.',
    )
  }
  const arn = parseDynamoTableArn(table.TableArn)
  if (arn.tableName !== table.TableName) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'A migration table ARN does not match its reported table name.',
    )
  }
  return {
    account: arn.account,
    creationTime: toCanonicalTimestamp(table.CreationDateTime),
    region: arn.region,
    tableArn: table.TableArn,
    tableId: table.TableId,
    tableName: table.TableName,
  }
}

/**
 * Normalizes one table schema and safety descriptor.
 *
 * @param table - Raw DynamoDB table description.
 * @param ttlOutput - Raw TTL description.
 * @param encryption - Validated encryption family.
 * @returns Normalized descriptor.
 */
function readTableDescriptor(
  table: TableDescription,
  ttlOutput: DescribeTimeToLiveCommandOutput,
  encryption: MigrationTableIdentity['encryption'],
): ExpectedTableDescriptor {
  if (table.BillingModeSummary?.BillingMode !== 'PAY_PER_REQUEST') {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table is not configured for on-demand billing.',
    )
  }
  const attributeTypes = readAttributeTypes(table)
  const key = normalizeKeySchema(table.KeySchema, attributeTypes)
  const globalSecondaryIndexes = (table.GlobalSecondaryIndexes ?? [])
    .map((index) => normalizeGlobalSecondaryIndex(index, attributeTypes))
    .sort((left, right) => compareUtf8Ordinal(left.name, right.name))
  if ((table.LocalSecondaryIndexes?.length ?? 0) !== 0) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an unsupported local secondary index.',
    )
  }
  return {
    key,
    globalSecondaryIndexes,
    ttl: readTtl(ttlOutput),
    encryption,
    deletionProtection: table.DeletionProtectionEnabled === true,
  }
}

/**
 * Reads AttributeDefinitions into a validated name-to-type map.
 *
 * @param table - Raw DynamoDB table description.
 * @returns Validated scalar attribute types.
 */
function readAttributeTypes(
  table: TableDescription,
): ReadonlyMap<string, ScalarAttributeType> {
  const result = new Map<string, ScalarAttributeType>()
  for (const attribute of table.AttributeDefinitions ?? []) {
    if (
      !isNonEmptyString(attribute.AttributeName) ||
      !isScalarAttributeType(attribute.AttributeType) ||
      result.has(attribute.AttributeName)
    ) {
      throw createIdentityFailure(
        'TABLE_SCHEMA_MISMATCH',
        'A migration table has invalid attribute definitions.',
      )
    }
    result.set(attribute.AttributeName, attribute.AttributeType)
  }
  return result
}

/**
 * Normalizes one DynamoDB key schema.
 *
 * @param schema - Raw key schema.
 * @param attributeTypes - Validated attribute definitions.
 * @returns Ordered key attributes.
 */
function normalizeKeySchema(
  schema: readonly KeySchemaElement[] | undefined,
  attributeTypes: ReadonlyMap<string, ScalarAttributeType>,
): readonly MigrationKeyAttribute[] {
  if (!schema || schema.length < 1 || schema.length > 2) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid key schema.',
    )
  }
  const normalized = schema.map((element) => {
    const name = element.AttributeName
    const role = element.KeyType
    const type = name ? attributeTypes.get(name) : undefined
    if (
      !isNonEmptyString(name) ||
      (role !== 'HASH' && role !== 'RANGE') ||
      !isScalarAttributeType(type)
    ) {
      throw createIdentityFailure(
        'TABLE_SCHEMA_MISMATCH',
        'A migration table has an invalid key schema.',
      )
    }
    return keyAttribute(name, role, type)
  })
  const hashCount = normalized.filter(({ role }) => role === 'HASH').length
  const rangeCount = normalized.filter(({ role }) => role === 'RANGE').length
  if (hashCount !== 1 || rangeCount !== normalized.length - 1) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid key schema.',
    )
  }
  return normalized.sort((left, right) => keyRoleRank(left.role) - keyRoleRank(right.role))
}

/**
 * Normalizes one global secondary index.
 *
 * @param index - Raw DynamoDB index description.
 * @param attributeTypes - Validated attribute definitions.
 * @returns Normalized active index descriptor.
 */
function normalizeGlobalSecondaryIndex(
  index: GlobalSecondaryIndexDescription,
  attributeTypes: ReadonlyMap<string, ScalarAttributeType>,
): MigrationGlobalSecondaryIndex {
  const projection = index.Projection?.ProjectionType
  if (
    !isNonEmptyString(index.IndexName) ||
    index.IndexStatus !== 'ACTIVE' ||
    (
      projection !== 'ALL' &&
      projection !== 'INCLUDE' &&
      projection !== 'KEYS_ONLY'
    )
  ) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid global secondary index.',
    )
  }
  const nonKeyAttributes = projection === 'INCLUDE'
    ? [...(index.Projection?.NonKeyAttributes ?? [])].sort(compareUtf8Ordinal)
    : []
  if (
    projection === 'INCLUDE' &&
    (
      nonKeyAttributes.length === 0 ||
      nonKeyAttributes.some((value) => !isNonEmptyString(value))
    )
  ) {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid INCLUDE projection.',
    )
  }
  return {
    name: index.IndexName,
    key: normalizeKeySchema(index.KeySchema, attributeTypes),
    projection,
    nonKeyAttributes,
    status: 'ACTIVE',
  }
}

/**
 * Reads DynamoDB TTL state without accepting transitional states.
 *
 * @param output - Raw DescribeTimeToLive output.
 * @returns Normalized TTL state.
 */
function readTtl(
  output: DescribeTimeToLiveCommandOutput,
): MigrationTableIdentity['ttl'] {
  const description = output.TimeToLiveDescription
  if (description?.TimeToLiveStatus === 'DISABLED') {
    return { status: 'DISABLED' }
  }
  if (
    description?.TimeToLiveStatus === 'ENABLED' &&
    isNonEmptyString(description.AttributeName)
  ) {
    return {
      status: 'ENABLED',
      attribute: description.AttributeName,
    }
  }
  throw createIdentityFailure(
    'TABLE_SCHEMA_MISMATCH',
    'A migration table has an invalid or transitional TTL state.',
  )
}

/**
 * Reads the DynamoDB encryption family and a digest of its KMS key ARN.
 *
 * @param table - Raw DynamoDB table description.
 * @param expectedAccount - Requested account used to validate a KMS key ARN.
 * @param expectedRegion - Requested region used to validate a KMS key ARN.
 * @returns Normalized encryption family and KMS key digest or null.
 */
function readEncryption(
  table: TableDescription,
  expectedAccount: string,
  expectedRegion: string,
): MeasuredTableEncryption {
  const description = table.SSEDescription
  if (!description) {
    return {
      encryption: 'AWS_OWNED',
      kmsKeyDigest: null,
    }
  }
  if (description.Status !== 'ENABLED') {
    throw createIdentityFailure(
      'TABLE_SCHEMA_MISMATCH',
      'A migration table has an invalid encryption state.',
    )
  }
  if (description.SSEType === 'KMS') {
    if (
      !isKmsKeyArn(
        description.KMSMasterKeyArn,
        expectedAccount,
        expectedRegion,
      )
    ) {
      throw createIdentityFailure(
        'TABLE_SCHEMA_MISMATCH',
        'A migration table has an invalid KMS key identity.',
      )
    }
    return {
      encryption: 'KMS',
      kmsKeyDigest: createMigrationDigest(description.KMSMasterKeyArn),
    }
  }
  if (
    description.SSEType === 'AES256' &&
    description.KMSMasterKeyArn === undefined
  ) {
    return {
      encryption: 'AWS_OWNED',
      kmsKeyDigest: null,
    }
  }
  throw createIdentityFailure(
    'TABLE_SCHEMA_MISMATCH',
    'A migration table has an unsupported encryption state.',
  )
}

/**
 * Reads required point-in-time recovery evidence.
 *
 * @param output - Raw DescribeContinuousBackups output.
 * @param role - Table role used in a secret-free error.
 * @returns Normalized enabled PITR evidence.
 */
function readPitrEvidence(
  output: DescribeContinuousBackupsCommandOutput,
  role: WorkspaceSearchMigrationTableRole,
): MigrationTableIdentity['pitr'] {
  const description = output.ContinuousBackupsDescription
  const recovery = description?.PointInTimeRecoveryDescription
  if (
    description?.ContinuousBackupsStatus !== 'ENABLED' ||
    recovery?.PointInTimeRecoveryStatus !== 'ENABLED' ||
    !recovery.EarliestRestorableDateTime ||
    !recovery.LatestRestorableDateTime
  ) {
    throw invalidPitrEvidence(role)
  }
  const earliestRestorableTime = toCanonicalTimestamp(
    recovery.EarliestRestorableDateTime,
  )
  const latestRestorableTime = toCanonicalTimestamp(
    recovery.LatestRestorableDateTime,
  )
  if (
    recovery.EarliestRestorableDateTime.getTime() >
    recovery.LatestRestorableDateTime.getTime()
  ) {
    throw invalidPitrEvidence(role)
  }
  return {
    status: 'ENABLED',
    earliestRestorableTime,
    latestRestorableTime,
  }
}

/**
 * Creates a stable unusable-PITR failure.
 *
 * @param role - Logical table role.
 * @returns Operator-safe PITR failure.
 */
function invalidPitrEvidence(
  role: WorkspaceSearchMigrationTableRole,
): WorkspaceSearchMigrationFailure {
  return createIdentityFailure(
    'PITR_NOT_READY',
    `The ${role} table does not have usable point-in-time recovery.`,
  )
}

/**
 * Parses a DynamoDB table ARN without accepting endpoints or non-table resources.
 *
 * @param value - Candidate ARN.
 * @returns Account, region, and physical table name.
 */
function parseDynamoTableArn(value: string): {
  /** AWS account in the ARN. */
  account: string
  /** AWS region in the ARN. */
  region: string
  /** Physical table name in the ARN resource. */
  tableName: string
} {
  const parts = value.split(':')
  const resource = parts[5]
  if (
    parts.length !== 6 ||
    parts[0] !== 'arn' ||
    !isAwsPartition(parts[1]) ||
    parts[2] !== 'dynamodb' ||
    !isAwsRegion(parts[3]) ||
    !isAwsAccount(parts[4]) ||
    !resource?.startsWith('table/')
  ) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'A migration table ARN is invalid.',
    )
  }
  const tableName = resource.slice('table/'.length)
  if (!isNonEmptyString(tableName) || tableName.includes('/')) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'A migration table ARN resource is invalid.',
    )
  }
  return {
    account: parts[4],
    region: parts[3],
    tableName,
  }
}

/**
 * Creates a complete role-keyed table record and rejects omissions.
 *
 * @param entries - Measured role and identity pairs.
 * @returns Complete identity record.
 */
function createTableIdentityRecord(
  entries: readonly (readonly [
    WorkspaceSearchMigrationTableRole,
    MigrationTableIdentity,
  ])[],
): Readonly<Record<WorkspaceSearchMigrationTableRole, MigrationTableIdentity>> {
  const map = new Map(entries)
  const projectDirectory = map.get('project-directory')
  const workItems = map.get('work-items')
  const collaboration = map.get('collaboration')
  const documents = map.get('documents')
  const workspaceSearch = map.get('workspace-search')
  const migrationState = map.get('migration-state')
  if (
    !projectDirectory ||
    !workItems ||
    !collaboration ||
    !documents ||
    !workspaceSearch ||
    !migrationState ||
    map.size !== 6
  ) {
    throw createIdentityFailure(
      'INVALID_ARGUMENT',
      'Every migration table role must be configured exactly once.',
    )
  }
  return {
    'project-directory': projectDirectory,
    'work-items': workItems,
    collaboration,
    documents,
    'workspace-search': workspaceSearch,
    'migration-state': migrationState,
  }
}

/**
 * Validates operator-selected account, region, profile, and resources.
 *
 * @param requested - Candidate requested resources.
 */
export function validateWorkspaceSearchMigrationRequestedResources(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): void {
  if (
    !isAwsAccount(requested.account) ||
    !isAwsRegion(requested.region) ||
    !isSafeProfile(requested.profile) ||
    typeof requested.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(requested.commit) ||
    !isS3BucketName(requested.journalBucket) ||
    !isKmsKeyArn(requested.journalKeyArn, requested.account, requested.region)
  ) {
    throw createIdentityFailure(
      'INVALID_ARGUMENT',
      'Migration account, region, profile, commit, or journal configuration is invalid.',
    )
  }
  const tableRoleKeys = Reflect.ownKeys(requested.tables)
  const tableNames = WORKSPACE_SEARCH_MIGRATION_TABLE_ROLES.map(
    (role) => requested.tables[role],
  )
  const uniqueNames = new Set(tableNames)
  if (
    !hasExactMigrationTableRoles(tableRoleKeys) ||
    uniqueNames.size !== WORKSPACE_SEARCH_MIGRATION_TABLE_ROLES.length ||
    tableNames.some((tableName) => !isDynamoTableName(tableName))
  ) {
    throw createIdentityFailure(
      'INVALID_ARGUMENT',
      'Migration table names must be valid and physically distinct.',
    )
  }
}

/**
 * Creates one expected key descriptor.
 *
 * @param name - Physical attribute name.
 * @param role - Partition or sort key role.
 * @param type - DynamoDB scalar type.
 * @returns Key descriptor.
 */
function keyAttribute(
  name: string,
  role: MigrationKeyAttribute['role'],
  type: MigrationKeyAttribute['type'],
): MigrationKeyAttribute {
  return { name, role, type }
}

/**
 * Creates one expected global secondary index descriptor.
 *
 * @param name - Physical index name.
 * @param key - Ordered key descriptor.
 * @param projection - Projection type.
 * @returns Expected active index descriptor.
 */
function globalSecondaryIndex(
  name: string,
  key: readonly MigrationKeyAttribute[],
  projection: MigrationGlobalSecondaryIndex['projection'],
): MigrationGlobalSecondaryIndex {
  return {
    name,
    key,
    projection,
    nonKeyAttributes: [],
    status: 'ACTIVE',
  }
}

/**
 * Reads a table role produced by Object.entries.
 *
 * @param value - Candidate role.
 * @returns Valid table role.
 */
function readTableRole(value: string): WorkspaceSearchMigrationTableRole {
  if (
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'workspace-search' ||
    value === 'migration-state'
  ) {
    return value
  }
  throw createIdentityFailure(
    'INVALID_ARGUMENT',
    'Migration table role is invalid.',
  )
}

/**
 * Creates a stable journal-configuration error.
 *
 * @param setting - Secret-free setting label.
 * @returns Operator-safe migration failure.
 */
function invalidJournalConfiguration(setting: string): WorkspaceSearchMigrationFailure {
  return createIdentityFailure(
    'CONFIGURATION_DRIFT',
    `The migration journal ${setting} does not satisfy the v1 safety contract.`,
  )
}

/**
 * Checks one AWS service exception by its stable modeled error name.
 *
 * @param error - Unknown port failure.
 * @param expectedName - Modeled AWS service exception name.
 * @returns Whether the failure has the expected modeled name.
 */
function hasErrorName(error: unknown, expectedName: string): boolean {
  return error instanceof Error && error.name === expectedName
}

/**
 * Creates and brands one failure from the adapter's closed safe vocabulary.
 *
 * @param code - Stable migration failure code.
 * @param message - Fixed secret-free operator guidance.
 * @returns Failure trusted by both adapter and public identity boundaries.
 */
function createIdentityAdapterFailure(
  code: WorkspaceSearchMigrationFailureCode,
  message: string,
): WorkspaceSearchMigrationFailure {
  const failure = createIdentityFailure(code, message)
  trustedIdentityAdapterFailures.add(failure)
  return failure
}

/**
 * Creates and privately brands one trusted operator-safe identity failure.
 *
 * @param code - Stable migration failure code.
 * @param message - Secret-free operator guidance.
 * @returns Branded failure that may cross the public redaction boundary.
 */
function createIdentityFailure(
  code: WorkspaceSearchMigrationFailureCode,
  message: string,
): WorkspaceSearchMigrationFailure {
  const failure = new WorkspaceSearchMigrationFailure(code, message)
  Object.freeze(failure)
  trustedIdentityFailures.add(failure)
  return failure
}

/**
 * Checks failure provenance without invoking attacker-controlled prototype
 * traps.
 *
 * @param error - Unknown thrown value.
 * @returns Whether this module created and branded the failure.
 */
function isTrustedIdentityFailure(
  error: unknown,
): error is WorkspaceSearchMigrationFailure {
  return typeof error === 'object' &&
    error !== null &&
    trustedIdentityFailures.has(error)
}

/**
 * Converts a Date to canonical UTC form.
 *
 * @param value - Date returned by an AWS SDK response.
 * @returns Canonical timestamp.
 */
function toCanonicalTimestamp(value: Date): string {
  const time = value.getTime()
  if (!Number.isFinite(time)) {
    throw createIdentityFailure(
      'IDENTITY_MISMATCH',
      'An AWS control-plane timestamp is invalid.',
    )
  }
  return new Date(time).toISOString()
}

/**
 * Returns a stable key-role sort rank.
 *
 * @param role - Partition or sort key role.
 * @returns Sort rank.
 */
function keyRoleRank(role: MigrationKeyAttribute['role']): number {
  return role === 'HASH' ? 0 : 1
}

/**
 * Checks an AWS account identifier.
 *
 * @param value - Candidate account.
 * @returns Whether the account is a 12-digit identifier.
 */
function isAwsAccount(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{12}$/.test(value)
}

/**
 * Checks an AWS ARN partition identifier.
 *
 * @param value - Candidate partition.
 * @returns Whether the partition uses an official AWS partition shape.
 */
function isAwsPartition(value: unknown): value is string {
  return typeof value === 'string' && /^aws(?:-[a-z0-9-]+)?$/.test(value)
}

/**
 * Checks a bounded conventional AWS region identifier.
 *
 * @param value - Candidate region.
 * @returns Whether the region is safe in an official AWS endpoint.
 */
function isAwsRegion(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 32 &&
    /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/.test(value)
}

/**
 * Checks a shared-configuration profile without accepting whitespace or paths.
 *
 * @param value - Candidate profile.
 * @returns Whether the profile is safe and explicit.
 */
function isSafeProfile(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

/**
 * Checks a physical DynamoDB table name before any control-plane lookup.
 *
 * @param value - Candidate physical table name.
 * @returns Whether the value satisfies DynamoDB table-name constraints.
 */
function isDynamoTableName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_.-]{3,255}$/.test(value)
}

/**
 * Checks a general-purpose S3 bucket name before any control-plane lookup.
 *
 * @param value - Candidate journal bucket name.
 * @returns Whether the value satisfies current general-purpose bucket rules.
 */
function isS3BucketName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)
  ) {
    return false
  }
  const reservedPrefixes = ['xn--', 'sthree-', 'amzn_s3_demo_']
  const reservedSuffixes = [
    '-s3alias',
    '--ol-s3',
    '.mrap',
    '--x-s3',
    '--table-s3',
  ]
  return !reservedPrefixes.some((prefix) => value.startsWith(prefix)) &&
    !reservedSuffixes.some((suffix) => value.endsWith(suffix))
}

/**
 * Checks one IAM role name carried by an STS assumed-role ARN.
 *
 * @param value - Candidate role name.
 * @returns Whether the segment uses the bounded IAM role-name shape.
 */
function isIamRoleName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_+=,.@-]+$/.test(value)
}

/**
 * Checks the final STS assumed-role session segment.
 *
 * @param value - Candidate role session name.
 * @returns Whether the name uses the bounded STS session-name shape.
 */
function isRoleSessionName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_+=,.@-]{2,64}$/.test(value)
}

/**
 * Checks a KMS key ARN in the requested account and region.
 *
 * @param value - Candidate key ARN.
 * @param account - Requested account.
 * @param region - Requested region.
 * @returns Whether the ARN identifies a key in the requested environment.
 */
function isKmsKeyArn(value: unknown, account: string, region: string): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  return parts.length === 6 &&
    parts[0] === 'arn' &&
    isAwsPartition(parts[1]) &&
    parts[2] === 'kms' &&
    parts[3] === region &&
    parts[4] === account &&
    /^key\/[A-Za-z0-9-]+$/.test(parts[5] ?? '')
}

/**
 * Checks a DynamoDB scalar attribute type.
 *
 * @param value - Candidate type.
 * @returns Whether the value is B, N, or S.
 */
function isScalarAttributeType(value: unknown): value is ScalarAttributeType {
  return value === 'B' || value === 'N' || value === 'S'
}

/**
 * Checks non-empty text without normalizing it.
 *
 * @param value - Candidate text.
 * @returns Whether the value contains non-whitespace text.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Compares strings by UTF-8 bytes.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive comparison value.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
