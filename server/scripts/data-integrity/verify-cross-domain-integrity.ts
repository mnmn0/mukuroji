import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import {
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ObjectAttributes,
  S3Client,
  type GetObjectAttributesCommandOutput,
  type GetObjectTaggingCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  GetCallerIdentityCommand,
  STSClient,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResult,
  verifyCrossDomainIntegrityResult,
  type CrossDomainIntegrityLimits,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResourceTarget,
  type CrossDomainIntegrityResult,
} from './cross-domain-integrity'
import { runCrossDomainIntegrityAwsCheck } from './cross-domain-integrity-aws'
import type {
  CrossDomainIntegrityAwsReaderConfiguration,
  CrossDomainIntegrityBucketNames,
  CrossDomainIntegrityBucketTarget,
  CrossDomainIntegrityCheckBridgeInput,
  CrossDomainIntegrityManagedAwsReadPort,
  CrossDomainIntegrityObjectVersionReference,
  CrossDomainIntegrityRole,
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-aws-types'

export type {
  CrossDomainIntegrityAwsReaderConfiguration,
  CrossDomainIntegrityBucketNames,
  CrossDomainIntegrityBucketTarget,
  CrossDomainIntegrityCheckBridgeInput,
  CrossDomainIntegrityManagedAwsReadPort,
  CrossDomainIntegrityObjectVersionReference,
  CrossDomainIntegrityRole,
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-aws-types'

const DIGEST_KEY_HEX_LENGTH = 64
const MAX_EVIDENCE_BYTES = 1024 * 1024
const MAX_PAGE_SIZE = 1000
const MAX_PAGES = 10_000
const MAX_ITEMS = 1_000_000
const MAX_OBJECT_REFERENCE_BYTES = 1024

const requiredTableTargets: readonly CrossDomainIntegrityTableTarget[] = [
  'work-items',
  'work-item-configuration',
  'project-directory',
  'workspace-access',
  'audit-events',
  'file-proofing',
]

const checkFlagNames = new Set([
  '--account',
  '--audit-pseudonym-key-file',
  '--bucket',
  '--checked-at',
  '--digest-key-file',
  '--max-items',
  '--max-pages',
  '--output',
  '--page-size',
  '--profile',
  '--region',
  '--role',
  '--table',
])

const helpPayload = {
  status: 'help',
  commands: [
    'bun server/scripts/data-integrity/verify-cross-domain-integrity.ts check --role source|restore --checked-at <canonical-utc-timestamp> --account <account> --region <region> --profile <profile> --table work-items=<table> --table work-item-configuration=<table> --table project-directory=<table> --table workspace-access=<table> --table audit-events=<table> --table file-proofing=<table> --bucket file=<bucket> --page-size <count> --max-pages <count> --max-items <count> --audit-pseudonym-key-file <path> --digest-key-file <path> --output <path>',
    'bun server/scripts/data-integrity/verify-cross-domain-integrity.ts help',
  ],
}

/** Strictly parsed checker command arguments. */
export type CrossDomainIntegrityCheckCliArguments = {
  /** Expected AWS account identifier. */
  readonly account: string
  /** Complete logical-to-physical bucket allowlist. */
  readonly buckets: CrossDomainIntegrityBucketNames
  /** File containing the existing 32-byte Workspace Audit pseudonym key. */
  readonly auditPseudonymKeyFile: string
  /** Canonical UTC timestamp shared by paired source and restore checks. */
  readonly checkedAt: string
  /** Selected subcommand. */
  readonly command: 'check'
  /** File containing the dedicated 32-byte HMAC key. */
  readonly digestKeyFile: string
  /** Total maximum number of DynamoDB scan pages. */
  readonly maxPages: number
  /** Total maximum number of normalized checker records. */
  readonly maxItems: number
  /** Destination for secret-free evidence. */
  readonly output: string
  /** Maximum item count requested in each DynamoDB scan page. */
  readonly pageSize: number
  /** Explicit shared-configuration profile used for credentials. */
  readonly profile: string
  /** Explicit AWS region. */
  readonly region: string
  /** Source or isolated-restore dataset role. */
  readonly role: CrossDomainIntegrityRole
  /** Complete logical-to-physical table allowlist. */
  readonly tables: CrossDomainIntegrityTableNames
}

/** Strictly parsed help command arguments. */
export type CrossDomainIntegrityHelpCliArguments = {
  /** Selected subcommand. */
  readonly command: 'help'
}

/** Strictly parsed cross-domain integrity CLI arguments. */
export type CrossDomainIntegrityCliArguments =
  | CrossDomainIntegrityCheckCliArguments
  | CrossDomainIntegrityHelpCliArguments

/** Stable CLI operation names that never contain untrusted input. */
type CrossDomainIntegrityCliOperation = 'check' | 'help' | 'unknown'

/** Stable raw-data-free CLI failure categories. */
export type CrossDomainIntegrityCliFailureCode =
  | 'ACCOUNT_MISMATCH'
  | 'AUDIT_PSEUDONYM_KEY_INVALID'
  | 'AWS_READ_FAILED'
  | 'AWS_RESPONSE_INVALID'
  | 'DIGEST_KEY_INVALID'
  | 'EVIDENCE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INVALID_USAGE'
  | 'KEY_REUSE_FORBIDDEN'
  | 'OBJECT_VERSION_INVALID'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_PUBLISHED_CLEANUP_FAILED'
  | 'OUTPUT_FILE_PUBLISHED_SYNC_FAILED'
  | 'OUTPUT_FILE_WRITE_FAILED'
  | 'RESOURCE_NOT_ALLOWLISTED'
  | 'SCAN_PAGE_LIMIT_EXCEEDED'

/** Exit statuses used by the operator CLI. */
type CrossDomainIntegrityCliExitCode = 0 | 1 | 2

/** Raw-data-free failure summary returned by the top-level error boundary. */
type ClassifiedCliFailure = {
  /** Stable failure category. */
  readonly code: CrossDomainIntegrityCliFailureCode
  /** Process exit status. */
  readonly exitCode: CrossDomainIntegrityCliExitCode
}

/** Safe failure carrying only a stable category and exit status. */
export class CrossDomainIntegrityCliFailure extends Error {
  /** Stable raw-data-free category. */
  readonly code: CrossDomainIntegrityCliFailureCode

  /** Process exit status for the category. */
  readonly exitCode: CrossDomainIntegrityCliExitCode

  /**
   * Creates a stable checker CLI failure.
   *
   * @param code - Raw-data-free failure category.
   * @param exitCode - Process exit status.
   */
  constructor(
    code: CrossDomainIntegrityCliFailureCode,
    exitCode: CrossDomainIntegrityCliExitCode,
  ) {
    super(code)
    this.name = 'CrossDomainIntegrityCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Narrow transport containing only the verifier's allowlisted AWS reads. */
export interface CrossDomainIntegrityAwsTransport {
  /** Releases all underlying AWS SDK clients. */
  close(): void

  /**
   * Sends one exact-version GetObjectAttributes command.
   *
   * @param command - Exact read-only command.
   * @returns S3 object-attributes response.
   */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput>

  /**
   * Sends one exact-version GetObjectTagging command.
   *
   * @param command - Exact read-only command.
   * @returns S3 object-tagging response.
   */
  getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput>

  /**
   * Sends one exact-version HeadObject command.
   *
   * @param command - Exact read-only command.
   * @returns S3 HEAD response.
   */
  headObject(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>

  /**
   * Sends one STS caller-identity command.
   *
   * @param command - Exact read-only command.
   * @returns STS caller response.
   */
  readCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput>

  /**
   * Sends one bounded unfiltered base-table Scan command.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB scan response.
   */
  scan(command: ScanCommand): Promise<ScanCommandOutput>
}

/** Factory binding a narrow AWS transport to an explicit profile and region. */
export type CrossDomainIntegrityAwsTransportFactory = (
  configuration: CrossDomainIntegrityAwsReaderConfiguration,
) => CrossDomainIntegrityAwsTransport

/** Explicit AWS SDK client configuration pinned to an official endpoint. */
export type CrossDomainIntegrityAwsSdkClientConfiguration = {
  /** Credentials resolved only through the explicitly named profile. */
  readonly credentials: ReturnType<typeof fromIni>
  /** Partition-aware official endpoint unaffected by environment overrides. */
  readonly endpoint: string
  /** Explicit shared-configuration profile retained for auditability. */
  readonly profile: string
  /** Explicit AWS region. */
  readonly region: string
}

/** Injectable constructor used to inspect all three safe SDK configurations. */
export type CrossDomainIntegrityAwsSdkTransportConstructor = (
  dynamodbConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
  s3Configuration: CrossDomainIntegrityAwsSdkClientConfiguration,
  stsConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
) => CrossDomainIntegrityAwsTransport

/** Dependencies used by the top-level CLI boundary. */
export type CrossDomainIntegrityCliDependencies = {
  /** Creates one closeable reader from explicit immutable settings. */
  readonly createReader: (
    configuration: CrossDomainIntegrityAwsReaderConfiguration,
  ) => CrossDomainIntegrityManagedAwsReadPort
  /**
   * Bridges raw AWS pages to the normalized cross-domain core and returns only
   * aggregate, secret-free machine-readable evidence.
   */
  readonly runCheck: (
    input: CrossDomainIntegrityCheckBridgeInput,
  ) => Promise<unknown>
}

/** CLI-owned values that an authenticated checker result must reproduce exactly. */
export type CrossDomainIntegrityPublicationExpectation = {
  /** Canonical timestamp selected by the operator. */
  readonly checkedAt: string
  /** Invocation-local key used to authenticate the complete result. */
  readonly digestKey: Uint8Array
  /** Exact read bounds selected by the operator. */
  readonly limits: CrossDomainIntegrityLimits
  /** Digest of the required logical resource roles. */
  readonly resourceBindingDigest: string
  /** Canonical keyed identities of all exact physical resources. */
  readonly resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Keyed digest of the selected physical resource identities. */
  readonly resourceIdentityDigest: string
  /** Source or isolated-restore role selected by the operator. */
  readonly role: CrossDomainIntegrityRole
}

/** Filesystem operations that run only after the final evidence path exists. */
export type CrossDomainIntegrityPostPublicationOperations = {
  /** Removes only the temporary hard-link name. */
  readonly removeTemporaryFile: (temporaryPath: string) => Promise<void>
  /** Flushes directory entries publishing and removing evidence names. */
  readonly syncOutputDirectory: (outputPath: string) => Promise<void>
}

/** AWS SDK transport whose public surface contains no mutation operation. */
class AwsSdkCrossDomainIntegrityTransport implements CrossDomainIntegrityAwsTransport {
  /** DynamoDB client bound to the explicit profile and region. */
  private readonly dynamodbClient: DynamoDBClient

  /** S3 client bound to the explicit profile and region. */
  private readonly s3Client: S3Client

  /** STS client bound to the explicit profile and region. */
  private readonly stsClient: STSClient

  /**
   * Creates a read-only transport.
   *
   * @param dynamodbConfiguration - Safe DynamoDB SDK configuration.
   * @param s3Configuration - Safe S3 SDK configuration.
   * @param stsConfiguration - Safe STS SDK configuration.
   */
  constructor(
    dynamodbConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
    s3Configuration: CrossDomainIntegrityAwsSdkClientConfiguration,
    stsConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
  ) {
    this.dynamodbClient = new DynamoDBClient(dynamodbConfiguration)
    this.s3Client = new S3Client(s3Configuration)
    this.stsClient = new STSClient(stsConfiguration)
  }

  /** Releases all SDK client resources. */
  close(): void {
    this.dynamodbClient.destroy()
    this.s3Client.destroy()
    this.stsClient.destroy()
  }

  /** @inheritdoc */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput> {
    return this.s3Client.send(command)
  }

  /** @inheritdoc */
  getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput> {
    return this.s3Client.send(command)
  }

  /** @inheritdoc */
  headObject(command: HeadObjectCommand): Promise<HeadObjectCommandOutput> {
    return this.s3Client.send(command)
  }

  /** @inheritdoc */
  readCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
  }

  /** @inheritdoc */
  scan(command: ScanCommand): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(command)
  }
}

/** Read-only AWS adapter restricted to typed allowlists and bounded scans. */
export class AwsCrossDomainIntegrityReader implements CrossDomainIntegrityManagedAwsReadPort {
  /** Exact logical-to-physical bucket allowlist. */
  private readonly buckets: CrossDomainIntegrityBucketNames

  /** Expected owner account for exact-version S3 reads. */
  private readonly expectedAccount: string

  /** Total scan page budget for this invocation. */
  private readonly maxPages: number

  /** Fixed item limit placed on every Scan request. */
  private readonly pageSize: number

  /** Number of Scan requests already consumed. */
  private scanPageCount = 0

  /** Exact logical-to-physical table allowlist. */
  private readonly tables: CrossDomainIntegrityTableNames

  /** Allowlisted command transport. */
  private readonly transport: CrossDomainIntegrityAwsTransport

  /**
   * Creates a reader bound to explicit credentials, resources, and limits.
   *
   * @param configuration - Immutable profile, region, allowlist, and limits.
   * @param transportFactory - Injectable allowlisted transport factory.
   */
  constructor(
    configuration: CrossDomainIntegrityAwsReaderConfiguration,
    transportFactory: CrossDomainIntegrityAwsTransportFactory =
      createCrossDomainIntegrityAwsSdkTransport,
  ) {
    validateReaderConfiguration(configuration)
    this.buckets = { file: configuration.buckets.file }
    this.expectedAccount = configuration.expectedAccount
    this.maxPages = configuration.maxPages
    this.pageSize = configuration.pageSize
    this.tables = {
      'audit-events': configuration.tables['audit-events'],
      'file-proofing': configuration.tables['file-proofing'],
      'project-directory': configuration.tables['project-directory'],
      'work-item-configuration':
        configuration.tables['work-item-configuration'],
      'work-items': configuration.tables['work-items'],
      'workspace-access': configuration.tables['workspace-access'],
    }
    this.transport = transportFactory(configuration)
  }

  /** Releases SDK client resources. */
  close(): void {
    this.transport.close()
  }

  /** @inheritdoc */
  async readCallerAccount(): Promise<string> {
    const output = await this.transport.readCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    if (!isAwsAccount(output.Account)) {
      throw new CrossDomainIntegrityCliFailure('AWS_RESPONSE_INVALID', 1)
    }
    return output.Account
  }

  /** @inheritdoc */
  scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput> {
    if (this.scanPageCount >= this.maxPages) {
      throw new CrossDomainIntegrityCliFailure('SCAN_PAGE_LIMIT_EXCEEDED', 1)
    }
    this.scanPageCount += 1
    const commonInput = {
      ConsistentRead: true,
      Limit: this.pageSize,
      TableName: resolveTableName(this.tables, target),
    }
    if (exclusiveStartKey) {
      return this.transport.scan(new ScanCommand({
        ...commonInput,
        ExclusiveStartKey: exclusiveStartKey,
      }))
    }
    return this.transport.scan(new ScanCommand(commonInput))
  }

  /** @inheritdoc */
  headObject(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<HeadObjectCommandOutput> {
    validateObjectVersionReference(reference)
    return this.transport.headObject(new HeadObjectCommand({
      Bucket: resolveBucketName(this.buckets, reference.bucket),
      ExpectedBucketOwner: this.expectedAccount,
      Key: reference.key,
      VersionId: reference.versionId,
    }))
  }

  /** @inheritdoc */
  getObjectAttributes(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<GetObjectAttributesCommandOutput> {
    validateObjectVersionReference(reference)
    return this.transport.getObjectAttributes(new GetObjectAttributesCommand({
      Bucket: resolveBucketName(this.buckets, reference.bucket),
      ExpectedBucketOwner: this.expectedAccount,
      Key: reference.key,
      ObjectAttributes: [
        ObjectAttributes.CHECKSUM,
        ObjectAttributes.ETAG,
        ObjectAttributes.OBJECT_SIZE,
        ObjectAttributes.STORAGE_CLASS,
      ],
      VersionId: reference.versionId,
    }))
  }

  /** @inheritdoc */
  getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<GetObjectTaggingCommandOutput> {
    validateObjectVersionReference(reference)
    return this.transport.getObjectTagging(new GetObjectTaggingCommand({
      Bucket: resolveBucketName(this.buckets, reference.bucket),
      ExpectedBucketOwner: this.expectedAccount,
      Key: reference.key,
      VersionId: reference.versionId,
    }))
  }
}

/**
 * Creates the production AWS SDK transport pinned to official endpoints.
 *
 * @param configuration - Explicit profile, region, resources, and limits.
 * @param transportConstructor - Injectable SDK client constructor.
 * @returns Allowlisted AWS SDK transport.
 */
export function createCrossDomainIntegrityAwsSdkTransport(
  configuration: CrossDomainIntegrityAwsReaderConfiguration,
  transportConstructor: CrossDomainIntegrityAwsSdkTransportConstructor =
    createDefaultAwsSdkTransport,
): CrossDomainIntegrityAwsTransport {
  validateReaderConfiguration(configuration)
  const credentials = fromIni({ profile: configuration.profile })
  const commonConfiguration = {
    credentials,
    profile: configuration.profile,
    region: configuration.region,
  }
  return transportConstructor(
    {
      ...commonConfiguration,
      endpoint: resolveOfficialAwsRegionalEndpoint(
        'dynamodb',
        configuration.region,
      ),
    },
    {
      ...commonConfiguration,
      endpoint: resolveOfficialAwsRegionalEndpoint('s3', configuration.region),
    },
    {
      ...commonConfiguration,
      endpoint: resolveOfficialAwsRegionalEndpoint('sts', configuration.region),
    },
  )
}

/**
 * Parses strict CLI arguments without consulting environment variables.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Validated command configuration.
 */
export function parseCrossDomainIntegrityCliArguments(
  arguments_: readonly string[],
): CrossDomainIntegrityCliArguments {
  const command = arguments_[0]
  if (command === 'help' || command === '--help') {
    if (arguments_.length !== 1) {
      throw invalidUsage()
    }
    return { command: 'help' }
  }
  if (command === 'check') {
    return parseCheckArguments(arguments_.slice(1))
  }
  throw invalidUsage()
}

/**
 * Parses an exact lowercase hexadecimal 32-byte HMAC key.
 *
 * @param content - Untrusted key-file content.
 * @returns Dedicated digest key bytes.
 */
export function parseCrossDomainIntegrityDigestKey(content: string): Uint8Array {
  return parseCrossDomainIntegrityHexadecimalKey(
    content,
    'DIGEST_KEY_INVALID',
  )
}

/**
 * Parses an exact lowercase hexadecimal Workspace Audit pseudonym key.
 *
 * @param content - Untrusted key-file content.
 * @returns Existing 32-byte Workspace Audit pseudonym key bytes.
 */
export function parseCrossDomainIntegrityAuditPseudonymKey(
  content: string,
): Uint8Array {
  return parseCrossDomainIntegrityHexadecimalKey(
    content,
    'AUDIT_PSEUDONYM_KEY_INVALID',
  )
}

/**
 * Parses one exact lowercase hexadecimal 32-byte key with a stable category.
 *
 * @param content - Untrusted key-file content.
 * @param invalidCode - Stable failure category for invalid content.
 * @returns Newly allocated 32-byte key bytes.
 */
function parseCrossDomainIntegrityHexadecimalKey(
  content: string,
  invalidCode: 'AUDIT_PSEUDONYM_KEY_INVALID' | 'DIGEST_KEY_INVALID',
): Uint8Array {
  const pattern = new RegExp(`^[0-9a-f]{${DIGEST_KEY_HEX_LENGTH}}\\n?$`, 'u')
  if (!pattern.test(content)) {
    throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
  }
  const hexadecimalKey = content.endsWith('\n') ? content.slice(0, -1) : content
  return Buffer.from(hexadecimalKey, 'hex')
}

/**
 * Creates the stable digest shared by source and restore checks for this exact
 * typed logical resource allowlist. Physical resource names are intentionally
 * excluded so isolated restore names remain comparable without being published.
 *
 * @returns Lowercase SHA-256 digest of the versioned logical allowlist.
 */
export function createCrossDomainIntegrityResourceBindingDigest(): string {
  return calculateCrossDomainIntegrityResourceBindingDigest()
}

/**
 * Creates a keyed digest of the exact physical resources selected for one check.
 *
 * Profile and dataset role are deliberately excluded: credential provenance is
 * not a resource identity, and source/restore reuse of the same resources must
 * produce the same digest so comparison can reject it.
 *
 * @param configuration - Strictly parsed account, Region, tables, and bucket.
 * @param digestKey - Dedicated 32-byte invocation-local HMAC key.
 * @returns Lowercase HMAC-SHA-256 digest without physical resource names.
 */
export function createCrossDomainIntegrityResourceIdentityDigest(
  configuration: CrossDomainIntegrityCheckCliArguments,
  digestKey: Uint8Array,
): string {
  const resourceIdentities = createCrossDomainIntegrityResourceIdentities(
    configuration,
    digestKey,
  )
  return calculateCrossDomainIntegrityResourceIdentityDigest(
    resourceIdentities,
    digestKey,
  )
}

/**
 * Creates the canonical seven-entry keyed physical-resource identity vector.
 *
 * Profile and dataset role are excluded so corresponding source and restore
 * targets can be compared without publishing physical names.
 *
 * @param configuration - Strictly parsed account, Region, tables, and bucket.
 * @param digestKey - Dedicated 32-byte invocation-local HMAC key.
 * @returns Fixed-order per-resource HMAC identities.
 */
export function createCrossDomainIntegrityResourceIdentities(
  configuration: CrossDomainIntegrityCheckCliArguments,
  digestKey: Uint8Array,
): CrossDomainIntegrityResourceIdentity[] {
  if (digestKey.byteLength !== 32) {
    throw new CrossDomainIntegrityCliFailure('DIGEST_KEY_INVALID', 2)
  }
  return CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => ({
    target,
    identityDigest: createPhysicalResourceIdentityDigest(
      configuration,
      target,
      digestKey,
    ),
  }))
}

/**
 * Creates one domain-separated HMAC for an exact configured AWS resource.
 *
 * @param configuration - Strictly parsed account, Region, tables, and bucket.
 * @param target - Canonical logical resource target.
 * @param digestKey - Dedicated 32-byte invocation-local HMAC key.
 * @returns Keyed physical identity without the raw resource name.
 */
function createPhysicalResourceIdentityDigest(
  configuration: CrossDomainIntegrityCheckCliArguments,
  target: CrossDomainIntegrityResourceTarget,
  digestKey: Uint8Array,
): string {
  const hmac = createHmac('sha256', digestKey)
  hmac.update('mukuroji-cross-domain-physical-resource-identity/v1\0', 'utf8')
  appendLengthPrefixedHmacField(hmac, 'target', target)
  appendLengthPrefixedHmacField(hmac, 'account', configuration.account)
  appendLengthPrefixedHmacField(hmac, 'region', configuration.region)
  appendLengthPrefixedHmacField(
    hmac,
    'physical-name',
    resolvePhysicalResourceName(configuration, target),
  )
  return hmac.digest('hex')
}

/**
 * Resolves one exact physical name from the fixed logical resource vector.
 *
 * @param configuration - Strictly parsed physical resource mappings.
 * @param target - Canonical logical resource target.
 * @returns Exact configured table or bucket name.
 */
function resolvePhysicalResourceName(
  configuration: CrossDomainIntegrityCheckCliArguments,
  target: CrossDomainIntegrityResourceTarget,
): string {
  if (target === 'bucket:file') return configuration.buckets.file
  if (target === 'table:audit-events') return configuration.tables['audit-events']
  if (target === 'table:file-proofing') return configuration.tables['file-proofing']
  if (target === 'table:project-directory') return configuration.tables['project-directory']
  if (target === 'table:work-item-configuration') {
    return configuration.tables['work-item-configuration']
  }
  if (target === 'table:work-items') return configuration.tables['work-items']
  return configuration.tables['workspace-access']
}

/** Adds one unambiguous UTF-8 label/value pair to a keyed digest. */
function appendLengthPrefixedHmacField(
  hmac: ReturnType<typeof createHmac>,
  label: string,
  value: string,
): void {
  appendLengthPrefixedHmacBytes(hmac, Buffer.from(label, 'utf8'))
  appendLengthPrefixedHmacBytes(hmac, Buffer.from(value, 'utf8'))
}

/** Adds one eight-byte-length-prefixed byte string to a keyed digest. */
function appendLengthPrefixedHmacBytes(
  hmac: ReturnType<typeof createHmac>,
  value: Uint8Array,
): void {
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(value.byteLength))
  hmac.update(length)
  hmac.update(value)
}

/**
 * Executes the operator CLI with stable raw-data-free output.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable reader and core bridge.
 * @returns Process exit status.
 */
export async function runCrossDomainIntegrityCli(
  arguments_: readonly string[],
  dependencies: CrossDomainIntegrityCliDependencies = defaultCliDependencies,
): Promise<CrossDomainIntegrityCliExitCode> {
  const operation = identifyOperation(arguments_[0])
  try {
    const configuration = parseCrossDomainIntegrityCliArguments(arguments_)
    if (configuration.command === 'help') {
      writeJsonLine(console.log, helpPayload)
      return 0
    }
    const status = await runCheckCommand(configuration, dependencies)
    writeJsonLine(console.log, {
      operation: 'check',
      role: configuration.role,
      status,
    })
    return status === 'pass' ? 0 : 1
  } catch (error: unknown) {
    const failure = classifyCliFailure(error)
    writeJsonLine(console.error, {
      operation,
      status: 'error',
      code: failure.code,
    })
    return failure.exitCode
  }
}

/**
 * Publishes validated evidence atomically without replacing an existing file.
 *
 * @param outputPath - Explicit final evidence path.
 * @param evidence - Untrusted aggregate checker result.
 * @param expectation - CLI-owned values and authentication key.
 * @param postPublicationOperations - Injectable durability operations.
 * @returns Strictly parsed and authenticated published result.
 */
export async function writeCrossDomainIntegrityEvidenceAtomically(
  outputPath: string,
  evidence: unknown,
  expectation: CrossDomainIntegrityPublicationExpectation,
  postPublicationOperations: CrossDomainIntegrityPostPublicationOperations =
    defaultPostPublicationOperations,
): Promise<CrossDomainIntegrityResult> {
  const normalizedEvidence = validateEvidenceForPublication(
    evidence,
    expectation,
  )
  const serializedEvidence = `${JSON.stringify(normalizedEvidence, undefined, 2)}\n`
  if (Buffer.byteLength(serializedEvidence, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new CrossDomainIntegrityCliFailure('EVIDENCE_INVALID', 1)
  }
  const temporaryPath = `${outputPath}.tmp-${randomBytes(12).toString('hex')}`
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(serializedEvidence, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporaryPath, outputPath)
  } catch {
    await removeTemporaryFile(temporaryPath)
    throw new CrossDomainIntegrityCliFailure('OUTPUT_FILE_WRITE_FAILED', 1)
  }

  const temporaryFileRemoved = await removePublishedTemporaryFile(
    temporaryPath,
    postPublicationOperations.removeTemporaryFile,
  )
  try {
    await postPublicationOperations.syncOutputDirectory(outputPath)
  } catch {
    throw new CrossDomainIntegrityCliFailure(
      'OUTPUT_FILE_PUBLISHED_SYNC_FAILED',
      1,
    )
  }
  if (!temporaryFileRemoved) {
    throw new CrossDomainIntegrityCliFailure(
      'OUTPUT_FILE_PUBLISHED_CLEANUP_FAILED',
      1,
    )
  }
  return normalizedEvidence
}

/**
 * Parses strict check flags including typed exactly-once resource allowlists.
 *
 * @param arguments_ - Flag/value pairs following `check`.
 * @returns Validated check configuration.
 */
function parseCheckArguments(
  arguments_: readonly string[],
): CrossDomainIntegrityCheckCliArguments {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw invalidUsage()
  }
  const scalarFlags = new Map<string, string>()
  const tableNames = new Map<CrossDomainIntegrityTableTarget, string>()
  let fileBucketName: string | undefined
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      !name ||
      !value ||
      !checkFlagNames.has(name) ||
      value.startsWith('--')
    ) {
      throw invalidUsage()
    }
    if (name === '--table') {
      const mapping = parseTableMapping(value)
      if (tableNames.has(mapping.target)) {
        throw invalidUsage()
      }
      tableNames.set(mapping.target, mapping.tableName)
      continue
    }
    if (name === '--bucket') {
      if (fileBucketName !== undefined) {
        throw invalidUsage()
      }
      fileBucketName = parseBucketMapping(value)
      continue
    }
    if (scalarFlags.has(name)) {
      throw invalidUsage()
    }
    scalarFlags.set(name, value)
  }

  const account = requireFlag(scalarFlags, '--account')
  const auditPseudonymKeyFile = requirePathFlag(
    scalarFlags,
    '--audit-pseudonym-key-file',
  )
  const digestKeyFile = requirePathFlag(scalarFlags, '--digest-key-file')
  const output = requirePathFlag(scalarFlags, '--output')
  if (
    !isAwsAccount(account) ||
    new Set([
      resolve(auditPseudonymKeyFile),
      resolve(digestKeyFile),
      resolve(output),
    ]).size !== 3
  ) {
    throw invalidUsage()
  }
  if (
    !fileBucketName ||
    tableNames.size !== requiredTableTargets.length ||
    new Set(tableNames.values()).size !== requiredTableTargets.length
  ) {
    throw invalidUsage()
  }
  const maxPages = requireBoundedInteger(
    scalarFlags,
    '--max-pages',
    MAX_PAGES,
  )
  const pageSize = requireBoundedInteger(
    scalarFlags,
    '--page-size',
    MAX_PAGE_SIZE,
  )
  const rawItemCapacity = maxPages * pageSize
  if (rawItemCapacity > MAX_ITEMS) {
    throw invalidUsage()
  }
  const maxItems = requireBoundedInteger(
    scalarFlags,
    '--max-items',
    MAX_ITEMS,
  )
  if (maxItems > rawItemCapacity) {
    throw invalidUsage()
  }
  return {
    account,
    auditPseudonymKeyFile,
    buckets: { file: fileBucketName },
    checkedAt: requireCheckedAt(scalarFlags),
    command: 'check',
    digestKeyFile,
    maxItems,
    maxPages,
    output,
    pageSize,
    profile: requireProfile(scalarFlags),
    region: requireRegion(scalarFlags),
    role: requireRole(scalarFlags),
    tables: createTableNames(tableNames),
  }
}

