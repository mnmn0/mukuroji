import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, mock, test } from 'bun:test'
import {
  type AttributeValue,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import { KMSClient } from '@aws-sdk/client-kms'
import {
  GetBucketTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
} from '../../data-integrity/cross-domain-integrity'

/** Process-isolated worker selector preventing persistent mock leakage. */
const workerScenarioEnvironmentName =
  'MUKUROJI_PRE_PERMIT_ROOT_AWS_TEST_SCENARIO'

/** Exact enabled target supplied only by the isolated resolver mock. */
const enabledTargetId = 'pre-permit-root-test'

/** Exact disabled target supplied only by the isolated resolver mock. */
const disabledTargetId = 'pre-permit-root-disabled-test'

/** Exact isolated non-production account. */
const deploymentAccount = '123456789012'

/** Exact isolated deployment Region. */
const deploymentRegion = 'ap-northeast-1'

/** Exact source-controlled deployment trust digest. */
const deploymentTrustRootDigest = 'a'.repeat(64)

/** Exact source-controlled protected production account digest. */
const productionAccountDigest = 'b'.repeat(64)

/** Exact expected STS role session. */
const roleSessionName = 'pre-permit-root-test'

/** Exact caller ARN authorized by the owner-only root plan. */
const expectedCallerArn =
  `arn:aws:sts::${deploymentAccount}:` +
  `assumed-role/MigrationRehearsal/${roleSessionName}`

/** Exact static shared profile selected by the owner-only root plan. */
const profile = 'pre-permit-root-test'

/** Exact reviewed DescribeTable policy accepted by managed construction. */
const ratePolicy = {
  policyVersion: 'c'.repeat(64),
  maximumAttemptsPerWindow: 1_000,
  maximumAttemptsPerLifecycle: 2_000,
  checkpointPageAttemptCapacity: 182,
  windowMilliseconds: 1_000,
  minimumAttemptIntervalMilliseconds: 1,
  minimumPageIntervalMilliseconds: 1,
  maximumAdmissionWaitMilliseconds: 5_000,
  throttleBackoffInitialMilliseconds: 1,
  throttleBackoffMaximumMilliseconds: 1,
}

/** Creates one fresh valid strict owner-only root-plan document. */
function createRootPlan(deploymentTargetId = enabledTargetId) {
  return {
    kind: 'mukuroji-workspace-search-migration-rehearsal-root-plan',
    version: 1,
    approval:
      'bootstrap-reviewed-non-production-migration-rehearsal-root',
    deploymentTargetId,
    expectedCallerArn,
    expectedConfigurationBindingDigest: 'd'.repeat(64),
    requestedResources: {
      account: deploymentAccount,
      region: deploymentRegion,
      profile,
      commit: 'e'.repeat(40),
      tables: {
        'project-directory': 'root-project-directory',
        'work-items': 'root-work-items',
        collaboration: 'root-collaboration',
        documents: 'root-documents',
        'workspace-search': 'root-workspace-search',
        'migration-state': 'root-migration-state',
      },
      journalBucket: 'root-migration-journal',
      journalKeyArn:
        `arn:aws:kms:${deploymentRegion}:${deploymentAccount}:` +
        'key/11111111-2222-4333-8444-555555555555',
    },
    integrityResources: {
      tables: {
        'audit-events': 'root-audit-events',
        'file-proofing': 'root-file-proofing',
        'project-directory': 'root-project-directory',
        'work-item-configuration': 'root-work-item-configuration',
        'work-items': 'root-work-items',
        'workspace-access': 'root-workspace-access',
      },
      fileBucket: 'root-file-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'root-marker-version',
        checksumSha256: Buffer.alloc(32, 7).toString('base64'),
        size: 128,
      },
    },
    maximumDurationMilliseconds: 60_000,
  }
}

