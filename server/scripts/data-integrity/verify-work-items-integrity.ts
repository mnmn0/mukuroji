import { randomBytes } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
  type DescribeContinuousBackupsCommandOutput,
  type DescribeTableCommandOutput,
  type DescribeTimeToLiveCommandOutput,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import {
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  compareWorkItemsIntegrityManifests,
  createWorkItemsIntegrityManifest,
  parseWorkItemsIntegrityManifest,
  type SourceCaptureConsistency,
  type WorkItemsIntegrityManifest,
  WorkItemsIntegrityFailure,
  type WorkItemsIntegrityFailureCode,
  type WorkItemsIntegrityReadPort,
  type WorkItemsIntegrityRole,
} from './work-items-integrity'

const DIGEST_KEY_HEX_LENGTH = 64
const MAX_MANIFEST_FILE_BYTES = 1024 * 1024

const manifestFlagNames = new Set([
  '--account',
  '--digest-key-file',
  '--output',
  '--profile',
  '--region',
  '--role',
  '--source-consistency',
  '--table',
])

const compareFlagNames = new Set([
  '--digest-key-file',
  '--restore-manifest',
  '--source-manifest',
])

const helpPayload = {
  status: 'help',
  commands: [
    'bun run --silent work-items:integrity -- manifest --role source --account <account> --region <region> --table <table> --profile <profile> --digest-key-file <path> --output <path> --source-consistency writer-fenced|live-observation',
    'bun run --silent work-items:integrity -- manifest --role restore --account <account> --region <region> --table <table> --profile <profile> --digest-key-file <path> --output <path>',
    'bun run --silent work-items:integrity -- compare --source-manifest <path> --restore-manifest <path> --digest-key-file <path>',
    'bun run --silent work-items:integrity -- help',
  ],
}

/** Stable CLI operation names that never include untrusted argument text. */
type WorkItemsIntegrityCliOperation = 'compare' | 'help' | 'manifest' | 'unknown'

/** Stable CLI-only error categories safe to emit to an operator terminal. */
type WorkItemsIntegrityCliFailureCode =
  | 'AWS_READ_FAILED'
  | 'AWS_RESPONSE_INVALID'
  | 'DIGEST_KEY_INVALID'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_PUBLISHED_CLEANUP_FAILED'
  | 'OUTPUT_FILE_PUBLISHED_SYNC_FAILED'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Exit statuses used by the operator CLI. */
type WorkItemsIntegrityCliExitCode = 0 | 1 | 2

/** Raw-data-free failure summary returned by the top-level error boundary. */
type ClassifiedCliFailure = {
  /** Stable CLI or integrity failure category. */
  code: WorkItemsIntegrityCliFailureCode | WorkItemsIntegrityFailureCode
  /** Process exit status. */
  exitCode: WorkItemsIntegrityCliExitCode
}

/** Parsed arguments for a source-table manifest. */
export type WorkItemsSourceManifestCliArguments = {
  /** Expected AWS account identifier. */
  account: string
  /** Selected subcommand. */
  command: 'manifest'
  /** File containing the dedicated 32-byte HMAC key. */
  digestKeyFile: string
  /** Destination for the authenticated manifest. */
  output: string
  /** Explicit shared-configuration profile used for credentials. */
  profile: string
  /** Explicit AWS region. */
  region: string
  /** Source-table role. */
  role: 'source'
  /** External writer-isolation context for the scan. */
  sourceConsistency: SourceCaptureConsistency
  /** Explicit physical DynamoDB table name. */
  tableName: string
}

/** Parsed arguments for an isolated restore-table manifest. */
export type WorkItemsRestoreManifestCliArguments = {
  /** Expected AWS account identifier. */
  account: string
  /** Selected subcommand. */
  command: 'manifest'
  /** File containing the dedicated 32-byte HMAC key. */
  digestKeyFile: string
  /** Destination for the authenticated manifest. */
  output: string
  /** Explicit shared-configuration profile used for credentials. */
  profile: string
  /** Explicit AWS region. */
  region: string
  /** Isolated restore-table role. */
  role: 'restore'
  /** Explicit physical DynamoDB table name. */
  tableName: string
}

