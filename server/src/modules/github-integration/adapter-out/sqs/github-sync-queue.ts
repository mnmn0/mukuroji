import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import type { GitHubSyncJob } from '../../domain/sync-jobs'
import type { GitHubSyncQueue } from '../../application/ports'

/** Longest delay SQS accepts, in seconds. */
const MAX_DELAY_SECONDS = 900

/** Sends sync jobs to the GitHub sync queue (ADR 0079). */
export class SqsGitHubSyncQueue implements GitHubSyncQueue {
  /** SQS client. */
  private readonly client: SQSClient

  /** Queue URL. */
  private readonly queueUrl: string

  /**
   * Creates the queue adapter.
   *
   * @param client - SQS client.
   * @param queueUrl - GitHub sync queue URL.
   */
  constructor(client: SQSClient, queueUrl: string) {
    this.client = client
    this.queueUrl = queueUrl
  }

  /**
   * Sends one job.
   *
   * @param job - Job.
   * @param delaySeconds - Delay, clamped to what SQS accepts.
   */
  async send(job: GitHubSyncJob, delaySeconds = 0): Promise<void> {
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
        DelaySeconds: Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.floor(delaySeconds))),
      }))
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubSyncQueueUnavailable', 'The GitHub sync job could not be queued.', { cause: error })
    }
  }
}

/** Keeps sent jobs in memory, for tests and deployments without the queue. */
export class InMemoryGitHubSyncQueue implements GitHubSyncQueue {
  /** Jobs in send order with their delays. */
  readonly sent: { job: GitHubSyncJob, delaySeconds: number }[] = []

  /**
   * Records a job.
   *
   * @param job - Job.
   * @param delaySeconds - Delay.
   */
  async send(job: GitHubSyncJob, delaySeconds = 0): Promise<void> {
    this.sent.push({ job: structuredClone(job), delaySeconds })
  }
}
