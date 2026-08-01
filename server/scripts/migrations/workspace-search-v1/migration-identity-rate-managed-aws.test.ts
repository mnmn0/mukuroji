import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttributeValue,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import { STSClient } from '@aws-sdk/client-sts'
import {
  createAwsWorkspaceSearchMigrationRateManagedSession,
  type CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
} from './migration-identity-aws'
import type {
  WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'

const requestedAccount = '123456789012'

/** Exact requested resources accepted before the STS preflight. */
const requestedResources: WorkspaceSearchMigrationRequestedResources = {
  account: requestedAccount,
  region: 'ap-northeast-1',
  profile: 'rate-managed-production-test',
  commit: 'a'.repeat(40),
  tables: {
    'project-directory': 'rate-production-project-directory',
    'work-items': 'rate-production-work-items',
    collaboration: 'rate-production-collaboration',
    documents: 'rate-production-documents',
    'workspace-search': 'rate-production-workspace-search',
    'migration-state': 'rate-production-migration-state',
  },
  journalBucket: 'rate-production-journal-bucket',
  journalKeyArn:
    `arn:aws:kms:ap-northeast-1:${requestedAccount}:key/` +
    '11111111-2222-4333-8444-555555555555',
}

/** Exact policy that reserves the proven page baseline. */
const ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy = {
  policyVersion: 'b'.repeat(64),
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

/**
 * Runs one production factory test with an isolated static shared profile.
 *
 * @param task - Test operation that may resolve the selected profile.
 * @returns Exact task result after restoring process-level file selection.
 */
async function withStaticProductionProfile<Result>(
  task: () => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(
    join(tmpdir(), 'mukuroji-rate-production-profile-'),
  )
  const credentialsFile = join(directory, 'credentials')
  const configFile = join(directory, 'config')
  await writeFile(
    credentialsFile,
    `[${requestedResources.profile}]\n` +
      'aws_access_key_id = rate-managed-production-access-key\n' +
      'aws_secret_access_key = rate-managed-production-secret-key\n',
    { mode: 0o600 },
  )
  await writeFile(configFile, '', { mode: 0o600 })
  const previousCredentialsFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE
  const previousConfigFile = process.env.AWS_CONFIG_FILE
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile
  process.env.AWS_CONFIG_FILE = configFile
  try {
    return await task()
  } finally {
    if (previousCredentialsFile === undefined) {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE
    } else {
      process.env.AWS_SHARED_CREDENTIALS_FILE = previousCredentialsFile
    }
    if (previousConfigFile === undefined) {
      delete process.env.AWS_CONFIG_FILE
    } else {
      process.env.AWS_CONFIG_FILE = previousConfigFile
    }
    await rm(directory, { recursive: true, force: true })
  }
}

describe('production rate-managed AWS identity composition', () => {
  test('closes both owned transports when abort wins after rate construction', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    const originalDynamoDbDestroy = DynamoDBClient.prototype.destroy
    const abortController = new AbortController()
    const signal = abortController.signal
    const removeEventListener = signal.removeEventListener.bind(signal)
    let dynamoDbDestroyCount = 0
    Object.defineProperty(signal, 'removeEventListener', {
      configurable: true,
      value: (
        type: string,
        callback: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ): void => {
        removeEventListener(type, callback, options)
        if (
          type === 'abort' &&
          typeof callback === 'function' &&
          callback.name === 'interrupt'
        ) {
          abortController.abort()
        }
      },
    })
    Reflect.set(
      STSClient.prototype,
      'send',
      function (): unknown {
        return Promise.resolve({
          $metadata: {},
          Account: requestedAccount,
          Arn:
            `arn:aws:sts::${requestedAccount}:` +
            'assumed-role/migration-role/rate-managed-test',
          UserId: 'AROA12345678901234567:rate-managed-test',
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          return Promise.resolve({ $metadata: {} })
        }
        if (command instanceof TransactWriteItemsCommand) {
          return Promise.resolve({ $metadata: {} })
        }
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'destroy',
      function (): void {
        dynamoDbDestroyCount += 1
      },
    )
    try {
      await withStaticProductionProfile(async () => {
        await expect(
          createAwsWorkspaceSearchMigrationRateManagedSession({
            requested: requestedResources,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
            signal,
          }),
        ).rejects.toMatchObject({
          code: 'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
        })
      })
      expect(dynamoDbDestroyCount).toBe(2)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
      Reflect.set(
        DynamoDBClient.prototype,
        'destroy',
        originalDynamoDbDestroy,
      )
    }
  })

  test('shares rate accounting with a capability-narrow measurement child', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    let checkpointTransactionCount = 0
    let describeTableCount = 0
    let checkpointItem:
      Readonly<Record<string, AttributeValue>> | undefined
    Reflect.set(
      STSClient.prototype,
      'send',
      function (): unknown {
        return Promise.resolve({
          $metadata: {},
          Account: requestedAccount,
          Arn:
            `arn:aws:sts::${requestedAccount}:` +
            'assumed-role/migration-role/rate-managed-test',
          UserId: 'AROA12345678901234567:rate-managed-test',
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (...callArguments: unknown[]): unknown {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          return Promise.resolve({
            $metadata: {},
            ...(checkpointItem === undefined
              ? {}
              : { Item: structuredClone(checkpointItem) }),
          })
        }
        if (command instanceof TransactWriteItemsCommand) {
          const item = command.input.TransactItems?.[0]?.Put?.Item
          if (item === undefined) {
            return Promise.reject(
              new Error('expected-rate-checkpoint-put'),
            )
          }
          checkpointItem = structuredClone(item)
          checkpointTransactionCount += 1
          return Promise.resolve({ $metadata: {} })
        }
        if (command instanceof DescribeTableCommand) {
          describeTableCount += 1
          return Promise.resolve({ $metadata: {} })
        }
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    try {
      await withStaticProductionProfile(async () => {
        const session =
          await createAwsWorkspaceSearchMigrationRateManagedSession({
            requested: requestedResources,
            ratePolicy,
            bootstrapRateCheckpoint: true,
            recoverInterruptedCleanup: false,
            recoverInterruptedAttempt: false,
          })
        try {
          expect(checkpointTransactionCount).toBe(1)
          expect(session.readDescribeTableRateEvidence()).toMatchObject({
            attemptCount: 0,
          })
          const child = await session.createRateManagedMeasurementSession()
          expect(Object.isFrozen(child)).toBeTrue()
          expect(Object.keys(child).sort()).toEqual([
            'close',
            'describeContinuousBackups',
            'describeJournalKey',
            'describeTable',
            'describeTimeToLive',
            'getBucketEncryption',
            'getBucketLogging',
            'getBucketVersioning',
            'getObjectLockConfiguration',
            'measureConfiguration',
            'readCallerIdentity',
            'readRequestedResourcesBinding',
          ])
          const forbiddenCapabilities = [
            'acquireLease',
            'claimDescribeTableRateAfterLease',
            'createApplicationWriterFencePort',
            'createApplyOperationPort',
            'createExecutionBoundaryPort',
            'createExecutionRunPort',
            'createFullVerificationPort',
            'createPartialRollbackOperationPort',
            'createRateManagedMeasurementSession',
            'createRollbackOperationPort',
            'heartbeatLease',
            'interruptDescribeTableRate',
            'interruptMutationAdmission',
            'readAuthority',
            'readDescribeTableRateEvidence',
            'renewMaintenanceEvidence',
            'runWithMutationAdmissionGuard',
          ]
          for (const capability of forbiddenCapabilities) {
            expect(Reflect.get(child, capability)).toBeUndefined()
          }
          await expect(child.describeTable(
            requestedResources.tables['project-directory'],
          )).resolves.toEqual({ $metadata: {} })
          await child.close()
          await expect(session.describeTable(
            requestedResources.tables['work-items'],
          )).resolves.toEqual({ $metadata: {} })
          expect(session.readDescribeTableRateEvidence()).toMatchObject({
            attemptCount: 2,
          })
        } finally {
          await session.close()
        }
      })
      expect(describeTableCount).toBe(2)
      expect(checkpointTransactionCount).toBe(5)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })

  test('snapshots every factory field before the STS await', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    let resolveSts = (_value: unknown): void => {}
    const stsResponse = new Promise<unknown>((resolve) => {
      resolveSts = resolve
    })
    let stsStarted = (): void => {}
    const observedStsStart = new Promise<void>((resolve) => {
      stsStarted = resolve
    })
    let changed = false
    const readCounts = new Map<string, number>()
    const recordRead = (name: string): void => {
      readCounts.set(name, (readCounts.get(name) ?? 0) + 1)
    }
    const aborted = new AbortController()
    aborted.abort()
    const input: CreateAwsWorkspaceSearchMigrationRateManagedSessionInput = {
      get requested() {
        recordRead('requested')
        return changed
          ? { ...requestedResources, account: '999999999999' }
          : requestedResources
      },
      get ratePolicy() {
        recordRead('ratePolicy')
        return changed
          ? { ...ratePolicy, checkpointPageAttemptCapacity: 1 }
          : ratePolicy
      },
      get bootstrapRateCheckpoint() {
        recordRead('bootstrapRateCheckpoint')
        return !changed
      },
      get recoverInterruptedCleanup() {
        recordRead('recoverInterruptedCleanup')
        return changed
      },
      get recoverInterruptedAttempt() {
        recordRead('recoverInterruptedAttempt')
        return changed
      },
      get rateRecorder() {
        recordRead('rateRecorder')
        return undefined
      },
      get prePlanAuthorityClock() {
        recordRead('prePlanAuthorityClock')
        return undefined
      },
      get signal() {
        recordRead('signal')
        return changed ? aborted.signal : undefined
      },
    }
    let checkpointTransportCallCount = 0
    Reflect.set(
      STSClient.prototype,
      'send',
      function (): unknown {
        stsStarted()
        return stsResponse
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (): unknown {
        checkpointTransportCallCount += 1
        return Promise.reject(new Error('unexpected-checkpoint-call'))
      },
    )
    try {
      const creating =
        createAwsWorkspaceSearchMigrationRateManagedSession(input)
      await observedStsStart
      changed = true
      resolveSts({
        $metadata: {},
        Account: '999999999999',
        Arn:
          'arn:aws:sts::999999999999:' +
          'assumed-role/migration-role/rate-managed-test',
        UserId: 'AROA12345678901234567:rate-managed-test',
      })

      await expect(creating).rejects.toMatchObject({
        code: 'IDENTITY_MISMATCH',
      })
      expect(readCounts.size).toBe(8)
      expect([...readCounts.values()]).toEqual(
        Array.from({ length: readCounts.size }, () => 1),
      )
      expect(checkpointTransportCallCount).toBe(0)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })

  test('performs zero checkpoint calls when STS reports another account', async () => {
    const originalStsSend = STSClient.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    let checkpointTransportCallCount = 0
    Reflect.set(
      STSClient.prototype,
      'send',
      function (): unknown {
        return Promise.resolve({
          $metadata: {},
          Account: '999999999999',
          Arn:
            'arn:aws:sts::999999999999:' +
            'assumed-role/migration-role/rate-managed-test',
          UserId: 'AROA12345678901234567:rate-managed-test',
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      function (): unknown {
        checkpointTransportCallCount += 1
        return Promise.reject(new Error('unexpected-checkpoint-call'))
      },
    )
    try {
      await expect(
        createAwsWorkspaceSearchMigrationRateManagedSession({
          requested: requestedResources,
          ratePolicy,
          bootstrapRateCheckpoint: true,
          recoverInterruptedCleanup: false,
          recoverInterruptedAttempt: false,
        }),
      ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
      expect(checkpointTransportCallCount).toBe(0)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
    }
  })
})
