import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { BatchResponse, DynamoStreamEvent } from '../../src/infrastructure/aws/dynamodb-stream'
import type { WorkItemImportSqsEvent } from '../../src/modules/work-items/work-item-import'

/**
 * Rejects non-loopback AWS destinations before loading application code.
 * @param endpoint - Explicit local AWS origin.
 * @returns The normalized HTTP origin.
 */
export function requireLocalOrigin(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Local workers require a loopback HTTP AWS origin.')
  }
  return url.origin
}

/**
 * Delivers one bounded SQS batch, retaining failed messages for SQS redrive.
 * @param client - Local SQS transport.
 * @param queueUrl - Validated local queue URL.
 * @param handle - Existing application batch handler.
 * @returns Number of messages received.
 */
export async function pollQueue(
  client: SQSClient,
  queueUrl: string,
  handle: (event: WorkItemImportSqsEvent) => Promise<BatchResponse>,
): Promise<number> {
  const batch = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
    MessageSystemAttributeNames: ['ApproximateReceiveCount'],
  }))
  for (const message of batch.Messages ?? []) {
    if (!message.MessageId || !message.ReceiptHandle) throw new Error('Invalid SQS envelope.')
    let renewal = Promise.resolve()
    let renewalFailed = false
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        try {
          await client.send(new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 900,
          }))
        } catch {
          renewalFailed = true
        }
      })
    }, 60_000)
    let result: BatchResponse
    try {
      result = await handle({ Records: [{
        messageId: message.MessageId,
        body: message.Body,
        attributes: message.Attributes,
      }] })
    } finally {
      clearInterval(timer)
      await renewal
    }
    if (renewalFailed) throw new Error('SQS visibility renewal failed; message retained.')
    if (result.batchItemFailures.length === 0) {
      await client.send(new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }))
    } else {
      throw new Error('SQS handler reported a failed message; retained for retry.')
    }
  }
  return batch.Messages?.length ?? 0
}

/**
 * Returns a stream checkpoint only after every projection acknowledges the batch.
 * @param event - Original stream batch, retained on any downstream failure.
 * @param handlers - Ordered existing projection handlers.
 * @returns Last processed sequence number, or undefined for an empty batch.
 */
export async function deliverStreamBatch(
  event: DynamoStreamEvent,
  handlers: ReadonlyArray<(event: DynamoStreamEvent) => Promise<BatchResponse>>,
): Promise<string | undefined> {
  if (!event.Records?.length) return undefined
  for (const handle of handlers) {
    const result = await handle(event)
    if (result.batchItemFailures.length) throw new Error('Audit fan-out failed; checkpoint retained.')
  }
  const sequence = event.Records.at(-1)?.dynamodb?.SequenceNumber
  if (!sequence) throw new Error('Stream batch is missing its checkpoint sequence.')
  return sequence
}
