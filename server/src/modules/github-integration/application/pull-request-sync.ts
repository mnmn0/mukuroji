import { verifyGitHubWebhookSignature } from '../domain/webhook-signature'
import {
  GITHUB_SYNC_JOB_MAX_ATTEMPTS,
  GITHUB_SYNC_JOB_MAX_NUMBERS,
  interpretGitHubWebhook,
  type GitHubSyncJob,
} from '../domain/sync-jobs'
import { isExpiredPullRequestSnapshot } from '../domain/pull-request-inbox'
import type { GitHubPullRequestSnapshot } from '../domain/pull-request-snapshot'
import type {
  GitHubAppCredentialSource,
  GitHubAppGateway,
  GitHubIntegrationStore,
  GitHubRepositoryLinkRecord,
  GitHubRepositoryReference,
  GitHubSyncQueue,
} from './ports'

/** `X-GitHub-Event` names: lowercase words joined by underscores. */
const EVENT_NAME_PATTERN = /^[a-z][a-z_]{0,63}$/u

/** Seconds a job waits per attempt while GitHub computes the merge conflict state. */
const MERGEABLE_RETRY_DELAY_SECONDS = 30

/** Raw webhook delivery handed over by the HTTP adapter. */
export type GitHubWebhookDelivery = {
  /** `X-GitHub-Event` header. */
  eventName: string | undefined
  /** `X-Hub-Signature-256` header. */
  signature: string | undefined
  /** Exact request body. */
  rawBody: Uint8Array
}

/** Outcome of {@link receiveGitHubWebhook}, which the HTTP adapter maps to a status. */
export type GitHubWebhookReceipt =
  | { kind: 'not-configured' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' }
  | { kind: 'pong' }
  | { kind: 'ignored' }
  | { kind: 'accepted' }

/** Dependencies of {@link receiveGitHubWebhook}. */
export type ReceiveGitHubWebhookDependencies = {
  /** App credentials, whose webhook secrets verify the signature. */
  credentials: GitHubAppCredentialSource
  /** Queue the job goes to. */
  queue: GitHubSyncQueue
}

/**
 * Verifies a webhook delivery and queues the sync job it implies (ADR 0079).
 *
 * The signature is checked before the body is parsed. The job carries identifiers only; the worker
 * checks the repository link and reads the current state from GitHub.
 *
 * @param dependencies - Credentials and queue.
 * @param delivery - Untrusted headers and raw body.
 * @returns The outcome.
 */
export async function receiveGitHubWebhook(
  dependencies: ReceiveGitHubWebhookDependencies,
  delivery: GitHubWebhookDelivery,
): Promise<GitHubWebhookReceipt> {
  const credentials = await dependencies.credentials.read()
  if (!credentials) return { kind: 'not-configured' }
  if (!verifyGitHubWebhookSignature(credentials.webhookSecrets, delivery.rawBody, delivery.signature)) {
    return { kind: 'unauthorized' }
  }
  const eventName = delivery.eventName?.trim() ?? ''
  if (!EVENT_NAME_PATTERN.test(eventName)) return { kind: 'invalid' }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(delivery.rawBody))
  } catch {
    return { kind: 'invalid' }
  }
  const interpretation = interpretGitHubWebhook(eventName, payload)
  if (interpretation.kind === 'ping') return { kind: 'pong' }
  if (interpretation.kind === 'ignored') return { kind: 'ignored' }
  await dependencies.queue.send(interpretation.job)
  return { kind: 'accepted' }
}

/** Dependencies of the sync worker and the reconcile. */
export type GitHubSyncDependencies = {
  /** Repository links and snapshots. */
  store: GitHubIntegrationStore
  /** GitHub reads. */
  gateway: GitHubAppGateway
  /** Queue that takes requeued jobs. */
  queue: GitHubSyncQueue
}

