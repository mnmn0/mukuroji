import { describe, expect, test } from 'bun:test'
import type { S3Client } from '@aws-sdk/client-s3'
import type { SQSClient } from '@aws-sdk/client-sqs'
import {
  S3WorkItemImportSourceStore,
  SqsWorkItemImportQueue,
  createDefaultWorkItemImportExecutionStore,
  createDefaultWorkItemImportQueue,
  createDefaultWorkItemImportSourceStore,
} from './work-item-import-aws'
import {
  WorkItemImportError,
  createWorkItemImportJobId,
  processWorkItemImportBatch,
  requestWorkItemImportCancellation,
  stageWorkItemImport,
  type WorkItemImportExecution,
  type WorkItemImportRowReceipt,
  type WorkItemImportWorkerDependencies,
} from './work-item-import'

describe('durable Work Item import', () => {
  test('stages a hashed immutable source and enqueues only a job locator', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-1')
    const request = createStageRequest(jobId)

    const first = await stageWorkItemImport(request, fixture)
    const replay = await stageWorkItemImport(request, fixture)

    expect(replay.jobId).toBe(first.jobId)
    expect(first.source).toMatchObject({
      byteLength: Buffer.byteLength(request.sourceContent),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(fixture.queued).toEqual([
      { workspaceId: 'workspace-1', jobId },
      { workspaceId: 'workspace-1', jobId },
    ])
    expect(JSON.stringify(fixture.queued)).not.toContain('Ship durable import')
    expect(JSON.stringify(first)).not.toContain('request-1')
  })

  test('resumes from a durable row receipt without duplicating completed rows', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-resume')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    let failSecondRow = true
    const created: Array<{ row: number; idempotencyKey: string; workItemId: string }> = []
    const dependencies = createWorkerDependencies(fixture, {
      async createWorkItem(request) {
        if (request.row === 2 && failSecondRow) {
          failSecondRow = false
          throw new Error('temporary write outage')
        }
        created.push({
          row: request.row,
          idempotencyKey: request.idempotencyKey,
          workItemId: request.workItemId,
        })
      },
    })

    const first = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)
    const second = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)

    expect(first.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }])
    expect(second).toEqual({ batchItemFailures: [] })
    expect(created.map((entry) => entry.row)).toEqual([1, 2])
    expect(created[0]?.idempotencyKey).toBe(created[0]?.workItemId)
    expect(fixture.execution?.checkpointRow).toBe(2)
    expect(fixture.execution?.status).toBe('completed')
    expect(fixture.execution?.terminalReport).toEqual({
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      errors: [],
    })
    expect(JSON.stringify(fixture.execution?.terminalReport)).not.toContain('member@example.com')
    expect(JSON.stringify(fixture.execution?.terminalReport)).not.toContain('Ship durable import')
    expect(fixture.jobEvents).toEqual(['running', 'running', 'completed'])
    expect(fixture.deletedSources).toBe(1)
  })

  test('revalidates creator/team/project access before every row', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-rbac')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    let authorizations = 0
    const dependencies = createWorkerDependencies(fixture, {
      async authorize() {
        authorizations += 1
      },
    })

    await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)

    expect(authorizations).toBe(3)
  })

  test('stops materialization when the current management role is demoted', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-demoted')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    let role: 'admin' | 'member' = 'admin'
    const createdRows: number[] = []
    const dependencies = createWorkerDependencies(fixture, {
      async authorize() {
        if (role === 'member') {
          throw new WorkItemImportError(
            'ImportManagementAccessRevoked',
            'Import management access is no longer available.',
          )
        }
      },
      async createWorkItem(request) {
        createdRows.push(request.row)
        role = 'member'
      },
    })

    const response = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)

    expect(response).toEqual({ batchItemFailures: [] })
    expect(createdRows).toEqual([1])
    expect(fixture.execution?.status).toBe('failed')
    expect(fixture.execution?.terminalReport).toMatchObject({
      totalRows: 2,
      validRows: 1,
      invalidRows: 1,
      errors: [{ row: 2, code: 'ImportManagementAccessRevoked' }],
    })
    expect(fixture.jobReports).toHaveLength(1)
    expect(fixture.jobEvents).toEqual(['running', 'failed:validation_failed'])
  })

  test('stops materialization when tenant closure begins between rows', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId(
      'workspace-1',
      'member@example.com',
      'request-closing',
    )
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    let enabled = true
    const createdRows: number[] = []
    const dependencies = createWorkerDependencies(fixture, {
      async assertTenantEnabled() {
        if (!enabled) {
          throw new WorkItemImportError(
            'ImportTenantUnavailable',
            'The tenant can no longer execute imports.',
          )
        }
      },
      async createWorkItem(request) {
        createdRows.push(request.row)
        enabled = false
      },
    })

    const response = await processWorkItemImportBatch(
      createSqsEvent(jobId),
      dependencies,
    )

    expect(response).toEqual({ batchItemFailures: [] })
    expect(createdRows).toEqual([1])
    expect(fixture.execution?.status).toBe('failed')
    expect(fixture.execution?.terminalReport).toMatchObject({
      validRows: 1,
      invalidRows: 1,
      errors: [{ row: 2, code: 'ImportTenantUnavailable' }],
    })
  })

  test('persists a bounded row report when asynchronous validation fails', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-invalid')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    const dependencies = createWorkerDependencies(fixture, {
      async validate() {
        return {
          report: {
            valid: false,
            totalRows: 1,
            validRows: 0,
            invalidRows: 1,
            errors: [{
              row: 1,
              code: 'WorkspaceAssigneeInactive',
              message: 'Only active Workspace members can be assigned.',
              field: 'assigneeUserId',
            }],
            sample: [{
              row: 1,
              input: { Assignee: 'removed@example.com', Title: 'Private launch' },
              mapped: { assigneeUserId: 'removed@example.com', title: 'Private launch' },
              valid: false,
              errors: [],
            }],
          },
          rows: [],
        }
      },
    })

    const response = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)

    expect(response).toEqual({ batchItemFailures: [] })
    expect(fixture.execution?.status).toBe('failed')
    expect(fixture.execution?.terminalReport).toEqual({
      totalRows: 1,
      validRows: 0,
      invalidRows: 1,
      errors: [{
        row: 1,
        code: 'WorkspaceAssigneeInactive',
        message: 'Only active Workspace members can be assigned.',
        field: 'assigneeUserId',
      }],
    })
    expect(fixture.jobReports).toHaveLength(1)
    expect(fixture.jobReports[0]).toEqual(fixture.execution!.terminalReport!)
    expect(JSON.stringify(fixture.execution?.terminalReport)).not.toContain('removed@example.com')
    expect(JSON.stringify(fixture.execution?.terminalReport)).not.toContain('Private launch')
  })

  test('cooperatively cancels queued work and removes the immutable source', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-cancel')
    await stageWorkItemImport(createStageRequest(jobId), fixture)

    const cancelled = await requestWorkItemImportCancellation(
      'workspace-1',
      jobId,
      createWorkerDependencies(fixture),
    )

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelRequested).toBe(true)
    expect(fixture.jobEvents).toEqual(['cancelled'])
    expect(fixture.deletedSources).toBe(1)
  })

  test('reconciles completion instead of cancelling when completion wins the race', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-cancel-race')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    const dependencies = createWorkerDependencies(fixture)
    dependencies.executions = {
      ...dependencies.executions,
      async requestCancellation() {
        return {
          ...fixture.execution!,
          status: 'completed' as const,
          terminalReport: {
            totalRows: 2,
            validRows: 2,
            invalidRows: 0,
            errors: [],
          },
        }
      },
    }

    const result = await requestWorkItemImportCancellation(
      'workspace-1',
      jobId,
      dependencies,
    )

    expect(result.status).toBe('completed')
    expect(fixture.jobEvents).toEqual(['completed'])
    expect(fixture.jobEvents).not.toContain('cancelled')
    expect(fixture.deletedSources).toBe(1)
  })

  test('replays durable completion after public lifecycle persistence crashes', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-reconcile')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    const dependencies = createWorkerDependencies(fixture)
    let failCompletion = true
    const markCompleted = dependencies.jobs.markCompleted
    dependencies.jobs = {
      ...dependencies.jobs,
      async markCompleted(execution, report) {
        if (failCompletion) {
          failCompletion = false
          throw new Error('public lifecycle persistence unavailable')
        }
        await markCompleted(execution, report)
      },
    }

    const first = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)
    expect(first).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] })
    expect(fixture.execution?.status).toBe('completed')
    expect(fixture.jobEvents).toEqual(['running'])
    expect(fixture.deletedSources).toBe(0)

    const replay = await processWorkItemImportBatch(createSqsEvent(jobId), dependencies)
    expect(replay).toEqual({ batchItemFailures: [] })
    expect(fixture.jobEvents).toEqual(['running', 'completed'])
    expect(fixture.deletedSources).toBe(1)
  })

  test('marks retry exhaustion failed while retaining the message for DLQ diagnostics', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-dlq')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    const response = await processWorkItemImportBatch(
      createSqsEvent(jobId, '5'),
      createWorkerDependencies(fixture, {
        async authorize() {
          throw new Error('dependency unavailable')
        },
      }),
    )

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    })
    expect(fixture.execution?.status).toBe('failed')
    expect(fixture.jobEvents).toEqual(['running', 'failed:temporarily_unavailable'])
    expect(fixture.deletedSources).toBe(1)
  })

  test('does not terminalize an exhausted duplicate after its worker lease is lost', async () => {
    const fixture = createFixture()
    const jobId = createWorkItemImportJobId('workspace-1', 'member@example.com', 'request-stale')
    await stageWorkItemImport(createStageRequest(jobId), fixture)
    const dependencies = createWorkerDependencies(fixture, {
      async authorize() {
        throw new Error('dependency unavailable')
      },
    })
    dependencies.executions = {
      ...dependencies.executions,
      async markFailedIfClaimed() {
        return false
      },
    }

    const response = await processWorkItemImportBatch(
      createSqsEvent(jobId, '5'),
      dependencies,
    )

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    })
    expect(fixture.execution?.status).toBe('running')
    expect(fixture.jobEvents).toEqual(['running'])
    expect(fixture.deletedSources).toBe(0)
  })
})

