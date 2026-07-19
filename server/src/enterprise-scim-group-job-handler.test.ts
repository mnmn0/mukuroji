import { expect, test } from 'bun:test'
import {
  isEnterpriseScimGroupJobStreamEvent,
  processEnterpriseScimGroupJobBatch,
  readEnterpriseScimGroupJobReference,
} from './enterprise-scim-group-job-handler'

function createJobRecord(
  eventName: 'INSERT' | 'MODIFY' = 'INSERT',
  revision = '1',
) {
  return {
    eventSource: 'aws:dynamodb',
    eventName,
    dynamodb: {
      SequenceNumber: `sequence-${eventName.toLowerCase()}`,
      NewImage: {
        scopeKey: { S: 'WORKSPACE#workspace-1' },
        recordKey: { S: 'SCIM_GROUP_JOB#job-1' },
        entryType: { S: 'enterprise-scim-group-job' },
        workspaceId: { S: 'workspace-1' },
        jobId: { S: 'job-1' },
        revision: { N: revision },
      },
    },
  }
}

test('strictly parses and dispatches DynamoDB INSERT/MODIFY job references', async () => {
  const references: unknown[] = []
  const event = {
    Records: [
      createJobRecord('INSERT', '1'),
      createJobRecord('MODIFY', '2'),
      {
        ...createJobRecord(),
        eventSource: 'aws:sqs',
      },
      {
        ...createJobRecord(),
        eventName: 'REMOVE',
      },
      {
        ...createJobRecord(),
        dynamodb: {
          ...createJobRecord().dynamodb,
          NewImage: {
            ...createJobRecord().dynamodb.NewImage,
            entryType: { S: 'enterprise-identity-control' },
          },
        },
      },
    ],
  }

  expect(isEnterpriseScimGroupJobStreamEvent(event)).toBe(true)
  expect(readEnterpriseScimGroupJobReference(createJobRecord('MODIFY', '2'))).toEqual({
    workspaceId: 'workspace-1',
    jobId: 'job-1',
    revision: 2,
  })
  await expect(processEnterpriseScimGroupJobBatch(event, {
    async processJob(reference) {
      references.push(reference)
    },
  })).resolves.toEqual({ batchItemFailures: [] })
  expect(references).toEqual([
    { workspaceId: 'workspace-1', jobId: 'job-1', revision: 1 },
    { workspaceId: 'workspace-1', jobId: 'job-1', revision: 2 },
  ])
})

test('rejects malformed job candidates and returns their sequence for partial retry', async () => {
  for (const mutate of [
    (record: ReturnType<typeof createJobRecord>) => {
      record.dynamodb.NewImage.scopeKey = { S: 'WORKSPACE#another-workspace' }
    },
    (record: ReturnType<typeof createJobRecord>) => {
      record.dynamodb.NewImage.recordKey = { S: 'SCIM_GROUP_JOB#another-job' }
    },
    (record: ReturnType<typeof createJobRecord>) => {
      record.dynamodb.NewImage.revision = { N: '0' }
    },
    (record: ReturnType<typeof createJobRecord>) => {
      record.dynamodb.NewImage.revision = { N: '9007199254740992' }
    },
  ]) {
    const record = createJobRecord()
    mutate(record)
    expect(() => readEnterpriseScimGroupJobReference(record)).toThrow(
      'Enterprise SCIM group job stream record is invalid.',
    )
    await expect(processEnterpriseScimGroupJobBatch({
      Records: [record],
    }, {
      async processJob() {
        throw new Error('Malformed jobs must not be dispatched.')
      },
    })).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'sequence-insert' }],
    })
  }
})

test('returns the failed processor sequence for partial stream retry', async () => {
  await expect(processEnterpriseScimGroupJobBatch({
    Records: [createJobRecord()],
  }, {
    async processJob() {
      throw new Error('Injected SCIM group job failure')
    },
  })).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'sequence-insert' }],
  })
})

test('rethrows a processing failure when the stream checkpoint is missing', async () => {
  const record = createJobRecord()
  record.dynamodb.SequenceNumber = undefined

  await expect(processEnterpriseScimGroupJobBatch({
    Records: [record],
  }, {
    async processJob() {
      throw new Error('Injected uncheckpointed failure')
    },
  })).rejects.toThrow('Injected uncheckpointed failure')
})

test('does not classify non-DynamoDB record collections as job stream events', () => {
  expect(isEnterpriseScimGroupJobStreamEvent({ Records: [] })).toBe(false)
  expect(isEnterpriseScimGroupJobStreamEvent({
    Records: [{ eventSource: 'aws:sqs' }],
  })).toBe(false)
  expect(isEnterpriseScimGroupJobStreamEvent({})).toBe(false)
  expect(isEnterpriseScimGroupJobStreamEvent(undefined)).toBe(false)
})
