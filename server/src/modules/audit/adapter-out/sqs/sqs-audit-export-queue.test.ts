import { describe, expect, test } from 'bun:test'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { parseAuditExportQueueMessage } from '../../audit-export'
import { SqsAuditExportQueue } from './sqs-audit-export-queue'

describe('SqsAuditExportQueue', () => {
  test('sends a step message the worker parses, including the request correlation ID', async () => {
    const client = new SQSClient({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
    const sent: SendMessageCommand['input'][] = []
    Object.assign(client, {
      async send(command: unknown) {
        if (!(command instanceof SendMessageCommand)) throw new Error('Unexpected SQS command.')
        sent.push(command.input)
        return {}
      },
    })
    const queue = new SqsAuditExportQueue(client, 'https://sqs.test/exports')
    const target = { workspaceId: 'ws-1', exportId: 'a'.repeat(32), correlationId: 'corr-1' }

    await queue.enqueue(target, 1_200)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ QueueUrl: 'https://sqs.test/exports', DelaySeconds: 900 })
    expect(parseAuditExportQueueMessage(sent[0]?.MessageBody ?? '')).toEqual({ version: 1, ...target })
  })
})
