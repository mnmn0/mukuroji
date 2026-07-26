import {
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  DescribeKeyCommand,
  type DescribeKeyCommandOutput,
  KMSClient,
} from '@aws-sdk/client-kms'
import {
  GetBucketEncryptionCommand,
  type GetBucketEncryptionOutput,
  GetBucketLoggingCommand,
  type GetBucketLoggingOutput,
  GetBucketVersioningCommand,
  type GetBucketVersioningOutput,
  GetObjectLockConfigurationCommand,
  type GetObjectLockConfigurationOutput,
  S3Client,
} from '@aws-sdk/client-s3'
import type { fromIni } from '@aws-sdk/credential-provider-ini'
import {
  AssumeRoleCommand,
  type Credentials,
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
  STSClient,
} from '@aws-sdk/client-sts'
import { parseKnownFiles } from '@smithy/core/config'
import {
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationIdentityPort,
  type WorkspaceSearchMigrationJournalKeyMetadata,
  type WorkspaceSearchMigrationJournalLookup,
  type WorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResourcesSnapshot,
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  createWorkspaceSearchMigrationRequestedResourcesSnapshot,
  measureWorkspaceSearchMigrationConfiguration,
} from './migration-identity'

/** AWS services used by the migration identity entry gate. */
type WorkspaceSearchMigrationIdentityAwsService =
  | 'dynamodb'
  | 'kms'
  | 's3'
  | 'sts'

/** Initialization accepted by the explicitly selected shared-profile provider. */
type WorkspaceSearchMigrationProfileCredentialsOptions =
  NonNullable<Parameters<typeof fromIni>[0]>

/** Named-profile role-assumption callback supplied to the AWS SDK. */
type WorkspaceSearchMigrationProfileRoleAssumer = NonNullable<
  WorkspaceSearchMigrationProfileCredentialsOptions['roleAssumer']
>

/** Credentials returned by one safe shared-profile resolution. */
type WorkspaceSearchMigrationProfileCredentials = Awaited<
  ReturnType<ReturnType<typeof fromIni>>
>

/** Parsed shared profiles loaded from the selected AWS configuration files. */
type WorkspaceSearchMigrationSharedProfiles =
  Awaited<ReturnType<typeof parseKnownFiles>>

/** Immutable selected-chain plan for static shared-profile credentials. */
type WorkspaceSearchMigrationStaticCredentialPlan = {
  /** Credential-plan discriminator. */
  readonly kind: 'static'
  /** Selected source access key ID. */
  readonly accessKeyId: string
  /** Selected source secret access key. */
  readonly secretAccessKey: string
  /** Optional selected source session token. */
  readonly sessionToken: string | undefined
}

/** Immutable selected-chain plan for one explicit AssumeRole hop. */
type WorkspaceSearchMigrationAssumeRoleCredentialPlan = {
  /** Credential-plan discriminator. */
  readonly kind: 'assume-role'
  /** Validated IAM role ARN. */
  readonly roleArn: string
  /** Explicit stable role-session name. */
  readonly roleSessionName: string
  /** Optional external identifier. */
  readonly externalId: string | undefined
  /** Validated STS session duration. */
  readonly durationSeconds: number
  /** Selected source-profile plan for this role. */
  readonly source: WorkspaceSearchMigrationCredentialPlan
}

/** Exact selected source-profile chain retained across credential refreshes. */
type WorkspaceSearchMigrationCredentialPlan =
  | WorkspaceSearchMigrationStaticCredentialPlan
  | WorkspaceSearchMigrationAssumeRoleCredentialPlan

/** Official STS location used by every nested profile role assumption. */
type WorkspaceSearchMigrationRoleAssumptionConfiguration = {
  /** Partition-aware official STS endpoint. */
  readonly endpoint: string
  /** Explicit shared-configuration profile. */
  readonly profile: string
  /** Explicit AWS region. */
  readonly region: string
}

/** Profile mechanisms excluded from the migration's credential boundary. */
const unsupportedWorkspaceSearchMigrationProfileKeys: readonly string[] =
  Object.freeze([
    'credential_process',
    'credential_source',
    'login_session',
    'mfa_serial',
    'sso_account_id',
    'sso_region',
    'sso_role_name',
    'sso_session',
    'sso_start_url',
    'web_identity_token_file',
  ])

/** Refresh lead time shared by every service client in one invocation. */
const PROFILE_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS = 5 * 60 * 1_000

/** Maximum explicit source-profile depth accepted by the migration. */
const MAXIMUM_PROFILE_ROLE_CHAIN_DEPTH = 8