/** Outcome of one sync job. */
export type GitHubSyncJobResult = {
  /** Whether the job was dropped because the repository is not linked to this installation. */
  skipped: boolean
  /** Snapshots written. */
  written: number
  /** Snapshots deleted because GitHub no longer shows the pull request. */
  deleted: number
  /** Whether the job was requeued to read a merge conflict state GitHub was still computing. */
  requeued: boolean
}

/**
 * Runs one sync job: reads the pull requests from GitHub and stores their snapshots.
 *
 * A repository without a link, or linked through another installation, is skipped, so a delivery
 * from an installation an administrator never linked writes nothing. Open pull requests whose
 * conflict state GitHub has not computed yet are read again after a delay, a bounded number of
 * times.
 *
 * @param dependencies - Store, gateway, and queue.
 * @param workspaceId - Workspace of this deployment.
 * @param job - Validated job.
 * @param now - Read time.
 * @returns What the job did.
 */
export async function processGitHubSyncJob(
  dependencies: GitHubSyncDependencies,
  workspaceId: string,
  job: GitHubSyncJob,
  now: Date,
): Promise<GitHubSyncJobResult> {
  const link = await dependencies.store.getRepositoryLink(workspaceId, job.repositoryId)
  if (!link || link.installationId !== job.installationId) {
    return { skipped: true, written: 0, deleted: 0, requeued: false }
  }
  const reference: GitHubRepositoryReference = {
    installationId: link.installationId,
    repositoryId: link.repositoryId,
    // The signed delivery names the repository as it is now, which survives a rename.
    repository: job.repository,
  }
  const syncedAt = now.toISOString()
  let snapshots: GitHubPullRequestSnapshot[]
  let missing: number[] = []
  switch (job.kind) {
    case 'pull-requests': {
      const result = await dependencies.gateway.readPullRequests(reference, job.numbers, syncedAt)
      snapshots = result.snapshots
      missing = result.missing
      break
    }
    case 'commit':
      snapshots = await dependencies.gateway.readCommitPullRequests(reference, job.sha, syncedAt)
      break
    case 'base-branch':
      snapshots = (await dependencies.gateway.readOpenPullRequests(reference, { baseRef: job.branch }, syncedAt)).snapshots
      break
    case 'repository':
      snapshots = (await dependencies.gateway.readOpenPullRequests(reference, {}, syncedAt)).snapshots
      break
  }
  const result = await storeSnapshots(dependencies.store, workspaceId, reference.repositoryId, snapshots, missing)
  const unknown = snapshots
    .filter((snapshot) => snapshot.state === 'open' && snapshot.mergeable === 'unknown')
    .map((snapshot) => snapshot.number)
    .slice(0, GITHUB_SYNC_JOB_MAX_NUMBERS)
  const nextAttempt = job.attempt + 1
  const requeued = unknown.length > 0 && nextAttempt < GITHUB_SYNC_JOB_MAX_ATTEMPTS
  if (requeued) {
    await dependencies.queue.send(
      { ...reference, attempt: nextAttempt, kind: 'pull-requests', numbers: unknown },
      MERGEABLE_RETRY_DELAY_SECONDS * nextAttempt,
    )
  }
  return { skipped: false, ...result, requeued }
}

/** Outcome of one reconcile run. */
export type GitHubReconcileResult = {
  /** Linked repositories read. */
  repositories: number
  /** Linked repositories whose read failed; the next run tries them again. */
  failedRepositories: number
  /** Snapshots written. */
  written: number
  /** Snapshots deleted: unlinked, expired, or no longer shown by GitHub. */
  deleted: number
}

/**
 * Corrects what webhooks missed (ADR 0079): rereads the open pull requests of every linked
 * repository, rereads stored open snapshots GitHub no longer lists as open, and deletes snapshots
 * of unlinked repositories and closed pull requests past the retention.
 *
 * One repository failing does not stop the others; the next run retries it.
 *
 * @param dependencies - Store, gateway, and queue.
 * @param workspaceId - Workspace of this deployment.
 * @param now - Run time.
 * @param onRepositoryError - Called with each repository failure, for logging.
 * @returns What the run did.
 */
