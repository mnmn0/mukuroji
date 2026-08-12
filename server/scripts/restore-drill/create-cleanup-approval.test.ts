import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  GetItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  DecryptCommand,
  type DecryptCommandOutput,
} from '@aws-sdk/client-kms'
import {
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import {
  DescribeExecutionCommand,
  type DescribeExecutionCommandOutput,
} from '@aws-sdk/client-sfn'
import {
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  createRestoreDrillCleanupApproval,
  parseRestoreDrillCleanupApprovalCliArguments,
  RestoreDrillCleanupApprovalCliFailure,
  runRestoreDrillCleanupApprovalCli,
  type RestoreDrillCleanupApprovalAwsSession,
  type RestoreDrillCleanupApprovalCliArguments,
  type RestoreDrillCleanupApprovalCliDependencies,
  type RestoreDrillCleanupApprovalCliFailureCode,
  type RestoreDrillCleanupApprovalS3GetOutput,
  type RestoreDrillCleanupApprovalS3PutOutput,
} from './create-cleanup-approval'

const REGION = 'ap-northeast-1'
const STATE_TABLE_NAME = 'mukuroji-restore-drill-state'
const APPROVAL_BUCKET_NAME = 'mukuroji-restore-drill-evidence-123456789012'
const DRILL_ID = 'drill-20260801-0001'
const ACCOUNT_ID = '123456789012'
const APPROVER =
  `arn:aws:sts::${ACCOUNT_ID}:assumed-role/RestoreDrillCleanupApprover/operator-session`
const KMS_KEY_ARN =
  `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/12345678-1234-1234-1234-123456789012`
const CHANGE_LOCATOR = 'https://github.com/mnmn0/mukuroji/issues/159#cleanup-approval'
const APPROVED_AT = '2026-08-01T00:36:00.000Z'
const EXPIRES_AT = '2026-08-01T01:00:00.000Z'
const DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const CIPHERTEXT_BASE64 = Buffer.from('kms-ciphertext').toString('base64')
const RESOURCE_DIGEST = 'a'.repeat(64)
const RESULT_DIGEST = 'b'.repeat(64)
const RESULT_EVIDENCE_KEY = `evidence/v1/runs/${DRILL_ID}/result.json`
const PRIOR_APPROVAL_MAC = 'c'.repeat(64)
const PRIOR_APPROVAL_DIGEST = 'd'.repeat(64)
const PRIOR_APPROVED_AT = '2026-08-01T00:11:00.000Z'
const CLEANUP_STARTED_AT = '2026-08-01T00:12:00.000Z'
const PRIOR_EXECUTION_STOPPED_AT = '2026-08-01T00:20:00.000Z'
const CLEANUP_EXECUTION_NAME = `restore-cleanup-${PRIOR_APPROVAL_MAC}`
const CLEANUP_STATE_MACHINE_ARN =
  `arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:mukuroji-restore-drill-cleanup`
const CLEANUP_EXECUTION_ARN =
  `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:mukuroji-restore-drill-cleanup:${CLEANUP_EXECUTION_NAME}`
const SECOND_APPROVAL_MAC = 'e'.repeat(64)
const SECOND_CLEANUP_EXECUTION_NAME = `restore-cleanup-${SECOND_APPROVAL_MAC}`
const SECOND_CLEANUP_EXECUTION_ARN =
  `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:mukuroji-restore-drill-cleanup:${SECOND_CLEANUP_EXECUTION_NAME}`
const APPROVAL_RETENTION_MILLISECONDS = 400 * 24 * 60 * 60 * 1_000
const MINIMUM_RETAIN_UNTIL_DATE = new Date(
  Date.parse(APPROVED_AT) + APPROVAL_RETENTION_MILLISECONDS,
)

const argumentVector: readonly string[] = [
  '--region',
  REGION,
  '--profile',
  'restore-drill-approver',
  '--state-table-name',
  STATE_TABLE_NAME,
  '--approval-bucket-name',
  APPROVAL_BUCKET_NAME,
  '--drill-id',
  DRILL_ID,
  '--approver',
  APPROVER,
  '--change-locator',
  CHANGE_LOCATOR,
  '--expires-at',
  EXPIRES_AT,
]

/** Failures and responses installed on one recording AWS session. */
type RecordingSessionOptions = {
  /** Optional session close failure. */
  readonly closeFailure?: unknown
  /** Optional Step Functions execution read failure. */
  readonly describeFailure?: unknown
  /** Optional Step Functions execution response override. */
  readonly describeOutput?: DescribeExecutionCommandOutput
  /** Optional KMS failure. */
  readonly decryptFailure?: unknown
  /** Optional KMS response override. */
  readonly decryptOutput?: DecryptCommandOutput
  /** Optional caller identity failure. */
  readonly identityFailure?: unknown
  /** Optional caller identity response override. */
  readonly identityOutput?: GetCallerIdentityCommandOutput
  /** Optional approval reconciliation read failure. */
  readonly getApprovalFailure?: unknown
  /** Optional approval reconciliation read response override. */
  readonly getApprovalOutput?: RestoreDrillCleanupApprovalS3GetOutput
  /** Optional approval reconciliation response derived from the attempted write. */
  readonly getApprovalOutputFactory?: (
    command: PutObjectCommand,
  ) => RestoreDrillCleanupApprovalS3GetOutput
  /** Optional approval write failure. */
  readonly putFailure?: unknown
  /** Optional approval write response override. */
  readonly putOutput?: RestoreDrillCleanupApprovalS3PutOutput
  /** Optional run read failure. */
  readonly readFailure?: unknown
  /** Optional run read response override. */
  readonly runOutput?: GetItemCommandOutput
}

/** Narrow in-memory AWS session that records all externally visible commands. */
class RecordingSession implements RestoreDrillCleanupApprovalAwsSession {
  /** Ordered operation names. */
  readonly events: string[] = []

  /** Recorded KMS commands. */
  readonly decryptCommands: DecryptCommand[] = []

  /** Recorded Step Functions execution reads. */
  readonly describeCommands: DescribeExecutionCommand[] = []

  /** Recorded DynamoDB run reads. */
  readonly getCommands: GetItemCommand[] = []

  /** Recorded S3 approval reconciliation reads. */
  readonly getApprovalCommands: GetObjectCommand[] = []

  /** Recorded STS identity reads. */
  readonly identityCommands: GetCallerIdentityCommand[] = []

  /** Recorded S3 approval writes. */
  readonly putCommands: PutObjectCommand[] = []

  /** Number of lifecycle close calls. */
  closeCount = 0

  /** Configured behavior and responses. */
  private readonly options: RecordingSessionOptions

  /**
   * Creates one recording AWS session.
   *
   * @param options - Optional response and failure overrides.
   */
  constructor(options: RecordingSessionOptions = {}) {
    this.options = options
  }

  /** Records session closure and throws the configured failure. */
  close(): void {
    this.closeCount += 1
    this.events.push('close')
    if (this.options.closeFailure !== undefined) {
      throw this.options.closeFailure
    }
  }

  /** Records and resolves one KMS decrypt. */
  async decrypt(command: DecryptCommand): Promise<DecryptCommandOutput> {
    this.events.push('decrypt')
    this.decryptCommands.push(command)
    if (this.options.decryptFailure !== undefined) {
      throw this.options.decryptFailure
    }
    return this.options.decryptOutput ?? createDecryptOutput()
  }

  /** Records and resolves one metadata-only execution read. */
  async describeExecution(
    command: DescribeExecutionCommand,
  ): Promise<DescribeExecutionCommandOutput> {
    this.events.push('describe-execution')
    this.describeCommands.push(command)
    if (this.options.describeFailure !== undefined) {
      throw this.options.describeFailure
    }
    return this.options.describeOutput ?? createDescribeExecutionOutput()
  }

  /** Records and resolves one strongly consistent run read. */
  async getRun(command: GetItemCommand): Promise<GetItemCommandOutput> {
    this.events.push('get-run')
    this.getCommands.push(command)
    if (this.options.readFailure !== undefined) throw this.options.readFailure
    return this.options.runOutput ?? {
      $metadata: {},
      Item: createRunItem(),
    }
  }

  /**
   * Records and resolves one approval reconciliation read.
   *
   * @param command - Exact GetObject command.
   * @returns Configured or attempted-write-derived response.
   */
  async getApproval(
    command: GetObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3GetOutput> {
    this.events.push('get-approval')
    this.getApprovalCommands.push(command)
    if (this.options.getApprovalFailure !== undefined) {
      throw this.options.getApprovalFailure
    }
    if (this.options.getApprovalOutput !== undefined) {
      return this.options.getApprovalOutput
    }
    const attemptedPut = this.putCommands.at(-1)
    if (attemptedPut === undefined) return {}
    if (this.options.getApprovalOutputFactory !== undefined) {
      return this.options.getApprovalOutputFactory(attemptedPut)
    }
    return createGetApprovalOutput(attemptedPut)
  }

  /** Records and resolves one STS caller identity read. */
  async getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    this.events.push('get-caller-identity')
    this.identityCommands.push(command)
    if (this.options.identityFailure !== undefined) {
      throw this.options.identityFailure
    }
    return this.options.identityOutput ?? {
      $metadata: {},
      Account: ACCOUNT_ID,
      Arn: APPROVER,
      UserId: 'ARO123456789EXAMPLE:operator-session',
    }
  }

  /**
   * Records and resolves one conditional approval object write.
   *
   * @param command - Exact PutObject command.
   * @returns Object Lock-bearing response unless a failure was configured.
   */
  async putApproval(
    command: PutObjectCommand,
  ): Promise<RestoreDrillCleanupApprovalS3PutOutput> {
    this.events.push('put-approval')
    this.putCommands.push(command)
    if (this.options.putFailure !== undefined) throw this.options.putFailure
    return this.options.putOutput ?? createPutApprovalOutput()
  }
}

/** Named fake AWS error used to exercise conditional-write classification. */
class NamedAwsFailure extends Error {
  /**
   * Creates one fake AWS exception.
   *
   * @param name - Stable AWS exception name.
   * @param message - Raw canary message that must remain private.
   */
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** Creates the strict parsed CLI configuration used by direct core tests. */
function createConfiguration(): RestoreDrillCleanupApprovalCliArguments {
  return parseRestoreDrillCleanupApprovalCliArguments(argumentVector)
}

/**
 * Creates one exact approvable low-level DynamoDB run item.
 *
 * @param overrides - Exact low-level attributes to replace or append.
 * @returns Complete run item.
 */
function createRunItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return {
    cleanupPolicyVersion: { S: 'restore-drill-cleanup-v1' },
    deadlineAt: { S: '2026-08-01T04:04:00.000Z' },
    digestKeyEnvelope: {
      M: {
        ciphertextBase64: { S: CIPHERTEXT_BASE64 },
        kind: { S: 'restore-drill-digest-key' },
        kmsKeyArn: { S: KMS_KEY_ARN },
      },
    },
    drillId: { S: DRILL_ID },
    failureCodes: { L: [] },
    kind: { S: 'mukuroji-restore-drill-run' },
    outcome: { S: 'in-progress' },
    phase: { S: 'awaiting-cleanup-approval' },
    recordKey: { S: 'RUN' },
    resourceDigest: { S: RESOURCE_DIGEST },
    restorePoint: { S: '2026-08-01T00:00:00.000Z' },
    resultDigest: { S: RESULT_DIGEST },
    resultEvidenceKey: { S: RESULT_EVIDENCE_KEY },
    resultOutcome: { S: 'pass' },
    revision: { N: '12' },
    runVersion: { N: '1' },
    scopeKey: { S: `RESTORE_DRILL#${DRILL_ID}` },
    startedAt: { S: '2026-08-01T00:04:00.000Z' },
    updatedAt: { S: '2026-08-01T00:35:00.000Z' },
    verificationCompletedAt: { S: '2026-08-01T00:34:00.000Z' },
    ...overrides,
  }
}

/**
 * Creates the exact cleaning-up RUN persisted after a prior approval admission.
 *
 * @param overrides - Exact low-level attributes to replace or append.
 * @returns Complete reapproval RUN item.
 */
function createCleaningRunItem(
  overrides: Readonly<Record<string, AttributeValue>> = {},
): Record<string, AttributeValue> {
  return createRunItem({
    approvalDigest: { S: PRIOR_APPROVAL_DIGEST },
    approvalObjectKey: {
      S: `approvals/v1/runs/${DRILL_ID}/${PRIOR_APPROVAL_MAC}.json`,
    },
    approvedAt: { S: PRIOR_APPROVED_AT },
    cleanupAttemptCount: { N: '1' },
    cleanupExecutionArn: { S: CLEANUP_EXECUTION_ARN },
    cleanupExecutionName: { S: CLEANUP_EXECUTION_NAME },
    cleanupStartedAt: { S: CLEANUP_STARTED_AT },
    phase: { S: 'cleaning-up' },
    updatedAt: { S: '2026-08-01T00:35:00.000Z' },
    verificationCompletedAt: { S: '2026-08-01T00:10:00.000Z' },
    ...overrides,
  })
}

/**
 * Creates a valid KMS response over a fresh mutable digest key.
 *
 * @returns Valid decrypt response.
 */
function createDecryptOutput(): DecryptCommandOutput {
  return {
    $metadata: {},
    EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    KeyId: KMS_KEY_ARN,
    Plaintext: DIGEST_KEY.slice(),
  }
}

/**
 * Creates an exact terminal observation for the pinned prior cleanup execution.
 *
 * @param overrides - Step Functions fields to replace for boundary tests.
 * @returns Complete DescribeExecution response.
 */
function createDescribeExecutionOutput(
  overrides: Partial<DescribeExecutionCommandOutput> = {},
): DescribeExecutionCommandOutput {
  return {
    $metadata: {},
    executionArn: CLEANUP_EXECUTION_ARN,
    name: CLEANUP_EXECUTION_NAME,
    startDate: new Date(CLEANUP_STARTED_AT),
    stateMachineArn: CLEANUP_STATE_MACHINE_ARN,
    status: 'FAILED',
    stopDate: new Date(PRIOR_EXECUTION_STOPPED_AT),
    ...overrides,
  }
}

/**
 * Creates a successful S3 write response with exact minimum retention.
 *
 * @param overrides - S3 fields to replace for lock-metadata tests.
 * @returns Object Lock-bearing PutObject response.
 */
function createPutApprovalOutput(
  overrides: Partial<RestoreDrillCleanupApprovalS3PutOutput> = {},
): RestoreDrillCleanupApprovalS3PutOutput {
  return {
    $metadata: {},
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(MINIMUM_RETAIN_UNTIL_DATE),
    ...overrides,
  }
}

/**
 * Creates the exact S3 reconciliation response for one attempted PutObject.
 *
 * @param command - Recorded immutable approval write.
 * @param bodyReplacement - Optional tampered body returned instead.
 * @returns Matching response metadata and a detached body stream facade.
 */
function createGetApprovalOutput(
  command: PutObjectCommand,
  bodyReplacement?: Uint8Array,
): RestoreDrillCleanupApprovalS3GetOutput {
  const attemptedBody = command.input.Body
  if (!(attemptedBody instanceof Uint8Array)) return {}
  const body = bodyReplacement ?? attemptedBody
  return {
    Body: {
      transformToByteArray: async () => body.slice(),
    },
    ChecksumSHA256: command.input.ChecksumSHA256,
    ContentLength: attemptedBody.byteLength,
    ContentType: command.input.ContentType,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(MINIMUM_RETAIN_UNTIL_DATE),
    ServerSideEncryption: command.input.ServerSideEncryption,
    SSEKMSKeyId: command.input.SSEKMSKeyId,
  }
}

/** Creates test CLI dependencies and captures all secret-free output lines. */
function createDependencies(session: RecordingSession): {
  /** Injectable CLI dependencies. */
  readonly dependencies: RestoreDrillCleanupApprovalCliDependencies
  /** Captured stderr lines. */
  readonly errors: string[]
  /** Captured stdout lines. */
  readonly outputs: string[]
} {
  const errors: string[] = []
  const outputs: string[] = []
  return {
    dependencies: {
      createSession: () => session,
      now: () => new Date(APPROVED_AT),
      writeError: (line) => errors.push(line),
      writeOutput: (line) => outputs.push(line),
    },
    errors,
    outputs,
  }
}

/** Expects one promise to reject with a stable CLI failure code. */
async function expectFailureCode(
  promise: Promise<unknown>,
  code: RestoreDrillCleanupApprovalCliFailureCode,
): Promise<void> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RestoreDrillCleanupApprovalCliFailure)
    if (!(error instanceof RestoreDrillCleanupApprovalCliFailure)) {
      throw error
    }
    expect(error.code).toBe(code)
    return
  }
  throw new Error('Expected cleanup approval to fail.')
}

