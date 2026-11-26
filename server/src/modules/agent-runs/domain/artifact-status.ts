import {
  WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS,
  type AgentRunArtifactProvider,
  type AgentRunArtifactStatus,
  type AgentRunArtifactUnverifiedReason,
  type AgentRunPullRequestStatus,
} from '@mukuroji/contracts'
import type { StoredAgentRunReport } from './agent-run-report'

/** Pull request or merge request a reported artifact URL points at. */
export type PullRequestArtifactReference = {
  /** Artifact URL exactly as reported. */
  url: string
  /** Provider of the URL. */
  provider: AgentRunArtifactProvider
  /** Lowercase repository path. */
  repository: string
  /** Pull request or merge request number. */
  number: number
}

/** Repository path segment: GitHub and GitLab names use letters, digits, `.`, `-`, and `_`. */
const repositorySegmentPattern = /^[A-Za-z0-9_.-]+$/

/**
 * Reads the pull request a reported artifact URL names. Only public provider hosts are recognized;
 * any other URL is not a pull request Mukuroji can verify.
 *
 * @param url - Reported artifact URL, already validated as HTTPS without a query.
 * @returns The reference, or undefined when the URL is no GitHub pull request or GitLab merge request.
 */
export function readPullRequestArtifactReference(url: string): PullRequestArtifactReference | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return undefined
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  const host = parsed.hostname.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repository, kind, number] = segments
    if (kind !== 'pull' || owner === undefined || repository === undefined) return undefined
    return createReference(url, 'github', [owner, repository], number)
  }
  if (host === 'gitlab.com') {
    const marker = segments.indexOf('-')
    if (marker < 2 || segments[marker + 1] !== 'merge_requests') return undefined
    return createReference(url, 'gitlab', segments.slice(0, marker), segments[marker + 2])
  }
  return undefined
}

/**
 * Builds a reference after checking the repository path and number.
 *
 * @param url - Reported URL.
 * @param provider - Provider of the URL.
 * @param path - Repository path segments.
 * @param number - Number segment, if any.
 * @returns The reference, or undefined when a segment is malformed.
 */
function createReference(
  url: string,
  provider: AgentRunArtifactProvider,
  path: readonly string[],
  number: string | undefined,
): PullRequestArtifactReference | undefined {
  if (path.length > 9 || !path.every((segment) => repositorySegmentPattern.test(segment))) return undefined
  if (number === undefined || !/^[1-9][0-9]{0,9}$/.test(number)) return undefined
  const parsedNumber = Number(number)
  if (!Number.isSafeInteger(parsedNumber)) return undefined
  return { url, provider, repository: path.join('/').toLowerCase(), number: parsedNumber }
}

/**
 * Collects the distinct pull request artifacts of reports, newest report first.
 *
 * @param reports - Reports of one Work Item, newest first.
 * @param limit - Most references to collect.
 * @returns Distinct references by URL, at most `limit`.
 */
export function collectPullRequestArtifacts(
  reports: readonly StoredAgentRunReport[],
  limit = WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS,
): PullRequestArtifactReference[] {
  const references: PullRequestArtifactReference[] = []
  const seen = new Set<string>()
  for (const report of reports) {
    for (const artifact of report.artifacts) {
      if (artifact.type !== 'pull-request' || seen.has(artifact.url)) continue
      seen.add(artifact.url)
      const reference = readPullRequestArtifactReference(artifact.url)
      if (reference !== undefined) references.push(reference)
      if (references.length >= limit) return references
    }
  }
  return references
}

/**
 * Checks whether the Team's allowlist admits a repository. An empty allowlist admits any
 * repository the connector can read.
 *
 * @param allowlist - Lowercase repository paths of the Team.
 * @param repository - Lowercase repository path of the artifact.
 * @returns True when the repository may be verified.
 */
export function isArtifactRepositoryAllowed(allowlist: readonly string[], repository: string): boolean {
  return allowlist.length === 0 || allowlist.includes(repository)
}

/**
 * Builds an unverified status of a reference.
 *
 * @param reference - Artifact reference.
 * @param reason - Why it is not verified.
 * @param checkedAt - Check time.
 * @returns The status.
 */
export function createUnverifiedArtifactStatus(
  reference: PullRequestArtifactReference,
  reason: NonNullable<AgentRunArtifactStatus['unverifiedReason']>,
  checkedAt: Date,
): AgentRunArtifactStatus {
  return {
    url: reference.url,
    provider: reference.provider,
    repository: reference.repository,
    number: reference.number,
    verification: 'unverified',
    unverifiedReason: reason,
    checkedAt: checkedAt.toISOString(),
  }
}

/**
 * Checks whether a stored status no longer changes, so a refresh need not read it again.
 *
 * @param status - Stored status.
 * @returns True for a merged pull request; a closed one may still be reopened.
 */
export function isFinalArtifactStatus(status: AgentRunArtifactStatus): boolean {
  return status.pullRequest?.state === 'merged'
}

/** Result of reading one pull request through the Workspace's connector. */
export type PullRequestStatusReadResult =
  | {
      /** The provider returned the pull request. */
      kind: 'verified'
      /** Provider state. */
      pullRequest: AgentRunPullRequestStatus
    }
  | {
      /** The pull request could not be read. */
      kind: 'unverified'
      /** Why it could not be read. */
      reason: Exclude<AgentRunArtifactUnverifiedReason, 'repository-not-allowed'>
    }

/**
 * Reads one pull request through the connector of its provider. It never throws: a provider
 * failure is an unverified result, so one artifact never hides the others.
 */
export type PullRequestStatusReader = (
  workspaceId: string,
  reference: PullRequestArtifactReference,
) => Promise<PullRequestStatusReadResult>
