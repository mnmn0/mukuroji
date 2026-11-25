import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createEmailFeedbackTelemetry, DynamoDbEmailSuppressionStore, drainEmailFeedback, type EmailFeedbackQueue } from '../../modules/notifications'

/**
 * Wraps the SQS queue that EventBridge fills with SES bounce and complaint events.
 * @param sqs - SQS client.
 * @param queueUrl - Feedback queue URL.
 * @returns Feedback queue port.
 */
export function createSqsEmailFeedbackQueue(sqs: Pick<SQSClient, 'send'>, queueUrl: string): EmailFeedbackQueue {
  return {
    async receive(limit) {
      const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: limit, WaitTimeSeconds: 0 }))
      return (result.Messages ?? []).flatMap((message) =>
        message.ReceiptHandle && typeof message.Body === 'string' ? [{ handle: message.ReceiptHandle, body: message.Body }] : [])
    },
    async acknowledge(messages) {
      const result = await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.handle })),
      }))
      // An undeleted message is received again; recording a suppression twice is harmless.
      if ((result.Failed ?? []).length > 0) throw new Error('Email feedback acknowledgement failed.')
    },
  }
}

/**
 * Creates the scheduled job that records SES bounces and complaints as suppressions. Without a
 * configured sender or queue the job does nothing.
 * @returns A handler that returns the number of suppressions recorded.
 */
export function createProductionEmailFeedbackHandler(): () => Promise<number> {
  const environment = loadServerConfig().environment
  const queueUrl = environment.NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL?.trim()
  if (!environment.NOTIFICATION_EMAIL_SENDER?.trim() || !queueUrl) return async () => 0
  const tableName = environment.NOTIFICATIONS_TABLE_NAME?.trim()
  if (!tableName) throw new Error('Email feedback runtime is not configured.')
  const store = new DynamoDbEmailSuppressionStore(createDynamoDbDocumentClient(createDynamoDbClient()), tableName)
  const queue = createSqsEmailFeedbackQueue(new SQSClient({ region: loadServerConfig().awsRegion }), queueUrl)
  return () => drainEmailFeedback({ queue, store, telemetry: createEmailFeedbackTelemetry(), now: () => new Date() })
}
