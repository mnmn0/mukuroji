import { describe, expect, test } from 'bun:test'
import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  type TenantOperationExecutionJob,
} from '../../application/tenant-operation-resource-owner'
import {
  processTenantOperationResourceOwnerBatch,
  readTenantOperationExecutionJob,
} from './tenant-operation-resource-owner'

/** Creates one valid queue job for adapter tests. */
function createJob(): TenantOperationExecutionJob {
  return {
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    step: 'delete-data',
    cursor: {
      targetIndex: 3,
      position: 'opaque-position',
      processedCount: 40,
    },
  }
}

describe('tenant operation resource-owner SQS adapter', () => {
  test('normalizes an ID-only job and bounded cursor', () => {
    expect(readTenantOperationExecutionJob(JSON.stringify({
      ...createJob(),
      untrustedDestination: 'https://example.invalid/queue',
      cursor: {
        ...createJob().cursor,
        untrustedSecret: 'must-not-pass-through',
      },
    }))).toEqual(createJob())
  })

  test('rejects malformed identifiers, unsupported protocol versions, and unbounded cursors', () => {
    for (const value of [
      { ...createJob(), version: 3 },
      { ...createJob(), workspaceId: 'workspace with spaces' },
      {
        ...createJob(),
        cursor: { targetIndex: -1, processedCount: 0 },
      },
      {
        ...createJob(),
        cursor: {
          targetIndex: 0,
          processedCount: 0,
          position: 'x'.repeat(8_193),
        },
      },
    ]) {
      expect(() => readTenantOperationExecutionJob(JSON.stringify(value)))
        .toThrow(/job is invalid/u)
    }
  })

  test('rebases a previous target cursor after the removed table target', () => {
    expect(readTenantOperationExecutionJob(JSON.stringify({
      ...createJob(),
      version: 1,
      cursor: {
        targetIndex: 4,
        position: 'canonical-target-position',
        processedCount: 40,
      },
    }))).toEqual({
      ...createJob(),
      cursor: {
        targetIndex: 3,
        position: 'canonical-target-position',
        processedCount: 40,
      },
    })

    expect(readTenantOperationExecutionJob(JSON.stringify({
      ...createJob(),
      version: 1,
      cursor: {
        targetIndex: 0,
        position: 'removed-target-position',
        processedCount: 12,
      },
    }))).toEqual({
      ...createJob(),
      cursor: {
        targetIndex: 0,
        processedCount: 12,
      },
    })
  })

  test('returns only failed message identifiers for bounded SQS retry', async () => {
    const executed: TenantOperationExecutionJob[] = []
    const result = await processTenantOperationResourceOwnerBatch({
      Records: [
        { messageId: 'message-1', body: JSON.stringify(createJob()) },
        { messageId: 'message-2', body: '{invalid-json' },
      ],
    }, {
      async execute(job) {
        executed.push(job)
      },
    })

    expect(executed).toEqual([createJob()])
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-2' }],
    })
  })

  test('fails the whole invocation when a malformed record has no retry identity', async () => {
    await expect(processTenantOperationResourceOwnerBatch({
      Records: [{ body: '{invalid-json' }],
    }, {
      async execute() {},
    })).rejects.toMatchObject({
      code: 'TenantOperationExecutionJobInvalid',
      status: 400,
    })
  })
})