/** Parsed arguments for offline source-to-restore comparison. */
export type WorkItemsCompareCliArguments = {
  /** Selected subcommand. */
  command: 'compare'
  /** File containing the dedicated 32-byte HMAC key. */
  digestKeyFile: string
  /** Authenticated restore manifest path. */
  restoreManifest: string
  /** Authenticated source manifest path. */
  sourceManifest: string
}

/** Parsed arguments for the machine-readable help response. */
export type WorkItemsHelpCliArguments = {
  /** Selected subcommand. */
  command: 'help'
}

/** Strictly parsed Work Items integrity CLI arguments. */
export type WorkItemsIntegrityCliArguments =
  | WorkItemsCompareCliArguments
  | WorkItemsHelpCliArguments
  | WorkItemsRestoreManifestCliArguments
  | WorkItemsSourceManifestCliArguments

/** Safe CLI failure carrying only a stable category and exit status. */
class WorkItemsIntegrityCliFailure extends Error {
  /** Stable raw-data-free category. */
  readonly code: WorkItemsIntegrityCliFailureCode

  /** Process exit status for the category. */
  readonly exitCode: WorkItemsIntegrityCliExitCode

  /**
   * Creates a stable CLI failure.
   *
   * @param code - Raw-data-free failure category.
   * @param exitCode - Process exit status.
   */
  constructor(
    code: WorkItemsIntegrityCliFailureCode,
    exitCode: WorkItemsIntegrityCliExitCode,
  ) {
    super(code)
    this.name = 'WorkItemsIntegrityCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Explicit AWS connection settings for the read-only adapter. */
export type WorkItemsIntegrityAwsReaderConfiguration = {
  /** Shared-configuration profile name. */
  profile: string
  /** AWS region. */
  region: string
}

/** Closeable read port owned by one CLI manifest invocation. */
export interface WorkItemsIntegrityManagedReadPort extends WorkItemsIntegrityReadPort {
  /**
   * Releases resources retained by the read port.
   */
  close(): void
}

/** Narrow command transport containing only the verifier's allowlisted AWS reads. */
export interface WorkItemsIntegrityAwsTransport {
  /**
   * Releases the underlying AWS SDK clients.
   */
  close(): void
  /**
   * Sends one DescribeContinuousBackups command.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /**
   * Sends one DescribeTable command.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB table response.
   */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput>
  /**
   * Sends one DescribeTimeToLive command.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput>
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
   * Sends one unfiltered base-table Scan command.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB scan page.
   */
  scan(command: ScanCommand): Promise<ScanCommandOutput>
}

/** Factory that binds a narrow AWS transport to an explicit profile and region. */
export type WorkItemsIntegrityAwsTransportFactory = (
  configuration: WorkItemsIntegrityAwsReaderConfiguration,
) => WorkItemsIntegrityAwsTransport

/** Explicit AWS SDK client configuration pinned to a generated official endpoint. */
export type WorkItemsIntegrityAwsSdkClientConfiguration = {
  /** Credentials resolved only through the explicitly named shared profile. */
  credentials: ReturnType<typeof fromIni>
  /** Partition-aware official endpoint generated without configured endpoint lookup. */
  endpoint: string
  /** Explicit shared-configuration profile retained on every SDK client. */
  profile: string
  /** Explicit AWS region. */
  region: string
}

/** Injectable constructor used to verify both SDK clients receive the safe configuration. */
export type WorkItemsIntegrityAwsSdkTransportConstructor = (
  dynamodbConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
  stsConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
) => WorkItemsIntegrityAwsTransport

/** Dependencies used by the top-level CLI boundary. */
export type WorkItemsIntegrityCliDependencies = {
  /** Creates one closeable reader for an explicit profile and region. */
  createReader: (
    configuration: WorkItemsIntegrityAwsReaderConfiguration,
  ) => WorkItemsIntegrityManagedReadPort
}

/** Filesystem operations that run only after the final evidence path exists. */
type WorkItemsIntegrityPostPublicationOperations = {
  /** Removes only the temporary hard-link name, preserving final evidence. */
  removeTemporaryFile: (temporaryPath: string) => Promise<void>
  /** Flushes the directory entries that publish and remove manifest names. */
  syncOutputDirectory: (outputPath: string) => Promise<void>
}

/** AWS SDK transport whose public surface contains no mutation operation. */
class AwsSdkWorkItemsIntegrityTransport implements WorkItemsIntegrityAwsTransport {
  /** DynamoDB client bound to an explicit region and profile. */
  private readonly dynamodbClient: DynamoDBClient

  /** STS client bound to the same explicit region and profile. */
  private readonly stsClient: STSClient

  /**
   * Creates a transport whose credentials come only from the named profile.
   *
   * @param dynamodbConfiguration - Safe DynamoDB client configuration.
   * @param stsConfiguration - Safe STS client configuration.
   */
  constructor(
    dynamodbConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
    stsConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
  ) {
    this.dynamodbClient = new DynamoDBClient(dynamodbConfiguration)
    this.stsClient = new STSClient(stsConfiguration)
  }

  /**
   * Releases SDK client resources.
   */
  close(): void {
    this.dynamodbClient.destroy()
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
   * Sends one table metadata read.
   *
   * @param command - Exact DescribeTable command.
   * @returns DynamoDB table response.
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
   * Sends one STS caller identity read.
   *
   * @param command - Exact GetCallerIdentity command.
   * @returns STS caller response.
   */
  readCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
  }

  /**
   * Sends one base-table scan.
   *
   * @param command - Exact Scan command.
   * @returns DynamoDB scan page.
   */
  scan(command: ScanCommand): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(command)
  }
}

/** Read-only AWS adapter restricted to the verifier's allowlisted commands. */
export class AwsWorkItemsIntegrityReader implements WorkItemsIntegrityManagedReadPort {
  /** Allowlisted AWS command transport. */
  private readonly transport: WorkItemsIntegrityAwsTransport

