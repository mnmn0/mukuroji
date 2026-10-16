import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { AuditExportQueue, AuditExportQueueMessage } from '../../audit-export'

/**
 * Schedules export steps on an SQS queue.
 */
export class SqsAuditExportQueue implements AuditExportQueue {
  /** SQS client used to send messages. */
  private readonly client: SQSClient
  /** URL of the export queue. */
  private readonly queueUrl: string

  /**
   * Creates the queue adapter.
   *
   * @param client - SQS client used to send messages.
   * @param queueUrl - URL of the export queue.
   */
  constructor(client: SQSClient, queueUrl: string) {
    this.client = client
    this.queueUrl = queueUrl
  }

  /**
   * Sends one step message.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @param delaySeconds - Optional delivery delay, capped at the SQS maximum of 900 seconds.
   */
  async enqueue(workspaceId: string, exportId: string, delaySeconds?: number): Promise<void> {
    const message: AuditExportQueueMessage = { version: 1, workspaceId, exportId }
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(message),
      ...(delaySeconds && delaySeconds > 0 ? { DelaySeconds: Math.min(Math.ceil(delaySeconds), 900) } : {}),
    }))
  }
}
