import { expect, test } from 'bun:test'
import { createStaticRuntimeControlProvider } from '../infrastructure/runtime/runtime-control'
import type { ExecuteTenantOperationInput } from '../modules/tenant-administration'
import { createTenantOperationExecutionEntrypoint } from './tenant-operation-execution-handler'

test('binds direct proof commands to a server-owned executor identity', async () => {
  const inputs: ExecuteTenantOperationInput[] = []
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute(input) {
        inputs.push(input)
        return { accepted: true }
      },
      async reconcileAuditRetention() {},
      async reconcileAuditEventRetention() {},
    }),
    {
      provider: createStaticRuntimeControlProvider('enabled'),
      recordObservation: () => undefined,
    },
    {
      executorId: 'executor:tenant-export',
      allowedSteps: ['snapshot', 'prepare-artifact', 'verify-artifact', 'export'],
    },
  )

  await expect(handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    executorId: 'executor:spoofed-caller',
    proof: {
      step: 'snapshot',
      evidenceReference: createEvidenceReference(1),
    },
  })).resolves.toEqual({ accepted: true })
  expect(inputs).toEqual([{
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    executorId: 'executor:tenant-export',
    allowedSteps: ['snapshot', 'prepare-artifact', 'verify-artifact', 'export'],
    proof: {
      step: 'snapshot',
      evidenceReference: createEvidenceReference(1),
    },
  }])
})

test('rejects mutable or location-only evidence references', async () => {
  let executionCalls = 0
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute() {
        executionCalls += 1
      },
      async reconcileAuditRetention() {},
      async reconcileAuditEventRetention() {},
    }),
    {
      provider: createStaticRuntimeControlProvider('enabled'),
      recordObservation: () => undefined,
    },
    {
      executorId: 'executor:tenant-export',
      allowedSteps: ['snapshot'],
    },
  )

  await expect(handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    proof: {
      step: 'snapshot',
      evidenceReference: 's3://bucket/current-export.json',
    },
  })).rejects.toMatchObject({
    code: 'TenantOperationEvidenceInvalid',
    status: 400,
  })
  expect(executionCalls).toBe(0)
})

test('rejects direct commands on the stream-only worker boundary', async () => {
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute() {},
      async reconcileAuditRetention() {},
      async reconcileAuditEventRetention() {},
    }),
    {
      provider: createStaticRuntimeControlProvider('enabled'),
      recordObservation: () => undefined,
    },
  )

  await expect(handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    proof: {
      step: 'snapshot',
      evidenceReference: createEvidenceReference(2),
    },
  })).rejects.toMatchObject({
    code: 'TenantOperationDirectInvocationDenied',
    status: 403,
  })
})

test('rejects forged stream events on a direct capability boundary', async () => {
  let executionCalls = 0
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute() {
        executionCalls += 1
      },
      async reconcileAuditRetention() {
        executionCalls += 1
      },
      async reconcileAuditEventRetention() {
        executionCalls += 1
      },
    }),
    {
      provider: createStaticRuntimeControlProvider('enabled'),
      recordObservation: () => undefined,
    },
    {
      executorId: 'executor:tenant-export',
      allowedSteps: ['snapshot'],
    },
  )

  await expect(handler({ Records: [] })).rejects.toMatchObject({
    code: 'TenantOperationStreamInvocationDenied',
    status: 403,
  })
  expect(executionCalls).toBe(0)
})

test('accepts a safe terminal failure through the bound capability', async () => {
  const inputs: ExecuteTenantOperationInput[] = []
  const handler = createTenantOperationExecutionEntrypoint(
    () => ({
      async execute(input) {
        inputs.push(input)
        return { accepted: true }
      },
      async reconcileAuditRetention() {},
      async reconcileAuditEventRetention() {},
    }),
    {
      provider: createStaticRuntimeControlProvider('enabled'),
      recordObservation: () => undefined,
    },
    {
      executorId: 'executor:tenant-secret-deletion',
      allowedSteps: ['delete-secrets'],
    },
  )

  await handler({
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    failureCode: 'SECRET_REVOCATION_FAILED',
  })

  expect(inputs).toEqual([{
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    executorId: 'executor:tenant-secret-deletion',
    allowedSteps: ['delete-secrets'],
    failureCode: 'SECRET_REVOCATION_FAILED',
  }])
})

/** Creates one deterministic immutable evidence digest for handler tests. */
function createEvidenceReference(value: number): string {
  return `evidence:sha256:${value.toString(16).padStart(64, '0')}`
}
