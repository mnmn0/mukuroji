import { expect, test } from 'bun:test'
import {
  RuntimeControlBlockedError,
  createStaticRuntimeControlProvider,
} from '../infrastructure/runtime/runtime-control'
import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  type ExecuteTenantOperationInput,
  type TenantOperationExecutionJob,
} from '../modules/tenant-administration'
import {
  createTenantOperationExecutionEntrypoint,
  createTenantOperationResourceOwnerEntrypoint,
} from './tenant-operation-execution-handler'

const enabledRuntimeControl = {
  provider: createStaticRuntimeControlProvider('enabled'),
  recordObservation: () => undefined,
}

test('starts durable tenant operations only from DynamoDB stream records', async () => {
  const inputs: ExecuteTenantOperationInput[] = []
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute(input) {
        inputs.push(input)
      },
      async reconcileAuditRetention() {},
      async reconcileAuditEventRetention() {},
    }),
    enabledRuntimeControl,
  )

  const response = await handler({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'sequence-1',
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
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(inputs).toEqual([{
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    executorId: 'executor:tenant-operation-stream',
  }])
})

test('rejects direct commands before constructing the stream processor', async () => {
  let constructions = 0
  const handler = createTenantOperationExecutionEntrypoint(
    () => {
      constructions += 1
      return {
        async execute() {},
        async reconcileAuditRetention() {},
        async reconcileAuditEventRetention() {},
      }
    },
    enabledRuntimeControl,
  )

  await expect(handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
  })).rejects.toMatchObject({
    code: 'TenantOperationDirectInvocationDenied',
    status: 403,
  })
  expect(constructions).toBe(0)
})

test('runs a capability-isolated owner only from validated SQS records', async () => {
  const jobs: TenantOperationExecutionJob[] = []
  const handler = createTenantOperationResourceOwnerEntrypoint(
    () => ({
      async execute(job) {
        jobs.push(job)
      },
    }),
    enabledRuntimeControl,
  )

  const response = await handler({
    Records: [{
      messageId: 'message-1',
      body: JSON.stringify({
        version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
        workspaceId: 'workspace-1',
        operationId: 'operation-1',
        step: 'delete-secrets',
        callerQueueUrl: 'https://example.invalid/untrusted',
      }),
    }],
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(jobs).toEqual([{
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    step: 'delete-secrets',
  }])
})

test('rejects non-SQS resource-owner invocations before constructing AWS clients', async () => {
  let constructions = 0
  const handler = createTenantOperationResourceOwnerEntrypoint(
    () => {
      constructions += 1
      return { async execute() {} }
    },
    enabledRuntimeControl,
  )

  await expect(handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
  })).rejects.toMatchObject({
    code: 'TenantOperationResourceOwnerInvocationDenied',
    status: 403,
  })
  expect(constructions).toBe(0)
})

test('runtime control blocks resource-owner construction and side effects', async () => {
  let constructions = 0
  const handler = createTenantOperationResourceOwnerEntrypoint(
    () => {
      constructions += 1
      return { async execute() {} }
    },
    {
      provider: createStaticRuntimeControlProvider('disabled'),
      recordObservation: () => undefined,
    },
  )

  await expect(handler({ Records: [] })).rejects
    .toBeInstanceOf(RuntimeControlBlockedError)
  expect(constructions).toBe(0)
})
