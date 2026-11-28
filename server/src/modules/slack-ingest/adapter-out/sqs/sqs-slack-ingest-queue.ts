import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { SlackIngestJob, SlackIngestQueue } from '../../application/ports/slack-ingest-ports'

/** Longest delay SQS accepts on one message. */
const MAX_DELAY_SECONDS = 900

/** Sends Slack ingest jobs to the SQS worker queue. */
export class SqsSlackIngestQueue implements SlackIngestQueue {
  /** SQS client. */
  private readonly client: SQSClient
  /** Queue URL. */
  private readonly queueUrl: string

  /**
   * Creates the queue adapter.
   *
   * @param client - SQS client.
   * @param queueUrl - Queue URL.
   */
  constructor(client: SQSClient, queueUrl: string) {
    this.client = client
    this.queueUrl = queueUrl
  }

  /**
   * Queues one job.
   *
   * @param job - Job.
   * @param delaySeconds - Delay, clamped to what SQS accepts.
   */
  async send(job: SlackIngestJob, delaySeconds?: number): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(job),
      ...(delaySeconds === undefined
        ? {}
        : { DelaySeconds: Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.floor(delaySeconds))) }),
    }))
  }
}
