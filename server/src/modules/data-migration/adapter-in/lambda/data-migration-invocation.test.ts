import { describe, expect, test } from 'bun:test'
import {
  createManualClock,
  createMemoryCheckpointStore,
  createMemoryRowStore,
  createPendingTaskRow,
  createTaskEstimateMigration,
} from '../../test-support/data-migration-fakes'
import type { DataMigrationOperatorProofRequest } from '../../application/ports/data-migration-ports'
import {
  computeDataMigrationRequestBinding,
  handleDataMigrationInvocation,
  parseDataMigrationInvocation,
  type DataMigrationInvocationContext,
  type DataMigrationInvocationDependencies,
  type DataMigrationInvocationRequest,
} from './data-migration-invocation'

/** Operator ARN the fake verifier returns. */
const OPERATOR = 'arn:aws:sts::123456789012:assumed-role/migration-operator/alice'

/** Invocation facts used by every test. */
const context: DataMigrationInvocationContext = {
  requestId: 'request-1',
  functionName: 'Mukuroji-DataMigrationFunction',
  accountId: '123456789012',
  remainingMilliseconds: 15 * 60 * 1000,
}

/**
 * Builds adapter dependencies over in-memory stores.
 *
 * @param overrides - Fields to replace.
 * @returns The dependencies, stores and captured calls.
 */
function createDependencies(overrides: Partial<DataMigrationInvocationDependencies> = {}) {
  const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
  const checkpointStore = createMemoryCheckpointStore()
  const auditLines: string[] = []
  const proofs: DataMigrationOperatorProofRequest[] = []
  const storeRequests: unknown[] = []
  const dependencies: DataMigrationInvocationDependencies = {
    registry: [createTaskEstimateMigration()],
    targetTables: new Map([['work-items', 'Mukuroji-WorkItemsTable']]),
    checkpointTableName: 'Mukuroji-DataMigrationCheckpointTable',
    createStores: async (request) => {
      storeRequests.push({ ...request })
      return { rowStore, checkpointStore }
    },
    verifyOperator: async (request) => {
      proofs.push(request)
      return OPERATOR
    },
    clock: createManualClock(),
    createRunId: () => 'run-1',
    writeAuditLog: (line) => auditLines.push(line),
    ...overrides,
  }
  return { dependencies, rowStore, checkpointStore, auditLines, proofs, storeRequests }
}

/** Proof carried by the applying payload. */
const PROOF = 'https://sts.ap-northeast-1.amazonaws.com/?Action=GetCallerIdentity'

/** Applying payload with a proof. */
const applyPayload: DataMigrationInvocationRequest = {
  command: 'run',
  migrationId: '0001-task-estimate-points',
  apply: true,
  segments: 1,
  nonce: '6b0f3c39-3f0c-4e43-8f0a-111111111111',
  operatorProof: PROOF,
}

describe('parseDataMigrationInvocation', () => {
  test('accepts each command with its own fields only', () => {
    expect(parseDataMigrationInvocation({ command: 'list' })).toEqual({ command: 'list' })
    expect(parseDataMigrationInvocation({ command: 'list', migrationId: 'x' })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'verify', migrationId: 'x' })).toEqual({ command: 'verify', migrationId: 'x' })
    expect(parseDataMigrationInvocation({ command: 'verify', migrationId: 'x', apply: true })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'run', migrationId: 'x' })).toEqual({ command: 'run', migrationId: 'x' })
    expect(parseDataMigrationInvocation({ command: 'run' })).toBeUndefined()
    expect(parseDataMigrationInvocation(applyPayload)).toEqual(applyPayload)
  })

  test('requires a nonce and a proof exactly when applying', () => {
    expect(parseDataMigrationInvocation({ ...applyPayload, operatorProof: undefined })).toBeUndefined()
    expect(parseDataMigrationInvocation({ ...applyPayload, nonce: undefined })).toBeUndefined()
    expect(parseDataMigrationInvocation({ ...applyPayload, apply: false })).toBeUndefined()
  })

  test('rejects unknown fields, physical table names and out-of-range bounds', () => {
    expect(parseDataMigrationInvocation({ command: 'run', migrationId: 'x', tableName: 'other' })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'run', migrationId: 'x', segments: 65 })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'run', migrationId: 'x', pageSize: 101 })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'run', migrationId: 'x', maxWritesPerSecond: 0 })).toBeUndefined()
    expect(parseDataMigrationInvocation({ command: 'drop' })).toBeUndefined()
    expect(parseDataMigrationInvocation('run')).toBeUndefined()
  })
})