  /**
   * Creates a reader bound to an explicit region and profile.
   *
   * @param configuration - Explicit profile and region.
   * @param transportFactory - Injectable command transport factory.
   */
  constructor(
    configuration: WorkItemsIntegrityAwsReaderConfiguration,
    transportFactory: WorkItemsIntegrityAwsTransportFactory = createAwsSdkTransport,
  ) {
    this.transport = transportFactory(configuration)
  }

  /**
   * Releases SDK client resources.
   */
  close(): void {
    this.transport.close()
  }

  /**
   * Reads and validates the caller account for the explicitly bound profile.
   *
   * @returns Twelve-digit AWS account identifier.
   */
  async readCallerAccount(): Promise<string> {
    const output = await this.transport.readCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    if (!isAwsAccount(output.Account)) {
      throw new WorkItemsIntegrityCliFailure('AWS_RESPONSE_INVALID', 1)
    }
    return output.Account
  }

  /**
   * Reads base-table metadata.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeTable response.
   */
  describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    return this.transport.describeTable(new DescribeTableCommand({
      TableName: tableName,
    }))
  }

  /**
   * Reads point-in-time recovery state.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeContinuousBackups response.
   */
  describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return this.transport.describeContinuousBackups(
      new DescribeContinuousBackupsCommand({
        TableName: tableName,
      }),
    )
  }

  /**
   * Reads DynamoDB TTL state.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeTimeToLive response.
   */
  describeTimeToLive(tableName: string): Promise<DescribeTimeToLiveCommandOutput> {
    return this.transport.describeTimeToLive(new DescribeTimeToLiveCommand({
      TableName: tableName,
    }))
  }

  /**
   * Reads one complete, unfiltered, strongly consistent base-table scan page.
   *
   * @param tableName - Explicit physical table name.
   * @param exclusiveStartKey - Opaque cursor returned by the preceding page.
   * @returns Scan response page.
   */
  scanPage(
    tableName: string,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput> {
    if (exclusiveStartKey) {
      return this.transport.scan(new ScanCommand({
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        TableName: tableName,
      }))
    }
    return this.transport.scan(new ScanCommand({
      ConsistentRead: true,
      TableName: tableName,
    }))
  }
}