/** Parsed logical-to-physical table mapping. */
type ParsedTableMapping = {
  /** Logical table target. */
  readonly target: CrossDomainIntegrityTableTarget
  /** Physical table name. */
  readonly tableName: string
}

/**
 * Parses one typed DynamoDB table mapping.
 *
 * @param value - Untrusted `logical=physical` value.
 * @returns Validated mapping.
 */
function parseTableMapping(value: string): ParsedTableMapping {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator !== value.lastIndexOf('=')) {
    throw invalidUsage()
  }
  const target = value.slice(0, separator)
  const tableName = value.slice(separator + 1)
  if (!isTableTarget(target) || !isDynamoDbTableName(tableName)) {
    throw invalidUsage()
  }
  return { target, tableName }
}

/**
 * Parses the exact typed file-bucket mapping.
 *
 * @param value - Untrusted `file=physical` value.
 * @returns Validated physical bucket name.
 */
function parseBucketMapping(value: string): string {
  const prefix = 'file='
  if (!value.startsWith(prefix) || value.indexOf('=', prefix.length) !== -1) {
    throw invalidUsage()
  }
  const bucketName = value.slice(prefix.length)
  if (!isS3BucketName(bucketName)) {
    throw invalidUsage()
  }
  return bucketName
}

/**
 * Constructs a complete table-name object without type assertions.
 *
 * @param values - Validated exactly-once mappings.
 * @returns Complete immutable table allowlist.
 */