describe('computeDataMigrationRequestBinding', () => {
  test('changes with every parameter that changes the invocation', () => {
    const base = computeDataMigrationRequestBinding(context.functionName, applyPayload)
    expect(base).toMatch(/^[0-9a-f]{64}$/u)
    expect(computeDataMigrationRequestBinding(context.functionName, { ...applyPayload, operatorProof: 'other' })).toBe(base)
    for (const changed of [
      { ...applyPayload, migrationId: '0002-other' },
      { ...applyPayload, segments: 2 },
      { ...applyPayload, maxPages: 1 },
      { ...applyPayload, nonce: '6b0f3c39-3f0c-4e43-8f0a-222222222222' },
    ]) {
      expect(computeDataMigrationRequestBinding(context.functionName, changed)).not.toBe(base)
    }
    expect(computeDataMigrationRequestBinding('Other-DataMigrationFunction', applyPayload)).not.toBe(base)
  })
})

describe('handleDataMigrationInvocation', () => {
  test('lists the registered migrations', async () => {
    const { dependencies } = createDependencies()
    const response = await handleDataMigrationInvocation({ command: 'list' }, context, dependencies)
    expect(response).toMatchObject({ operation: 'list', migrations: [{ id: '0001-task-estimate-points', table: 'work-items' }] })
  })

  test('dry-runs without a proof and writes nothing', async () => {
    const { dependencies, rowStore, checkpointStore, proofs, storeRequests } = createDependencies()
    const response = await handleDataMigrationInvocation(
      { command: 'run', migrationId: '0001-task-estimate-points', segments: 1 },
      context,
      dependencies,
    )
    expect(response).toMatchObject({ operation: 'run', mode: 'dry-run', status: 'completed', counters: { migrated: 3 } })
    expect(rowStore.replaceCalls).toBe(0)
    expect(checkpointStore.checkpoints.size).toBe(0)
    expect(proofs).toEqual([])
    expect(storeRequests).toEqual([{
      tableName: 'Mukuroji-WorkItemsTable',
      checkpointTableName: 'Mukuroji-DataMigrationCheckpointTable',
      segments: 1,
    }])
  })

  test('applies as the verified operator and records it in the run record and the audit log', async () => {
    const { dependencies, checkpointStore, proofs, auditLines } = createDependencies()
    const response = await handleDataMigrationInvocation(applyPayload, context, dependencies)
    expect(response).toMatchObject({ operation: 'run', mode: 'apply', status: 'completed', counters: { migrated: 3 } })
    expect(proofs).toEqual([{
      proof: PROOF,
      binding: computeDataMigrationRequestBinding(context.functionName, applyPayload),
      accountId: '123456789012',
    }])
    expect([...checkpointStore.runs.values()].map((run) => [run.operator, run.status])).toEqual([[OPERATOR, 'completed']])
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? '{}')
    expect(audit).toMatchObject({
      type: 'data-migration.invocation',
      requestId: 'request-1',
      operation: 'run',
      mode: 'apply',
      operator: OPERATOR,
      status: 'completed',
    })
    expect(auditLines[0]).not.toContain('sts.ap-northeast-1')
    expect(auditLines[0]).not.toContain('Mukuroji-WorkItemsTable')
  })

  test('refuses an applying run whose operator cannot be verified, before touching any store', async () => {
    const { dependencies, storeRequests, auditLines } = createDependencies({
      verifyOperator: async () => {
        throw new Error('STS_REJECTED')
      },
    })
    const response = await handleDataMigrationInvocation(applyPayload, context, dependencies)
    expect(response).toEqual({ operation: 'run', status: 'error', code: 'OPERATOR_UNVERIFIED' })
    expect(storeRequests).toEqual([])
    expect(JSON.parse(auditLines[0] ?? '{}')).toMatchObject({ code: 'OPERATOR_UNVERIFIED', mode: 'apply', reason: 'STS_REJECTED' })
  })

  test('refuses an unknown migration and a table outside the allowlist', async () => {
    const { dependencies } = createDependencies({ targetTables: new Map() })
    expect(await handleDataMigrationInvocation(
      { command: 'verify', migrationId: '9999-missing' }, context, dependencies,
    )).toEqual({ operation: 'verify', status: 'error', code: 'MIGRATION_NOT_FOUND' })
    expect(await handleDataMigrationInvocation(
      { command: 'verify', migrationId: '0001-task-estimate-points' }, context, dependencies,
    )).toEqual({ operation: 'verify', status: 'error', code: 'TABLE_NOT_CONFIGURED' })
    expect(await handleDataMigrationInvocation({ command: 'drop' }, context, dependencies))
      .toEqual({ operation: 'unknown', status: 'error', code: 'INVALID_REQUEST' })
  })

  test('moves the deadline earlier by the worst-case write time of one page', async () => {
    const { dependencies } = createDependencies()
    // 3 rows per page at 1 write/s may take 9 s with retries: 69 s left is not enough for another page.
    const tight = { ...context, remainingMilliseconds: 68_000 }
    const paused = await handleDataMigrationInvocation(
      { ...applyPayload, pageSize: 3, maxWritesPerSecond: 1 }, tight, dependencies,
    )
    expect(paused).toMatchObject({ status: 'paused', pagesRead: 0 })
    const enough = { ...context, remainingMilliseconds: 70_000 }
    const completed = await handleDataMigrationInvocation(
      { ...applyPayload, pageSize: 3, maxWritesPerSecond: 1 }, enough, dependencies,
    )
    expect(completed).toMatchObject({ status: 'completed' })
  })

  test('pauses before the Lambda limit and verifies after resuming', async () => {
    const { dependencies } = createDependencies()
    const nearLimit = { ...context, remainingMilliseconds: 30_000 }
    const paused = await handleDataMigrationInvocation(applyPayload, nearLimit, dependencies)
    expect(paused).toMatchObject({ status: 'paused', pagesRead: 0 })
    const resumed = await handleDataMigrationInvocation(applyPayload, context, dependencies)
    expect(resumed).toMatchObject({ status: 'completed' })
    const verified = await handleDataMigrationInvocation(
      { command: 'verify', migrationId: '0001-task-estimate-points', segments: 1 }, context, dependencies,
    )
    expect(verified).toMatchObject({ operation: 'verify', status: 'pass', migratedRows: 3 })
  })

  test('drops a verifier message that is not a reason code from the audit log', async () => {
    const { dependencies, auditLines } = createDependencies({
      verifyOperator: async () => {
        throw new Error('https://sts.example/?X-Amz-Signature=secret')
      },
    })
    await handleDataMigrationInvocation(applyPayload, context, dependencies)
    expect(auditLines[0]).not.toContain('secret')
    expect(JSON.parse(auditLines[0] ?? '{}')).not.toHaveProperty('reason')
  })

  test('reports a store failure with its code and no raw error', async () => {
    const { dependencies } = createDependencies({
      createStores: async () => {
        throw new Error('secret table detail')
      },
    })
    const response = await handleDataMigrationInvocation(
      { command: 'verify', migrationId: '0001-task-estimate-points' }, context, dependencies,
    )
    expect(response).toEqual({ operation: 'verify', status: 'error', code: 'UPSTREAM_FAILURE' })
  })
})
