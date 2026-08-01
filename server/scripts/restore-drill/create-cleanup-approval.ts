import { createHash } from 'node:crypto'
import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import {
  DecryptCommand,
  KMSClient,
  type DecryptCommandOutput,
} from '@aws-sdk/client-kms'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  DescribeExecutionCommand,
  SFNClient,
  type DescribeExecutionCommandOutput,
} from '@aws-sdk/client-sfn'
import {
  GetCallerIdentityCommand,
  STSClient,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  RESTORE_DRILL_CLEANUP_APPROVAL_MAXIMUM_MILLISECONDS,
  createRestoreDrillCleanupApprovalReceipt,
  createRestoreDrillCleanupExecutionName,
  RestoreDrillFailure,
  type RestoreDrillCleanupApprovalReceipt,
  type RestoreDrillFailureCode,
} from '../../src/modules/restore-drill'

const CLEANUP_POLICY_VERSION = 'restore-drill-cleanup-v1'
const RUN_RECORD_KEY = 'RUN'
const DIGEST_KEY_BYTES = 32
const APPROVAL_CONTENT_TYPE = 'application/json'
const APPROVAL_MAXIMUM_BYTES = 16_384
const APPROVAL_RETENTION_MILLISECONDS = 400 * 24 * 60 * 60 * 1_000
const CLEANUP_REAPPROVAL_GRACE_MILLISECONDS = 16 * 60 * 1_000

const flagNames = new Set([
  '--approval-bucket-name',
  '--approver',
  '--change-locator',
  '--drill-id',
  '--expires-at',
  '--profile',
  '--region',
  '--state-table-name',
])

const runItemKeys = new Set([
  'cleanupPolicyVersion',
  'deadlineAt',
  'digestKeyEnvelope',
  'drillId',
  'failureCodes',
  'kind',
  'outcome',
  'phase',
  'recordKey',
  'resourceDigest',
  'restorePoint',
  'resultDigest',
  'resultEvidenceKey',
  'resultOutcome',
  'revision',
  'runVersion',
  'scopeKey',
  'startedAt',
  'updatedAt',
  'verificationCompletedAt',
])

const fallbackRunItemKeys = new Set(
  [...runItemKeys].filter((key) => key !== 'restorePoint'),
)

const cleanupBindingItemKeys = new Set([
  'approvalDigest',
  'approvalObjectKey',
  'approvedAt',
  'cleanupAttemptCount',
  'cleanupExecutionArn',
  'cleanupExecutionName',
  'cleanupStartedAt',
])

const cleaningRunItemKeys = new Set([
  ...runItemKeys,
  ...cleanupBindingItemKeys,
])

const fallbackCleaningRunItemKeys = new Set(
  [...cleaningRunItemKeys].filter((key) => key !== 'restorePoint'),
)

const digestKeyEnvelopeKeys = new Set([
  'ciphertextBase64',
  'kind',
  'kmsKeyArn',
])

const runProjectionAttributeNames = [...cleaningRunItemKeys].sort()
const runProjectionExpressionAttributeNames = Object.fromEntries(
  runProjectionAttributeNames.map((attributeName, index) => [
    `#run${index}`,
    attributeName,
  ]),
)
const runProjectionExpression = Object.keys(
  runProjectionExpressionAttributeNames,
).join(', ')

const callerResourcePattern = new RegExp(
  '^(?:assumed-role|federated-user|role|user)/[A-Za-z0-9+=,.@_/-]+$|^root$',
  'u',
)

const knownFailureCodes: ReadonlySet<string> = new Set([
  'AGGREGATE_CONTENT_MISMATCH',
  'AGGREGATE_DESCRIPTOR_MISMATCH',
  'AGGREGATE_INVALID',
  'AGGREGATE_KEY_MISMATCH',
  'AGGREGATE_METADATA_MISMATCH',
  'AGGREGATE_PARTITION_COUNT_MISMATCH',
  'AGGREGATE_RECORD_COUNT_MISMATCH',
  'AGGREGATE_RESOURCE_MISMATCH',
  'AGGREGATE_RESTORE_POINT_MISMATCH',
  'AGGREGATE_ROLE_MISMATCH',
  'APPROVAL_APPROVER_UNAUTHORIZED',
  'APPROVAL_AUTHENTICATION_FAILED',
  'APPROVAL_CHANGE_MISMATCH',
  'APPROVAL_DRILL_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_YET_VALID',
  'APPROVAL_POLICY_MISMATCH',
  'APPROVAL_RECEIPT_INVALID',
  'APPROVAL_RESOURCE_MISMATCH',
  'APPROVAL_RESULT_MISMATCH',
  'CADENCE_OVERDUE',
  'CLEANUP_CONTEXT_INVALID',
  'CLEANUP_FAILED',
  'CROSS_DOMAIN_INTEGRITY_FAILED',
  'DIGEST_DOMAIN_INVALID',
  'DIGEST_KEY_INVALID',
  'DYNAMODB_RESTORE_FAILED',
  'EVIDENCE_INVALID',
  'EVIDENCE_PERSIST_FAILED',
  'OBJECTIVE_TIMELINE_INVALID',
  'PITR_WINDOW_INVALID',
  'PITR_WINDOW_NO_OVERLAP',
  'PITR_WINDOW_TARGET_MISMATCH',
  'RESOURCE_IDENTITY_INVALID',
  'RPO_TARGET_MISSED',
  'RTO_TARGET_MISSED',
  'RUN_STATE_INVALID',
  'S3_VERSION_RESTORE_FAILED',
  'WORKFLOW_POLL_BUDGET_EXCEEDED',
  'WORKFLOW_TASK_FAILED',
])

/** Stable failure categories safe to write at the CLI boundary. */
export type RestoreDrillCleanupApprovalCliFailureCode =
  | 'APPROVAL_ALREADY_EXISTS'
  | 'APPROVAL_BINDING_INVALID'
  | 'APPROVAL_WINDOW_INVALID'
  | 'APPROVAL_WRITE_FAILED'
  | 'APPROVER_MISMATCH'
  | 'CALLER_IDENTITY_FAILED'
  | 'CALLER_IDENTITY_INVALID'
  | 'CLEANUP_EXECUTION_INVALID'
  | 'CLEANUP_EXECUTION_NOT_REAPPROVABLE'
  | 'CLEANUP_EXECUTION_READ_FAILED'
  | 'CLEANUP_REAPPROVAL_TOO_EARLY'
  | 'INVALID_USAGE'
  | 'KMS_DECRYPT_FAILED'
  | 'KMS_RESPONSE_INVALID'
  | 'RUN_INVALID'
  | 'RUN_NOT_APPROVABLE'
  | 'RUN_NOT_FOUND'
  | 'RUN_READ_FAILED'
  | 'UNEXPECTED_FAILURE'

/** Process exit statuses exposed by the cleanup-approval CLI. */
export type RestoreDrillCleanupApprovalCliExitCode = 0 | 1 | 2

/** Strictly parsed operator arguments for one cleanup approval. */
export type RestoreDrillCleanupApprovalCliArguments = {
  /** Explicit Object Lock evidence bucket that owns immutable approvals. */
  readonly approvalBucketName: string
  /** Exact caller ARN expected from STS for this invocation. */
  readonly approver: string
  /** Immutable change request or change-set locator authorizing cleanup. */
  readonly changeLocator: string
  /** Stable restore drill identifier. */
  readonly drillId: string
  /** Canonical UTC timestamp after which the approval is unusable. */
  readonly expiresAt: string
  /** Optional shared-configuration profile used for all AWS clients. */
  readonly profile?: string
  /** Explicit AWS Region used for all AWS clients. */
  readonly region: string
  /** Explicit restore drill state table name. */
  readonly stateTableName: string
}

/** Explicit AWS connection settings for one CLI session. */
export type RestoreDrillCleanupApprovalAwsConfiguration = {
  /** Optional shared-configuration profile used for credentials. */
  readonly profile?: string
  /** Explicit AWS Region used by DynamoDB, KMS, S3, Step Functions, and STS. */
  readonly region: string
}

/** Narrow DynamoDB transport for the one projected strong read. */
export interface RestoreDrillCleanupApprovalDynamoDbPort {
  /**
   * Strongly reads the exact durable run item.
   *
   * @param command - Exact GetItem command.
   * @returns DynamoDB GetItem response.
   */
  getRun(command: GetItemCommand): Promise<GetItemCommandOutput>
}