/** Creates the exact three deployment tags expected before checkpoint I/O. */
function createValidJournalTags() {
  return {
    $metadata: {},
    TagSet: [
      {
        Key: 'mukuroji:workspace-search-migration-environment',
        Value: 'non-production',
      },
      {
        Key: 'mukuroji:workspace-search-migration-deployment-trust-root',
        Value: deploymentTrustRootDigest,
      },
      {
        Key: 'mukuroji:workspace-search-migration-production-account-sha256',
        Value: productionAccountDigest,
      },
    ],
  }
}

/** Runs one scenario in a fresh Bun process with isolated module mocks. */
async function runIsolatedWorker(scenario: string): Promise<void> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, import.meta.path],
    env: {
      ...process.env,
      [workerScenarioEnvironmentName]: scenario,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, standardOutput, standardError] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  assert.equal(
    exitCode,
    0,
    `isolated pre-permit AWS worker failed: ${standardError}${standardOutput}`,
  )
}

/** Runs one task with a private static shared-credentials file. */
async function withStaticProfile(task: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), 'mukuroji-pre-permit-root-profile-'),
  )
  const credentialsFile = join(directory, 'credentials')
  const configFile = join(directory, 'config')
  await writeFile(
    credentialsFile,
    `[${profile}]\n` +
      'aws_access_key_id = pre-permit-root-access-key\n' +
      'aws_secret_access_key = pre-permit-root-secret-key\n',
    { mode: 0o600 },
  )
  await writeFile(configFile, '', { mode: 0o600 })
  const previousCredentials = process.env.AWS_SHARED_CREDENTIALS_FILE
  const previousConfig = process.env.AWS_CONFIG_FILE
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile
  process.env.AWS_CONFIG_FILE = configFile
  try {
    await task()
  } finally {
    if (previousCredentials === undefined) {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE
    } else {
      process.env.AWS_SHARED_CREDENTIALS_FILE = previousCredentials
    }
    if (previousConfig === undefined) {
      delete process.env.AWS_CONFIG_FILE
    } else {
      process.env.AWS_CONFIG_FILE = previousConfig
    }
    await rm(directory, { recursive: true, force: true })
  }
}

