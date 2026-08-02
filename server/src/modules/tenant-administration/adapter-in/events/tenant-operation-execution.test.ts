import { expect, test } from 'bun:test'
import type { ExecuteTenantOperationInput } from '../../application/tenant-operation-executor'
import {
  processTenantOperationExecutionBatch,
  readRequestedTenantOperation,
  readTenantRetentionWorkspace,
} from './tenant-operation-execution'

test('starts only a matching requested operation stream record', () => {
  const input = readRequestedTenantOperation({
    eventName: 'INSERT',
    dynamodb: {
      NewImage: {
        kind: { S: 'operation' },
        workspaceId: { S: 'workspace-1' },
        recordKey: { S: 'OPERATION#operation-1' },
        payload: {
          S: JSON.stringify({
            workspaceId: 'workspace-1',
            operationId: 'operation-1',
            status: 'requested',
          }),
        },
      },
    },
  })

  expect(input).toEqual({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    executorId: 'executor:tenant-operation-stream',
  })
})

test('routes active retention jobs to the bounded reconciliation processor', async () => {
  const executionInputs: ExecuteTenantOperationInput[] = []
  const retentionWorkspaces: string[] = []
  const result = await processTenantOperationExecutionBatch({
    Records: [{
      eventName: 'MODIFY',
      dynamodb: {
        SequenceNumber: 'sequence-1',
        NewImage: {
          kind: { S: 'retention-job' },
          recordKey: { S: 'RETENTION_JOB' },
          status: { S: 'running' },
          workspaceId: { S: 'workspace-1' },
        },
      },
    }],
  }, {
    async execute(input) {
      executionInputs.push(input)
    },
    async reconcileAuditRetention(workspaceId) {
      retentionWorkspaces.push(workspaceId)
    },
  })

  expect(result).toEqual({ batchItemFailures: [] })
  expect(executionInputs).toEqual([])
  expect(retentionWorkspaces).toEqual(['workspace-1'])
  expect(readTenantRetentionWorkspace({ eventName: 'REMOVE' })).toBeUndefined()
})

test('returns the failed stream checkpoint when execution fails', async () => {
  const result = await processTenantOperationExecutionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'sequence-2',
        NewImage: {
          kind: { S: 'operation' },
          workspaceId: { S: 'workspace-1' },
          recordKey: { S: 'OPERATION#operation-1' },
          payload: {
            S: JSON.stringify({
              workspaceId: 'workspace-1',
              operationId: 'operation-1',
              status: 'requested',
            }),
          },
        },
      },
    }],
  }, {
    async execute() {
      throw new Error('temporary failure')
    },
    async reconcileAuditRetention() {},
  })

  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: 'sequence-2' }],
  })
})

test('fails closed instead of acknowledging a malformed operation row', async () => {
  let executions = 0
  const result = await processTenantOperationExecutionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'sequence-malformed',
        NewImage: {
          kind: { S: 'operation' },
          workspaceId: { S: 'workspace-1' },
          recordKey: { S: 'OPERATION#operation-1' },
          payload: { S: '{not-json' },
        },
      },
    }],
  }, {
    async execute() {
      executions += 1
    },
    async reconcileAuditRetention() {},
  })

  expect(executions).toBe(0)
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: 'sequence-malformed' }],
  })
})
