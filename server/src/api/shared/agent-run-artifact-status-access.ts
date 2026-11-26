import {
  WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS,
  type AgentRunArtifactStatus,
  type AgentRunPullRequestStatus,
  type ConnectorInstallation,
  type WorkItemArtifactStatusesResponse,
} from '@mukuroji/contracts'
import { ConnectorRuntimeError } from '../../modules/developer-platform/connector-oauth'
import {
  collectPullRequestArtifacts,
  createUnverifiedArtifactStatus,
  isArtifactRepositoryAllowed,
  isFinalArtifactStatus,
  type AgentRunArtifactStatusStore,
  type AgentRunStore,
  type PullRequestArtifactReference,
  type PullRequestStatusReadResult,
  type PullRequestStatusReader,
  type StoredAgentRunReport,
} from '../../modules/agent-runs'

/** Age after which an open pull request's stored status is read again from the provider. */
export const ARTIFACT_STATUS_STALE_AFTER_MS = 2 * 60_000

/** Shortest interval between two provider refreshes of one Work Item's artifacts. */
export const ARTIFACT_STATUS_REFRESH_INTERVAL_MS = 60_000

/**
 * Longest time one read spends on provider refreshes. The API Lambda stops at 20 seconds and one
 * provider request may take 10, so reads still running at this point are left for a later view.
 */
export const ARTIFACT_STATUS_REFRESH_BUDGET_MS = 8_000

/**
 * Report pages read to find a Work Item's newest pull request artifacts. Reading stops sooner once
 * {@link WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS} are found.
 */
const maximumReportPages = 20

/** Pull requests read from the provider at once. */
const readConcurrency = 5

/** Stores and reader one artifact status read uses. */
export type ArtifactStatusDependencies = {
  /** Agent Run reports and Team Agent settings. */
  agentRuns: Pick<AgentRunStore, 'listWorkItemReports' | 'getSettings'>
  /** Stored artifact statuses. */
  statuses: AgentRunArtifactStatusStore
  /** Provider reader of the Workspace's connectors. */
  reader: PullRequestStatusReader
  /** Time budget of provider refreshes; {@link ARTIFACT_STATUS_REFRESH_BUDGET_MS} when omitted. */
  refreshBudgetMs?: number
}

/** Work Item whose artifact statuses are read; the caller has already authorized the viewer. */
export type ArtifactStatusTarget = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
}

/**
 * Reads the verification of a Work Item's reported pull requests (ADR 0103). Stored statuses are
 * returned as they are while fresh; a missing status, or an open pull request's status older than
 * {@link ARTIFACT_STATUS_STALE_AFTER_MS}, is read again from the provider, at most once per
 * {@link ARTIFACT_STATUS_REFRESH_INTERVAL_MS} for the Work Item. Merged pull requests are not read again.
 * A repository outside the Team's current allowlist is reported as not allowed, whatever is stored.
 *
 * @param target - Authorized Work Item.
 * @param dependencies - Stores and reader.
 * @param now - Read time.
 * @returns One status per distinct reported pull request URL, newest report first.
 */