/**
 * Creates the production AWS SDK transport.
 *
 * @param configuration - Explicit profile and region.
 * @param transportConstructor - Injectable SDK client constructor.
 * @returns Allowlisted AWS SDK transport.
 */
export function createAwsSdkTransport(
  configuration: WorkItemsIntegrityAwsReaderConfiguration,
  transportConstructor: WorkItemsIntegrityAwsSdkTransportConstructor =
    createDefaultAwsSdkTransport,
): WorkItemsIntegrityAwsTransport {
  const credentials = fromIni({ profile: configuration.profile })
  const dynamodbConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration = {
    credentials,
    endpoint: resolveOfficialAwsRegionalEndpoint('dynamodb', configuration.region),
    profile: configuration.profile,
    region: configuration.region,
  }
  const stsConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration = {
    credentials,
    endpoint: resolveOfficialAwsRegionalEndpoint('sts', configuration.region),
    profile: configuration.profile,
    region: configuration.region,
  }
  return transportConstructor(
    dynamodbConfiguration,
    stsConfiguration,
  )
}

/**
 * Constructs a partition-aware official AWS regional endpoint without consulting overrides.
 *
 * @param service - Allowlisted AWS service endpoint prefix.
 * @param region - Explicit AWS region.
 * @returns Official regional endpoint URL.
 */
function resolveOfficialAwsRegionalEndpoint(
  service: 'dynamodb' | 'sts',
  region: string,
): string {
  if (!isAwsRegion(region)) {
    throw invalidUsage()
  }
  return `https://${service}.${region}.${resolveOfficialAwsDnsSuffix(region)}/`
}

/**
 * Resolves the official DNS suffix for every AWS partition supported by the pinned clients.
 *
 * @param region - Explicit AWS region.
 * @returns Official non-dualstack DNS suffix.
 */