/** Exact S3 fields needed to reconcile an ambiguous immutable approval write. */
export type RestoreDrillCleanupApprovalS3GetOutput = {
  /** Streaming body exposing the official SDK byte conversion operation. */
  readonly Body?: {
    /**
     * Reads the complete, already length-bounded response body.
     *
     * @returns Exact downloaded object bytes.
     */
    transformToByteArray(): Promise<Uint8Array>
  }
  /** Base64 SHA-256 checksum returned by S3. */
  readonly ChecksumSHA256?: string
  /** Exact stored byte length. */
  readonly ContentLength?: number
  /** Exact receipt media type. */
  readonly ContentType?: string
  /** Effective S3 Object Lock retention mode. */
  readonly ObjectLockMode?: string
  /** Effective S3 Object Lock retention deadline. */
  readonly ObjectLockRetainUntilDate?: Date
  /** Exact KMS key identifier returned by S3. */
  readonly SSEKMSKeyId?: string
  /** Server-side encryption algorithm returned by S3. */
  readonly ServerSideEncryption?: string
}

/** S3 write response fields used to prove effective Object Lock retention. */
export type RestoreDrillCleanupApprovalS3PutOutput = PutObjectCommandOutput & {
  /** Effective S3 Object Lock retention mode when returned by S3. */
  readonly ObjectLockMode?: string
  /** Effective S3 Object Lock retention deadline when returned by S3. */
  readonly ObjectLockRetainUntilDate?: Date
}