export async function readWorkItemArtifactStatuses(
  target: ArtifactStatusTarget,
  dependencies: ArtifactStatusDependencies,
  now: Date = new Date(),
): Promise<WorkItemArtifactStatusesResponse> {
  const { references, complete } = await readNewestReferences(target, dependencies.agentRuns)
  // The allowlist is applied to every read, so a repository removed from it stops showing as
  // verified at once, even for a merged pull request that is never read again.
  const { artifactRepositories } = await dependencies.agentRuns.getSettings(target.directoryId, target.teamId)
  const allowed = references.filter((reference) => isArtifactRepositoryAllowed(artifactRepositories, reference.repository))
  const stored = new Map((await dependencies.statuses.getStatuses(
    target.directoryId, target.teamId, target.workItemId, allowed.map((reference) => reference.url),
  )).map((status) => [status.url, status]))
  const stale = allowed.filter((reference) => needsRefresh(stored.get(reference.url), now))
  if (stale.length > 0 &&
      await dependencies.statuses.claimRefresh(target.directoryId, target.teamId, target.workItemId, now, ARTIFACT_STATUS_REFRESH_INTERVAL_MS)) {
    const refreshed = await refreshWithinBudget(
      rotateForRefresh(stale, now),
      (reference) => checkReference(target.directoryId, reference, stored.get(reference.url), dependencies.reader, now),
      dependencies.refreshBudgetMs ?? ARTIFACT_STATUS_REFRESH_BUDGET_MS,
    )
    await dependencies.statuses.saveStatuses(target.directoryId, target.teamId, target.workItemId, refreshed)
    for (const status of refreshed) stored.set(status.url, status)
  }
  const allowedUrls = new Set(allowed.map((reference) => reference.url))
  return {
    teamId: target.teamId,
    workItemId: target.workItemId,
    items: references.map((reference) => {
      if (!allowedUrls.has(reference.url)) return createUnverifiedArtifactStatus(reference, 'repository-not-allowed', now)
      // A reference another viewer is refreshing for the first time shows as unavailable until then.
      return stored.get(reference.url) ?? createUnverifiedArtifactStatus(reference, 'unavailable', now)
    }),
    ...(complete ? {} : { incomplete: true as const }),
  }
}

/**
 * Starts each refresh at a different reference, moving on once per refresh interval, so slow
 * references at the front cannot use up every budget and keep the ones behind them unchecked.
 *
 * @param references - Stale references, newest report first.
 * @param now - Read time.
 * @returns The same references, starting at this interval's position.
 */
function rotateForRefresh(
  references: readonly PullRequestArtifactReference[],
  now: Date,
): PullRequestArtifactReference[] {
  const start = Math.floor(now.getTime() / ARTIFACT_STATUS_REFRESH_INTERVAL_MS) % references.length
  return [...references.slice(start), ...references.slice(0, start)]
}

/**
 * Checks references a few at a time until all are done or the budget runs out. Checks still
 * running at the deadline are dropped, so the read keeps the stored or unverified status for them
 * and the finished ones are still saved.
 *
 * @param references - References to check.
 * @param check - Check of one reference.
 * @param budgetMs - Time budget.
 * @returns The statuses of the checks that finished in time.
 */
async function refreshWithinBudget(
  references: readonly PullRequestArtifactReference[],
  check: (reference: PullRequestArtifactReference) => Promise<AgentRunArtifactStatus>,
  budgetMs: number,
): Promise<AgentRunArtifactStatus[]> {
  const deadline = Date.now() + budgetMs
  const finished: AgentRunArtifactStatus[] = []
  let next = 0
  /** Takes the next reference until none are left or the deadline passes. */
  const worker = async () => {
    while (next < references.length && Date.now() < deadline) {
      const reference = references[next]
      next += 1
      if (reference !== undefined) finished.push(await check(reference))
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(readConcurrency, references.length) }, worker)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  // A copy, so a check that finishes after the deadline is not saved with this read.
  return [...finished]
}

/**
 * Reads the Work Item's newest reports until they name enough pull requests, or none are left.
 *
 * @param target - Work Item.
 * @param agentRuns - Report store.
 * @returns The newest distinct pull request references, newest report first, and whether every
 * report that could name another one was read.
 */
async function readNewestReferences(
  target: ArtifactStatusTarget,
  agentRuns: Pick<AgentRunStore, 'listWorkItemReports'>,
): Promise<{ references: PullRequestArtifactReference[], complete: boolean }> {
  const reports: StoredAgentRunReport[] = []
  let cursor: string | undefined
  for (let page = 0; page < maximumReportPages; page += 1) {
    const result = await agentRuns.listWorkItemReports(target.directoryId, target.teamId, target.workItemId, cursor, 100)
    reports.push(...result.reports)
    const references = collectPullRequestArtifacts(reports)
    if (result.nextCursor === undefined || references.length >= WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS) {
      return { references, complete: true }
    }
    cursor = result.nextCursor
  }
  return { references: collectPullRequestArtifacts(reports), complete: false }
}