function createTableNames(
  values: ReadonlyMap<CrossDomainIntegrityTableTarget, string>,
): CrossDomainIntegrityTableNames {
  return {
    'audit-events': requireTableMapping(values, 'audit-events'),
    'file-proofing': requireTableMapping(values, 'file-proofing'),
    'project-directory': requireTableMapping(values, 'project-directory'),
    'work-item-configuration': requireTableMapping(
      values,
      'work-item-configuration',
    ),
    'work-items': requireTableMapping(values, 'work-items'),
    'workspace-access': requireTableMapping(values, 'workspace-access'),
  }
}

/**
 * Reads one table mapping already proven complete by the parser.
 *
 * @param values - Parsed typed mappings.
 * @param target - Required logical target.
 * @returns Physical table name.
 */
function requireTableMapping(
  values: ReadonlyMap<CrossDomainIntegrityTableTarget, string>,
  target: CrossDomainIntegrityTableTarget,
): string {
  const value = values.get(target)
  if (!value) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads a required flag.
 *
 * @param flags - Parsed scalar flag map.
 * @param name - Required flag name.
 * @returns Non-empty value.
 */
function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)
  if (!value) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads a path without leading or trailing whitespace.
 *
 * @param flags - Parsed scalar flags.
 * @param name - Required path flag.
 * @returns Exact path.
 */
function requirePathFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = requireFlag(flags, name)
  if (value.trim() !== value || containsControlCharacter(value)) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads a bounded positive integer flag.
 *
 * @param flags - Parsed scalar flags.
 * @param name - Required integer flag.
 * @param maximum - Inclusive safety bound.
 * @returns Validated positive integer.
 */
function requireBoundedInteger(
  flags: ReadonlyMap<string, string>,
  name: string,
  maximum: number,
): number {
  const value = requireFlag(flags, name)
  if (!/^[1-9]\d*$/u.test(value)) {
    throw invalidUsage()
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw invalidUsage()
  }
  return parsed
}

/**
 * Reads a source or restore role.
 *
 * @param flags - Parsed scalar flags.
 * @returns Validated role.
 */
function requireRole(
  flags: ReadonlyMap<string, string>,
): CrossDomainIntegrityRole {
  const role = requireFlag(flags, '--role')
  if (role !== 'source' && role !== 'restore') {
    throw invalidUsage()
  }
  return role
}

/**
 * Reads the canonical UTC timestamp shared by a paired source and restore check.
 *
 * @param flags - Parsed scalar flags.
 * @returns Canonical millisecond-precision UTC timestamp.
 */
function requireCheckedAt(flags: ReadonlyMap<string, string>): string {
  const checkedAt = requireFlag(flags, '--checked-at')
  const milliseconds = Date.parse(checkedAt)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== checkedAt) {
    throw invalidUsage()
  }
  return checkedAt
}