export async function reconcileGitHubPullRequests(
  dependencies: GitHubSyncDependencies,
  workspaceId: string,
  now: Date,
  onRepositoryError: (link: GitHubRepositoryLinkRecord, error: unknown) => void,
): Promise<GitHubReconcileResult> {
  const links = await dependencies.store.listRepositoryLinks(workspaceId)
  const linked = new Map(links.map((link) => [link.repositoryId, link]))
  const stored = await dependencies.store.listPullRequestSnapshots(workspaceId)
  let deleted = 0
  const storedOpen = new Map<string, number[]>()
  for (const snapshot of stored.snapshots) {
    if (!linked.has(snapshot.repositoryId) || isExpiredPullRequestSnapshot(snapshot, now)) {
      await dependencies.store.deletePullRequestSnapshot(workspaceId, snapshot.repositoryId, snapshot.number)
      deleted += 1
    } else if (snapshot.state === 'open') {
      storedOpen.set(snapshot.repositoryId, [...storedOpen.get(snapshot.repositoryId) ?? [], snapshot.number])
    }
  }
  const syncedAt = now.toISOString()
  let written = 0
  let failedRepositories = 0
  for (const link of links) {
    try {
      const name = await dependencies.gateway.readRepositoryName(link)
      if (name === null) {
        // The installation lost the repository. Its snapshots stay until an administrator
        // removes the link, which hides them at once.
        failedRepositories += 1
        onRepositoryError(link, new Error('The GitHub App can no longer read the repository.'))
        continue
      }
      const reference = { installationId: link.installationId, repositoryId: link.repositoryId, repository: name }
      const open = await dependencies.gateway.readOpenPullRequests(reference, {}, syncedAt)
      const openNumbers = new Set(open.snapshots.map((snapshot) => snapshot.number))
      const result = await storeSnapshots(dependencies.store, workspaceId, link.repositoryId, open.snapshots, [])
      written += result.written
      // Without the complete open list, a stored open pull request may still be open.
      const stale = open.incomplete ? [] : (storedOpen.get(link.repositoryId) ?? []).filter((number) => !openNumbers.has(number))
      for (let index = 0; index < stale.length; index += GITHUB_SYNC_JOB_MAX_NUMBERS) {
        const read = await dependencies.gateway.readPullRequests(
          reference,
          stale.slice(index, index + GITHUB_SYNC_JOB_MAX_NUMBERS),
          syncedAt,
        )
        const chunk = await storeSnapshots(dependencies.store, workspaceId, link.repositoryId, read.snapshots, read.missing)
        written += chunk.written
        deleted += chunk.deleted
      }
    } catch (error) {
      failedRepositories += 1
      onRepositoryError(link, error)
    }
  }
  return { repositories: links.length, failedRepositories, written, deleted }
}

/**
 * Writes snapshots and deletes the ones GitHub no longer shows.
 *
 * @param store - Store.
 * @param workspaceId - Workspace.
 * @param repositoryId - Repository the snapshots belong to.
 * @param snapshots - Snapshots read from GitHub.
 * @param missing - Numbers GitHub no longer shows.
 * @returns Counts of written and deleted snapshots.
 */
async function storeSnapshots(
  store: GitHubIntegrationStore,
  workspaceId: string,
  repositoryId: string,
  snapshots: readonly GitHubPullRequestSnapshot[],
  missing: readonly number[],
): Promise<{ written: number, deleted: number }> {
  let written = 0
  for (const snapshot of snapshots) {
    if (await store.putPullRequestSnapshot(workspaceId, snapshot) === 'written') written += 1
  }
  for (const number of missing) await store.deletePullRequestSnapshot(workspaceId, repositoryId, number)
  return { written, deleted: missing.length }
}