/**
 * Checks whether a stored status must be read again.
 *
 * @param status - Stored status, if any.
 * @param now - Read time.
 * @returns True when the status is missing, or not final and older than the stale age.
 */
function needsRefresh(status: AgentRunArtifactStatus | undefined, now: Date): boolean {
  if (status === undefined) return true
  if (isFinalArtifactStatus(status)) return false
  return now.getTime() - Date.parse(status.checkedAt) >= ARTIFACT_STATUS_STALE_AFTER_MS
}

/**
 * Checks one allowed reference against the provider. When the provider cannot be read
 * for a moment, a previously verified status is kept with its old check time, so a short outage
 * does not turn a verified pull request into an unverified one.
 *
 * @param workspaceId - Workspace ID.
 * @param reference - Pull request reference the Team's allowlist permits.
 * @param previous - Stored status, if any.
 * @param reader - Provider reader.
 * @param now - Check time.
 * @returns The status to store.
 */
async function checkReference(
  workspaceId: string,
  reference: PullRequestArtifactReference,
  previous: AgentRunArtifactStatus | undefined,
  reader: PullRequestStatusReader,
  now: Date,
): Promise<AgentRunArtifactStatus> {
  const result = await reader(workspaceId, reference)
  if (result.kind === 'unverified') {
    if (result.reason === 'unavailable' && previous?.verification === 'verified') return previous
    return createUnverifiedArtifactStatus(reference, result.reason, now)
  }
  return {
    url: reference.url,
    provider: reference.provider,
    repository: reference.repository,
    number: reference.number,
    verification: 'verified',
    pullRequest: result.pullRequest,
    checkedAt: now.toISOString(),
  }
}

/**
 * Connected installations tried for one pull request, so a Workspace with many accounts stays
 * bounded. The account named like the repository owner is tried first, so the cap rarely matters,
 * and the read's time budget stops the rest.
 */
const maximumInstallationsPerRead = 10

/** Connector engine method the pull request reader uses. */
export type PullRequestConnectorEngine = {
  /**
   * Reads a pull request through a connected installation.
   *
   * @param workspaceId - Workspace of the installation.
   * @param installationId - Installation ID.
   * @param reference - Repository and pull request number.
   * @returns The pull request state, checks, and reviews.
   */
  readPullRequest(
    workspaceId: string,
    installationId: string,
    reference: { repository: string, number: number },
  ): Promise<AgentRunPullRequestStatus>
}

/** Connector reads the pull request reader needs. */
export type PullRequestReaderConnectors = {
  /** Lists the Workspace's connector installations. */
  listConnectors(workspaceId: string): Promise<ConnectorInstallation[]>
  /** Loads the connector engine; throws ConnectorRuntimeUnavailable when connectors are not configured. */
  getEngine(): Promise<PullRequestConnectorEngine>
}

/**
 * Creates the reader that verifies a pull request through the Workspace's own connected accounts
 * (ADR 0103). Only GitHub is read; a GitLab merge request is reported as an unsupported provider.
 * Each connected GitHub installation is tried in turn until one can read the pull request, so the
 * result never shows a repository that none of the Workspace's accounts can read.
 *
 * When the Workspace has more accounts than one read tries, each read starts at a randomly chosen
 * one, and an unread pull request is reported as `unavailable` rather than `not-accessible`, since
 * an untried account might read it. A random start, unlike one taken from the clock, cannot fall
 * back on the same accounts every time the refresh period lines up with the account count.
 *
 * @param connectors - Installation list and engine loader.
 * @param pickStart - Chooses where among the other accounts a read starts, from 0 to below `size`.
 * @returns The reader.
 */