test('S3 source store pins encryption, checksum, version and verifies downloaded bytes', async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const content = 'Title\nShip durable import\n'
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'version-1' }
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          ContentLength: Buffer.byteLength(content),
          Body: {
            async transformToByteArray() {
              return new TextEncoder().encode(content)
            },
          },
        }
      }
      return {}
    },
  } as unknown as S3Client
  const store = new S3WorkItemImportSourceStore(client, 'import-bucket')
  const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    .then((digest) => Buffer.from(digest).toString('hex'))
  const locator = await store.putImmutable({
    workspaceId: 'workspace-1',
    jobId: 'import_job-1',
    content,
    sha256,
    byteLength: Buffer.byteLength(content),
    expiresAt: '2026-07-25T00:00:00.000Z',
  })

  expect(commands[0]).toMatchObject({
    name: 'PutObjectCommand',
    input: {
      Bucket: 'import-bucket',
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: expect.any(String),
    },
  })
  expect(locator.objectVersionId).toBe('version-1')
  expect(await store.getVerified(locator, {
    workspaceId: 'workspace-1',
    jobId: 'import_job-1',
  })).toBe(content)
  expect(commands[1]).toMatchObject({
    name: 'GetObjectCommand',
    input: { VersionId: 'version-1', ChecksumMode: 'ENABLED' },
  })
  await expect(store.getVerified({
    ...locator,
    objectKey: 'work-item-imports/foreign/import_job-1/source',
  }, {
    workspaceId: 'workspace-1',
    jobId: 'import_job-1',
  })).rejects.toMatchObject({ code: 'ImportSourceLocatorInvalid' })
})