function resolveOfficialAwsDnsSuffix(
  region: string,
): string {
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
 * Creates the concrete allowlisted SDK transport.
 *
 * @param dynamodbConfiguration - Safe DynamoDB client configuration.
 * @param stsConfiguration - Safe STS client configuration.
 * @returns Concrete AWS SDK transport.
 */
function createDefaultAwsSdkTransport(
  dynamodbConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
  stsConfiguration: WorkItemsIntegrityAwsSdkClientConfiguration,
): WorkItemsIntegrityAwsTransport {
  return new AwsSdkWorkItemsIntegrityTransport(
    dynamodbConfiguration,
    stsConfiguration,
  )
}

/**
 * Creates the production closeable AWS reader.
 *
 * @param configuration - Explicit profile and region.
 * @returns Read-only reader.
 */
function createDefaultAwsReader(
  configuration: WorkItemsIntegrityAwsReaderConfiguration,
): WorkItemsIntegrityManagedReadPort {
  return new AwsWorkItemsIntegrityReader(configuration)
}

const defaultCliDependencies: WorkItemsIntegrityCliDependencies = {
  createReader: createDefaultAwsReader,
}

/**
 * Parses strict subcommand arguments without consulting environment variables.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Validated command configuration.
 */
export function parseWorkItemsIntegrityCliArguments(
  arguments_: readonly string[],
): WorkItemsIntegrityCliArguments {
  const command = arguments_[0]
  if (command === 'help' || command === '--help') {
    if (arguments_.length !== 1) {
      throw invalidUsage()
    }
    return { command: 'help' }
  }
  if (command === 'manifest') {
    return parseManifestArguments(arguments_.slice(1))
  }
  if (command === 'compare') {
    return parseCompareArguments(arguments_.slice(1))
  }
  throw invalidUsage()
}

/**
 * Parses a digest key file's exact lowercase hexadecimal representation.
 *
 * @param content - Untrusted file contents.
 * @returns Dedicated 32-byte HMAC key.
 */
export function parseWorkItemsIntegrityDigestKey(content: string): Uint8Array {
  const digestKeyPattern = new RegExp(`^[0-9a-f]{${DIGEST_KEY_HEX_LENGTH}}\\n?$`, 'u')
  if (!digestKeyPattern.test(content)) {
    throw new WorkItemsIntegrityCliFailure('DIGEST_KEY_INVALID', 2)
  }
  const hexadecimalKey = content.endsWith('\n') ? content.slice(0, -1) : content
  return Buffer.from(hexadecimalKey, 'hex')
}

/**
 * Executes the operator CLI and converts every failure into a stable JSON response.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable resource factory used by tests.
 * @returns Process exit status.
 */
export async function runWorkItemsIntegrityCli(
  arguments_: readonly string[],
  dependencies: WorkItemsIntegrityCliDependencies = defaultCliDependencies,
): Promise<WorkItemsIntegrityCliExitCode> {
  const operation = identifyOperation(arguments_[0])
  try {
    const configuration = parseWorkItemsIntegrityCliArguments(arguments_)
    if (configuration.command === 'help') {
      writeJsonLine(console.log, helpPayload)
      return 0
    }
    if (configuration.command === 'manifest') {
      await runManifestCommand(configuration, dependencies)
      writeJsonLine(console.log, {
        operation: 'manifest',
        role: configuration.role,
        status: 'pass',
      })
      return 0
    }

    const comparison = await runCompareCommand(configuration)
    writeJsonLine(console.log, {
      operation: 'compare',
      status: comparison.status,
      failureCodes: comparison.failureCodes,
    })
    return comparison.status === 'pass' ? 0 : 1
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
 * Parses manifest flags and enforces role-specific source consistency.
 *
 * @param arguments_ - Flag/value arguments following `manifest`.
 * @returns Validated source or restore configuration.
 */
function parseManifestArguments(
  arguments_: readonly string[],
): WorkItemsSourceManifestCliArguments | WorkItemsRestoreManifestCliArguments {
  const flags = parseFlagPairs(arguments_, manifestFlagNames)
  const account = requireFlag(flags, '--account')
  const digestKeyFile = requirePathFlag(flags, '--digest-key-file')
  const output = requirePathFlag(flags, '--output')
  const profile = requireNonWhitespaceFlag(flags, '--profile')
  const region = requireRegion(flags)
  const role = requireRole(flags)
  const tableName = requireTableName(flags)
  const sourceConsistency = flags.get('--source-consistency')

  if (!isAwsAccount(account) || resolve(output) === resolve(digestKeyFile)) {
    throw invalidUsage()
  }
  if (role === 'source') {
    if (!isSourceCaptureConsistency(sourceConsistency)) {
      throw invalidUsage()
    }
    return {
      account,
      command: 'manifest',
      digestKeyFile,
      output,
      profile,
      region,
      role,
      sourceConsistency,
      tableName,
    }
  }
  if (sourceConsistency !== undefined) {
    throw invalidUsage()
  }
  return {
    account,
    command: 'manifest',
    digestKeyFile,
    output,
    profile,
    region,
    role,
    tableName,
  }
}

/**
 * Parses strict offline comparison flags.
 *
 * @param arguments_ - Flag/value arguments following `compare`.
 * @returns Validated comparison configuration.
 */
function parseCompareArguments(arguments_: readonly string[]): WorkItemsCompareCliArguments {
  const flags = parseFlagPairs(arguments_, compareFlagNames)
  return {
    command: 'compare',
    digestKeyFile: requirePathFlag(flags, '--digest-key-file'),
    restoreManifest: requirePathFlag(flags, '--restore-manifest'),
    sourceManifest: requirePathFlag(flags, '--source-manifest'),
  }
}

/**
 * Parses a list of unique `--flag value` pairs against an allowlist.
 *
 * @param arguments_ - Untrusted flag/value sequence.
 * @param allowedFlags - Exact accepted flag names.
 * @returns Unique flag map.
 */
function parseFlagPairs(
  arguments_: readonly string[],
  allowedFlags: ReadonlySet<string>,
): Map<string, string> {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw invalidUsage()
  }
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      !name ||
      !value ||
      !allowedFlags.has(name) ||
      flags.has(name) ||
      value.startsWith('--')
    ) {
      throw invalidUsage()
    }
    flags.set(name, value)
  }
  return flags
}

