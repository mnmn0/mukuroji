import { verifyGitHubWebhookSignature } from '../domain/webhook-signature'
import {
  GITHUB_SYNC_JOB_MAX_ATTEMPTS,
  GITHUB_SYNC_JOB_MAX_NUMBERS,
  interpretGitHubWebhook,
  type GitHubSyncJob,
} from '../domain/sync-jobs'
import { isExpiredPullRequestSnapshot } from '../domain/pull-request-inbox'
import { carryLastKnownMergeable, detectPullRequestNotifications } from '../domain/pull-request-notifications'
import type { GitHubPullRequestSnapshot } from '../domain/pull-request-snapshot'
import type {
  GitHubAppCredentialSource,
  GitHubAppGateway,
  GitHubIntegrationStore,
  GitHubPullRequestNotificationSink,
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
  /** Inbox notifications of pull request changes. */
  notifications: GitHubPullRequestNotificationSink
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
  // Linking a repository reads every open pull request; only a webhook announces a new one.
  const result = await storeSnapshots(dependencies, workspaceId, link, snapshots, missing, job.kind !== 'repository')
  const requeued = await queueMergeableRetries(dependencies, reference, unresolvedNumbers(snapshots), job.attempt + 1)
  return { skipped: false, ...result, requeued }
}

/**
 * Lists the open pull requests whose merge conflict state GitHub is still computing.
 *
 * @param snapshots - Snapshots just read.
 * @returns Their numbers.
 */
function unresolvedNumbers(snapshots: readonly GitHubPullRequestSnapshot[]): number[] {
  return snapshots
    .filter((snapshot) => snapshot.state === 'open' && snapshot.mergeable === 'unknown')
    .map((snapshot) => snapshot.number)
}

/**
 * Queues delayed rereads of pull requests whose merge conflict state is unresolved, split into
 * jobs of at most `GITHUB_SYNC_JOB_MAX_NUMBERS` numbers. Nothing is queued past the last attempt.
 *
 * @param dependencies - Queue.
 * @param reference - Repository the pull requests belong to.
 * @param numbers - Unresolved pull request numbers.
 * @param attempt - Attempt number of the retry jobs.
 * @returns Whether any retry was queued.
 */
async function queueMergeableRetries(
  dependencies: GitHubSyncDependencies,
  reference: GitHubRepositoryReference,
  numbers: readonly number[],
  attempt: number,
): Promise<boolean> {
  if (numbers.length === 0 || attempt >= GITHUB_SYNC_JOB_MAX_ATTEMPTS) return false
  for (let index = 0; index < numbers.length; index += GITHUB_SYNC_JOB_MAX_NUMBERS) {
    await dependencies.queue.send(
      { ...reference, attempt, kind: 'pull-requests', numbers: numbers.slice(index, index + GITHUB_SYNC_JOB_MAX_NUMBERS) },
      MERGEABLE_RETRY_DELAY_SECONDS * attempt,
    )
  }
  return true
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
  // Maintenance reads every snapshot; a bounded read would leave the same tail unreconciled each run.
  const stored = await dependencies.store.listPullRequestSnapshots(workspaceId, { exhaustive: true })
  let deleted = 0
  const storedOpen = new Map<string, number[]>()
  for (const snapshot of stored.snapshots) {
    if (!linked.has(snapshot.repositoryId) || isExpiredPullRequestSnapshot(snapshot, now)) {
      // A sync that wrote a newer snapshot since it was listed keeps it.
      if (await dependencies.store.deletePullRequestSnapshot(workspaceId, snapshot.repositoryId, snapshot.number, snapshot.syncedAt) === 'deleted') {
        deleted += 1
      }
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
      const result = await storeSnapshots(dependencies, workspaceId, link, open.snapshots, [], false)
      written += result.written
      const unresolved = unresolvedNumbers(open.snapshots)
      // A stored open pull request missing from the list is read by number, which tells whether it
      // is still open even when the list stopped at its page limit.
      const stale = (storedOpen.get(link.repositoryId) ?? []).filter((number) => !openNumbers.has(number))
      for (let index = 0; index < stale.length; index += GITHUB_SYNC_JOB_MAX_NUMBERS) {
        const read = await dependencies.gateway.readPullRequests(
          reference,
          stale.slice(index, index + GITHUB_SYNC_JOB_MAX_NUMBERS),
          syncedAt,
        )
        const chunk = await storeSnapshots(dependencies, workspaceId, link, read.snapshots, read.missing, false)
        written += chunk.written
        deleted += chunk.deleted
        unresolved.push(...unresolvedNumbers(read.snapshots))
      }
      // A conflict state GitHub is still computing is reread shortly, as a webhook sync does.
      await queueMergeableRetries(dependencies, reference, unresolved, 1)
    } catch (error) {
      failedRepositories += 1
      onRepositoryError(link, error)
    }
  }
  return { repositories: links.length, failedRepositories, written, deleted }
}

/**
 * Writes snapshots, sends the notifications their changes imply, and deletes the ones GitHub no
 * longer shows.
 *
 * Each notification is written before its snapshot, and its key comes from the snapshot it is
 * compared with, so a retry after a failure sends it once. A snapshot older than the stored one is
 * skipped without notifying.
 *
 * @param dependencies - Store and notification sink.
 * @param workspaceId - Workspace.
 * @param link - Repository link, which names the Team the notifications are scoped to.
 * @param snapshots - Snapshots read from GitHub.
 * @param missing - Numbers GitHub no longer shows.
 * @param notifyNew - Whether a pull request seen for the first time notifies its reviewers.
 * @returns Counts of written and deleted snapshots.
 */
async function storeSnapshots(
  dependencies: Pick<GitHubSyncDependencies, 'store' | 'notifications'>,
  workspaceId: string,
  link: GitHubRepositoryLinkRecord,
  snapshots: readonly GitHubPullRequestSnapshot[],
  missing: readonly number[],
  notifyNew: boolean,
): Promise<{ written: number, deleted: number }> {
  const { store } = dependencies
  let written = 0
  for (const snapshot of snapshots) {
    const previous = await store.getPullRequestSnapshot(workspaceId, snapshot.repositoryId, snapshot.number) ?? undefined
    if (previous && previous.syncedAt >= snapshot.syncedAt) continue
    for (const notification of detectPullRequestNotifications(previous, snapshot, { notifyNew })) {
      const memberKey = await store.findMemberByLogin(workspaceId, notification.login)
      if (!memberKey) continue
      await dependencies.notifications.publish({ ...notification, workspaceId, memberKey, teamId: link.teamId, pullRequest: snapshot })
    }
    if (await store.putPullRequestSnapshot(workspaceId, carryLastKnownMergeable(previous, snapshot)) === 'written') written += 1
  }
  for (const number of missing) await store.deletePullRequestSnapshot(workspaceId, link.repositoryId, number)
  return { written, deleted: missing.length }
}