/**
 * Reads an explicit safe profile name.
 *
 * @param flags - Parsed scalar flags.
 * @returns Validated profile name.
 */
function requireProfile(flags: ReadonlyMap<string, string>): string {
  const profile = requireFlag(flags, '--profile')
  if (
    profile.trim() !== profile ||
    profile.length > 128 ||
    containsControlCharacter(profile)
  ) {
    throw invalidUsage()
  }
  return profile
}

/**
 * Reads a syntactically valid AWS region.
 *
 * @param flags - Parsed scalar flags.
 * @returns Validated region.
 */
function requireRegion(flags: ReadonlyMap<string, string>): string {
  const region = requireFlag(flags, '--region')
  if (!isAwsRegion(region)) {
    throw invalidUsage()
  }
  return region
}

/**
 * Checks a supported logical table target.
 *
 * @param value - Untrusted mapping prefix.
 * @returns True for one exact table target.
 */
function isTableTarget(value: string): value is CrossDomainIntegrityTableTarget {
  return requiredTableTargets.some((target) => target === value)
}

/**
 * Checks a conventional physical DynamoDB table name.
 *
 * @param value - Untrusted physical name.
 * @returns True for a syntactically valid table name.
 */
function isDynamoDbTableName(value: string): boolean {
  return value.length >= 3 &&
    value.length <= 255 &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
}