/** Executes one worker after installing the repository target resolver mock. */
async function executeWorkerScenario(scenario: string): Promise<void> {
  const resolvedTargetIds: string[] = []
  let capturedRateConstruction: unknown
  /** Resolves the sole enabled or disabled test deployment target. */
  function resolveTestTarget(targetId: string) {
    resolvedTargetIds.push(targetId)
    if (targetId === disabledTargetId) {
      throw new Error('Workspace Search migration rehearsal target is disabled.')
    }
    if (targetId !== enabledTargetId) {
      throw new Error('Unknown Workspace Search migration rehearsal target.')
    }
    return Object.freeze({
      targetId,
      version: 1,
      environment: 'non-production',
      deploymentAccount,
      productionAccountDigest,
      region: deploymentRegion,
      rehearsalEnabled: true,
      digest: deploymentTrustRootDigest,
    })
  }
  mock.module('./migration-deployment-targets', () => ({
    resolveWorkspaceSearchMigrationRehearsalDeploymentTarget:
      resolveTestTarget,
  }))
  if (scenario === 'rate-construction') {
    const initialRateEvidence = Object.freeze({
      version: 2,
      policyVersion: ratePolicy.policyVersion,
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      awsServiceThrottleCount: 0,
      rehearsalInjectedThrottleCount: 0,
      budgetStopCount: 0,
      operationalBudgetStopCount: 0,
      awsServiceThrottleBudgetStopCount: 0,
      rehearsalInjectedBudgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 0,
    })
    const capturedRate = Object.freeze({
      describeTable: async () => {
        throw new Error('Unexpected mocked rate DescribeTable call.')
      },
      runCheckpointPage: async (_input: unknown, task: () => unknown) =>
        await task(),
      runMandatoryCleanup: async (task: () => unknown) => await task(),
      runNonPageOperation: async (task: () => unknown) => await task(),
      runWithMutationAdmissionGuard: async (
        guard: () => void,
        task: () => unknown,
      ) => {
        guard()
        return await task()
      },
      assertNewDataIoAllowed: () => undefined,
      claimAfterLease: async () => undefined,
      interrupt: () => undefined,
      quarantine: () => undefined,
      readEvidence: () => initialRateEvidence,
      closeAndReadEvidence: async () => initialRateEvidence,
      close: async () => undefined,
    })
    mock.module(
      './migration-describe-table-rate-managed-session',
      () => ({
        createWorkspaceSearchMigrationManagedDescribeTableRate:
          async (input: unknown) => {
            capturedRateConstruction = input
            return capturedRate
          },
        createWorkspaceSearchMigrationRehearsalManagedDescribeTableRate:
          async () => {
            throw new Error('Unexpected rehearsal rate construction.')
          },
        WorkspaceSearchMigrationManagedDescribeTableRateError: Error,
      }),
    )
  }

  const serviceOrder: string[] = []
  let checkpointItem:
    Readonly<Record<string, AttributeValue>> | undefined
  let stsReadCount = 0
  let s3ReadCount = 0
  let dynamoDbReadCount = 0
  let dynamoDbDestroyCount = 0
  let s3DestroyCount = 0
  let stsDestroyCount = 0
  let kmsDestroyCount = 0
  let callerAccount = deploymentAccount
  let callerArn = expectedCallerArn
  let journalTags = createValidJournalTags()
  let monotonicClockReadCount = 0
  let wallClockReadCount = 0

  Reflect.set(STSClient.prototype, 'send', function (
    ...callArguments: unknown[]
  ): unknown {
    const command = callArguments[0]
    assert.ok(command instanceof GetCallerIdentityCommand)
    const options = callArguments[1]
    assert.ok(typeof options === 'object' && options !== null)
    assert.ok(Reflect.get(options, 'abortSignal') instanceof AbortSignal)
    assert.ok(monotonicClockReadCount > 0)
    assert.ok(wallClockReadCount > 0)
    stsReadCount += 1
    serviceOrder.push('sts')
    return Promise.resolve({
      $metadata: {},
      Account: callerAccount,
      Arn: callerArn,
      UserId: `AROA12345678901234567:${roleSessionName}`,
    })
  })
  Reflect.set(S3Client.prototype, 'send', function (
    ...callArguments: unknown[]
  ): unknown {
    const command = callArguments[0]
    assert.ok(command instanceof GetBucketTaggingCommand)
    const options = callArguments[1]
    assert.ok(typeof options === 'object' && options !== null)
    assert.ok(Reflect.get(options, 'abortSignal') instanceof AbortSignal)
    s3ReadCount += 1
    serviceOrder.push('tags')
    return Promise.resolve(structuredClone(journalTags))
  })
  Reflect.set(DynamoDBClient.prototype, 'send', function (
    ...callArguments: unknown[]
  ): unknown {
    const command = callArguments[0]
    dynamoDbReadCount += 1
    if (command instanceof GetItemCommand) {
      serviceOrder.push('checkpoint-read')
      return Promise.resolve({
        $metadata: {},
        ...(checkpointItem === undefined
          ? {}
          : { Item: structuredClone(checkpointItem) }),
      })
    }
    if (command instanceof TransactWriteItemsCommand) {
      serviceOrder.push('checkpoint-write')
      const item = command.input.TransactItems?.[0]?.Put?.Item
      assert.ok(item !== undefined)
      checkpointItem = structuredClone(item)
      return Promise.resolve({ $metadata: {} })
    }
    if (command instanceof DescribeTableCommand) {
      throw new Error('Root factory issued DescribeTable before measurement.')
    }
    throw new Error('Unexpected root factory DynamoDB command.')
  })
  Reflect.set(DynamoDBClient.prototype, 'destroy', function (): void {
    dynamoDbDestroyCount += 1
  })
  Reflect.set(S3Client.prototype, 'destroy', function (): void {
    s3DestroyCount += 1
  })
  Reflect.set(STSClient.prototype, 'destroy', function (): void {
    stsDestroyCount += 1
  })
  Reflect.set(KMSClient.prototype, 'destroy', function (): void {
    kmsDestroyCount += 1
  })

  const identity = await import('./migration-identity-aws')
  const createSession =
    identity.createAwsWorkspaceSearchMigrationRehearsalPrePermitRootSession
  /** Creates the stable clock input used by every factory attempt. */
  const createInput = (rootPlan = createRootPlan()) => ({
    rootPlan,
    ratePolicy,
    monotonicClock: () => {
      monotonicClockReadCount += 1
      return 100
    },
    wallClock: () => {
      wallClockReadCount += 1
      return new Date('2026-08-01T00:00:00.000Z')
    },
  })

  await withStaticProfile(async () => {
    switch (scenario) {
      case 'disabled-no-aws': {
        await assert.rejects(
          createSession(createInput(createRootPlan(disabledTargetId))),
          { name: 'WorkspaceSearchMigrationRehearsalRootPlanError' },
        )
        assert.deepEqual(resolvedTargetIds, [disabledTargetId])
        assert.equal(stsReadCount, 0)
        assert.equal(s3ReadCount, 0)
        assert.equal(dynamoDbReadCount, 0)
        assert.equal(dynamoDbDestroyCount, 0)
        assert.equal(s3DestroyCount, 0)
        assert.equal(stsDestroyCount, 0)
        assert.equal(kmsDestroyCount, 0)
        return
      }
      case 'wrong-identity': {
        for (const kind of ['account', 'arn']) {
          callerAccount = kind === 'account'
            ? '999999999999'
            : deploymentAccount
          callerArn = kind === 'arn'
            ? `arn:aws:sts::${deploymentAccount}:assumed-role/Other/root-test`
            : expectedCallerArn
          await assert.rejects(createSession(createInput()), {
            name:
              'WorkspaceSearchMigrationRehearsalPrePermitRootSessionError',
          })
        }
        assert.equal(stsReadCount, 2)
        assert.equal(s3ReadCount, 0)
        assert.equal(dynamoDbReadCount, 0)
        assert.equal(dynamoDbDestroyCount, 2)
        assert.equal(s3DestroyCount, 2)
        assert.equal(stsDestroyCount, 2)
        assert.equal(kmsDestroyCount, 2)
        return
      }
      case 'wrong-tags': {
        const invalidTags = [
          {
            ...createValidJournalTags(),
            TagSet: createValidJournalTags().TagSet.map((tag) =>
              tag.Key.endsWith('environment')
                ? { ...tag, Value: 'production' }
                : tag
            ),
          },
          {
            ...createValidJournalTags(),
            TagSet: createValidJournalTags().TagSet.map((tag) =>
              tag.Key.endsWith('deployment-trust-root')
                ? { ...tag, Value: 'f'.repeat(64) }
                : tag
            ),
          },
          {
            ...createValidJournalTags(),
            TagSet: createValidJournalTags().TagSet.slice(0, 2),
          },
          {
            ...createValidJournalTags(),
            TagSet: [
              ...createValidJournalTags().TagSet,
              {
                Key:
                  'mukuroji:workspace-search-migration-environment',
                Value: 'non-production',
              },
            ],
          },
        ]
        for (const tags of invalidTags) {
          journalTags = tags
          await assert.rejects(createSession(createInput()), {
            name:
              'WorkspaceSearchMigrationRehearsalPrePermitRootSessionError',
          })
        }
        assert.equal(stsReadCount, invalidTags.length)
        assert.equal(s3ReadCount, invalidTags.length)
        assert.equal(dynamoDbReadCount, 0)
        return
      }
      case 'success-and-surface': {
        const preConstructionServiceCount = serviceOrder.length
        const recoveryEscapeInput = {
          ...createInput(),
          recoverInterruptedCleanup: true,
        }
        await assert.rejects(createSession(recoveryEscapeInput), {
          name:
            'WorkspaceSearchMigrationRehearsalPrePermitRootSessionError',
        })
        assert.equal(serviceOrder.length, preConstructionServiceCount)

        const session = await createSession(createInput())
        assert.deepEqual(serviceOrder.slice(0, 5), [
          'sts',
          'tags',
          'checkpoint-read',
          'checkpoint-read',
          'checkpoint-write',
        ])
        for (const forbidden of [
          'describeTable',
          'rate',
          'scan',
          'transport',
          'createRateManagedMeasurementSession',
        ]) {
          assert.equal(Reflect.get(session, forbidden), undefined)
        }
        const measurementPort = session.takeMeasurementPort()
        assert.deepEqual(Object.keys(measurementPort).sort(), [
          'measureConfiguration',
          'readDescribeTableRateEvidence',
        ])
        assert.deepEqual(
          measurementPort.readDescribeTableRateEvidence(),
          {
            version: 2,
            policyVersion: ratePolicy.policyVersion,
            attemptCount: 0,
            forfeitedAttemptCount: 0,
            throttleCount: 0,
            awsServiceThrottleCount: 0,
            rehearsalInjectedThrottleCount: 0,
            budgetStopCount: 0,
            operationalBudgetStopCount: 0,
            awsServiceThrottleBudgetStopCount: 0,
            rehearsalInjectedBudgetStopCount: 0,
            cadenceWaitCount: 0,
            cadenceWaitMilliseconds: 0,
            maximumInFlight: 0,
          },
        )
        await session.close()
        assert.equal(dynamoDbDestroyCount, 2)
        assert.equal(s3DestroyCount, 2)
        assert.equal(stsDestroyCount, 1)
        assert.equal(kmsDestroyCount, 1)
        return
      }
      case 'rate-construction': {
        const session = await createSession(createInput())
        assert.deepEqual(serviceOrder, ['sts', 'tags'])
        assert.ok(
          typeof capturedRateConstruction === 'object' &&
          capturedRateConstruction !== null,
        )
        assert.deepEqual(
          Reflect.get(capturedRateConstruction, 'recoveryTableNames'),
          [
            'root-project-directory',
            'root-work-items',
            'root-collaboration',
            'root-documents',
            'root-workspace-search',
            'root-migration-state',
          ],
        )
        assert.deepEqual(
          Reflect.get(capturedRateConstruction, 'allowedTableNames'),
          [
            'root-project-directory',
            'root-work-items',
            'root-collaboration',
            'root-documents',
            'root-workspace-search',
            'root-migration-state',
            'root-audit-events',
            'root-file-proofing',
            'root-work-item-configuration',
            'root-workspace-access',
          ],
        )
        assert.equal(
          Reflect.get(capturedRateConstruction, 'bootstrap'),
          true,
        )
        assert.equal(
          Reflect.get(
            capturedRateConstruction,
            'recoverInterruptedCleanup',
          ),
          false,
        )
        assert.equal(
          Reflect.get(
            capturedRateConstruction,
            'recoverInterruptedAttempt',
          ),
          false,
        )
        await session.close()
        return
      }
      default:
        throw new Error(`Unknown isolated scenario: ${scenario}`)
    }
  })
}

const workerScenario = process.env[workerScenarioEnvironmentName]
if (workerScenario !== undefined) {
  await executeWorkerScenario(workerScenario)
} else {
  describe('pre-permit root AWS composition', () => {
    test('does no AWS work for a disabled source-controlled target', async () => {
      await runIsolatedWorker('disabled-no-aws')
    })

    test('rejects wrong STS account or ARN before tags and checkpoint I/O', async () => {
      await runIsolatedWorker('wrong-identity')
    })

    test('rejects missing, duplicate, or mismatched journal tags before rate I/O', async () => {
      await runIsolatedWorker('wrong-tags')
    })

    test('fixes preflight order, recovery refusal, surface, and close ownership', async () => {
      await runIsolatedWorker('success-and-surface')
    })

    test('derives the exact six recovery names and exact ten allowlist', async () => {
      await runIsolatedWorker('rate-construction')
    })
  })
}