test('S3 source store refreshes a stale matching version before staging a retry', async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const content = 'Title\nShip durable import\n'
  const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    .then((digest) => Buffer.from(digest).toString('hex'))
  let putCount = 0
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'PutObjectCommand') {
        putCount += 1
        if (putCount === 1) {
          throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
        }
        return { VersionId: 'version-refreshed' }
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          VersionId: 'version-stale',
          LastModified: new Date('2026-06-01T00:00:00.000Z'),
          Metadata: {
            'mukuroji-sha256': sha256,
            'mukuroji-byte-length': String(Buffer.byteLength(content)),
            'mukuroji-expires-at': '2026-06-16T00:00:00.000Z',
          },
        }
      }
      return {}
    },
  } as unknown as S3Client
  const store = new S3WorkItemImportSourceStore(client, 'import-bucket')

  const locator = await store.putImmutable({
    workspaceId: 'workspace-1',
    jobId: 'import_job-1',
    content,
    sha256,
    byteLength: Buffer.byteLength(content),
    expiresAt: '2026-08-02T00:00:00.000Z',
  })

  expect(commands.map((command) => command.name)).toEqual([
    'PutObjectCommand',
    'HeadObjectCommand',
    'PutObjectCommand',
  ])
  expect(commands[2]?.input).not.toHaveProperty('IfNoneMatch')
  expect(locator.objectVersionId).toBe('version-refreshed')
  expect(locator.expiresAt).toBe('2026-08-02T00:00:00.000Z')
})