/** Explicit AWS SDK client configuration retained for construction tests. */
export type WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration = {
  /** Credentials resolved only from the explicitly selected shared profile. */
  readonly credentials: ReturnType<typeof fromIni>
  /** Partition-aware official regional endpoint. */
  readonly endpoint: string
  /** Explicit shared-configuration profile that selected the credentials. */
  readonly profile: string
  /** Explicit AWS region used by the client. */
  readonly region: string
}

/** S3 client configuration that refuses transparent cross-region redirects. */
export type WorkspaceSearchMigrationIdentityS3SdkClientConfiguration =
  WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration & {
    /** Prevents a journal bucket in another region from being followed. */
    readonly followRegionRedirects: false
  }

/** Complete client configurations supplied to the allowlisted SDK transport. */
export type WorkspaceSearchMigrationIdentityAwsSdkConfigurations = {
  /** DynamoDB control-plane client configuration. */
  readonly dynamodb: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
  /** KMS control-plane client configuration. */
  readonly kms: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
  /** S3 control-plane client configuration. */
  readonly s3: WorkspaceSearchMigrationIdentityS3SdkClientConfiguration
  /** STS identity client configuration. */
  readonly sts: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
}

/** Closeable identity port owned by one migration operator invocation. */
export interface WorkspaceSearchMigrationManagedIdentityPort
  extends WorkspaceSearchMigrationIdentityPort {
  /**
   * Releases resources retained by the AWS SDK clients.
   */
  close(): void
  /**
   * Measures identity with the same immutable resource snapshot that configured
   * this port.
   *
   * @returns Exact measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>
}

/** Narrow transport containing only the identity entry gate's AWS reads. */
export interface WorkspaceSearchMigrationIdentityAwsTransport {
  /**
   * Releases all underlying AWS SDK clients.
   */
  close(): void
  /**
   * Sends one DynamoDB point-in-time recovery read.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /**
   * Sends one KMS key metadata read.
   *
   * @param command - Exact read-only command.
   * @returns KMS key metadata response.
   */
  describeKey(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput>
  /**
   * Sends one DynamoDB table metadata read.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB table metadata response.
   */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput>
  /**
   * Sends one DynamoDB TTL metadata read.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput>
  /**
   * Sends one S3 bucket-encryption read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 encryption response.
   */
  getBucketEncryption(
    command: GetBucketEncryptionCommand,
  ): Promise<GetBucketEncryptionOutput>
  /**
   * Sends one S3 server-access-logging read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 logging response.
   */
  getBucketLogging(
    command: GetBucketLoggingCommand,
  ): Promise<GetBucketLoggingOutput>
  /**
   * Sends one S3 bucket-versioning read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 versioning response.
   */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
  ): Promise<GetBucketVersioningOutput>
  /**
   * Sends one STS caller-identity read.
   *
   * @param command - Exact read-only command.
   * @returns STS caller response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput>
  /**
   * Sends one S3 Object Lock configuration read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 Object Lock response.
   */
  getObjectLockConfiguration(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationOutput>
}

/**
 * Injectable constructor for the allowlisted AWS SDK transport.
 *
 * @param configurations - Explicit official-endpoint client configurations.
 * @returns Transport exposing only the identity entry gate's reads.
 */
export type WorkspaceSearchMigrationIdentityAwsTransportConstructor = (
  configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
) => WorkspaceSearchMigrationIdentityAwsTransport

/** AWS SDK transport whose public surface contains no mutation operation. */
class AwsSdkWorkspaceSearchMigrationIdentityTransport
  implements WorkspaceSearchMigrationIdentityAwsTransport {
  /** DynamoDB client bound to the explicit profile and region. */
  private readonly dynamodbClient: DynamoDBClient

  /** KMS client bound to the explicit profile and region. */
  private readonly kmsClient: KMSClient

  /** S3 client bound to the explicit profile and region. */
  private readonly s3Client: S3Client

  /** STS client bound to the explicit profile and region. */
  private readonly stsClient: STSClient

  /**
   * Creates the exact clients needed by the identity entry gate.
   *
   * @param configurations - Explicit official-endpoint client configurations.
   */
  constructor(configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations) {
    this.dynamodbClient = new DynamoDBClient(configurations.dynamodb)
    this.kmsClient = new KMSClient(configurations.kms)
    this.s3Client = new S3Client(configurations.s3)
    this.stsClient = new STSClient(configurations.sts)
  }

  /**
   * Releases every AWS SDK client.
   */
  close(): void {
    this.dynamodbClient.destroy()
    this.kmsClient.destroy()
    this.s3Client.destroy()
    this.stsClient.destroy()
  }

  /**
   * Sends one point-in-time recovery read.
   *
   * @param command - Exact DescribeContinuousBackups command.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one KMS key metadata read.
   *
   * @param command - Exact DescribeKey command.
   * @returns KMS key metadata response.
   */
  describeKey(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput> {
    return this.kmsClient.send(command)
  }

  /**
   * Sends one table metadata read.
   *
   * @param command - Exact DescribeTable command.
   * @returns DynamoDB table metadata response.
   */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one TTL metadata read.
   *
   * @param command - Exact DescribeTimeToLive command.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one bucket-encryption read.
   *
   * @param command - Exact GetBucketEncryption command.
   * @returns S3 encryption response.
   */
  getBucketEncryption(
    command: GetBucketEncryptionCommand,
  ): Promise<GetBucketEncryptionOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Sends one bucket-logging read.
   *
   * @param command - Exact GetBucketLogging command.
   * @returns S3 logging response.
   */
  getBucketLogging(
    command: GetBucketLoggingCommand,
  ): Promise<GetBucketLoggingOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Sends one bucket-versioning read.
   *
   * @param command - Exact GetBucketVersioning command.
   * @returns S3 versioning response.
   */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
  ): Promise<GetBucketVersioningOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Sends one caller-identity read.
   *
   * @param command - Exact GetCallerIdentity command.
   * @returns STS caller response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
  }

  /**
   * Sends one Object Lock configuration read.
   *
   * @param command - Exact GetObjectLockConfiguration command.
   * @returns S3 Object Lock response.
   */
  getObjectLockConfiguration(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationOutput> {
    return this.s3Client.send(command)
  }
}

/** Read-only AWS adapter bound to one validated resource selection. */
class AwsWorkspaceSearchMigrationIdentityPort
  implements WorkspaceSearchMigrationManagedIdentityPort {
  /** Immutable resource snapshot shared with identity measurement. */
  private readonly requested: WorkspaceSearchMigrationRequestedResourcesSnapshot

  /** Digest binding every read to the immutable resource snapshot. */
  private readonly requestedResourcesBinding: string

  /** AWS account selected by the operator. */
  private readonly account: string

  /** Physical journal bucket selected by the operator. */
  private readonly journalBucket: string

  /** Customer-managed journal key selected by the operator. */
  private readonly journalKeyArn: string

  /** Exact physical table names selected by the operator. */
  private readonly tableNames: ReadonlySet<string>

  /** Allowlisted AWS command transport. */
  private readonly transport: WorkspaceSearchMigrationIdentityAwsTransport

  /**
   * Creates a port bound to immutable copies of the reviewed resources.
   *
   * @param requested - Validated operator-selected resources.
   * @param transport - Allowlisted AWS command transport.
   */
  constructor(
    requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
    transport: WorkspaceSearchMigrationIdentityAwsTransport,
  ) {
    this.requested = requested
    this.requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
    this.account = requested.account
    this.journalBucket = requested.journalBucket
    this.journalKeyArn = requested.journalKeyArn
    this.tableNames = new Set(Object.values(requested.tables))
    this.transport = transport
  }

  /**
   * Releases every AWS SDK client owned by the transport.
   */
  close(): void {
    this.transport.close()
  }

  /**
   * Measures identity against the same snapshot that configured every client
   * and lookup allowlist.
   *
   * @returns Exact measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration> {
    return measureWorkspaceSearchMigrationConfiguration({
      requested: this.requested,
      port: this,
    })
  }

  /**
   * Returns the digest of the resource snapshot that configured this port.
   *
   * @returns Lowercase SHA-256 resource-selection digest.
   */
  readRequestedResourcesBinding(): string {
    return this.requestedResourcesBinding
  }

  /**
   * Reads the exact selected table's point-in-time recovery state.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    this.validateTableName(tableName)
    return this.transport.describeContinuousBackups(
      new DescribeContinuousBackupsCommand({ TableName: tableName }),
    )
  }

  /**
   * Reads the exact selected journal KMS key metadata.
   *
   * @param keyArn - Operator-selected KMS key ARN.
   * @returns Narrow detached KMS key metadata.
   */
  async describeJournalKey(
    keyArn: string,
  ): Promise<WorkspaceSearchMigrationJournalKeyMetadata> {
    if (keyArn !== this.journalKeyArn) {
      throw invalidIdentityLookup()
    }
    const output = await this.transport.describeKey(
      new DescribeKeyCommand({ KeyId: keyArn }),
    )
    const metadata = output.KeyMetadata
    const arn = metadata?.Arn
    const awsAccountId = metadata?.AWSAccountId
    const keyId = metadata?.KeyId
    const creationDate = metadata?.CreationDate
    const enabled = metadata?.Enabled
    const keyManager = metadata?.KeyManager
    const keyState = metadata?.KeyState
    const keyUsage = metadata?.KeyUsage
    const keySpec = metadata?.KeySpec
    const origin = metadata?.Origin
    const multiRegion = metadata?.MultiRegion
    return {
      arn,
      awsAccountId,
      keyId,
      creationDate: creationDate === undefined
        ? undefined
        : new Date(creationDate.getTime()),
      enabled,
      keyManager,
      keyState,
      keyUsage,
      keySpec,
      origin,
      multiRegion,
    }
  }

  /**
   * Reads the exact selected table's physical metadata.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB table metadata response.
   */
  describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    this.validateTableName(tableName)
    return this.transport.describeTable(
      new DescribeTableCommand({ TableName: tableName }),
    )
  }

  /**
   * Reads the exact selected table's TTL state.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    tableName: string,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    this.validateTableName(tableName)
    return this.transport.describeTimeToLive(
      new DescribeTimeToLiveCommand({ TableName: tableName }),
    )
  }

  /**
   * Reads the selected journal bucket's default encryption.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 encryption response.
   */
  getBucketEncryption(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketEncryptionOutput> {
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketEncryption(
      new GetBucketEncryptionCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads the selected journal bucket's access-logging configuration.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 logging response.
   */
  getBucketLogging(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketLoggingOutput> {
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketLogging(
      new GetBucketLoggingCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads the selected journal bucket's versioning state.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 versioning response.
   */
  getBucketVersioning(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketVersioningOutput> {
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketVersioning(
      new GetBucketVersioningCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads and validates the caller identity returned by STS.
   *
   * @returns Complete STS caller identity.
   */
  async readCallerIdentity(): Promise<{
    /** AWS account returned by STS. */
    account: string
    /** Caller ARN returned by STS. */
    arn: string
    /** Caller unique ID returned by STS. */
    userId: string
  }> {
    const output = await this.transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    const account = output.Account
    const arn = output.Arn
    const userId = output.UserId
    if (
      !isNonEmptyString(account) ||
      !isNonEmptyString(arn) ||
      !isNonEmptyString(userId)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'IDENTITY_MISMATCH',
        'STS caller identity response is incomplete.',
      )
    }
    return {
      account,
      arn,
      userId,
    }
  }

  /**
   * Reads the selected journal bucket's Object Lock configuration.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 Object Lock response.
   */
  getObjectLockConfiguration(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetObjectLockConfigurationOutput> {
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getObjectLockConfiguration(
      new GetObjectLockConfigurationCommand(
        createBucketLookupInput(validatedLookup),
      ),
    )
  }

  /**
   * Rejects a table lookup outside the reviewed resource selection.
   *
   * @param tableName - Candidate physical table name.
   */
  private validateTableName(tableName: string): void {
    if (!this.tableNames.has(tableName)) {
      throw invalidIdentityLookup()
    }
  }

  /**
   * Snapshots and validates one S3 lookup against the reviewed bucket and
   * account.
   *
   * @param lookup - Candidate journal lookup.
   * @returns Detached owner-bound lookup used to construct one command.
   */
  private createJournalLookupSnapshot(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): WorkspaceSearchMigrationJournalLookup {
    let snapshot: WorkspaceSearchMigrationJournalLookup
    try {
      snapshot = {
        bucketName: lookup.bucketName,
        expectedBucketOwner: lookup.expectedBucketOwner,
      }
    } catch {
      throw invalidIdentityLookup()
    }
    if (
      snapshot.bucketName !== this.journalBucket ||
      snapshot.expectedBucketOwner !== this.account
    ) {
      throw invalidIdentityLookup()
    }
    return snapshot
  }
}

/**
 * Creates a production identity port pinned to explicit resources and endpoints.
 *
 * @param requested - Complete operator-selected migration resources.
 * @param transportConstructor - Injectable allowlisted transport constructor.
 * @returns Closeable read-only identity port.
 */
export function createAwsWorkspaceSearchMigrationIdentityPort(
  requested: WorkspaceSearchMigrationRequestedResources,
  transportConstructor: WorkspaceSearchMigrationIdentityAwsTransportConstructor =
    createDefaultAwsTransport,
): WorkspaceSearchMigrationManagedIdentityPort {
  const resources =
    createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  const credentials = createPinnedProfileCredentials(resources)
  /**
   * Creates one official-endpoint SDK client configuration.
   *
   * @param service - Allowlisted AWS service.
   * @returns Client configuration bound to the resource snapshot.
   */
  const createConfiguration = (
    service: WorkspaceSearchMigrationIdentityAwsService,
  ): WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration => ({
    credentials,
    endpoint: resolveOfficialAwsRegionalEndpoint(service, resources.region),
    profile: resources.profile,
    region: resources.region,
  })
  const configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations = {
    dynamodb: createConfiguration('dynamodb'),
    kms: createConfiguration('kms'),
    s3: {
      ...createConfiguration('s3'),
      followRegionRedirects: false,
    },
    sts: createConfiguration('sts'),
  }
  return new AwsWorkspaceSearchMigrationIdentityPort(
    resources,
    transportConstructor(configurations),
  )
}

/**
 * Creates a named-profile provider whose nested STS operations cannot honor
 * endpoint override environment variables.
 *
 * @param requested - Validated immutable resource selection.
 * @returns Lazy shared-profile credentials provider.
 */
function createPinnedProfileCredentials(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): ReturnType<typeof fromIni> {
  const configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration = {
    endpoint: resolveOfficialAwsRegionalEndpoint('sts', requested.region),
    profile: requested.profile,
    region: requested.region,
  }
  const roleAssumer = createPinnedRoleAssumer(configuration)
  let cachedCredentials: WorkspaceSearchMigrationProfileCredentials | undefined
  let credentialPlan:
    Promise<WorkspaceSearchMigrationCredentialPlan> | undefined
  let pendingRefresh:
    Promise<WorkspaceSearchMigrationProfileCredentials> | undefined
  return async () => {
    try {
      if (
        cachedCredentials &&
        hasUsableProfileCredentialLifetime(cachedCredentials)
      ) {
        return detachProfileCredentials(cachedCredentials)
      }
      credentialPlan ??= loadPinnedCredentialPlan(requested.profile)
      pendingRefresh ??= credentialPlan.then((plan) =>
        resolvePinnedProfileCredentials(
          plan,
          roleAssumer,
        ),
      )
      const resolved = await pendingRefresh
      cachedCredentials = Object.freeze(resolved)
      return detachProfileCredentials(cachedCredentials)
    } catch {
      cachedCredentials = undefined
      throw invalidProfileCredentials()
    } finally {
      pendingRefresh = undefined
    }
  }
}

/**
 * Loads only the selected validated source chain into an immutable credential
 * plan used by every refresh in an invocation.
 *
 * @param profileName - Explicit selected profile name.
 * @returns Null-prototype plan that retains no unrelated profile secret.
 */
async function loadPinnedCredentialPlan(
  profileName: string,
): Promise<WorkspaceSearchMigrationCredentialPlan> {
  const profiles = await parseKnownFiles({
    ignoreCache: true,
    profile: profileName,
  })
  return createPinnedCredentialPlan(
    profileName,
    profiles,
    new Set(),
  )
}

/**
 * Resolves only static credentials or an explicit source-profile assume-role
 * chain from the invocation's immutable selected-chain plan.
 *
 * @param plan - Immutable selected source-profile chain.
 * @param roleAssumer - Pinned assume-role callback.
 * @returns Complete credentials shared by every service client.
 */
async function resolvePinnedProfileCredentials(
  plan: WorkspaceSearchMigrationCredentialPlan,
  roleAssumer: WorkspaceSearchMigrationProfileRoleAssumer,
): Promise<WorkspaceSearchMigrationProfileCredentials> {
  if (plan.kind === 'static') {
    return {
      accessKeyId: plan.accessKeyId,
      secretAccessKey: plan.secretAccessKey,
      sessionToken: plan.sessionToken,
    }
  }
  const sourceCredentials = await resolvePinnedProfileCredentials(
    plan.source,
    roleAssumer,
  )
  return roleAssumer(sourceCredentials, {
    RoleArn: plan.roleArn,
    RoleSessionName: plan.roleSessionName,
    ExternalId: plan.externalId,
    DurationSeconds: plan.durationSeconds,
  })
}

/**
 * Recursively builds one exact selected-chain credential plan.
 *
 * @param profileName - Current profile in the explicit source chain.
 * @param profiles - Temporary full shared-file parse.
 * @param visitedProfiles - Profiles already visited in this chain.
 * @returns Frozen null-prototype static or AssumeRole plan.
 */
function createPinnedCredentialPlan(
  profileName: string,
  profiles: WorkspaceSearchMigrationSharedProfiles,
  visitedProfiles: ReadonlySet<string>,
): WorkspaceSearchMigrationCredentialPlan {
  if (
    !isSafeProfileName(profileName) ||
    visitedProfiles.has(profileName) ||
    visitedProfiles.size >= MAXIMUM_PROFILE_ROLE_CHAIN_DEPTH
  ) {
    throw invalidProfileCredentials()
  }
  const profile = readOwnProfile(profiles, profileName)
  if (hasUnsupportedProfileMechanism(profile)) {
    throw invalidProfileCredentials()
  }
  if (
    hasOwnProfileField(profile, 'role_arn') ||
    hasOwnProfileField(profile, 'source_profile')
  ) {
    return createPinnedAssumeRoleCredentialPlan(
      profile,
      profiles,
      new Set([...visitedProfiles, profileName]),
    )
  }
  return createPinnedStaticCredentialPlan(profile)
}

/**
 * Builds one immutable AssumeRole hop from exact own profile fields.
 *
 * @param profile - Parsed assume-role profile.
 * @param profiles - Temporary full shared-file parse.
 * @param visitedProfiles - Profiles already visited in this chain.
 * @returns Frozen null-prototype AssumeRole plan.
 */
function createPinnedAssumeRoleCredentialPlan(
  profile: object,
  profiles: WorkspaceSearchMigrationSharedProfiles,
  visitedProfiles: ReadonlySet<string>,
): WorkspaceSearchMigrationAssumeRoleCredentialPlan {
  const roleArn = readOwnProfileField(profile, 'role_arn')
  const sourceProfile = readOwnProfileField(profile, 'source_profile')
  const sessionName = readOwnProfileField(profile, 'role_session_name')
  const externalId = readOwnProfileField(profile, 'external_id')
  if (
    !isIamRoleArn(roleArn) ||
    !isSafeProfileName(sourceProfile) ||
    !isRoleSessionName(sessionName) ||
    (externalId !== undefined && !isNonEmptyString(externalId)) ||
    hasOwnProfileField(profile, 'aws_access_key_id') ||
    hasOwnProfileField(profile, 'aws_secret_access_key') ||
    hasOwnProfileField(profile, 'aws_session_token')
  ) {
    throw invalidProfileCredentials()
  }
  const source = createPinnedCredentialPlan(
    sourceProfile,
    profiles,
    visitedProfiles,
  )
  const plan: WorkspaceSearchMigrationAssumeRoleCredentialPlan = {
    kind: 'assume-role',
    roleArn,
    roleSessionName: sessionName,
    externalId,
    durationSeconds: readRoleDurationSeconds(
      readOwnProfileField(profile, 'duration_seconds'),
    ),
    source,
  }
  Object.setPrototypeOf(plan, null)
  return Object.freeze(plan)
}

/**
 * Builds one immutable static-credential leaf from exact own profile fields.
 *
 * @param profile - Parsed shared-profile section.
 * @returns Frozen null-prototype static credential plan.
 */
function createPinnedStaticCredentialPlan(
  profile: object,
): WorkspaceSearchMigrationStaticCredentialPlan {
  const accessKeyId = readOwnProfileField(profile, 'aws_access_key_id')
  const secretAccessKey = readOwnProfileField(
    profile,
    'aws_secret_access_key',
  )
  const sessionToken = readOwnProfileField(profile, 'aws_session_token')
  if (
    !isNonEmptyString(accessKeyId) ||
    !isNonEmptyString(secretAccessKey) ||
    (sessionToken !== undefined && !isNonEmptyString(sessionToken))
  ) {
    throw invalidProfileCredentials()
  }
  const plan: WorkspaceSearchMigrationStaticCredentialPlan = {
    kind: 'static',
    accessKeyId,
    secretAccessKey,
    sessionToken,
  }
  Object.setPrototypeOf(plan, null)
  return Object.freeze(plan)
}

/**
 * Reads one profile through an exact own data property on the parsed map.
 *
 * @param profiles - Temporary parsed shared-profile map.
 * @param profileName - Exact selected or source profile name.
 * @returns Object-valued own data property for the profile.
 */
function readOwnProfile(
  profiles: WorkspaceSearchMigrationSharedProfiles,
  profileName: string,
): object {
  if (!Object.hasOwn(profiles, profileName)) {
    throw invalidProfileCredentials()
  }
  const descriptor = Object.getOwnPropertyDescriptor(profiles, profileName)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalidProfileCredentials()
  }
  const value: unknown = descriptor.value
  if (typeof value !== 'object' || value === null) {
    throw invalidProfileCredentials()
  }
  return value
}

/**
 * Checks one exact own field without consulting a profile prototype.
 *
 * @param profile - Parsed profile object.
 * @param key - Exact shared-profile field name.
 * @returns Whether the profile defines the field itself.
 */
function hasOwnProfileField(profile: object, key: string): boolean {
  return Object.hasOwn(profile, key)
}

/**
 * Reads one exact own data property without consulting a profile prototype.
 *
 * @param profile - Parsed profile object.
 * @param key - Exact shared-profile field name.
 * @returns Own field value, or undefined when absent.
 */
function readOwnProfileField(profile: object, key: string): unknown {
  if (!hasOwnProfileField(profile, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(profile, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalidProfileCredentials()
  }
  return descriptor.value
}

/**
 * Rejects shared-profile mechanisms that add unmanaged clients, shell
 * execution, ambient credentials, or arbitrary metadata endpoints.
 *
 * @param profile - Parsed shared-profile section.
 * @returns Whether the profile uses an unsupported mechanism.
 */
function hasUnsupportedProfileMechanism(
  profile: object,
): boolean {
  return unsupportedWorkspaceSearchMigrationProfileKeys.some(
    (key) => hasOwnProfileField(profile, key),
  )
}

/**
 * Parses a strict STS role duration.
 *
 * @param value - Optional duration text from the shared profile.
 * @returns Duration in seconds, defaulting to one hour.
 */
function readRoleDurationSeconds(value: unknown): number {
  if (value === undefined) return 3_600
  if (typeof value !== 'string' || !/^[0-9]{3,5}$/.test(value)) {
    throw invalidProfileCredentials()
  }
  const duration = Number(value)
  if (!Number.isSafeInteger(duration) || duration < 900 || duration > 43_200) {
    throw invalidProfileCredentials()
  }
  return duration
}

/**
 * Checks whether cached credentials are safe to share for another client
 * request.
 *
 * @param credentials - Cached credentials.
 * @returns Whether they are static or remain valid beyond the refresh window.
 */
function hasUsableProfileCredentialLifetime(
  credentials: WorkspaceSearchMigrationProfileCredentials,
): boolean {
  const expiration = credentials.expiration
  if (expiration === undefined) return true
  const expirationTime = Date.prototype.getTime.call(expiration)
  return Number.isFinite(expirationTime) &&
    expirationTime - Date.now() >
    PROFILE_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS
}

/**
 * Returns a detached credential object so SDK wrappers cannot mutate the
 * shared cache.
 *
 * @param credentials - Cached shared credentials.
 * @returns Detached credentials with a cloned expiration.
 */
function detachProfileCredentials(
  credentials: WorkspaceSearchMigrationProfileCredentials,
): WorkspaceSearchMigrationProfileCredentials {
  const expiration = credentials.expiration
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: expiration === undefined
      ? undefined
      : new Date(Date.prototype.getTime.call(expiration)),
  }
}

/**
 * Creates an assume-role callback that owns and immediately releases its
 * official-endpoint STS client.
 *
 * @param configuration - Explicit profile, region, and STS endpoint.
 * @returns AWS SDK shared-profile role-assumption callback.
 */
function createPinnedRoleAssumer(
  configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration,
): WorkspaceSearchMigrationProfileRoleAssumer {
  return async (sourceCredentials, parameters) => {
    const client = new STSClient({
      ...configuration,
      credentials: sourceCredentials,
    })
    try {
      const output = await client.send(new AssumeRoleCommand(parameters))
      return readAssumedCredentials(output.Credentials)
    } finally {
      client.destroy()
    }
  }
}

/**
 * Detaches complete temporary credentials from one STS response.
 *
 * @param credentials - Temporary credentials returned by STS.
 * @returns Complete credentials suitable for signing migration reads.
 */
function readAssumedCredentials(
  credentials: Credentials | undefined,
): Awaited<ReturnType<WorkspaceSearchMigrationProfileRoleAssumer>> {
  let accessKeyId: unknown
  let secretAccessKey: unknown
  let sessionToken: unknown
  let expiration: unknown
  let expirationTime: unknown
  try {
    accessKeyId = credentials?.AccessKeyId
    secretAccessKey = credentials?.SecretAccessKey
    sessionToken = credentials?.SessionToken
    expiration = credentials?.Expiration
    expirationTime = Date.prototype.getTime.call(expiration)
  } catch {
    throw invalidAssumedCredentials()
  }
  if (
    !isNonEmptyString(accessKeyId) ||
    !isNonEmptyString(secretAccessKey) ||
    !isNonEmptyString(sessionToken) ||
    typeof expirationTime !== 'number' ||
    !Number.isFinite(expirationTime)
  ) {
    throw invalidAssumedCredentials()
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration: new Date(expirationTime),
  }
}

/**
 * Creates the concrete allowlisted AWS SDK transport.
 *
 * @param configurations - Explicit official-endpoint client configurations.
 * @returns AWS SDK transport exposing only entry-gate reads.
 */
function createDefaultAwsTransport(
  configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
): WorkspaceSearchMigrationIdentityAwsTransport {
  return new AwsSdkWorkspaceSearchMigrationIdentityTransport(configurations)
}

/**
 * Creates one owner-bound S3 control-plane command input.
 *
 * @param lookup - Validated journal bucket and expected owner.
 * @returns Exact S3 bucket input.
 */
function createBucketLookupInput(
  lookup: WorkspaceSearchMigrationJournalLookup,
): {
  /** Physical journal bucket name. */
  Bucket: string
  /** Expected AWS account that owns the bucket. */
  ExpectedBucketOwner: string
} {
  return {
    Bucket: lookup.bucketName,
    ExpectedBucketOwner: lookup.expectedBucketOwner,
  }
}

/**
 * Constructs a partition-aware official AWS regional endpoint.
 *
 * @param service - Allowlisted AWS service endpoint prefix.
 * @param region - Explicit AWS region.
 * @returns Official regional endpoint URL.
 */
function resolveOfficialAwsRegionalEndpoint(
  service: WorkspaceSearchMigrationIdentityAwsService,
  region: string,
): string {
  return `https://${service}.${region}.${resolveOfficialAwsDnsSuffix(region)}/`
}

/**
 * Resolves the official DNS suffix for supported AWS partitions.
 *
 * @param region - Explicit validated AWS region.
 * @returns Official non-dualstack DNS suffix.
 */
function resolveOfficialAwsDnsSuffix(region: string): string {
  if (region.startsWith('cn-')) {
    return 'amazonaws.com.cn'
  }
  if (region.startsWith('eusc-')) {
    return 'amazonaws.eu'
  }
  if (region.startsWith('us-iso-')) {
    return 'c2s.ic.gov'
  }
  if (region.startsWith('us-isob-')) {
    return 'sc2s.sgov.gov'
  }
  if (region.startsWith('eu-isoe-')) {
    return 'cloud.adc-e.uk'
  }
  if (region.startsWith('us-isof-')) {
    return 'csp.hci.ic.gov'
  }
  return 'amazonaws.com'
}

/**
 * Creates a stable failure for an incomplete STS role-assumption response.
 *
 * @returns Secret-free identity failure.
 */
function invalidAssumedCredentials(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'IDENTITY_MISMATCH',
    'STS role assumption response is incomplete.',
  )
}

/**
 * Creates a stable failure for an unsupported or malformed shared profile.
 *
 * @returns Secret-free identity failure.
 */
function invalidProfileCredentials(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'IDENTITY_MISMATCH',
    'Selected AWS profile credentials are unsupported or invalid.',
  )
}

/**
 * Creates a stable failure for a control-plane read outside reviewed resources.
 *
 * @returns Secret-free invalid-argument failure.
 */
function invalidIdentityLookup(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'INVALID_ARGUMENT',
    'Migration identity lookup is outside the requested resource set.',
  )
}

/**
 * Checks one explicit shared-profile name.
 *
 * @param value - Candidate profile name.
 * @returns Whether the profile name is bounded and path-free.
 */
function isSafeProfileName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

/**
 * Checks an IAM role ARN accepted for one explicit assume-role hop.
 *
 * @param value - Candidate role ARN.
 * @returns Whether the value is a bounded AWS-partition IAM role ARN.
 */
function isIamRoleArn(value: unknown): value is string {
  return typeof value === 'string' &&
    /^arn:aws(?:-[a-z0-9-]+)?:iam::[0-9]{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,64}$/.test(
      value,
    )
}

/**
 * Checks an explicit STS role-session name.
 *
 * @param value - Candidate role-session name.
 * @returns Whether the value satisfies STS length and character rules.
 */
function isRoleSessionName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_+=,.@-]{2,64}$/.test(value)
}

/**
 * Checks non-empty text without normalizing the AWS response.
 *
 * @param value - Candidate response field.
 * @returns Whether the field contains non-whitespace text.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