/**
 * Checks a conventional general-purpose S3 bucket name.
 *
 * @param value - Untrusted physical name.
 * @returns True for a syntactically safe bucket name.
 */
function isS3BucketName(value: string): boolean {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
  ) {
    return false
  }
  return !value.startsWith('xn--') &&
    !value.startsWith('sthree-') &&
    !value.startsWith('amzn_s3_demo_') &&
    !value.endsWith('-s3alias') &&
    !value.endsWith('--ol-s3') &&
    !value.endsWith('.mrap') &&
    !value.endsWith('--x-s3') &&
    !value.endsWith('--table-s3')
}

/**
 * Checks a twelve-digit AWS account identifier.
 *
 * @param value - Optional untrusted value.
 * @returns True for a valid account identifier.
 */
function isAwsAccount(value: string | undefined): value is string {
  return value !== undefined && /^\d{12}$/u.test(value)
}

/**
 * Checks a bounded conventional AWS region identifier.
 *
 * @param value - Candidate AWS region.
 * @returns True for a safe regional hostname component.
 */
function isAwsRegion(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(value)
}

/**
 * Checks for terminal control characters.
 *
 * @param value - Untrusted argument.
 * @returns True when an ASCII control character is present.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true
    }
  }
  return false
}

/**
 * Validates reader settings even when constructed outside CLI parsing.
 *
 * @param configuration - Potentially programmatic reader settings.
 */
function validateReaderConfiguration(
  configuration: CrossDomainIntegrityAwsReaderConfiguration,
): void {
  if (
    !isAwsAccount(configuration.expectedAccount) ||
    !isAwsRegion(configuration.region) ||
    configuration.profile.trim() !== configuration.profile ||
    configuration.profile.length === 0 ||
    configuration.profile.length > 128 ||
    containsControlCharacter(configuration.profile) ||
    !Number.isSafeInteger(configuration.pageSize) ||
    configuration.pageSize < 1 ||
    configuration.pageSize > MAX_PAGE_SIZE ||
    !Number.isSafeInteger(configuration.maxPages) ||
    configuration.maxPages < 1 ||
    configuration.maxPages > MAX_PAGES ||
    !isS3BucketName(configuration.buckets.file)
  ) {
    throw invalidUsage()
  }
  for (const target of requiredTableTargets) {
    if (!isDynamoDbTableName(resolveTableName(configuration.tables, target))) {
      throw invalidUsage()
    }
  }
  const physicalTableNames = requiredTableTargets.map((target) =>
    resolveTableName(configuration.tables, target))
  if (new Set(physicalTableNames).size !== requiredTableTargets.length) {
    throw invalidUsage()
  }
}

/**
 * Resolves only a compile-time allowlisted logical table target.
 *
 * @param tables - Complete immutable table mapping.
 * @param target - Logical target.
 * @returns Physical table name.
 */
function resolveTableName(
  tables: CrossDomainIntegrityTableNames,
  target: CrossDomainIntegrityTableTarget,
): string {
  const tableName = tables[target]
  if (!isDynamoDbTableName(tableName)) {
    throw new CrossDomainIntegrityCliFailure('RESOURCE_NOT_ALLOWLISTED', 1)
  }
  return tableName
}

/**
 * Resolves only the compile-time allowlisted logical bucket target.
 *
 * @param buckets - Complete immutable bucket mapping.
 * @param target - Logical target.
 * @returns Physical bucket name.
 */
function resolveBucketName(
  buckets: CrossDomainIntegrityBucketNames,
  target: CrossDomainIntegrityBucketTarget,
): string {
  const bucketName = buckets[target]
  if (!isS3BucketName(bucketName)) {
    throw new CrossDomainIntegrityCliFailure('RESOURCE_NOT_ALLOWLISTED', 1)
  }
  return bucketName
}

/**
 * Validates an exact object key and VersionId before issuing any S3 request.
 *
 * @param reference - In-memory reference produced from verified records.
 */
function validateObjectVersionReference(
  reference: CrossDomainIntegrityObjectVersionReference,
): void {
  if (
    reference.bucket !== 'file' ||
    reference.key.length === 0 ||
    Buffer.byteLength(reference.key, 'utf8') > MAX_OBJECT_REFERENCE_BYTES ||
    containsControlCharacter(reference.key) ||
    reference.versionId.length === 0 ||
    reference.versionId === 'null' ||
    Buffer.byteLength(reference.versionId, 'utf8') > MAX_OBJECT_REFERENCE_BYTES ||
    containsControlCharacter(reference.versionId)
  ) {
    throw new CrossDomainIntegrityCliFailure('OBJECT_VERSION_INVALID', 1)
  }
}