test('S3 source store pins every locator when concurrent retries refresh matching source', async () => {
  const content = 'Title\nShip durable import\n'
  const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    .then((digest) => Buffer.from(digest).toString('hex'))
  let refreshedVersions = 0
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (command.constructor.name === 'PutObjectCommand') {
        if (command.input.IfNoneMatch === '*') {
          throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
        }
        refreshedVersions += 1
        return { VersionId: `version-refreshed-${refreshedVersions}` }
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          VersionId: 'version-stale',
          LastModified: new Date('2026-06-01T00:00:00.000Z'),
          Metadata: {
            'mukuroji-sha256': sha256,
            'mukuroji-byte-length': String(Buffer.byteLength(content)),
            'mukuroji-expires-at': '2026-06-16T00:00:00.000Z',
          },
        }
      }
      return {}
    },
  } as unknown as S3Client
  const store = new S3WorkItemImportSourceStore(client, 'import-bucket')
  const request = {
    workspaceId: 'workspace-1',
    jobId: 'import_job-1',
    content,
    sha256,
    byteLength: Buffer.byteLength(content),
    expiresAt: '2026-08-02T00:00:00.000Z',
  }

  const locators = await Promise.all([
    store.putImmutable(request),
    store.putImmutable(request),
  ])

  expect(locators.map((locator) => locator.objectVersionId).sort()).toEqual([
    'version-refreshed-1',
    'version-refreshed-2',
  ])
  expect(locators.every((locator) => locator.expiresAt === request.expiresAt)).toBe(true)
})

test('SQS queue serializes no source, actor, mapping, or secret material', async () => {
  const inputs: Record<string, unknown>[] = []
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      inputs.push(command.input)
      return {}
    },
  } as unknown as SQSClient
  const queue = new SqsWorkItemImportQueue(client, 'https://sqs.example/imports')

  await queue.enqueue({ workspaceId: 'workspace-1', jobId: 'import-1' })

  expect(inputs).toEqual([{
    QueueUrl: 'https://sqs.example/imports',
    MessageBody: JSON.stringify({ workspaceId: 'workspace-1', jobId: 'import-1' }),
  }])
})