describe('parseRestoreDrillCleanupApprovalCliArguments', () => {
  test('strictly parses required flags and the optional profile', () => {
    expect(parseRestoreDrillCleanupApprovalCliArguments(argumentVector)).toEqual({
      approvalBucketName: APPROVAL_BUCKET_NAME,
      approver: APPROVER,
      changeLocator: CHANGE_LOCATOR,
      drillId: DRILL_ID,
      expiresAt: EXPIRES_AT,
      profile: 'restore-drill-approver',
      region: REGION,
      stateTableName: STATE_TABLE_NAME,
    })

    const withoutProfile = argumentVector.filter((value, index, values) =>
      value !== '--profile' && values[index - 1] !== '--profile')
    expect(parseRestoreDrillCleanupApprovalCliArguments(withoutProfile)).toEqual({
      approvalBucketName: APPROVAL_BUCKET_NAME,
      approver: APPROVER,
      changeLocator: CHANGE_LOCATOR,
      drillId: DRILL_ID,
      expiresAt: EXPIRES_AT,
      region: REGION,
      stateTableName: STATE_TABLE_NAME,
    })
  })

  test.each([
    { arguments_: [...argumentVector, '--unknown', 'value'] },
    { arguments_: [...argumentVector, '--region', REGION] },
    { arguments_: argumentVector.slice(0, -1) },
    {
      arguments_: argumentVector.filter((value, index, values) =>
        value !== '--approval-bucket-name' &&
        values[index - 1] !== '--approval-bucket-name'),
    },
    { arguments_: replaceFlag(argumentVector, '--region', 'AP-NORTHEAST-1') },
    { arguments_: replaceFlag(argumentVector, '--state-table-name', 'x') },
    { arguments_: replaceFlag(argumentVector, '--approval-bucket-name', 'INVALID') },
    { arguments_: replaceFlag(argumentVector, '--drill-id', 'short') },
    {
      arguments_: replaceFlag(
        argumentVector,
        '--approver',
        'arn:aws:iam::123456789012:role/control\n',
      ),
    },
    { arguments_: replaceFlag(argumentVector, '--change-locator', ' trailing ') },
    { arguments_: replaceFlag(argumentVector, '--expires-at', '2026-08-01T01:00:00Z') },
  ])('rejects malformed or ambiguous arguments', ({ arguments_ }) => {
    expect(() => parseRestoreDrillCleanupApprovalCliArguments(arguments_)).toThrow(
      new RestoreDrillCleanupApprovalCliFailure('INVALID_USAGE', 2),
    )
  })

  test('rejects an empty argument vector', () => {
    expect(() => parseRestoreDrillCleanupApprovalCliArguments([])).toThrow(
      new RestoreDrillCleanupApprovalCliFailure('INVALID_USAGE', 2),
    )
  })
})