/** Narrow S3 transport for immutable approval storage and reconciliation. */
export interface RestoreDrillCleanupApprovalS3Port {
  /**
   * Reads an existing approval object after an ambiguous or conditional write failure.
   *
   * @param command - Exact GetObject command.
   * @returns Integrity-bearing S3 object response.
   */
  getApproval(
    command: GetObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3GetOutput>

  /**
   * Exclusively stores one Object Lock protected approval object.
   *
   * @param command - Exact conditional PutObject command.
   * @returns Raw S3 PutObject response.
   */
  putApproval(
    command: PutObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3PutOutput>
}

/** Narrow Step Functions transport for one pinned execution observation. */
export interface RestoreDrillCleanupApprovalStepFunctionsPort {
  /**
   * Describes the exact cleanup execution already pinned in RUN.
   *
   * @param command - Metadata-only execution description command.
   * @returns Official Step Functions execution response.
   */
  describeExecution(
    command: DescribeExecutionCommand,
  ): Promise<DescribeExecutionCommandOutput>
}

/** Narrow KMS transport that can only decrypt the drill-bound digest key. */
export interface RestoreDrillCleanupApprovalKmsPort {
  /**
   * Decrypts one exact ciphertext under its recorded key and context.
   *
   * @param command - Exact Decrypt command.
   * @returns KMS Decrypt response.
   */
  decrypt(command: DecryptCommand): Promise<DecryptCommandOutput>
}

/** Narrow STS transport used to bind the receipt to the actual AWS caller. */
export interface RestoreDrillCleanupApprovalStsPort {
  /**
   * Resolves the identity whose credentials will read, decrypt, and write.
   *
   * @param command - Parameter-free caller identity command.
   * @returns STS caller identity response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput>
}

/** Closeable AWS session containing only cleanup-approval operations. */
export interface RestoreDrillCleanupApprovalAwsSession extends
  RestoreDrillCleanupApprovalDynamoDbPort,
  RestoreDrillCleanupApprovalKmsPort,
  RestoreDrillCleanupApprovalS3Port,
  RestoreDrillCleanupApprovalStepFunctionsPort,
  RestoreDrillCleanupApprovalStsPort {
  /** Releases resources held by the official AWS SDK clients. */
  close(): void
}

/** Factory for one explicit-region cleanup-approval AWS session. */
export type RestoreDrillCleanupApprovalAwsSessionFactory = (
  configuration: RestoreDrillCleanupApprovalAwsConfiguration,
) => RestoreDrillCleanupApprovalAwsSession

/** Injectable boundaries used by the top-level CLI. */
export type RestoreDrillCleanupApprovalCliDependencies = {
  /** Creates one closeable AWS session. */
  readonly createSession: RestoreDrillCleanupApprovalAwsSessionFactory
  /** Returns the approval decision time. */
  readonly now: () => Date
  /** Writes one secret-free failure result. */
  readonly writeError: (line: string) => void
  /** Writes one secret-free success result. */
  readonly writeOutput: (line: string) => void
}

/** Secret-free result returned after an immutable approval is stored. */
export type RestoreDrillCleanupApprovalResult = {
  /** Safe immutable locator supplied to the cleanup workflow. */
  readonly approvalObjectKey: string
  /** Canonical UTC time at which the operator approved cleanup. */
  readonly approvedAt: string
  /** Deterministic Step Functions execution name for response-loss retries. */
  readonly cleanupExecutionName: string
  /** Stable drill identifier represented by the approval. */
  readonly drillId: string
  /** Approval expiration copied from validated operator input. */
  readonly expiresAt: string
  /** Fixed cleanup policy version authenticated by the receipt. */
  readonly policyVersion: typeof CLEANUP_POLICY_VERSION
  /** Safe evidence object locator that the operator reviewed. */
  readonly resultEvidenceKey: string
  /** Stable success discriminator. */
  readonly status: 'approval-created'
}

/** Stable CLI failure containing no raw AWS or persisted values. */
export class RestoreDrillCleanupApprovalCliFailure extends Error {
  /** Raw-data-free failure category. */
  readonly code: RestoreDrillCleanupApprovalCliFailureCode

  /** Process exit status associated with the failure. */
  readonly exitCode: RestoreDrillCleanupApprovalCliExitCode

  /**
   * Creates a stable cleanup-approval CLI failure.
   *
   * @param code - Raw-data-free failure category.
   * @param exitCode - Process exit status.
   */
  constructor(
    code: RestoreDrillCleanupApprovalCliFailureCode,
    exitCode: RestoreDrillCleanupApprovalCliExitCode,
  ) {
    super(code)
    this.name = 'RestoreDrillCleanupApprovalCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Strict terminal fields shared by initial approval and cleanup reapproval. */
type ApprovableRestoreDrillRunBase = {
  /** Fixed cleanup policy version recorded by the terminal seal. */
  readonly cleanupPolicyVersion: typeof CLEANUP_POLICY_VERSION
  /** Canonical four-hour execution deadline. */
  readonly deadlineAt: string
  /** KMS-protected per-run digest key. */
  readonly digestKeyEnvelope: RestoreDrillDigestKeyEnvelope
  /** Stable restore drill identifier. */
  readonly drillId: string
  /** Sorted unique stable terminal failure categories. */
  readonly failureCodes: readonly RestoreDrillFailureCode[]
  /** In-progress outer orchestration outcome while cleanup is pending. */
  readonly outcome: 'in-progress'
  /** Positive durable revision. */
  readonly revision: number
  /** HMAC digest of the exact isolated resource identities. */
  readonly resourceDigest: string
  /** Common source restore point, absent only for an operational fallback before selection. */
  readonly restorePoint?: string
  /** HMAC digest of the terminal verification result. */
  readonly resultDigest: string
  /** Canonical immutable result evidence object key. */
  readonly resultEvidenceKey: string
  /** Verification outcome sealed before cleanup approval. */
  readonly resultOutcome: 'fail' | 'pass'
  /** Canonical start time. */
  readonly startedAt: string
  /** Canonical last-update time. */
  readonly updatedAt: string
  /** Canonical terminal verification time. */
  readonly verificationCompletedAt: string
}

/** Exact RUN shape before the first cleanup approval is admitted. */
type InitialApprovableRestoreDrillRun = ApprovableRestoreDrillRunBase & {
  /** Initial approval phase with no prior cleanup binding. */
  readonly phase: 'awaiting-cleanup-approval'
}

/** Exact prior cleanup binding required before a replacement approval. */
type RestoreDrillCleanupReapprovalBinding = {
  /** SHA-256 digest of the previously selected immutable approval. */
  readonly approvalDigest: string
  /** Immutable object key of the previously selected approval. */
  readonly approvalObjectKey: string
  /** Canonical time of the previously selected approval. */
  readonly approvedAt: string
  /** Positive count of previously admitted cleanup attempts. */
  readonly cleanupAttemptCount: number
  /** Exact ARN of the cleanup execution whose terminal failure permits rotation. */
  readonly cleanupExecutionArn: string
  /** Receipt-bound name of the cleanup execution whose terminal failure permits rotation. */
  readonly cleanupExecutionName: string
  /** Derived exact state machine ARN owning the pinned execution. */
  readonly cleanupStateMachineArn: string
  /** Canonical time at which cleanup was first admitted. */
  readonly cleanupStartedAt: string
}

/** Strict RUN shape eligible for a replacement cleanup approval. */
type ReapprovableRestoreDrillRun = ApprovableRestoreDrillRunBase &
  RestoreDrillCleanupReapprovalBinding & {
  /** Active cleanup phase requiring proof that the pinned execution failed terminally. */
  readonly phase: 'cleaning-up'
}

/** Strict RUN variant from which the CLI may issue an approval receipt. */
type ApprovableRestoreDrillRun =
  | InitialApprovableRestoreDrillRun
  | ReapprovableRestoreDrillRun

/** KMS ciphertext envelope strictly parsed from one run item. */
type RestoreDrillDigestKeyEnvelope = {
  /** Canonical Base64 KMS ciphertext. */
  readonly ciphertextBase64: string
  /** Fixed envelope discriminator. */
  readonly kind: 'restore-drill-digest-key'
  /** Exact KMS key ARN required for decryption. */
  readonly kmsKeyArn: string
}

/** Parsed components of one AWS ARN. */
type AwsArnIdentity = {
  /** Twelve-digit AWS account identifier. */
  readonly accountId: string
  /** AWS partition identifier. */
  readonly partition: string
  /** ARN resource suffix. */
  readonly resource: string
  /** AWS service identifier. */
  readonly service: string
}

/** AWS partitions supported by the restore-drill deployment contract. */
type RestoreDrillCleanupApprovalAwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov'

/** Official AWS SDK v3 session shared by one approval invocation. */
class OfficialRestoreDrillCleanupApprovalAwsSession
implements RestoreDrillCleanupApprovalAwsSession {
  /** DynamoDB client bound to the selected credentials and Region. */
  private readonly dynamodbClient: DynamoDBClient

  /** KMS client bound to the selected credentials and Region. */
  private readonly kmsClient: KMSClient

  /** S3 client bound to the selected credentials and Region. */
  private readonly s3Client: S3Client

  /** Step Functions client bound to the selected credentials and Region. */
  private readonly sfnClient: SFNClient

  /** STS client bound to the selected credentials and Region. */
  private readonly stsClient: STSClient

  /**
   * Creates one official SDK session.
   *
   * @param configuration - Explicit Region and optional shared profile.
   */
  constructor(configuration: RestoreDrillCleanupApprovalAwsConfiguration) {
    if (configuration.profile === undefined) {
      const clientConfiguration = { region: configuration.region }
      this.dynamodbClient = new DynamoDBClient(clientConfiguration)
      this.kmsClient = new KMSClient(clientConfiguration)
      this.s3Client = new S3Client(clientConfiguration)
      this.sfnClient = new SFNClient(clientConfiguration)
      this.stsClient = new STSClient(clientConfiguration)
      return
    }
    const credentials = fromIni({ profile: configuration.profile })
    const clientConfiguration = {
      credentials,
      region: configuration.region,
    }
    this.dynamodbClient = new DynamoDBClient(clientConfiguration)
    this.kmsClient = new KMSClient(clientConfiguration)
    this.s3Client = new S3Client(clientConfiguration)
    this.sfnClient = new SFNClient(clientConfiguration)
    this.stsClient = new STSClient(clientConfiguration)
  }

  /** Releases all official SDK clients. */
  close(): void {
    this.dynamodbClient.destroy()
    this.kmsClient.destroy()
    this.s3Client.destroy()
    this.sfnClient.destroy()
    this.stsClient.destroy()
  }

  /** Sends one exact KMS Decrypt command. */
  decrypt(command: DecryptCommand): Promise<DecryptCommandOutput> {
    return this.kmsClient.send(command)
  }

  /** Sends one metadata-only Step Functions execution description command. */
  describeExecution(
    command: DescribeExecutionCommand,
  ): Promise<DescribeExecutionCommandOutput> {
    return this.sfnClient.send(command)
  }

  /** Sends one exact strongly consistent DynamoDB GetItem command. */
  getRun(command: GetItemCommand): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one exact approval GetObject command.
   *
   * @param command - Exact reconciliation read command.
   * @returns Integrity-bearing S3 object response.
   */
  getApproval(
    command: GetObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3GetOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one parameter-free STS GetCallerIdentity command. */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
  }

  /**
   * Sends one exact conditional S3 PutObject command.
   *
   * @param command - Exact immutable approval write command.
   * @returns Raw S3 PutObject response.
   */
  putApproval(
    command: PutObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3PutOutput> {
    return this.s3Client.send(command)
  }
}

const defaultCliDependencies: RestoreDrillCleanupApprovalCliDependencies = {
  createSession: (configuration) =>
    new OfficialRestoreDrillCleanupApprovalAwsSession(configuration),
  now: () => new Date(),
  writeError: console.error,
  writeOutput: console.log,
}

/**
 * Strictly parses one complete cleanup-approval argument vector.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Validated explicit resource and approval inputs.
 */
export function parseRestoreDrillCleanupApprovalCliArguments(
  arguments_: readonly string[],
): RestoreDrillCleanupApprovalCliArguments {
  const flags = parseFlagPairs(arguments_)
  const region = requireRegion(flags)
  const approvalBucketName = requireBucketName(flags, '--approval-bucket-name')
  const stateTableName = requireTableName(flags, '--state-table-name')
  const drillId = requireDrillId(flags)
  const approver = requireApprover(flags)
  const changeLocator = requireBoundedPrintableFlag(flags, '--change-locator', 2_048)
  const expiresAt = requireCanonicalTimestamp(flags, '--expires-at')
  const profileValue = flags.get('--profile')
  const profile = profileValue === undefined
    ? undefined
    : validateBoundedPrintableValue(profileValue, 256)

  return {
    approvalBucketName,
    approver,
    changeLocator,
    drillId,
    expiresAt,
    ...(profile === undefined ? {} : { profile }),
    region,
    stateTableName,
  }
}

/**
 * Reads, authenticates, and stores one immutable cleanup approval.
 *
 * @param configuration - Strict operator arguments.
 * @param session - Injectable AWS ports bound to one identity.
 * @param now - Approval decision time.
 * @returns Secret-free approval summary.
 */
export async function createRestoreDrillCleanupApproval(
  configuration: RestoreDrillCleanupApprovalCliArguments,
  session: RestoreDrillCleanupApprovalAwsSession,
  now: Date,
): Promise<RestoreDrillCleanupApprovalResult> {
  const approvedAt = readDecisionTime(now)
  const approvedAtMilliseconds = Date.parse(approvedAt)
  const expiresAtMilliseconds = Date.parse(configuration.expiresAt)
  if (
    expiresAtMilliseconds <= approvedAtMilliseconds ||
    expiresAtMilliseconds - approvedAtMilliseconds >
      RESTORE_DRILL_CLEANUP_APPROVAL_MAXIMUM_MILLISECONDS
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('APPROVAL_WINDOW_INVALID', 1)
  }

  const run = await readApprovableRun(configuration, session)
  await verifyCleanupReapprovalEligibility(
    run,
    approvedAt,
    session,
  )
  const caller = await readAndVerifyCaller(configuration, run, session)
  const receipt = await createApprovalReceipt(configuration, run, caller, approvedAt, session)
  const approvalObjectKey = await writeApproval(
    configuration,
    run,
    receipt,
    session,
  )

  return {
    approvalObjectKey,
    approvedAt,
    cleanupExecutionName: createRestoreDrillCleanupExecutionName(receipt),
    drillId: configuration.drillId,
    expiresAt: configuration.expiresAt,
    policyVersion: CLEANUP_POLICY_VERSION,
    resultEvidenceKey: run.resultEvidenceKey,
    status: 'approval-created',
  }
}

/**
 * Executes the cleanup-approval CLI behind a raw-data-free output boundary.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable session, clock, and output ports.
 * @returns Stable process exit status.
 */
export async function runRestoreDrillCleanupApprovalCli(
  arguments_: readonly string[],
  dependencies: RestoreDrillCleanupApprovalCliDependencies = defaultCliDependencies,
): Promise<RestoreDrillCleanupApprovalCliExitCode> {
  let session: RestoreDrillCleanupApprovalAwsSession | undefined
  try {
    const configuration = parseRestoreDrillCleanupApprovalCliArguments(arguments_)
    session = dependencies.createSession({
      ...(configuration.profile === undefined ? {} : { profile: configuration.profile }),
      region: configuration.region,
    })
    const result = await createRestoreDrillCleanupApproval(
      configuration,
      session,
      dependencies.now(),
    )
    writeJsonLine(dependencies.writeOutput, {
      approvalObjectKey: result.approvalObjectKey,
      cleanupExecutionName: result.cleanupExecutionName,
      drillId: result.drillId,
      operation: 'create-cleanup-approval',
      status: result.status,
    })
    return 0
  } catch (error: unknown) {
    const failure = classifyCliFailure(error)
    writeJsonLine(dependencies.writeError, {
      code: failure.code,
      operation: 'create-cleanup-approval',
      status: 'error',
    })
    return failure.exitCode
  } finally {
    closeSessionWithoutOverwritingResult(session)
  }
}

/**
 * Releases one AWS session without replacing the CLI's determined result.
 *
 * @param session - Optional session created after successful argument parsing.
 */
function closeSessionWithoutOverwritingResult(
  session: RestoreDrillCleanupApprovalAwsSession | undefined,
): void {
  try {
    session?.close()
  } catch {
    // SDK client destruction must not replace the already classified CLI result.
  }
}

/**
 * Strongly reads and strictly parses the one approvable run item.
 *
 * @param configuration - Validated CLI inputs.
 * @param dynamodb - Narrow DynamoDB port.
 * @returns Strict terminal verification seal.
 */
async function readApprovableRun(
  configuration: RestoreDrillCleanupApprovalCliArguments,
  dynamodb: RestoreDrillCleanupApprovalDynamoDbPort,
): Promise<ApprovableRestoreDrillRun> {
  let output: GetItemCommandOutput
  try {
    output = await dynamodb.getRun(new GetItemCommand({
      ConsistentRead: true,
      ExpressionAttributeNames: runProjectionExpressionAttributeNames,
      Key: {
        scopeKey: { S: createRunScopeKey(configuration.drillId) },
        recordKey: { S: RUN_RECORD_KEY },
      },
      ProjectionExpression: runProjectionExpression,
      TableName: configuration.stateTableName,
    }))
  } catch {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_READ_FAILED', 1)
  }
  if (output.Item === undefined) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_NOT_FOUND', 1)
  }
  return parseApprovableRun(output.Item, configuration)
}

/**
 * Proves that a pinned cleanup attempt failed terminally before reapproval.
 *
 * Initial approvals have no prior execution and pass through without calling
 * Step Functions. Reapprovals require an exact metadata-only observation and a
 * full grace interval after the terminal stop time.
 *
 * @param run - Strict initial or reapprovable durable RUN.
 * @param approvedAt - Canonical current approval decision time.
 * @param stepFunctions - Narrow Step Functions execution reader.
 */
async function verifyCleanupReapprovalEligibility(
  run: ApprovableRestoreDrillRun,
  approvedAt: string,
  stepFunctions: RestoreDrillCleanupApprovalStepFunctionsPort,
): Promise<void> {
  if (run.phase === 'awaiting-cleanup-approval') return

  let output: DescribeExecutionCommandOutput
  try {
    output = await stepFunctions.describeExecution(new DescribeExecutionCommand({
      executionArn: run.cleanupExecutionArn,
      includedData: 'METADATA_ONLY',
    }))
  } catch {
    throw new RestoreDrillCleanupApprovalCliFailure(
      'CLEANUP_EXECUTION_READ_FAILED',
      1,
    )
  }

  if (
    output.executionArn !== run.cleanupExecutionArn ||
    output.name !== run.cleanupExecutionName ||
    output.stateMachineArn !== run.cleanupStateMachineArn
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(
      'CLEANUP_EXECUTION_INVALID',
      1,
    )
  }

  switch (output.status) {
    case 'ABORTED':
    case 'FAILED':
    case 'TIMED_OUT':
      break
    case 'PENDING_REDRIVE':
    case 'RUNNING':
    case 'SUCCEEDED':
      throw new RestoreDrillCleanupApprovalCliFailure(
        'CLEANUP_EXECUTION_NOT_REAPPROVABLE',
        1,
      )
    default:
      throw new RestoreDrillCleanupApprovalCliFailure(
        'CLEANUP_EXECUTION_INVALID',
        1,
      )
  }

  const stopDate = output.stopDate
  if (!(stopDate instanceof Date) || !Number.isFinite(stopDate.getTime())) {
    throw new RestoreDrillCleanupApprovalCliFailure(
      'CLEANUP_EXECUTION_INVALID',
      1,
    )
  }
  const canonicalStopDate = stopDate.toISOString()
  const stopMilliseconds = Date.parse(canonicalStopDate)
  if (
    !isCanonicalTimestamp(canonicalStopDate) ||
    stopMilliseconds < Date.parse(run.cleanupStartedAt)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(
      'CLEANUP_EXECUTION_INVALID',
      1,
    )
  }
  if (
    Date.parse(approvedAt) <
      stopMilliseconds + CLEANUP_REAPPROVAL_GRACE_MILLISECONDS
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(
      'CLEANUP_REAPPROVAL_TOO_EARLY',
      1,
    )
  }
}

/**
 * Resolves and verifies the actual AWS caller before any secret is decrypted.
 *
 * @param configuration - Validated CLI inputs.
 * @param run - Strict run containing the owning KMS key ARN.
 * @param sts - Narrow STS port.
 * @returns Exact authenticated caller ARN.
 */
async function readAndVerifyCaller(
  configuration: RestoreDrillCleanupApprovalCliArguments,
  run: ApprovableRestoreDrillRun,
  sts: RestoreDrillCleanupApprovalStsPort,
): Promise<string> {
  let output: GetCallerIdentityCommandOutput
  try {
    output = await sts.getCallerIdentity(new GetCallerIdentityCommand({}))
  } catch {
    throw new RestoreDrillCleanupApprovalCliFailure('CALLER_IDENTITY_FAILED', 1)
  }
  if (
    typeof output.Arn !== 'string' ||
    typeof output.Account !== 'string' ||
    !/^\d{12}$/u.test(output.Account)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('CALLER_IDENTITY_INVALID', 1)
  }
  const callerIdentity = parseCallerArn(output.Arn, 'CALLER_IDENTITY_INVALID')
  const kmsIdentity = parseKmsKeyArn(
    run.digestKeyEnvelope.kmsKeyArn,
    configuration.region,
    'RUN_INVALID',
  )
  if (
    callerIdentity.accountId !== output.Account ||
    callerIdentity.accountId !== kmsIdentity.accountId ||
    callerIdentity.partition !== kmsIdentity.partition
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('CALLER_IDENTITY_INVALID', 1)
  }
  if (output.Arn !== configuration.approver) {
    throw new RestoreDrillCleanupApprovalCliFailure('APPROVER_MISMATCH', 1)
  }
  return output.Arn
}

/**
 * Decrypts the run-bound digest key and creates a receipt before zeroizing plaintext.
 *
 * @param configuration - Validated CLI inputs.
 * @param run - Strict terminal run.
 * @param callerArn - Exact authenticated caller ARN.
 * @param approvedAt - Canonical approval time.
 * @param kms - Narrow KMS port.
 * @returns Authenticated receipt containing no plaintext key material.
 */
async function createApprovalReceipt(
  configuration: RestoreDrillCleanupApprovalCliArguments,
  run: ApprovableRestoreDrillRun,
  callerArn: string,
  approvedAt: string,
  kms: RestoreDrillCleanupApprovalKmsPort,
): Promise<RestoreDrillCleanupApprovalReceipt> {
  let output: DecryptCommandOutput
  try {
    output = await kms.decrypt(new DecryptCommand({
      CiphertextBlob: Buffer.from(run.digestKeyEnvelope.ciphertextBase64, 'base64'),
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: createDigestKeyEncryptionContext(configuration.drillId),
      KeyId: run.digestKeyEnvelope.kmsKeyArn,
    }))
  } catch {
    throw new RestoreDrillCleanupApprovalCliFailure('KMS_DECRYPT_FAILED', 1)
  }

  const plaintext = output.Plaintext
  if (!(plaintext instanceof Uint8Array)) {
    throw new RestoreDrillCleanupApprovalCliFailure('KMS_RESPONSE_INVALID', 1)
  }
  try {
    if (
      plaintext.length !== DIGEST_KEY_BYTES ||
      output.KeyId !== run.digestKeyEnvelope.kmsKeyArn ||
      output.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
    ) {
      throw new RestoreDrillCleanupApprovalCliFailure('KMS_RESPONSE_INVALID', 1)
    }
    try {
      return createRestoreDrillCleanupApprovalReceipt({
        approver: callerArn,
        approvedAt,
        changeLocator: configuration.changeLocator,
        drillId: configuration.drillId,
        expiresAt: configuration.expiresAt,
        policyVersion: run.cleanupPolicyVersion,
        resourceDigest: run.resourceDigest,
        resultDigest: run.resultDigest,
      }, plaintext)
    } catch (error: unknown) {
      if (error instanceof RestoreDrillFailure) {
        throw new RestoreDrillCleanupApprovalCliFailure('APPROVAL_BINDING_INVALID', 1)
      }
      throw error
    }
  } finally {
    plaintext.fill(0)
  }
}

/**
 * Exclusively stores or exactly reconciles one immutable approval receipt.
 *
 * The evidence bucket's default Object Lock retention supplies the retention
 * interval, and the effective response is verified before success. A
 * content-addressed key allows a later, newly authenticated approval after an
 * earlier receipt expires without mutating prior evidence.
 *
 * @param configuration - Explicit bucket, Region, and drill bindings.
 * @param run - Strict run containing the exact evidence KMS key ARN.
 * @param receipt - Kernel-generated authenticated approval.
 * @param s3 - Narrow S3 immutable object port.
 * @returns Safe object key supplied to the cleanup workflow.
 */
async function writeApproval(
  configuration: RestoreDrillCleanupApprovalCliArguments,
  run: ApprovableRestoreDrillRun,
  receipt: RestoreDrillCleanupApprovalReceipt,
  s3: RestoreDrillCleanupApprovalS3Port,
): Promise<string> {
  const objectKey = createApprovalObjectKey(receipt)
  const body = serializeApprovalReceipt(receipt)
  const checksumSha256 = createHash('sha256').update(body).digest('base64')
  const expectedBucketOwner = parseKmsKeyArn(
    run.digestKeyEnvelope.kmsKeyArn,
    configuration.region,
    'RUN_INVALID',
  ).accountId
  const minimumRetainUntilMilliseconds =
    Date.parse(receipt.approvedAt) + APPROVAL_RETENTION_MILLISECONDS
  let writeFailure: unknown
  let putSucceeded = false
  try {
    const output = await s3.putApproval(new PutObjectCommand({
      Body: body,
      Bucket: configuration.approvalBucketName,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: checksumSha256,
      ContentLength: body.byteLength,
      ContentType: APPROVAL_CONTENT_TYPE,
      ExpectedBucketOwner: expectedBucketOwner,
      IfNoneMatch: '*',
      Key: objectKey,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: run.digestKeyEnvelope.kmsKeyArn,
    }))
    putSucceeded = true
    if (hasRequiredApprovalObjectLock(
      output,
      minimumRetainUntilMilliseconds,
    )) return objectKey
  } catch (error: unknown) {
    writeFailure = error
  }

  const reconciled = await reconcileApprovalWrite({
    body,
    bucketName: configuration.approvalBucketName,
    checksumSha256,
    expectedBucketOwner,
    kmsKeyArn: run.digestKeyEnvelope.kmsKeyArn,
    minimumRetainUntilMilliseconds,
    objectKey,
  }, s3)
  if (reconciled) return objectKey
  if (putSucceeded) {
    throw new RestoreDrillCleanupApprovalCliFailure('APPROVAL_WRITE_FAILED', 1)
  }
  const failureCode = isS3PreconditionFailure(writeFailure)
    ? 'APPROVAL_ALREADY_EXISTS'
    : 'APPROVAL_WRITE_FAILED'
  throw new RestoreDrillCleanupApprovalCliFailure(failureCode, 1)
}

/** Exact immutable object properties used for response-loss reconciliation. */
type ApprovalObjectExpectation = {
  /** Exact canonical receipt bytes. */
  readonly body: Uint8Array
  /** Explicit evidence bucket name. */
  readonly bucketName: string
  /** Base64 SHA-256 checksum of the exact receipt bytes. */
  readonly checksumSha256: string
  /** Account extracted from the exact KMS key ARN. */
  readonly expectedBucketOwner: string
  /** Exact evidence KMS key ARN. */
  readonly kmsKeyArn: string
  /** Earliest effective Object Lock retention deadline. */
  readonly minimumRetainUntilMilliseconds: number
  /** Content-addressed approval object key. */
  readonly objectKey: string
}

/**
 * Reads and compares the current immutable approval after an ambiguous write.
 *
 * @param expectation - Exact body, checksum, encryption, and locator expected.
 * @param s3 - Narrow S3 reconciliation port.
 * @returns Whether the object is byte-for-byte the attempted approval.
 */
async function reconcileApprovalWrite(
  expectation: ApprovalObjectExpectation,
  s3: RestoreDrillCleanupApprovalS3Port,
): Promise<boolean> {
  let output: RestoreDrillCleanupApprovalS3GetOutput
  try {
    output = await s3.getApproval(new GetObjectCommand({
      Bucket: expectation.bucketName,
      ChecksumMode: 'ENABLED',
      ExpectedBucketOwner: expectation.expectedBucketOwner,
      Key: expectation.objectKey,
    }))
  } catch {
    return false
  }
  if (
    output.Body === undefined ||
    output.ChecksumSHA256 !== expectation.checksumSha256 ||
    output.ContentLength !== expectation.body.byteLength ||
    output.ContentType !== APPROVAL_CONTENT_TYPE ||
    !hasRequiredApprovalObjectLock(
      output,
      expectation.minimumRetainUntilMilliseconds,
    ) ||
    output.ServerSideEncryption !== 'aws:kms' ||
    output.SSEKMSKeyId !== expectation.kmsKeyArn
  ) {
    return false
  }
  let actualBody: Uint8Array
  try {
    actualBody = await output.Body.transformToByteArray()
  } catch {
    return false
  }
  if (
    actualBody.byteLength > APPROVAL_MAXIMUM_BYTES ||
    actualBody.byteLength !== expectation.body.byteLength
  ) {
    actualBody.fill(0)
    return false
  }
  const equal = Buffer.from(actualBody).equals(Buffer.from(expectation.body))
  actualBody.fill(0)
  return equal
}

/** Effective Object Lock fields shared by PutObject and GetObject responses. */
type ApprovalObjectLockObservation = {
  /** Effective S3 Object Lock retention mode. */
  readonly ObjectLockMode?: string
  /** Effective S3 Object Lock retention deadline. */
  readonly ObjectLockRetainUntilDate?: Date
}

/**
 * Checks that S3 applied the required compliance retention interval.
 *
 * @param output - PutObject or GetObject lock metadata.
 * @param minimumRetainUntilMilliseconds - Earliest accepted retention deadline.
 * @returns Whether effective retention is COMPLIANCE for the full interval.
 */
function hasRequiredApprovalObjectLock(
  output: ApprovalObjectLockObservation,
  minimumRetainUntilMilliseconds: number,
): boolean {
  const retainUntil = output.ObjectLockRetainUntilDate
  return output.ObjectLockMode === 'COMPLIANCE' &&
    retainUntil instanceof Date &&
    Number.isFinite(retainUntil.getTime()) &&
    retainUntil.getTime() >= minimumRetainUntilMilliseconds
}

/**
 * Serializes a receipt with fixed lexicographic keys and no surrounding whitespace.
 *
 * @param receipt - Strict authenticated receipt.
 * @returns Detached canonical UTF-8 bytes.
 */
function serializeApprovalReceipt(
  receipt: RestoreDrillCleanupApprovalReceipt,
): Uint8Array {
  const bytes = Buffer.from(JSON.stringify({
    algorithm: receipt.algorithm,
    approvalMac: receipt.approvalMac,
    approvedAt: receipt.approvedAt,
    approver: receipt.approver,
    changeLocator: receipt.changeLocator,
    drillId: receipt.drillId,
    expiresAt: receipt.expiresAt,
    keyFingerprint: receipt.keyFingerprint,
    kind: receipt.kind,
    policyVersion: receipt.policyVersion,
    receiptVersion: receipt.receiptVersion,
    resourceDigest: receipt.resourceDigest,
    resultDigest: receipt.resultDigest,
  }), 'utf8')
  if (bytes.byteLength === 0 || bytes.byteLength > APPROVAL_MAXIMUM_BYTES) {
    bytes.fill(0)
    throw new RestoreDrillCleanupApprovalCliFailure('APPROVAL_BINDING_INVALID', 1)
  }
  return bytes
}

/**
 * Creates the safe content-addressed cleanup workflow input locator.
 *
 * @param receipt - Strict authenticated receipt.
 * @returns Approval object key unique to this receipt MAC.
 */
function createApprovalObjectKey(
  receipt: RestoreDrillCleanupApprovalReceipt,
): string {
  return `approvals/v1/runs/${receipt.drillId}/${receipt.approvalMac}.json`
}

/**
 * Strictly parses an exact terminal run item.
 *
 * @param value - Untrusted DynamoDB item.
 * @param configuration - Expected drill and Region bindings.
 * @returns Validated approvable run.
 */
function parseApprovableRun(
  value: unknown,
  configuration: RestoreDrillCleanupApprovalCliArguments,
): ApprovableRestoreDrillRun {
  const item = readRunRecord(value)
  const scopeKey = readStringAttribute(item.scopeKey)
  const recordKey = readStringAttribute(item.recordKey)
  const kind = readStringAttribute(item.kind)
  const runVersion = readPositiveIntegerAttribute(item.runVersion)
  const drillId = readStringAttribute(item.drillId)
  const revision = readPositiveIntegerAttribute(item.revision)
  const phase = readStringAttribute(item.phase)
  const outcome = readStringAttribute(item.outcome)
  if (
    scopeKey !== createRunScopeKey(configuration.drillId) ||
    recordKey !== RUN_RECORD_KEY ||
    kind !== 'mukuroji-restore-drill-run' ||
    runVersion !== 1 ||
    drillId !== configuration.drillId
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  if (
    (phase !== 'awaiting-cleanup-approval' && phase !== 'cleaning-up') ||
    outcome !== 'in-progress'
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_NOT_APPROVABLE', 1)
  }
  requireExactRunVariant(item, phase)

  const cleanupPolicyVersion = readStringAttribute(item.cleanupPolicyVersion)
  const resultOutcome = readStringAttribute(item.resultOutcome)
  const failureCodes = readFailureCodeListAttribute(item.failureCodes)
  if (
    cleanupPolicyVersion !== CLEANUP_POLICY_VERSION ||
    (resultOutcome !== 'pass' && resultOutcome !== 'fail') ||
    (resultOutcome === 'pass') !== (failureCodes.length === 0)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }

  const startedAt = readTimestampAttribute(item.startedAt)
  const deadlineAt = readTimestampAttribute(item.deadlineAt)
  const updatedAt = readTimestampAttribute(item.updatedAt)
  const restorePoint = item.restorePoint === undefined
    ? undefined
    : readTimestampAttribute(item.restorePoint)
  const verificationCompletedAt = readTimestampAttribute(item.verificationCompletedAt)
  if (
    Date.parse(deadlineAt) !== Date.parse(startedAt) + 14_400_000 ||
    (restorePoint !== undefined && Date.parse(restorePoint) > Date.parse(startedAt)) ||
    Date.parse(verificationCompletedAt) < Date.parse(startedAt) ||
    Date.parse(updatedAt) < Date.parse(verificationCompletedAt) ||
    (restorePoint === undefined && resultOutcome !== 'fail')
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }

  const resultEvidenceKey = readStringAttribute(item.resultEvidenceKey)
  if (resultEvidenceKey !== `evidence/v1/runs/${configuration.drillId}/result.json`) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }

  const digestKeyEnvelope = parseDigestKeyEnvelope(
    item.digestKeyEnvelope,
    configuration.region,
  )
  const base: ApprovableRestoreDrillRunBase = {
    cleanupPolicyVersion: CLEANUP_POLICY_VERSION,
    deadlineAt,
    digestKeyEnvelope,
    drillId,
    failureCodes,
    outcome: 'in-progress',
    revision,
    resourceDigest: readDigestAttribute(item.resourceDigest),
    ...(restorePoint === undefined ? {} : { restorePoint }),
    resultDigest: readDigestAttribute(item.resultDigest),
    resultEvidenceKey,
    resultOutcome,
    startedAt,
    updatedAt,
    verificationCompletedAt,
  }
  if (phase === 'awaiting-cleanup-approval') {
    return { ...base, phase: 'awaiting-cleanup-approval' }
  }

  return {
    ...base,
    ...parseCleanupReapprovalBinding(
      item,
      configuration,
      digestKeyEnvelope,
      verificationCompletedAt,
      updatedAt,
    ),
    phase: 'cleaning-up',
  }
}

/**
 * Reads one untrusted low-level RUN record before phase-specific key checking.
 *
 * @param value - Untrusted DynamoDB run item.
 * @returns Non-array record for strict attribute parsing.
 */
function readRunRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return value
}

/**
 * Requires the exact projected field set for an initial or replacement approval.
 *
 * @param item - Low-level DynamoDB RUN record.
 * @param phase - Already narrowed approvable phase.
 */
function requireExactRunVariant(
  item: Readonly<Record<string, unknown>>,
  phase: 'awaiting-cleanup-approval' | 'cleaning-up',
): void {
  const keys = Object.keys(item)
  const primaryKeys = phase === 'cleaning-up' ? cleaningRunItemKeys : runItemKeys
  const fallbackKeys = phase === 'cleaning-up'
    ? fallbackCleaningRunItemKeys
    : fallbackRunItemKeys
  if (!hasExactKeys(keys, primaryKeys) && !hasExactKeys(keys, fallbackKeys)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
}

/**
 * Strictly parses the complete cleanup binding persisted by the orchestrator.
 *
 * @param item - Exact cleaning-up RUN record.
 * @param configuration - Expected drill, Region, account, and partition bindings.
 * @param digestKeyEnvelope - Strict envelope owning the expected AWS identity.
 * @param verificationCompletedAt - Canonical terminal verification time.
 * @param updatedAt - Canonical durable update time.
 * @returns Complete prior cleanup binding and derived state machine ARN.
 */
function parseCleanupReapprovalBinding(
  item: Readonly<Record<string, unknown>>,
  configuration: RestoreDrillCleanupApprovalCliArguments,
  digestKeyEnvelope: RestoreDrillDigestKeyEnvelope,
  verificationCompletedAt: string,
  updatedAt: string,
): RestoreDrillCleanupReapprovalBinding {
  const approvalDigest = readDigestAttribute(item.approvalDigest)
  const approvalObjectKey = readStringAttribute(item.approvalObjectKey)
  const approvedAt = readTimestampAttribute(item.approvedAt)
  const cleanupAttemptCount = readPositiveIntegerAttribute(item.cleanupAttemptCount)
  const cleanupExecutionArn = readStringAttribute(item.cleanupExecutionArn)
  const cleanupExecutionName = readStringAttribute(item.cleanupExecutionName)
  const cleanupStartedAt = readTimestampAttribute(item.cleanupStartedAt)
  const objectKeyPrefix = `approvals/v1/runs/${configuration.drillId}/`
  const approvalMac =
    approvalObjectKey.startsWith(objectKeyPrefix) &&
      approvalObjectKey.endsWith('.json')
      ? approvalObjectKey.slice(objectKeyPrefix.length, -'.json'.length)
      : ''
  const expectedExecutionName = `restore-cleanup-${approvalMac}`
  if (
    !/^[0-9a-f]{64}$/u.test(approvalMac) ||
    cleanupExecutionName !== expectedExecutionName ||
    Date.parse(approvedAt) < Date.parse(verificationCompletedAt) ||
    Date.parse(cleanupStartedAt) < Date.parse(verificationCompletedAt) ||
    Date.parse(updatedAt) < Date.parse(approvedAt) ||
    Date.parse(updatedAt) < Date.parse(cleanupStartedAt) ||
    (cleanupAttemptCount === 1 &&
      Date.parse(approvedAt) > Date.parse(cleanupStartedAt)) ||
    (cleanupAttemptCount > 1 &&
      Date.parse(approvedAt) < Date.parse(cleanupStartedAt))
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }

  const cleanupStateMachineArn = parseCleanupExecutionArn(
    cleanupExecutionArn,
    cleanupExecutionName,
    digestKeyEnvelope.kmsKeyArn,
    configuration.region,
  )
  return {
    approvalDigest,
    approvalObjectKey,
    approvedAt,
    cleanupAttemptCount,
    cleanupExecutionArn,
    cleanupExecutionName,
    cleanupStartedAt,
    cleanupStateMachineArn,
  }
}

/**
 * Validates an exact Standard execution ARN against the persisted AWS identity.
 *
 * @param value - Candidate cleanup execution ARN.
 * @param executionName - Exact receipt-bound execution name.
 * @param kmsKeyArn - Persisted KMS key establishing partition and account.
 * @param expectedRegion - Explicit CLI Region.
 * @returns Exact state machine ARN derived from the validated execution ARN.
 */
function parseCleanupExecutionArn(
  value: string,
  executionName: string,
  kmsKeyArn: string,
  expectedRegion: string,
): string {
  const parts = value.split(':')
  const partition = parts[1]
  const service = parts[2]
  const region = parts[3]
  const accountId = parts[4]
  const resourceType = parts[5]
  const stateMachineName = parts[6]
  const actualExecutionName = parts[7]
  const kmsIdentity = parseKmsKeyArn(kmsKeyArn, expectedRegion, 'RUN_INVALID')
  const expectedPartition = resolveRestoreDrillCleanupApprovalPartition(expectedRegion)
  if (
    parts.length !== 8 ||
    parts[0] !== 'arn' ||
    expectedPartition === undefined ||
    partition !== expectedPartition ||
    partition !== kmsIdentity.partition ||
    service !== 'states' ||
    region !== expectedRegion ||
    accountId !== kmsIdentity.accountId ||
    resourceType !== 'execution' ||
    stateMachineName === undefined ||
    !/^[A-Za-z0-9_-]{1,80}$/u.test(stateMachineName) ||
    actualExecutionName !== executionName
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return `arn:${partition}:states:${region}:${accountId}:stateMachine:${stateMachineName}`
}

/**
 * Strictly parses one nested digest key envelope.
 *
 * @param value - Untrusted DynamoDB map attribute.
 * @param expectedRegion - Explicit CLI Region.
 * @returns Validated ciphertext-only envelope.
 */
function parseDigestKeyEnvelope(
  value: unknown,
  expectedRegion: string,
): RestoreDrillDigestKeyEnvelope {
  const map = readMapAttribute(value)
  const record = readExactRecord(map, digestKeyEnvelopeKeys, 'RUN_INVALID')
  const kind = readStringAttribute(record.kind)
  const kmsKeyArn = readStringAttribute(record.kmsKeyArn)
  const ciphertextBase64 = readStringAttribute(record.ciphertextBase64)
  parseKmsKeyArn(kmsKeyArn, expectedRegion, 'RUN_INVALID')
  if (
    kind !== 'restore-drill-digest-key' ||
    ciphertextBase64.length === 0 ||
    ciphertextBase64.length > 16_384 ||
    !isCanonicalBase64(ciphertextBase64)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return {
    ciphertextBase64,
    kind: 'restore-drill-digest-key',
    kmsKeyArn,
  }
}

/**
 * Parses a unique strict flag/value sequence.
 *
 * @param arguments_ - Untrusted CLI arguments.
 * @returns Unique allowlisted flag map.
 */
function parseFlagPairs(arguments_: readonly string[]): ReadonlyMap<string, string> {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw invalidUsage()
  }
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !flagNames.has(name) ||
      flags.has(name) ||
      value.startsWith('--') ||
      value.length === 0
    ) {
      throw invalidUsage()
    }
    flags.set(name, value)
  }
  return flags
}

/**
 * Reads a required allowlisted flag.
 *
 * @param flags - Strict flag map.
 * @param name - Required flag name.
 * @returns Non-empty flag value.
 */
function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined) throw invalidUsage()
  return value
}

/**
 * Reads a bounded printable flag.
 *
 * @param flags - Strict flag map.
 * @param name - Required flag name.
 * @param maximumLength - Maximum accepted UTF-16 length.
 * @returns Trimmed control-free value.
 */
function requireBoundedPrintableFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  maximumLength: number,
): string {
  return validateBoundedPrintableValue(requireFlag(flags, name), maximumLength)
}

/**
 * Validates one bounded printable operator value.
 *
 * @param value - Untrusted value.
 * @param maximumLength - Maximum accepted UTF-16 length.
 * @returns Validated value.
 */
function validateBoundedPrintableValue(value: string, maximumLength: number): string {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads a conventional explicit AWS Region.
 *
 * @param flags - Strict flag map.
 * @returns Validated Region.
 */
function requireRegion(flags: ReadonlyMap<string, string>): string {
  const region = requireBoundedPrintableFlag(flags, '--region', 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(region)) throw invalidUsage()
  return region
}

/**
 * Reads an explicit general-purpose S3 evidence bucket name.
 *
 * @param flags - Strict flag map.
 * @param name - Bucket-name flag.
 * @returns Validated DNS-compatible bucket name.
 */
function requireBucketName(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const bucketName = requireBoundedPrintableFlag(flags, name, 63)
  if (
    bucketName.length < 3 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucketName) ||
    bucketName.includes('..') ||
    bucketName.includes('.-') ||
    bucketName.includes('-.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucketName) ||
    bucketName.startsWith('xn--') ||
    bucketName.startsWith('sthree-') ||
    bucketName.startsWith('amzn-s3-demo-') ||
    bucketName.endsWith('-s3alias') ||
    bucketName.endsWith('--ol-s3') ||
    bucketName.endsWith('.mrap') ||
    bucketName.endsWith('--x-s3') ||
    bucketName.endsWith('--table-s3')
  ) {
    throw invalidUsage()
  }
  return bucketName
}

/**
 * Reads an explicit physical DynamoDB table name.
 *
 * @param flags - Strict flag map.
 * @param name - Table-name flag.
 * @returns Validated table name.
 */
function requireTableName(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const tableName = requireBoundedPrintableFlag(flags, name, 255)
  if (tableName.length < 3 || !/^[A-Za-z0-9_.-]+$/u.test(tableName)) {
    throw invalidUsage()
  }
  return tableName
}

/**
 * Reads the canonical drill identifier format used by isolated resources.
 *
 * @param flags - Strict flag map.
 * @returns Validated drill identifier.
 */
function requireDrillId(flags: ReadonlyMap<string, string>): string {
  const drillId = requireFlag(flags, '--drill-id')
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(drillId)) throw invalidUsage()
  return drillId
}

/**
 * Reads a syntactically valid IAM or STS caller ARN.
 *
 * @param flags - Strict flag map.
 * @returns Validated expected caller ARN.
 */
function requireApprover(flags: ReadonlyMap<string, string>): string {
  const approver = requireBoundedPrintableFlag(flags, '--approver', 256)
  parseCallerArn(approver, 'INVALID_USAGE')
  return approver
}

/**
 * Reads one canonical millisecond-precision UTC timestamp flag.
 *
 * @param flags - Strict flag map.
 * @param name - Timestamp flag name.
 * @returns Canonical UTC timestamp.
 */
function requireCanonicalTimestamp(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = requireFlag(flags, name)
  if (!isCanonicalTimestamp(value)) throw invalidUsage()
  return value
}

/**
 * Reads and canonicalizes the injected approval clock.
 *
 * @param value - Injected clock value.
 * @returns Canonical UTC timestamp.
 */
function readDecisionTime(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new RestoreDrillCleanupApprovalCliFailure('APPROVAL_WINDOW_INVALID', 1)
  }
  return value.toISOString()
}