test('production Work Item import adapters fail closed when AWS resources are missing', () => {
  const names = [
    'AWS_EXECUTION_ENV',
    'AWS_LAMBDA_FUNCTION_NAME',
    'DEVELOPER_PLATFORM_TABLE_NAME',
    'NODE_ENV',
    'WORK_ITEM_IMPORT_BUCKET_NAME',
    'WORK_ITEM_IMPORT_QUEUE_URL',
  ] as const
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'mukuroji-import-test'
    delete process.env.AWS_EXECUTION_ENV
    delete process.env.NODE_ENV
    delete process.env.DEVELOPER_PLATFORM_TABLE_NAME
    delete process.env.WORK_ITEM_IMPORT_BUCKET_NAME
    delete process.env.WORK_ITEM_IMPORT_QUEUE_URL

    expect(() => createDefaultWorkItemImportExecutionStore()).toThrow(
      'Developer platform table name is required in production.',
    )
    expect(() => createDefaultWorkItemImportSourceStore()).toThrow(
      'Work Item import bucket name is required in production.',
    )
    expect(() => createDefaultWorkItemImportQueue()).toThrow(
      'Work Item import queue URL is required in production.',
    )
  } finally {
    for (const name of names) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

function createStageRequest(jobId: string) {
  return {
    jobId,
    workspaceId: 'workspace-1',
    createdByUserId: 'member@example.com',
    teamId: 'team-1',
    assignedProjectId: 'project-1',
    format: 'csv' as const,
    sourceContent:
      'Title,Assignee,Due date\nShip durable import,member@example.com,2026/07/31\n' +
      'Verify retry,member@example.com,2026/08/01\n',
    mapping: [
      { sourceField: 'Title', targetField: 'title' },
      { sourceField: 'Assignee', targetField: 'assigneeUserId' },
      { sourceField: 'Due date', targetField: 'dueDate' },
    ],
    requestFingerprint: 'fingerprint-1',
  }
}

function createFixture() {
  let execution: WorkItemImportExecution | undefined
  const receipts = new Map<number, WorkItemImportRowReceipt>()
  let now = new Date('2026-07-18T00:00:00.000Z')
  const queued: Array<{ workspaceId: string; jobId: string }> = []
  const jobEvents: string[] = []
  const jobReports: Array<NonNullable<WorkItemImportExecution['terminalReport']>> = []
  let deletedSources = 0
  const fixture = {
    get execution() {
      return execution
    },
    get deletedSources() {
      return deletedSources
    },
    queued,
    jobEvents,
    jobReports,
    now() {
      now = new Date(now.getTime() + 1_000)
      return now
    },
    sources: {
      async putImmutable(request: {
        workspaceId: string
        jobId: string
        sha256: string
        byteLength: number
        expiresAt: string
      }) {
        return {
          bucketName: 'import-bucket',
          objectKey: `imports/${request.jobId}/${request.sha256}`,
          objectVersionId: 'version-1',
          sha256: request.sha256,
          byteLength: request.byteLength,
          expiresAt: request.expiresAt,
        }
      },
      async getVerified() {
        return createStageRequest(execution!.jobId).sourceContent
      },
      async deleteVersion() {
        deletedSources += 1
      },
    },
    executions: {
      async createOrGet(candidate: WorkItemImportExecution) {
        execution ??= structuredClone(candidate)
        return structuredClone(execution)
      },
      async get() {
        return execution ? structuredClone(execution) : undefined
      },
      async claim(
        _workspaceId: string,
        _jobId: string,
        leaseOwner: string,
        leaseExpiresAt: string,
      ) {
        if (!execution || execution.cancelRequested || execution.status === 'cancelled') {
          return undefined
        }
        execution.status = 'running'
        execution.leaseOwner = leaseOwner
        execution.leaseExpiresAt = leaseExpiresAt
        return structuredClone(execution)
      },
      async releaseClaim(_workspaceId: string, _jobId: string, leaseOwner: string) {
        if (execution?.leaseOwner === leaseOwner) {
          delete execution.leaseOwner
          delete execution.leaseExpiresAt
        }
      },
      async recordRowReceipt(
        _workspaceId: string,
        _jobId: string,
        leaseOwner: string,
        receipt: WorkItemImportRowReceipt,
        leaseExpiresAt: string,
      ) {
        const existing = receipts.get(receipt.row)
        if (existing) return 'existing' as const
        if (!execution || execution.leaseOwner !== leaseOwner || execution.cancelRequested) {
          throw new Error('lease lost')
        }
        receipts.set(receipt.row, structuredClone(receipt))
        execution.checkpointRow = receipt.row
        execution.leaseExpiresAt = leaseExpiresAt
        return 'created' as const
      },
      async requestCancellation() {
        if (!execution) throw new Error('missing execution')
        execution.status = 'cancelled'
        execution.cancelRequested = true
        return structuredClone(execution)
      },
      async markCompletedIfClaimed(
        _workspaceId: string,
        _jobId: string,
        leaseOwner: string,
        report: NonNullable<WorkItemImportExecution['terminalReport']>,
      ) {
        if (!execution || execution.leaseOwner !== leaseOwner || execution.status !== 'running') {
          return false
        }
        execution.status = 'completed'
        execution.terminalReport = structuredClone(report)
        delete execution.leaseOwner
        delete execution.leaseExpiresAt
        return true
      },
      async markFailedIfClaimed(
        _workspaceId: string,
        _jobId: string,
        leaseOwner: string,
        problem: NonNullable<WorkItemImportExecution['terminalProblem']>,
        report: WorkItemImportExecution['terminalReport'],
      ) {
        if (!execution || execution.leaseOwner !== leaseOwner || execution.status !== 'running') {
          return false
        }
        execution.status = 'failed'
        execution.terminalProblem = structuredClone(problem)
        if (report) execution.terminalReport = structuredClone(report)
        delete execution.leaseOwner
        delete execution.leaseExpiresAt
        return true
      },
    },
    queue: {
      async enqueue(message: { workspaceId: string; jobId: string }) {
        queued.push(structuredClone(message))
      },
    },
  }
  return fixture
}

function createWorkerDependencies(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<WorkItemImportWorkerDependencies> = {},
): WorkItemImportWorkerDependencies {
  let lease = 0
  return {
    executions: fixture.executions,
    sources: fixture.sources,
    jobs: {
      async markRunning() {
        fixture.jobEvents.push('running')
      },
      async markCompleted() {
        fixture.jobEvents.push('completed')
      },
      async markFailed(
        _execution: WorkItemImportExecution,
        problem: { code: string },
        report?: NonNullable<WorkItemImportExecution['terminalReport']>,
      ) {
        fixture.jobEvents.push(`failed:${problem.code}`)
        if (report) fixture.jobReports.push(structuredClone(report))
      },
      async markCancelled() {
        fixture.jobEvents.push('cancelled')
      },
    },
    async authorize() {},
    async assertTenantEnabled() {},
    async validate() {
      return {
        report: {
          valid: true,
          totalRows: 2,
          validRows: 2,
          invalidRows: 0,
          errors: [],
          sample: [],
        },
        rows: [
          {
            row: 1,
            input: {
              title: 'Ship durable import',
              assigneeUserId: 'member@example.com',
              dueDate: '2026/07/31',
              priority: 'medium',
            },
          },
          {
            row: 2,
            input: {
              title: 'Verify retry',
              assigneeUserId: 'member@example.com',
              dueDate: '2026/08/01',
              priority: 'medium',
            },
          },
        ],
      }
    },
    async createWorkItem() {},
    now: fixture.now,
    createLeaseOwner() {
      lease += 1
      return `lease-${lease}`
    },
    ...overrides,
  }
}

function createSqsEvent(jobId: string, receiveCount = '1') {
  return {
    Records: [{
      messageId: 'message-1',
      body: JSON.stringify({ workspaceId: 'workspace-1', jobId }),
      attributes: { ApproximateReceiveCount: receiveCount },
    }],
  }
}