describe('createRestoreDrillCleanupApproval', () => {
  test('binds the actual caller and exact sealed run into an immutable receipt', async () => {
    const plaintext = DIGEST_KEY.slice()
    const session = new RecordingSession({
      decryptOutput: {
        $metadata: {},
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        KeyId: KMS_KEY_ARN,
        Plaintext: plaintext,
      },
    })

    const result = await createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )

    expect(result).toEqual({
      approvalObjectKey: expect.stringMatching(
        new RegExp(`^approvals/v1/runs/${DRILL_ID}/[0-9a-f]{64}\\.json$`, 'u'),
      ),
      approvedAt: APPROVED_AT,
      cleanupExecutionName: expect.stringMatching(
        /^restore-cleanup-[0-9a-f]{64}$/u,
      ),
      drillId: DRILL_ID,
      expiresAt: EXPIRES_AT,
      policyVersion: 'restore-drill-cleanup-v1',
      resultEvidenceKey: RESULT_EVIDENCE_KEY,
      status: 'approval-created',
    })
    expect(session.events).toEqual([
      'get-run',
      'get-caller-identity',
      'decrypt',
      'put-approval',
    ])
    expect(session.getCommands[0]?.input).toEqual(expect.objectContaining({
      ConsistentRead: true,
      Key: {
        scopeKey: { S: `RESTORE_DRILL#${DRILL_ID}` },
        recordKey: { S: 'RUN' },
      },
      TableName: STATE_TABLE_NAME,
    }))
    const getRun = session.getCommands[0]?.input
    expect(Object.values(getRun?.ExpressionAttributeNames ?? {}).sort()).toEqual([
      'approvalDigest',
      'approvalObjectKey',
      'approvedAt',
      'cleanupAttemptCount',
      'cleanupExecutionArn',
      'cleanupExecutionName',
      'cleanupPolicyVersion',
      'cleanupStartedAt',
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
    expect(getRun?.ProjectionExpression?.split(', ')).toHaveLength(27)
    expect(session.identityCommands[0]?.input).toEqual({})
    expect(session.decryptCommands[0]?.input).toEqual({
      CiphertextBlob: Buffer.from(CIPHERTEXT_BASE64, 'base64'),
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: {
        purpose: 'restore-drill-evidence-digest-v1',
        drillIdDigest: createHash('sha256')
          .update(`digest-key\u0000${DRILL_ID}`, 'utf8')
          .digest('hex'),
      },
      KeyId: KMS_KEY_ARN,
    })
    expect([...plaintext]).toEqual(Array.from({ length: 32 }, () => 0))

    const put = session.putCommands[0]?.input
    expect(put).toEqual(expect.objectContaining({
      Bucket: APPROVAL_BUCKET_NAME,
      ChecksumAlgorithm: 'SHA256',
      ContentType: 'application/json',
      ExpectedBucketOwner: ACCOUNT_ID,
      IfNoneMatch: '*',
      Key: result.approvalObjectKey,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN,
    }))
    const body = put?.Body
    if (!(body instanceof Uint8Array)) {
      throw new Error('Expected an in-memory canonical receipt body.')
    }
    expect(put?.ContentLength).toBe(body.byteLength)
    expect(put?.ChecksumSHA256).toBe(
      createHash('sha256').update(body).digest('base64'),
    )
    const bodyRecord = parseJsonRecord(Buffer.from(body).toString('utf8'))
    expect(Object.keys(bodyRecord)).toEqual([
      'algorithm',
      'approvalMac',
      'approvedAt',
      'approver',
      'changeLocator',
      'drillId',
      'expiresAt',
      'keyFingerprint',
      'kind',
      'policyVersion',
      'receiptVersion',
      'resourceDigest',
      'resultDigest',
    ])
    expect(bodyRecord).toEqual({
      algorithm: 'HMAC-SHA-256',
      approvalMac: expect.stringMatching(/^[0-9a-f]{64}$/u),
      approvedAt: APPROVED_AT,
      approver: APPROVER,
      changeLocator: CHANGE_LOCATOR,
      drillId: DRILL_ID,
      expiresAt: EXPIRES_AT,
      keyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      kind: 'mukuroji-restore-drill-cleanup-approval',
      policyVersion: 'restore-drill-cleanup-v1',
      receiptVersion: 1,
      resourceDigest: RESOURCE_DIGEST,
      resultDigest: RESULT_DIGEST,
    })
    expect(Buffer.from(body).toString('utf8')).toBe(JSON.stringify(bodyRecord))
    expect(JSON.stringify(put)).not.toContain(CIPHERTEXT_BASE64)
    expect(JSON.stringify(put)).not.toContain(Buffer.from(DIGEST_KEY).toString('hex'))
  })

  test('rejects non-approvable or non-exact run items before identity or KMS access', async () => {
    const cases: readonly GetItemCommandOutput[] = [
      { $metadata: {}, Item: createRunItem({ phase: { S: 'cleaning-up' } }) },
      { $metadata: {}, Item: createRunItem({ unknownField: { S: 'canary' } }) },
      { $metadata: {}, Item: createRunItem({ resourceDigest: { S: 'not-a-digest' } }) },
      { $metadata: {}, Item: createRunItem({
        failureCodes: { L: [{ S: 'UNKNOWN_FAILURE' }] },
      }) },
      { $metadata: {}, Item: createRunItem({
        failureCodes: { L: [{ S: 'RTO_TARGET_MISSED' }, { S: 'RPO_TARGET_MISSED' }] },
        resultOutcome: { S: 'fail' },
      }) },
      { $metadata: {}, Item: createRunItem({
        failureCodes: { L: [{ S: 'RPO_TARGET_MISSED' }, { S: 'RPO_TARGET_MISSED' }] },
        resultOutcome: { S: 'fail' },
      }) },
      { $metadata: {}, Item: createRunItem({
        failureCodes: { L: [{ S: 'RPO_TARGET_MISSED' }] },
      }) },
      { $metadata: {}, Item: createRunItem({ resultOutcome: { S: 'fail' } }) },
      { $metadata: {}, Item: createRunItem({
        resultEvidenceKey: { S: `evidence/v1/runs/${DRILL_ID}/other.json` },
      }) },
    ]

    for (const runOutput of cases) {
      const session = new RecordingSession({ runOutput })
      await expectFailureCode(
        createRestoreDrillCleanupApproval(
          createConfiguration(),
          session,
          new Date(APPROVED_AT),
        ),
        'RUN_INVALID',
      )
      expect(session.identityCommands).toHaveLength(0)
      expect(session.decryptCommands).toHaveLength(0)
      expect(session.putCommands).toHaveLength(0)
    }
  })

  test('creates a replacement receipt at the exact terminal-failure grace boundary', async () => {
    const session = new RecordingSession({
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })

    const result = await createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )

    expect(result.status).toBe('approval-created')
    expect(result.approvalObjectKey).not.toBe(
      `approvals/v1/runs/${DRILL_ID}/${PRIOR_APPROVAL_MAC}.json`,
    )
    expect(session.events).toEqual([
      'get-run',
      'describe-execution',
      'get-caller-identity',
      'decrypt',
      'put-approval',
    ])
    expect(session.describeCommands[0]?.input).toEqual({
      executionArn: CLEANUP_EXECUTION_ARN,
      includedData: 'METADATA_ONLY',
    })
  })

  test.each([
    { partition: 'aws-us-gov', region: 'us-gov-west-1' },
    { partition: 'aws-cn', region: 'cn-north-1' },
  ])('creates a replacement approval in the Region-bound $partition partition', async ({
    partition,
    region,
  }) => {
    const approver =
      `arn:${partition}:sts::${ACCOUNT_ID}:assumed-role/RestoreDrillCleanupApprover/operator-session`
    const kmsKeyArn =
      `arn:${partition}:kms:${region}:${ACCOUNT_ID}:key/12345678-1234-1234-1234-123456789012`
    const cleanupStateMachineArn =
      `arn:${partition}:states:${region}:${ACCOUNT_ID}:stateMachine:mukuroji-restore-drill-cleanup`
    const cleanupExecutionArn =
      `arn:${partition}:states:${region}:${ACCOUNT_ID}:execution:mukuroji-restore-drill-cleanup:${CLEANUP_EXECUTION_NAME}`
    const session = new RecordingSession({
      decryptOutput: {
        $metadata: {},
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        KeyId: kmsKeyArn,
        Plaintext: DIGEST_KEY.slice(),
      },
      describeOutput: createDescribeExecutionOutput({
        executionArn: cleanupExecutionArn,
        stateMachineArn: cleanupStateMachineArn,
      }),
      identityOutput: {
        $metadata: {},
        Account: ACCOUNT_ID,
        Arn: approver,
        UserId: 'ARO123456789EXAMPLE:operator-session',
      },
      runOutput: {
        $metadata: {},
        Item: createCleaningRunItem({
          cleanupExecutionArn: { S: cleanupExecutionArn },
          digestKeyEnvelope: {
            M: {
              ciphertextBase64: { S: CIPHERTEXT_BASE64 },
              kind: { S: 'restore-drill-digest-key' },
              kmsKeyArn: { S: kmsKeyArn },
            },
          },
        }),
      },
    })
    const configuration = parseRestoreDrillCleanupApprovalCliArguments(
      replaceFlag(
        replaceFlag(argumentVector, '--region', region),
        '--approver',
        approver,
      ),
    )

    await expect(createRestoreDrillCleanupApproval(
      configuration,
      session,
      new Date(APPROVED_AT),
    )).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.describeCommands[0]?.input.executionArn).toBe(cleanupExecutionArn)
    expect(session.decryptCommands[0]?.input.KeyId).toBe(kmsKeyArn)
  })

  test.each([
    { status: 'ABORTED', output: createDescribeExecutionOutput({ status: 'ABORTED' }) },
    { status: 'TIMED_OUT', output: createDescribeExecutionOutput({ status: 'TIMED_OUT' }) },
  ])('allows replacement approval after terminal $status', async ({ output }) => {
    const session = new RecordingSession({
      describeOutput: output,
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })

    await expect(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )).resolves.toMatchObject({ status: 'approval-created' })
  })

  test('allows another replacement after a later approved cleanup attempt fails', async () => {
    const session = new RecordingSession({
      describeOutput: createDescribeExecutionOutput({
        executionArn: SECOND_CLEANUP_EXECUTION_ARN,
        name: SECOND_CLEANUP_EXECUTION_NAME,
        startDate: new Date('2026-08-01T00:31:00.000Z'),
        stopDate: new Date('2026-08-01T00:40:00.000Z'),
      }),
      runOutput: {
        $metadata: {},
        Item: createCleaningRunItem({
          approvalObjectKey: {
            S: `approvals/v1/runs/${DRILL_ID}/${SECOND_APPROVAL_MAC}.json`,
          },
          approvedAt: { S: '2026-08-01T00:30:00.000Z' },
          cleanupAttemptCount: { N: '2' },
          cleanupExecutionArn: { S: SECOND_CLEANUP_EXECUTION_ARN },
          cleanupExecutionName: { S: SECOND_CLEANUP_EXECUTION_NAME },
          updatedAt: { S: '2026-08-01T00:31:00.000Z' },
        }),
      },
      putOutput: createPutApprovalOutput({
        ObjectLockRetainUntilDate: new Date('2030-01-01T00:00:00.000Z'),
      }),
    })

    await expect(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date('2026-08-01T00:56:00.000Z'),
    )).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.describeCommands[0]?.input.executionArn).toBe(
      SECOND_CLEANUP_EXECUTION_ARN,
    )
  })

  test.each([
    { status: 'PENDING_REDRIVE', output: createDescribeExecutionOutput({
      status: 'PENDING_REDRIVE',
      stopDate: undefined,
    }) },
    { status: 'RUNNING', output: createDescribeExecutionOutput({
      status: 'RUNNING',
      stopDate: undefined,
    }) },
    { status: 'SUCCEEDED', output: createDescribeExecutionOutput({
      status: 'SUCCEEDED',
    }) },
  ])('rejects replacement approval while prior status is $status', async ({
    output,
  }) => {
    const session = new RecordingSession({
      describeOutput: output,
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })

    await expectFailureCode(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    ), 'CLEANUP_EXECUTION_NOT_REAPPROVABLE')
    expect(session.identityCommands).toHaveLength(0)
    expect(session.decryptCommands).toHaveLength(0)
  })

  test('rejects replacement approval one millisecond before the grace boundary', async () => {
    const session = new RecordingSession({
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })

    await expectFailureCode(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(Date.parse(APPROVED_AT) - 1),
    ), 'CLEANUP_REAPPROVAL_TOO_EARLY')
    expect(session.identityCommands).toHaveLength(0)
    expect(session.decryptCommands).toHaveLength(0)
  })

  test.each([
    {
      name: 'execution ARN',
      output: createDescribeExecutionOutput({
        executionArn: `${CLEANUP_EXECUTION_ARN}-other`,
      }),
    },
    {
      name: 'execution name',
      output: createDescribeExecutionOutput({ name: `${CLEANUP_EXECUTION_NAME}-other` }),
    },
    {
      name: 'state machine ARN',
      output: createDescribeExecutionOutput({
        stateMachineArn: `${CLEANUP_STATE_MACHINE_ARN}-other`,
      }),
    },
    {
      name: 'missing status',
      output: createDescribeExecutionOutput({ status: undefined }),
    },
    {
      name: 'missing stop time',
      output: createDescribeExecutionOutput({ stopDate: undefined }),
    },
    {
      name: 'invalid stop time',
      output: createDescribeExecutionOutput({ stopDate: new Date(Number.NaN) }),
    },
    {
      name: 'stop time before cleanup admission',
      output: createDescribeExecutionOutput({
        stopDate: new Date(Date.parse(CLEANUP_STARTED_AT) - 1),
      }),
    },
  ])('rejects an invalid prior execution $name', async ({ output }) => {
    const session = new RecordingSession({
      describeOutput: output,
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })

    await expectFailureCode(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    ), 'CLEANUP_EXECUTION_INVALID')
    expect(session.identityCommands).toHaveLength(0)
    expect(session.decryptCommands).toHaveLength(0)
  })

  test('strictly requires every internally consistent cleanup binding field', async () => {
    const missingBinding = createCleaningRunItem()
    delete missingBinding.approvalDigest
    const malformedItems = [
      missingBinding,
      createCleaningRunItem({ approvalDigest: { S: 'not-a-digest' } }),
      createCleaningRunItem({
        approvalObjectKey: {
          S: `approvals/v1/runs/${DRILL_ID}/${'e'.repeat(64)}.json`,
        },
      }),
      createCleaningRunItem({ cleanupAttemptCount: { N: '0' } }),
      createCleaningRunItem({
        cleanupExecutionArn: {
          S: CLEANUP_EXECUTION_ARN.replace(ACCOUNT_ID, '999999999999'),
        },
      }),
      createCleaningRunItem({ approvedAt: { S: '2026-08-01T00:10:00Z' } }),
      createCleaningRunItem({ approvedAt: { S: '2026-08-01T00:13:00.000Z' } }),
      createCleaningRunItem({ cleanupAttemptCount: { N: '2' } }),
    ]

    for (const item of malformedItems) {
      const session = new RecordingSession({ runOutput: { $metadata: {}, Item: item } })
      await expectFailureCode(createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ), 'RUN_INVALID')
      expect(session.describeCommands).toHaveLength(0)
      expect(session.identityCommands).toHaveLength(0)
    }
  })

  test('accepts the exact failure fallback variant without an invented restore point', async () => {
    const fallbackItem = createRunItem({
      failureCodes: { L: [{ S: 'PITR_WINDOW_NO_OVERLAP' }] },
      resultOutcome: { S: 'fail' },
    })
    delete fallbackItem.restorePoint
    const session = new RecordingSession({
      runOutput: { $metadata: {}, Item: fallbackItem },
    })

    await expect(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ),
    ).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.putCommands).toHaveLength(1)
  })

  test('accepts a poll-budget operational failure for cleanup approval', async () => {
    const session = new RecordingSession({
      runOutput: {
        $metadata: {},
        Item: createRunItem({
          failureCodes: { L: [{ S: 'WORKFLOW_POLL_BUDGET_EXCEEDED' }] },
          resultOutcome: { S: 'fail' },
        }),
      },
    })

    await expect(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ),
    ).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.putCommands).toHaveLength(1)
  })

  test('accepts a generic workflow task failure for cleanup approval', async () => {
    const session = new RecordingSession({
      runOutput: {
        $metadata: {},
        Item: createRunItem({
          failureCodes: { L: [{ S: 'WORKFLOW_TASK_FAILED' }] },
          resultOutcome: { S: 'fail' },
        }),
      },
    })

    await expect(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ),
    ).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.putCommands).toHaveLength(1)
  })

  test('accepts the exact cleaning-up fallback variant without a restore point', async () => {
    const fallbackItem = createCleaningRunItem({
      failureCodes: { L: [{ S: 'PITR_WINDOW_NO_OVERLAP' }] },
      resultOutcome: { S: 'fail' },
    })
    delete fallbackItem.restorePoint
    const session = new RecordingSession({
      runOutput: { $metadata: {}, Item: fallbackItem },
    })

    await expect(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.describeCommands).toHaveLength(1)
    expect(session.putCommands).toHaveLength(1)
  })

  test('requires the actual STS caller ARN and owning KMS account before decrypting', async () => {
    const mismatchSession = new RecordingSession({
      identityOutput: {
        $metadata: {},
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/RestoreDrillCleanupApprover/other-session`,
      },
    })
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        mismatchSession,
        new Date(APPROVED_AT),
      ),
      'APPROVER_MISMATCH',
    )
    expect(mismatchSession.decryptCommands).toHaveLength(0)
    expect(mismatchSession.putCommands).toHaveLength(0)

    const accountSession = new RecordingSession({
      identityOutput: {
        $metadata: {},
        Account: '999999999999',
        Arn: APPROVER,
      },
    })
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        accountSession,
        new Date(APPROVED_AT),
      ),
      'CALLER_IDENTITY_INVALID',
    )
    expect(accountSession.decryptCommands).toHaveLength(0)
  })

  test('always zeroizes a returned plaintext even when KMS identity is invalid', async () => {
    const plaintext = DIGEST_KEY.slice()
    const session = new RecordingSession({
      decryptOutput: {
        $metadata: {},
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        KeyId: `${KMS_KEY_ARN}-other`,
        Plaintext: plaintext,
      },
    })
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ),
      'KMS_RESPONSE_INVALID',
    )
    expect([...plaintext]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(session.putCommands).toHaveLength(0)
  })

  test('exactly reconciles a successful PutObject response missing lock metadata', async () => {
    const session = new RecordingSession({ putOutput: { $metadata: {} } })

    await expect(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )).resolves.toMatchObject({ status: 'approval-created' })
    expect(session.events).toEqual([
      'get-run',
      'get-caller-identity',
      'decrypt',
      'put-approval',
      'get-approval',
    ])
  })

  test('fails closed when a successful write cannot prove 400-day compliance retention', async () => {
    const shortRetainUntilDate = new Date(MINIMUM_RETAIN_UNTIL_DATE.getTime() - 1)
    const session = new RecordingSession({
      getApprovalOutputFactory: (command) => ({
        ...createGetApprovalOutput(command),
        ObjectLockRetainUntilDate: shortRetainUntilDate,
      }),
      putOutput: createPutApprovalOutput({
        ObjectLockRetainUntilDate: shortRetainUntilDate,
      }),
    })

    await expectFailureCode(createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    ), 'APPROVAL_WRITE_FAILED')
    expect(session.getApprovalCommands).toHaveLength(1)
  })

  test('adopts an exact object after ambiguous PutObject response loss', async () => {
    const session = new RecordingSession({
      putFailure: new NamedAwsFailure(
        'TimeoutError',
        'raw response-loss details',
      ),
    })
    const result = await createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )

    expect(result.status).toBe('approval-created')
    expect(session.events).toEqual([
      'get-run',
      'get-caller-identity',
      'decrypt',
      'put-approval',
      'get-approval',
    ])
    expect(session.getApprovalCommands[0]?.input).toEqual({
      Bucket: APPROVAL_BUCKET_NAME,
      ChecksumMode: 'ENABLED',
      ExpectedBucketOwner: ACCOUNT_ID,
      Key: result.approvalObjectKey,
    })
  })

  test('adopts the same receipt after a 412 and rejects a conflicting body', async () => {
    const exactSession = new RecordingSession({
      putFailure: new NamedAwsFailure('PreconditionFailed', 'raw 412 details'),
    })
    await expect(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        exactSession,
        new Date(APPROVED_AT),
      ),
    ).resolves.toMatchObject({ status: 'approval-created' })

    const conflictingSession = new RecordingSession({
      getApprovalOutputFactory: (command) =>
        createGetApprovalOutput(command, Buffer.from('{"tampered":true}', 'utf8')),
      putFailure: new NamedAwsFailure('PreconditionFailed', 'raw 412 details'),
    })
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        conflictingSession,
        new Date(APPROVED_AT),
      ),
      'APPROVAL_ALREADY_EXISTS',
    )
  })

  test.each([
    {
      name: 'checksum',
      outputFactory: (command: PutObjectCommand) => ({
        ...createGetApprovalOutput(command),
        ChecksumSHA256: Buffer.from('tampered-checksum').toString('base64'),
      }),
    },
    {
      name: 'KMS key',
      outputFactory: (command: PutObjectCommand) => ({
        ...createGetApprovalOutput(command),
        SSEKMSKeyId: `${KMS_KEY_ARN}-other`,
      }),
    },
    {
      name: 'body',
      outputFactory: (command: PutObjectCommand) =>
        createGetApprovalOutput(command, Buffer.from('{"tampered":true}', 'utf8')),
    },
    {
      name: 'Object Lock mode',
      outputFactory: (command: PutObjectCommand) => ({
        ...createGetApprovalOutput(command),
        ObjectLockMode: 'GOVERNANCE',
      }),
    },
    {
      name: 'Object Lock retention',
      outputFactory: (command: PutObjectCommand) => ({
        ...createGetApprovalOutput(command),
        ObjectLockRetainUntilDate: new Date(
          MINIMUM_RETAIN_UNTIL_DATE.getTime() - 1,
        ),
      }),
    },
  ])('fails closed on response-loss reconciliation $name tampering', async ({
    outputFactory,
  }) => {
    const session = new RecordingSession({
      getApprovalOutputFactory: outputFactory,
      putFailure: new NamedAwsFailure('TimeoutError', 'raw timeout details'),
    })
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        createConfiguration(),
        session,
        new Date(APPROVED_AT),
      ),
      'APPROVAL_WRITE_FAILED',
    )
  })

  test.each([
    EXPIRES_AT,
    '2026-08-02T00:36:00.001Z',
  ])('rejects an expired or over-24-hour approval before AWS access', async (
    invalidDecisionTime,
  ) => {
    const session = new RecordingSession()
    const decisionTime = invalidDecisionTime === EXPIRES_AT
      ? new Date(EXPIRES_AT)
      : new Date(APPROVED_AT)
    const configuration = invalidDecisionTime === EXPIRES_AT
      ? createConfiguration()
      : parseRestoreDrillCleanupApprovalCliArguments(
        replaceFlag(argumentVector, '--expires-at', invalidDecisionTime),
      )
    await expectFailureCode(
      createRestoreDrillCleanupApproval(
        configuration,
        session,
        decisionTime,
      ),
      'APPROVAL_WINDOW_INVALID',
    )
    expect(session.events).toEqual([])
  })

  test('accepts the exact 24-hour limit and creates a new key after expiry', async () => {
    const session = new RecordingSession({
      putOutput: createPutApprovalOutput({
        ObjectLockRetainUntilDate: new Date('2030-01-01T00:00:00.000Z'),
      }),
    })
    const first = await createRestoreDrillCleanupApproval(
      createConfiguration(),
      session,
      new Date(APPROVED_AT),
    )
    const renewedConfiguration = parseRestoreDrillCleanupApprovalCliArguments(
      replaceFlag(argumentVector, '--expires-at', '2026-08-03T02:00:00.000Z'),
    )
    const renewed = await createRestoreDrillCleanupApproval(
      renewedConfiguration,
      session,
      new Date('2026-08-02T02:00:00.000Z'),
    )

    expect(renewed.approvalObjectKey).not.toBe(first.approvalObjectKey)
    expect(session.putCommands).toHaveLength(2)
  })
})

describe('runRestoreDrillCleanupApprovalCli', () => {
  test('prints only a minimal secret-free success result and closes the session', async () => {
    const session = new RecordingSession()
    const capture = createDependencies(session)
    const exitCode = await runRestoreDrillCleanupApprovalCli(
      argumentVector,
      capture.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capture.errors).toEqual([])
    const approvalObjectKey = session.putCommands[0]?.input.Key
    const approvalMac = approvalObjectKey?.split('/').at(-1)?.replace(/\.json$/u, '')
    expect(capture.outputs).toEqual([
      JSON.stringify({
        approvalObjectKey,
        cleanupExecutionName: `restore-cleanup-${approvalMac}`,
        drillId: DRILL_ID,
        operation: 'create-cleanup-approval',
        status: 'approval-created',
      }),
    ])
    expect(session.closeCount).toBe(1)
    const output = capture.outputs.join('\n')
    expect(output).not.toContain(CIPHERTEXT_BASE64)
    expect(output).not.toContain(CHANGE_LOCATOR)
    expect(output).not.toContain(APPROVER)
    expect(output).not.toContain(RESOURCE_DIGEST)
    expect(output).not.toContain(RESULT_DIGEST)
    expect(output).not.toContain('approvalMac')
  })

  test('redacts raw AWS errors and closes the session on failure', async () => {
    const canary = 'RAW_STATE_SECRET_CANARY'
    const session = new RecordingSession({ readFailure: new Error(canary) })
    const capture = createDependencies(session)
    const exitCode = await runRestoreDrillCleanupApprovalCli(
      argumentVector,
      capture.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(capture.outputs).toEqual([])
    expect(capture.errors).toEqual([
      JSON.stringify({
        code: 'RUN_READ_FAILED',
        operation: 'create-cleanup-approval',
        status: 'error',
      }),
    ])
    expect(capture.errors.join('\n')).not.toContain(canary)
    expect(session.closeCount).toBe(1)
  })

  test('preserves the determined result when closing the session fails', async () => {
    const session = new RecordingSession({
      closeFailure: new Error('RAW_CLOSE_SECRET_CANARY'),
    })
    const capture = createDependencies(session)
    const exitCode = await runRestoreDrillCleanupApprovalCli(
      argumentVector,
      capture.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capture.errors).toEqual([])
    expect(capture.outputs).toHaveLength(1)
    expect(session.closeCount).toBe(1)
  })

  test('classifies unknown exceptions without blaming approval binding', async () => {
    const canary = 'RAW_UNEXPECTED_SECRET_CANARY'
    const session = new RecordingSession()
    const capture = createDependencies(session)
    const exitCode = await runRestoreDrillCleanupApprovalCli(
      argumentVector,
      {
        ...capture.dependencies,
        now: () => {
          throw new Error(canary)
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(capture.outputs).toEqual([])
    expect(capture.errors).toEqual([
      JSON.stringify({
        code: 'UNEXPECTED_FAILURE',
        operation: 'create-cleanup-approval',
        status: 'error',
      }),
    ])
    expect(capture.errors.join('\n')).not.toContain(canary)
    expect(session.closeCount).toBe(1)
  })

  test('redacts raw Step Functions errors during reapproval', async () => {
    const canary = 'RAW_EXECUTION_SECRET_CANARY'
    const session = new RecordingSession({
      describeFailure: new Error(canary),
      runOutput: { $metadata: {}, Item: createCleaningRunItem() },
    })
    const capture = createDependencies(session)
    const exitCode = await runRestoreDrillCleanupApprovalCli(
      argumentVector,
      capture.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(capture.outputs).toEqual([])
    expect(capture.errors).toEqual([
      JSON.stringify({
        code: 'CLEANUP_EXECUTION_READ_FAILED',
        operation: 'create-cleanup-approval',
        status: 'error',
      }),
    ])
    expect(capture.errors.join('\n')).not.toContain(canary)
    expect(session.closeCount).toBe(1)
  })

  test('does not create a session for invalid usage', async () => {
    let createCount = 0
    const errors: string[] = []
    const exitCode = await runRestoreDrillCleanupApprovalCli([], {
      createSession: () => {
        createCount += 1
        return new RecordingSession()
      },
      now: () => new Date(APPROVED_AT),
      writeError: (line) => errors.push(line),
      writeOutput: () => undefined,
    })

    expect(exitCode).toBe(2)
    expect(createCount).toBe(0)
    expect(errors).toEqual([
      JSON.stringify({
        code: 'INVALID_USAGE',
        operation: 'create-cleanup-approval',
        status: 'error',
      }),
    ])
  })
})

/**
 * Replaces one flag value in an immutable argument vector.
 *
 * @param arguments_ - Existing strict flag/value vector.
 * @param flag - Flag whose value is replaced.
 * @param replacement - Replacement value.
 * @returns New argument vector.
 */
function replaceFlag(
  arguments_: readonly string[],
  flag: string,
  replacement: string,
): string[] {
  return arguments_.map((value, index, values) =>
    values[index - 1] === flag ? replacement : value)
}

/**
 * Parses one test JSON value and requires a non-array object.
 *
 * @param value - Serialized receipt JSON.
 * @returns Parsed record for exact assertions.
 */
function parseJsonRecord(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value)
  if (!isUnknownRecord(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed
}

/**
 * Narrows one unknown value to a non-array record.
 *
 * @param value - Unknown parsed value.
 * @returns Whether the value is a plain record shape.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