/**
 * Reads a strict DynamoDB string attribute.
 *
 * @param value - Untrusted attribute value.
 * @returns String payload.
 */
function readStringAttribute(value: unknown): string {
  const record = readExactRecord(value, new Set(['S']), 'RUN_INVALID')
  if (typeof record.S !== 'string') {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return record.S
}

/**
 * Reads a strict DynamoDB map attribute.
 *
 * @param value - Untrusted attribute value.
 * @returns Nested attribute map.
 */
function readMapAttribute(value: unknown): Readonly<Record<string, unknown>> {
  const record = readExactRecord(value, new Set(['M']), 'RUN_INVALID')
  if (!isRecord(record.M)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return record.M
}

/**
 * Reads a positive safe integer DynamoDB number attribute.
 *
 * @param value - Untrusted attribute value.
 * @returns Positive safe integer.
 */
function readPositiveIntegerAttribute(value: unknown): number {
  const record = readExactRecord(value, new Set(['N']), 'RUN_INVALID')
  if (typeof record.N !== 'string' || !/^[1-9]\d*$/u.test(record.N)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  const parsed = Number(record.N)
  if (!Number.isSafeInteger(parsed)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return parsed
}

/**
 * Reads a canonical timestamp string attribute.
 *
 * @param value - Untrusted attribute value.
 * @returns Canonical UTC timestamp.
 */
function readTimestampAttribute(value: unknown): string {
  const timestamp = readStringAttribute(value)
  if (!isCanonicalTimestamp(timestamp)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return timestamp
}

/**
 * Reads a lowercase SHA-256 hexadecimal string attribute.
 *
 * @param value - Untrusted attribute value.
 * @returns Validated digest.
 */
function readDigestAttribute(value: unknown): string {
  const digest = readStringAttribute(value)
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  return digest
}

/**
 * Reads a sorted unique DynamoDB list of stable failure-code strings.
 *
 * @param value - Untrusted list attribute.
 * @returns Validated stable failure categories.
 */
function readFailureCodeListAttribute(value: unknown): readonly RestoreDrillFailureCode[] {
  const record = readExactRecord(value, new Set(['L']), 'RUN_INVALID')
  if (!Array.isArray(record.L)) {
    throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
  const failureCodes: RestoreDrillFailureCode[] = []
  let previous: string | undefined
  for (const attribute of record.L) {
    const code = readStringAttribute(attribute)
    if (!knownFailureCodes.has(code) || (previous !== undefined && previous >= code)) {
      throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
    }
    failureCodes.push(readKnownFailureCode(code))
    previous = code
  }
  return failureCodes
}

/**
 * Narrows a value already checked against the complete runtime allowlist.
 *
 * @param value - Known stable failure code.
 * @returns Narrow failure-code value.
 */
function readKnownFailureCode(value: string): RestoreDrillFailureCode {
  switch (value) {
    case 'AGGREGATE_CONTENT_MISMATCH':
    case 'AGGREGATE_DESCRIPTOR_MISMATCH':
    case 'AGGREGATE_INVALID':
    case 'AGGREGATE_KEY_MISMATCH':
    case 'AGGREGATE_METADATA_MISMATCH':
    case 'AGGREGATE_PARTITION_COUNT_MISMATCH':
    case 'AGGREGATE_RECORD_COUNT_MISMATCH':
    case 'AGGREGATE_RESOURCE_MISMATCH':
    case 'AGGREGATE_RESTORE_POINT_MISMATCH':
    case 'AGGREGATE_ROLE_MISMATCH':
    case 'APPROVAL_APPROVER_UNAUTHORIZED':
    case 'APPROVAL_AUTHENTICATION_FAILED':
    case 'APPROVAL_CHANGE_MISMATCH':
    case 'APPROVAL_DRILL_MISMATCH':
    case 'APPROVAL_EXPIRED':
    case 'APPROVAL_NOT_YET_VALID':
    case 'APPROVAL_POLICY_MISMATCH':
    case 'APPROVAL_RECEIPT_INVALID':
    case 'APPROVAL_RESOURCE_MISMATCH':
    case 'APPROVAL_RESULT_MISMATCH':
    case 'CADENCE_OVERDUE':
    case 'CLEANUP_CONTEXT_INVALID':
    case 'CLEANUP_FAILED':
    case 'CROSS_DOMAIN_INTEGRITY_FAILED':
    case 'DIGEST_DOMAIN_INVALID':
    case 'DIGEST_KEY_INVALID':
    case 'DYNAMODB_RESTORE_FAILED':
    case 'EVIDENCE_INVALID':
    case 'EVIDENCE_PERSIST_FAILED':
    case 'OBJECTIVE_TIMELINE_INVALID':
    case 'PITR_WINDOW_INVALID':
    case 'PITR_WINDOW_NO_OVERLAP':
    case 'PITR_WINDOW_TARGET_MISMATCH':
    case 'RESOURCE_IDENTITY_INVALID':
    case 'RPO_TARGET_MISSED':
    case 'RTO_TARGET_MISSED':
    case 'RUN_STATE_INVALID':
    case 'S3_VERSION_RESTORE_FAILED':
    case 'WORKFLOW_POLL_BUDGET_EXCEEDED':
    case 'WORKFLOW_TASK_FAILED':
      return value
    default:
      throw new RestoreDrillCleanupApprovalCliFailure('RUN_INVALID', 1)
  }
}

/**
 * Checks a record key vector against one exact expected set.
 *
 * @param keys - Actual record keys.
 * @param expectedKeys - Complete expected key set.
 * @returns Whether no key is missing or extra.
 */
function hasExactKeys(
  keys: readonly string[],
  expectedKeys: ReadonlySet<string>,
): boolean {
  return keys.length === expectedKeys.size && keys.every((key) => expectedKeys.has(key))
}

/**
 * Requires a record to have exactly the provided keys.
 *
 * @param value - Untrusted record.
 * @param expectedKeys - Complete exact key set.
 * @param failureCode - Stable failure raised for mismatches.
 * @returns Validated record.
 */
function readExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
  failureCode: RestoreDrillCleanupApprovalCliFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new RestoreDrillCleanupApprovalCliFailure(failureCode, failureCode === 'INVALID_USAGE' ? 2 : 1)
  }
  const keys = Object.keys(value)
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new RestoreDrillCleanupApprovalCliFailure(failureCode, failureCode === 'INVALID_USAGE' ? 2 : 1)
  }
  return value
}

/**
 * Parses and validates an IAM or STS caller ARN.
 *
 * @param value - Candidate caller ARN.
 * @param failureCode - Stable failure category.
 * @returns Parsed caller identity.
 */
function parseCallerArn(
  value: string,
  failureCode: 'CALLER_IDENTITY_INVALID' | 'INVALID_USAGE',
): AwsArnIdentity {
  const identity = parseAwsArn(value, failureCode)
  if (
    (identity.service !== 'iam' && identity.service !== 'sts') ||
    !callerResourcePattern.test(identity.resource)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(
      failureCode,
      failureCode === 'INVALID_USAGE' ? 2 : 1,
    )
  }
  return identity
}

/**
 * Parses and validates one regional KMS key ARN.
 *
 * @param value - Candidate KMS key ARN.
 * @param expectedRegion - Exact CLI Region.
 * @param failureCode - Stable failure category.
 * @returns Parsed KMS key identity.
 */
function parseKmsKeyArn(
  value: string,
  expectedRegion: string,
  failureCode: 'RUN_INVALID',
): AwsArnIdentity {
  const identity = parseAwsArn(value, failureCode)
  const parts = value.split(':')
  const region = parts[3]
  const partition = resolveRestoreDrillCleanupApprovalPartition(expectedRegion)
  if (
    partition === undefined ||
    identity.partition !== partition ||
    identity.service !== 'kms' ||
    region !== expectedRegion ||
    !/^key\/[A-Za-z0-9-]{1,256}$/u.test(identity.resource)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(failureCode, 1)
  }
  return identity
}

/**
 * Resolves the supported AWS ARN partition for one canonical Region.
 *
 * @param region - Candidate explicit CLI Region.
 * @returns Canonical partition, or undefined for malformed and unsupported Regions.
 */
function resolveRestoreDrillCleanupApprovalPartition(
  region: string,
): RestoreDrillCleanupApprovalAwsPartition | undefined {
  if (/^us-gov-[a-z]+-\d$/u.test(region)) return 'aws-us-gov'
  if (/^cn-[a-z]+-\d$/u.test(region)) return 'aws-cn'
  if (/^[a-z]{2}-[a-z]+-\d$/u.test(region)) return 'aws'
  return undefined
}

/**
 * Parses the common account-bound AWS ARN fields.
 *
 * @param value - Candidate ARN.
 * @param failureCode - Stable failure category.
 * @returns Parsed account-bound identity.
 */
function parseAwsArn(
  value: string,
  failureCode: 'CALLER_IDENTITY_INVALID' | 'INVALID_USAGE' | 'RUN_INVALID',
): AwsArnIdentity {
  const parts = value.split(':')
  const partition = parts[1]
  const service = parts[2]
  const accountId = parts[4]
  const resource = parts.slice(5).join(':')
  const exitCode = failureCode === 'INVALID_USAGE' ? 2 : 1
  if (
    parts.length < 6 ||
    parts[0] !== 'arn' ||
    partition === undefined ||
    service === undefined ||
    accountId === undefined ||
    partition.length === 0 ||
    !/^[a-z0-9-]+$/u.test(partition) ||
    !/^[a-z0-9-]+$/u.test(service) ||
    !/^\d{12}$/u.test(accountId) ||
    resource.length === 0 ||
    containsControlCharacter(resource)
  ) {
    throw new RestoreDrillCleanupApprovalCliFailure(failureCode, exitCode)
  }
  return { accountId, partition, resource, service }
}

/**
 * Creates the exact KMS encryption context used by the restore-drill runner.
 *
 * @param drillId - Stable drill identifier.
 * @returns Exact purpose and drill digest context.
 */
function createDigestKeyEncryptionContext(drillId: string): Record<string, string> {
  return {
    purpose: 'restore-drill-evidence-digest-v1',
    drillIdDigest: createHash('sha256')
      .update(`digest-key\u0000${drillId}`, 'utf8')
      .digest('hex'),
  }
}

/**
 * Creates the exact run partition key.
 *
 * @param drillId - Validated drill identifier.
 * @returns Durable run partition key.
 */
function createRunScopeKey(drillId: string): string {
  return `RESTORE_DRILL#${drillId}`
}

/**
 * Checks one canonical millisecond-precision UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Whether parsing round-trips exactly through Date.toISOString.
 */
function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

/**
 * Checks one canonical padded Base64 payload.
 *
 * @param value - Candidate Base64 value.
 * @returns Whether the value decodes and re-encodes exactly.
 */
function isCanonicalBase64(value: string): boolean {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * Checks for C0 or delete control characters.
 *
 * @param value - Candidate operator value.
 * @returns Whether the value contains a terminal control character.
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
 * Recognizes S3's exclusive-write precondition failure without exposing details.
 *
 * @param error - Unknown caught failure.
 * @returns Whether S3 reported that the key already had a current object.
 */
function isS3PreconditionFailure(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.name === 'PreconditionFailed') return true
  const metadata = error.$metadata
  return isRecord(metadata) && metadata.httpStatusCode === 412
}

/**
 * Checks whether an unknown value is a non-array object record.
 *
 * @param value - Unknown value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the standard strict-usage failure.
 *
 * @returns Invalid-usage failure with exit status two.
 */
function invalidUsage(): RestoreDrillCleanupApprovalCliFailure {
  return new RestoreDrillCleanupApprovalCliFailure('INVALID_USAGE', 2)
}

/**
 * Converts unknown failures into a stable raw-data-free result.
 *
 * @param error - Unknown caught failure.
 * @returns Stable cleanup-approval CLI failure.
 */
function classifyCliFailure(error: unknown): RestoreDrillCleanupApprovalCliFailure {
  if (error instanceof RestoreDrillCleanupApprovalCliFailure) return error
  return new RestoreDrillCleanupApprovalCliFailure('UNEXPECTED_FAILURE', 1)
}

/**
 * Writes one compact deterministic JSON line.
 *
 * @param writer - Injectable console writer.
 * @param value - Raw-data-free payload.
 */
function writeJsonLine(writer: (line: string) => void, value: unknown): void {
  writer(JSON.stringify(value))
}

if (import.meta.main) {
  void runRestoreDrillCleanupApprovalCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = 1
  })
}