export function createConnectorPullRequestStatusReader(
  connectors: PullRequestReaderConnectors,
  pickStart: (size: number) => number = pickRandomIndex,
): PullRequestStatusReader {
  return async (workspaceId, reference) => {
    if (reference.provider !== 'github') return { kind: 'unverified', reason: 'unsupported-provider' }
    let installations: ConnectorInstallation[]
    let untried = false
    try {
      const candidates = orderInstallationsForRepository(
        (await connectors.listConnectors(workspaceId)).filter((installation) => installation.provider === 'github' &&
          (installation.status === 'connected' || installation.status === 'degraded')),
        reference.repository,
        pickStart,
      )
      installations = candidates.slice(0, maximumInstallationsPerRead)
      untried = candidates.length > installations.length
    } catch (error) {
      console.error(error)
      return { kind: 'unverified', reason: 'unavailable' }
    }
    if (installations.length === 0) return { kind: 'unverified', reason: 'no-connector' }
    let engine: PullRequestConnectorEngine
    try {
      engine = await connectors.getEngine()
    } catch (error) {
      if (error instanceof ConnectorRuntimeError && error.code === 'ConnectorRuntimeUnavailable') {
        return { kind: 'unverified', reason: 'no-connector' }
      }
      console.error(error)
      return { kind: 'unverified', reason: 'unavailable' }
    }
    let result: PullRequestStatusReadResult = { kind: 'unverified', reason: untried ? 'unavailable' : 'not-accessible' }
    for (const installation of installations) {
      try {
        return {
          kind: 'verified',
          pullRequest: await engine.readPullRequest(workspaceId, installation.id, {
            repository: reference.repository,
            number: reference.number,
          }),
        }
      } catch (error) {
        result = { kind: 'unverified', reason: toUnverifiedReason(error, result) }
      }
    }
    return result
  }
}

/**
 * Orders installations so the ones whose account is named like the repository owner come first.
 * When the others do not all fit in one read, they start at a chosen position and wrap around, so
 * over repeated reads every account is tried.
 *
 * @param installations - Connected GitHub installations.
 * @param repository - Lowercase `owner/repo` path.
 * @param pickStart - Chooses the start position among the other accounts.
 * @returns The installations in the order to try.
 */
function orderInstallationsForRepository(
  installations: ConnectorInstallation[],
  repository: string,
  pickStart: (size: number) => number,
): ConnectorInstallation[] {
  const owner = repository.split('/')[0]
  const ownsRepository = (installation: ConnectorInstallation) => installation.externalAccountName?.toLowerCase() === owner
  const owners = installations.filter(ownsRepository)
  const others = installations.filter((installation) => !ownsRepository(installation))
  if (owners.length + others.length <= maximumInstallationsPerRead) return [...owners, ...others]
  const picked = Math.trunc(pickStart(others.length))
  const start = Number.isFinite(picked) ? ((picked % others.length) + others.length) % others.length : 0
  return [...owners, ...others.slice(start), ...others.slice(0, start)]
}

/**
 * Picks a uniformly random index.
 *
 * @param size - Number of positions.
 * @returns An integer from 0 to below `size`.
 */
function pickRandomIndex(size: number): number {
  return Math.floor(Math.random() * size)
}

/**
 * Maps a failed provider read to the reason shown for the pull request. A missing or unreadable
 * pull request on one account does not hide an outage seen on another.
 *
 * @param error - Thrown value.
 * @param previous - Result of the installations tried before.
 * @returns The reason to report.
 */
function toUnverifiedReason(
  error: unknown,
  previous: PullRequestStatusReadResult,
): 'not-accessible' | 'unsupported-provider' | 'unavailable' {
  const before = previous.kind === 'unverified' && previous.reason === 'unavailable' ? 'unavailable' : 'not-accessible'
  if (!(error instanceof ConnectorRuntimeError)) {
    console.error(error)
    return 'unavailable'
  }
  if (error.code === 'ConnectorExternalResourceMissing' || error.authorizationRequired) return before
  if (error.code === 'ConnectorCapabilityUnsupported') return before === 'unavailable' ? before : 'unsupported-provider'
  return 'unavailable'
}