/**
 * Executes one check while keeping the HMAC key and clients invocation-local.
 *
 * @param configuration - Validated CLI settings.
 * @param dependencies - Injectable reader and normalized-core bridge.
 * @returns Evidence status.
 */
async function runCheckCommand(
  configuration: CrossDomainIntegrityCheckCliArguments,
  dependencies: CrossDomainIntegrityCliDependencies,
): Promise<'fail' | 'pass'> {
  const digestKey = await readSecretKeyFile(
    configuration.digestKeyFile,
    'DIGEST_KEY_INVALID',
  )
  let auditPseudonymKey: Uint8Array | undefined
  let reader: CrossDomainIntegrityManagedAwsReadPort | undefined
  try {
    auditPseudonymKey = await readSecretKeyFile(
      configuration.auditPseudonymKeyFile,
      'AUDIT_PSEUDONYM_KEY_INVALID',
    )
    if (timingSafeEqual(digestKey, auditPseudonymKey)) {
      throw new CrossDomainIntegrityCliFailure('KEY_REUSE_FORBIDDEN', 2)
    }
    reader = dependencies.createReader({
      buckets: configuration.buckets,
      expectedAccount: configuration.account,
      maxPages: configuration.maxPages,
      pageSize: configuration.pageSize,
      profile: configuration.profile,
      region: configuration.region,
      tables: configuration.tables,
    })
    const callerAccount = await reader.readCallerAccount()
    if (callerAccount !== configuration.account) {
      throw new CrossDomainIntegrityCliFailure('ACCOUNT_MISMATCH', 1)
    }
    const resourceBindingDigest =
      createCrossDomainIntegrityResourceBindingDigest()
    const resourceIdentities =
      createCrossDomainIntegrityResourceIdentities(configuration, digestKey)
    const resourceIdentityDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        digestKey,
      )
    const evidence = await dependencies.runCheck({
      auditPseudonymKey,
      checkedAt: configuration.checkedAt,
      digestKey,
      maxItems: configuration.maxItems,
      maxPages: configuration.maxPages,
      pageSize: configuration.pageSize,
      reader,
      resourceBindingDigest,
      resourceIdentities,
      resourceIdentityDigest,
      role: configuration.role,
    })
    const validatedEvidence = await writeCrossDomainIntegrityEvidenceAtomically(
      configuration.output,
      evidence,
      {
        checkedAt: configuration.checkedAt,
        digestKey,
        limits: {
          maxItems: configuration.maxItems,
          maxPages: configuration.maxPages,
          pageSize: configuration.pageSize,
        },
        resourceBindingDigest,
        resourceIdentities,
        resourceIdentityDigest,
        role: configuration.role,
      },
    )
    return validatedEvidence.status === 'pass' ? 'pass' : 'fail'
  } finally {
    auditPseudonymKey?.fill(0)
    digestKey.fill(0)
    reader?.close()
  }
}

/**
 * Reads an exact mode-restricted 32-byte hexadecimal secret-key file.
 *
 * @param path - Explicit key file path.
 * @param invalidCode - Stable category for invalid content or permissions.
 * @returns Dedicated 32-byte HMAC key.
 */
async function readSecretKeyFile(
  path: string,
  invalidCode: 'AUDIT_PSEUDONYM_KEY_INVALID' | 'DIGEST_KEY_INVALID',
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>
  let encodedBuffer: Buffer | undefined
  try {
    handle = await open(path, 'r')
  } catch {
    throw new CrossDomainIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  }
  try {
    const file = await handle.stat()
    if (
      !file.isFile() ||
      file.size > DIGEST_KEY_HEX_LENGTH + 1 ||
      (file.mode & 0o077) !== 0
    ) {
      throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
    }
    encodedBuffer = Buffer.alloc(DIGEST_KEY_HEX_LENGTH + 2)
    let offset = 0
    while (offset < encodedBuffer.byteLength) {
      const result = await handle.read(
        encodedBuffer,
        offset,
        encodedBuffer.byteLength - offset,
        offset,
      )
      if (result.bytesRead === 0) {
        break
      }
      offset += result.bytesRead
    }
    if (offset > DIGEST_KEY_HEX_LENGTH + 1) {
      throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
    }
    return parseCrossDomainIntegrityKeyBytes(
      encodedBuffer.subarray(0, offset),
      invalidCode,
    )
  } catch (error: unknown) {
    if (error instanceof CrossDomainIntegrityCliFailure) {
      throw error
    }
    throw new CrossDomainIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  } finally {
    encodedBuffer?.fill(0)
    try {
      await handle.close()
    } catch {
      // The stable top-level error boundary intentionally hides filesystem errors.
    }
  }
}

/**
 * Decodes a strict lowercase hexadecimal key without creating a JavaScript string.
 *
 * @param content - Mutable bytes read from the mode-restricted key file.
 * @param invalidCode - Stable failure category for invalid content.
 * @returns Newly allocated 32-byte key owned by the invocation.
 */
function parseCrossDomainIntegrityKeyBytes(
  content: Uint8Array,
  invalidCode: 'AUDIT_PSEUDONYM_KEY_INVALID' | 'DIGEST_KEY_INVALID',
): Uint8Array {
  const hasTrailingNewline = content.byteLength === DIGEST_KEY_HEX_LENGTH + 1 &&
    content[DIGEST_KEY_HEX_LENGTH] === 0x0a
  if (
    content.byteLength !== DIGEST_KEY_HEX_LENGTH &&
    !hasTrailingNewline
  ) {
    throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
  }
  for (let index = 0; index < DIGEST_KEY_HEX_LENGTH; index += 1) {
    const byte = content[index]
    if (byte === undefined || !isLowercaseHexadecimalByte(byte)) {
      throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
    }
  }
  const digestKey = Buffer.alloc(DIGEST_KEY_HEX_LENGTH / 2)
  for (let index = 0; index < digestKey.byteLength; index += 1) {
    const high = content[index * 2]
    const low = content[index * 2 + 1]
    if (high === undefined || low === undefined) {
      digestKey.fill(0)
      throw new CrossDomainIntegrityCliFailure(invalidCode, 2)
    }
    digestKey[index] = hexadecimalNibble(high) * 16 + hexadecimalNibble(low)
  }
  return digestKey
}

/**
 * Checks one byte for the strict lowercase hexadecimal alphabet.
 *
 * @param value - Byte read from the digest-key file.
 * @returns True for an ASCII decimal digit or lowercase `a` through `f`.
 */
function isLowercaseHexadecimalByte(value: number): boolean {
  return (value >= 0x30 && value <= 0x39) ||
    (value >= 0x61 && value <= 0x66)
}

/**
 * Converts one already validated hexadecimal byte to its numeric nibble.
 *
 * @param value - Validated ASCII hexadecimal byte.
 * @returns Integer from zero through fifteen.
 */
