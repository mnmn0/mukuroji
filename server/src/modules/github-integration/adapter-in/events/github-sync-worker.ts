import { GitHubIntegrationError } from '../../domain/github-integration-error'
import { parseGitHubSyncJob } from '../../domain/sync-jobs'
import {
  processGitHubSyncJob,
  reconcileGitHubPullRequests,
  type GitHubReconcileResult,
  type GitHubSyncDependencies,
} from '../../application/pull-request-sync'

/** One SQS record of the GitHub sync queue. */
export type GitHubSyncSqsRecord = {
  /** SQS message ID. */
  readonly messageId: string
  /** JSON sync job. */
  readonly body: string
}

/** SQS batch of the GitHub sync queue. */
export type GitHubSyncSqsEvent = {
  /** Records in the batch. */
  readonly Records?: readonly GitHubSyncSqsRecord[]
}

/** Partial batch response. */
export type GitHubSyncBatchResponse = {
  /** Records SQS delivers again. */
  readonly batchItemFailures: { readonly itemIdentifier: string }[]
}

/** Structured, secret-free logger. */
export type GitHubSyncLogger = (message: string, details: Record<string, unknown>) => void

/** Dependencies of the worker entrypoints. */
export type GitHubSyncWorkerDependencies = GitHubSyncDependencies & {
  /** Workspace of this deployment. */
  workspaceId: string
  /** Clock. */
  now: () => Date
  /** Logger. */
  log: GitHubSyncLogger
}

/**
 * Creates the SQS handler of the GitHub sync queue (ADR 0079).
 *
 * A malformed message or a failure GitHub will not fix by retrying (an unexpected response) is
 * logged and dropped, so it does not cycle until the DLQ. Every retryable failure is reported for
 * SQS to deliver again; after five receives SQS moves it to the DLQ, whose alarm tells the operator.
 *
 * @param dependencies - Store, gateway, queue, Workspace, clock, and logger.
 * @returns The handler.
 */
export function createGitHubSyncQueueHandler(
  dependencies: GitHubSyncWorkerDependencies,
): (event: GitHubSyncSqsEvent) => Promise<GitHubSyncBatchResponse> {
  return async (event) => {
    const failures: { itemIdentifier: string }[] = []
    for (const record of event.Records ?? []) {
      let job
      try {
        job = parseGitHubSyncJob(JSON.parse(record.body))
      } catch {
        dependencies.log('GitHub sync worker dropped a malformed message.', { messageId: record.messageId })
        continue
      }
      try {
        const result = await processGitHubSyncJob(dependencies, dependencies.workspaceId, job, dependencies.now())
        dependencies.log('GitHub sync job finished.', {
          messageId: record.messageId,
          kind: job.kind,
          repositoryId: job.repositoryId,
          attempt: job.attempt,
          ...result,
        })
      } catch (error) {
        const retryable = !(error instanceof GitHubIntegrationError) || error.retryable
        dependencies.log('GitHub sync job failed.', {
          messageId: record.messageId,
          kind: job.kind,
          repositoryId: job.repositoryId,
          retryable,
          code: error instanceof GitHubIntegrationError ? error.code : 'Unexpected',
        })
        if (retryable) failures.push({ itemIdentifier: record.messageId })
      }
    }
    return { batchItemFailures: failures }
  }
}

/**
 * Creates the hourly reconcile handler (ADR 0079). A deployment without a GitHub App does nothing.
 *
 * @param dependencies - Store, gateway, queue, Workspace, clock, and logger.
 * @param isConfigured - Whether this deployment has a GitHub App configured.
 * @returns The handler; it throws when every linked repository failed, so EventBridge retries.
 */
export function createGitHubReconcileHandler(
  dependencies: GitHubSyncWorkerDependencies,
  isConfigured: () => Promise<boolean>,
): () => Promise<GitHubReconcileResult | { skipped: true }> {
  return async () => {
    if (!await isConfigured()) return { skipped: true }
    const result = await reconcileGitHubPullRequests(dependencies, dependencies.workspaceId, dependencies.now(), (link, error) => {
      dependencies.log('GitHub reconcile failed for a repository.', {
        repositoryId: link.repositoryId,
        code: error instanceof GitHubIntegrationError ? error.code : 'Unexpected',
      })
    })
    dependencies.log('GitHub reconcile finished.', { ...result })
    if (result.repositories > 0 && result.failedRepositories === result.repositories) {
      throw new GitHubIntegrationError('unavailable', 'GitHubReconcileFailed', 'Every linked repository failed to reconcile.')
    }
    return result
  }
}