/**
 * Reads a required non-empty flag value.
 *
 * @param flags - Parsed flag map.
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
 * Reads a required path without accepting leading or trailing whitespace.
 *
 * @param flags - Parsed flag map.
 * @param name - Required path flag.
 * @returns Exact path.
 */
function requirePathFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = requireFlag(flags, name)
  if (value.trim() !== value) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads a required printable non-whitespace value.
 *
 * @param flags - Parsed flag map.
 * @param name - Required flag.
 * @returns Validated value.
 */
function requireNonWhitespaceFlag(
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
 * Checks for terminal control characters in an operator argument.
 *
 * @param value - Untrusted argument value.
 * @returns True when the value contains an ASCII control character.
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
 * Reads an explicit AWS region.
 *
 * @param flags - Parsed flag map.
 * @returns Syntactically valid AWS region.
 */
function requireRegion(flags: ReadonlyMap<string, string>): string {
  const region = requireNonWhitespaceFlag(flags, '--region')
  if (!isAwsRegion(region)) {
    throw invalidUsage()
  }
  return region
}

/**
 * Checks a bounded conventional AWS region identifier.
 *
 * @param value - Candidate AWS region.
 * @returns True for a syntactically safe regional hostname component.
 */
function isAwsRegion(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(value)
}

/**
 * Reads an explicit physical DynamoDB table name.
 *
 * @param flags - Parsed flag map.
 * @returns Syntactically valid table name.
 */
function requireTableName(flags: ReadonlyMap<string, string>): string {
  const tableName = requireNonWhitespaceFlag(flags, '--table')
  if (
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName)
  ) {
    throw invalidUsage()
  }
  return tableName
}

/**
 * Reads a manifest role.
 *
 * @param flags - Parsed flag map.
 * @returns Supported source or restore role.
 */
function requireRole(flags: ReadonlyMap<string, string>): WorkItemsIntegrityRole {
  const role = requireFlag(flags, '--role')
  if (role !== 'source' && role !== 'restore') {
    throw invalidUsage()
  }
  return role
}

/**
 * Checks a source consistency declaration.
 *
 * @param value - Optional untrusted value.
 * @returns True for a supported declaration.
 */