function hexadecimalNibble(value: number): number {
  return value <= 0x39 ? value - 0x30 : value - 0x61 + 10
}

/**
 * Strictly parses, authenticates, and binds aggregate evidence before publication.
 *
 * @param evidence - Untrusted bridge result.
 * @param expectation - CLI-owned values and authentication key.
 * @returns Normalized authenticated checker result.
 */
function validateEvidenceForPublication(
  evidence: unknown,
  expectation: CrossDomainIntegrityPublicationExpectation,
): CrossDomainIntegrityResult {
  let result: CrossDomainIntegrityResult
  try {
    result = parseCrossDomainIntegrityResult(evidence)
  } catch {
    throw new CrossDomainIntegrityCliFailure('EVIDENCE_INVALID', 1)
  }
  if (
    !verifyCrossDomainIntegrityResult(result, expectation.digestKey) ||
    result.role !== expectation.role ||
    result.checkedAt !== expectation.checkedAt ||
    result.limits.pageSize !== expectation.limits.pageSize ||
    result.limits.maxPages !== expectation.limits.maxPages ||
    result.limits.maxItems !== expectation.limits.maxItems ||
    result.evidence.resourceBindingDigest !==
      expectation.resourceBindingDigest ||
    !sameResourceIdentities(
      result.evidence.resourceIdentities,
      expectation.resourceIdentities,
    ) ||
    result.evidence.resourceIdentityDigest !==
      expectation.resourceIdentityDigest
  ) {
    throw new CrossDomainIntegrityCliFailure('EVIDENCE_INVALID', 1)
  }
  return result
}

/**
 * Compares two canonical physical-resource identity vectors exactly.
 *
 * @param left - Authenticated vector returned by the checker bridge.
 * @param right - CLI-owned expected vector.
 * @returns True only when every target and keyed identity match in order.
 */
function sameResourceIdentities(
  left: readonly CrossDomainIntegrityResourceIdentity[],
  right: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((identity, index) => {
    const other = right[index]
    return other !== undefined &&
      identity.target === other.target &&
      identity.identityDigest === other.identityDigest
  })
}

/**
 * Constructs a partition-aware official AWS endpoint.
 *
 * @param service - Allowlisted AWS service prefix.
 * @param region - Explicit AWS region.
 * @returns Official regional endpoint URL.
 */
function resolveOfficialAwsRegionalEndpoint(
  service: 'dynamodb' | 's3' | 'sts',
  region: string,
): string {
  if (!isAwsRegion(region)) {
    throw invalidUsage()
  }
  return `https://${service}.${region}.${resolveOfficialAwsDnsSuffix(region)}/`
}

/**
 * Resolves the official DNS suffix for supported AWS partitions.
 *
 * @param region - Explicit AWS region.
 * @returns Official DNS suffix.
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
 * Creates the concrete SDK transport.
 *
 * @param dynamodbConfiguration - Safe DynamoDB configuration.
 * @param s3Configuration - Safe S3 configuration.
 * @param stsConfiguration - Safe STS configuration.
 * @returns Concrete read-only transport.
 */
function createDefaultAwsSdkTransport(
  dynamodbConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
  s3Configuration: CrossDomainIntegrityAwsSdkClientConfiguration,
  stsConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration,
): CrossDomainIntegrityAwsTransport {
  return new AwsSdkCrossDomainIntegrityTransport(
    dynamodbConfiguration,
    s3Configuration,
    stsConfiguration,
  )
}

/**
 * Creates the production reader.
 *
 * @param configuration - Explicit resource and connection settings.
 * @returns Closeable read-only reader.
 */
function createDefaultReader(
  configuration: CrossDomainIntegrityAwsReaderConfiguration,
): CrossDomainIntegrityManagedAwsReadPort {
  return new AwsCrossDomainIntegrityReader(configuration)
}

const defaultCliDependencies: CrossDomainIntegrityCliDependencies = {
  createReader: createDefaultReader,
  runCheck: runCrossDomainIntegrityAwsCheck,
}

const defaultPostPublicationOperations: CrossDomainIntegrityPostPublicationOperations = {
  removeTemporaryFile: unlink,
  syncOutputDirectory,
}

/**
 * Flushes directory entries containing the evidence publication.
 *
 * @param outputPath - Final evidence path.
 */
async function syncOutputDirectory(outputPath: string): Promise<void> {
  const directoryHandle = await open(dirname(resolve(outputPath)), 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

/**
 * Retries removal of the temporary hard-link name once.
 *
 * @param temporaryPath - Exact temporary path created by this process.
 * @param removeFile - Injectable removal operation.
 * @returns True when the temporary name was removed.
 */
async function removePublishedTemporaryFile(
  temporaryPath: string,
  removeFile: (path: string) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await removeFile(temporaryPath)
      return true
    } catch {
      // One bounded retry handles transient local filesystem failures.
    }
  }
  return false
}

/**
 * Removes only a randomly named temporary output after failed publication.
 *
 * @param temporaryPath - Exact temporary path created by this process.
 */
async function removeTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath)
  } catch {
    // A failed open or successful hard-link publication may leave nothing to remove.
  }
}

/**
 * Converts unknown exceptions into stable raw-data-free failures.
 *
 * @param error - Caught failure.
 * @returns Stable category and exit status.
 */
function classifyCliFailure(error: unknown): ClassifiedCliFailure {
  if (error instanceof CrossDomainIntegrityCliFailure) {
    return { code: error.code, exitCode: error.exitCode }
  }
  return {
    code: identifyAwsFailure(error) ? 'AWS_READ_FAILED' : 'OPERATION_FAILED',
    exitCode: 1,
  }
}

/**
 * Recognizes AWS SDK failures without serializing raw details.
 *
 * @param error - Unknown caught value.
 * @returns True when SDK response metadata is present.
 */
function identifyAwsFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return false
  }
  return '$metadata' in error
}

/**
 * Identifies a stable operation label.
 *
 * @param command - First CLI argument.
 * @returns Safe operation label.
 */
function identifyOperation(
  command: string | undefined,
): CrossDomainIntegrityCliOperation {
  if (command === 'check') {
    return 'check'
  }
  if (command === 'help' || command === '--help') {
    return 'help'
  }
  return 'unknown'
}

/**
 * Creates the standard usage failure.
 *
 * @returns Stable usage failure.
 */
function invalidUsage(): CrossDomainIntegrityCliFailure {
  return new CrossDomainIntegrityCliFailure('INVALID_USAGE', 2)
}

/**
 * Writes one compact deterministic JSON line.
 *
 * @param writer - Console writer.
 * @param value - Raw-data-free payload.
 */
function writeJsonLine(writer: (value: string) => void, value: unknown): void {
  writer(JSON.stringify(value))
}

if (import.meta.main) {
  void runCrossDomainIntegrityCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
