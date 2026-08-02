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
    executorId: 'executor:tenant-operation-capability',
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

/** Creates one deterministic immutable evidence digest for handler tests. */
function createEvidenceReference(value: number): string {
  return `evidence:sha256:${value.toString(16).padStart(64, '0')}`
}