function isSourceCaptureConsistency(
  value: string | undefined,
): value is SourceCaptureConsistency {
  return value === 'writer-fenced' || value === 'live-observation'
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
 * Creates the standard usage failure.
 *
 * @returns Stable usage failure.
 */
function invalidUsage(): WorkItemsIntegrityCliFailure {
  return new WorkItemsIntegrityCliFailure('INVALID_USAGE', 2)
}

/**
 * Executes one source or restore manifest capture.
 *
 * @param configuration - Validated manifest configuration.
 * @param dependencies - Closeable reader factory.
 */
async function runManifestCommand(
  configuration: WorkItemsSourceManifestCliArguments | WorkItemsRestoreManifestCliArguments,
  dependencies: WorkItemsIntegrityCliDependencies,
): Promise<void> {
  const digestKey = await readDigestKeyFile(configuration.digestKeyFile)
  let reader: WorkItemsIntegrityManagedReadPort | undefined
  try {
    reader = dependencies.createReader({
      profile: configuration.profile,
      region: configuration.region,
    })
    const commonInput = {
      account: configuration.account,
      digestKey,
      profile: configuration.profile,
      reader,
      region: configuration.region,
      role: configuration.role,
      tableName: configuration.tableName,
    }
    const manifest = configuration.role === 'source'
      ? await createWorkItemsIntegrityManifest({
        ...commonInput,
        role: 'source',
        sourceConsistency: configuration.sourceConsistency,
      })
      : await createWorkItemsIntegrityManifest({
        ...commonInput,
        role: 'restore',
      })
    await writeManifestAtomically(configuration.output, manifest)
  } finally {
    digestKey.fill(0)
    reader?.close()
  }
}

/**
 * Executes an offline authenticated manifest comparison.
 *
 * @param configuration - Validated comparison configuration.
 * @returns Exact comparison result.
 */
async function runCompareCommand(
  configuration: WorkItemsCompareCliArguments,
): Promise<ReturnType<typeof compareWorkItemsIntegrityManifests>> {
  const digestKey = await readDigestKeyFile(configuration.digestKeyFile)
  try {
    const [source, restore] = await Promise.all([
      readManifestFile(configuration.sourceManifest),
      readManifestFile(configuration.restoreManifest),
    ])
    return compareWorkItemsIntegrityManifests(source, restore, digestKey)
  } finally {
    digestKey.fill(0)
  }
}

/**
 * Reads and validates an exact dedicated digest key file.
 *
 * @param path - Explicit key file path.
 * @returns Dedicated 32-byte HMAC key.
 */
async function readDigestKeyFile(path: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    throw new WorkItemsIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  }
  try {
    const file = await handle.stat()
    if (
      !file.isFile() ||
      file.size > DIGEST_KEY_HEX_LENGTH + 1 ||
      (file.mode & 0o077) !== 0
    ) {
      throw new WorkItemsIntegrityCliFailure('DIGEST_KEY_INVALID', 2)
    }
    const content = await readBoundedUtf8Content(
      handle,
      DIGEST_KEY_HEX_LENGTH + 1,
      'DIGEST_KEY_INVALID',
      2,
    )
    return parseWorkItemsIntegrityDigestKey(content)
  } catch (error: unknown) {
    if (error instanceof WorkItemsIntegrityCliFailure) {
      throw error
    }
    throw new WorkItemsIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  } finally {
    try {
      await handle.close()
    } catch {
      // The error boundary must not expose a raw filesystem failure.
    }
  }
}

/**
 * Reads one bounded JSON manifest and validates its complete schema.
 *
 * @param path - Explicit manifest file path.
 * @returns Strict authenticated-manifest structure.
 */
async function readManifestFile(path: string): Promise<WorkItemsIntegrityManifest> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    throw new WorkItemsIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  }
  let content: string
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.size > MAX_MANIFEST_FILE_BYTES) {
      throw new WorkItemsIntegrityCliFailure('INPUT_FILE_INVALID', 1)
    }
    content = await readBoundedUtf8Content(
      handle,
      MAX_MANIFEST_FILE_BYTES,
      'INPUT_FILE_INVALID',
      1,
    )
  } catch (error: unknown) {
    if (error instanceof WorkItemsIntegrityCliFailure) {
      throw error
    }
    throw new WorkItemsIntegrityCliFailure('INPUT_FILE_UNREADABLE', 2)
  } finally {
    try {
      await handle.close()
    } catch {
      // The error boundary must not expose a raw filesystem failure.
    }
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new WorkItemsIntegrityCliFailure('INPUT_FILE_INVALID', 1)
  }
  return parseWorkItemsIntegrityManifest(value)
}

/**
 * Reads a regular file through a byte limit and rejects invalid UTF-8.
 *
 * @param handle - Open regular file.
 * @param maximumBytes - Maximum accepted byte length.
 * @param failureCode - Stable failure emitted for overflow or invalid UTF-8.
 * @param exitCode - CLI exit status paired with the failure.
 * @returns Bounded, losslessly decoded UTF-8 text.
 */
async function readBoundedUtf8Content(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  failureCode: WorkItemsIntegrityCliFailureCode,
  exitCode: WorkItemsIntegrityCliExitCode,
): Promise<string> {
  const buffer = Buffer.alloc(maximumBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    )
    if (result.bytesRead === 0) {
      break
    }
    offset += result.bytesRead
  }
  if (offset > maximumBytes) {
    throw new WorkItemsIntegrityCliFailure(failureCode, exitCode)
  }
  const encodedContent = buffer.subarray(0, offset)
  const content = encodedContent.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(encodedContent)) {
    throw new WorkItemsIntegrityCliFailure(failureCode, exitCode)
  }
  return content
}

/**
 * Publishes a manifest atomically without replacing an existing evidence file.
 *
 * @param outputPath - Explicit final manifest path.
 * @param manifest - Authenticated secret-free manifest.
 * @param postPublicationOperations - Injectable finalization operations.
 */
export async function writeManifestAtomically(
  outputPath: string,
  manifest: WorkItemsIntegrityManifest,
  postPublicationOperations: WorkItemsIntegrityPostPublicationOperations =
    defaultPostPublicationOperations,
): Promise<void> {
  const temporaryPath = `${outputPath}.tmp-${randomBytes(12).toString('hex')}`
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporaryPath, outputPath)
  } catch {
    await removeTemporaryFile(temporaryPath)
    throw new WorkItemsIntegrityCliFailure('OUTPUT_FILE_WRITE_FAILED', 1)
  }

  const temporaryFileRemoved = await removePublishedTemporaryFile(
    temporaryPath,
    postPublicationOperations.removeTemporaryFile,
  )
  try {
    await postPublicationOperations.syncOutputDirectory(outputPath)
  } catch {
    throw new WorkItemsIntegrityCliFailure(
      'OUTPUT_FILE_PUBLISHED_SYNC_FAILED',
      1,
    )
  }
  if (!temporaryFileRemoved) {
    throw new WorkItemsIntegrityCliFailure(
      'OUTPUT_FILE_PUBLISHED_CLEANUP_FAILED',
      1,
    )
  }
}

const defaultPostPublicationOperations: WorkItemsIntegrityPostPublicationOperations = {
  removeTemporaryFile: unlink,
  syncOutputDirectory,
}

/**
 * Flushes the directory entries that publish and remove the hard-linked names.
 *
 * @param outputPath - Final manifest path.
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
 * Retries removal of the temporary hard-link name after final publication.
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
      // A transient cleanup failure receives one bounded retry.
    }
  }
  return false
}

/**
 * Removes only the randomly named temporary output after a failed atomic write.
 *
 * @param temporaryPath - Exact temporary path created by this process.
 */
async function removeTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath)
  } catch {
    // A failed open or completed hard-link publication leaves no temporary file to remove.
  }
}

/**
 * Converts untrusted exceptions into raw-data-free CLI failures.
 *
 * @param error - Caught failure.
 * @returns Stable category and exit status.
 */
function classifyCliFailure(error: unknown): ClassifiedCliFailure {
  if (error instanceof WorkItemsIntegrityCliFailure) {
    return {
      code: error.code,
      exitCode: error.exitCode,
    }
  }
  if (error instanceof WorkItemsIntegrityFailure) {
    return {
      code: error.code,
      exitCode: 1,
    }
  }
  return {
    code: identifyAwsFailure(error) ? 'AWS_READ_FAILED' : 'OPERATION_FAILED',
    exitCode: 1,
  }
}

/**
 * Recognizes AWS SDK failures without serializing their names, messages, or metadata.
 *
 * @param error - Caught unknown value.
 * @returns True when the value exposes SDK response metadata.
 */
function identifyAwsFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return false
  }
  return '$metadata' in error
}

/**
 * Identifies a safe operation label without returning arbitrary argument text.
 *
 * @param command - First CLI argument.
 * @returns Stable operation label.
 */
function identifyOperation(command: string | undefined): WorkItemsIntegrityCliOperation {
  if (command === 'manifest' || command === 'compare') {
    return command
  }
  if (command === 'help' || command === '--help') {
    return 'help'
  }
  return 'unknown'
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
  void runWorkItemsIntegrityCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
