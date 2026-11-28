import { GITHUB_REPOSITORY_ID_PATTERN } from '@mukuroji/contracts'

/** Most pull request numbers one sync job names. */
export const GITHUB_SYNC_JOB_MAX_NUMBERS = 20

/** Attempts a job makes while GitHub has not finished computing the merge conflict state. */
export const GITHUB_SYNC_JOB_MAX_ATTEMPTS = 4

/** `owner/repo` of a GitHub repository. */
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u

/** Commit SHA GitHub reports: 40 (SHA-1) or 64 (SHA-256) hexadecimal digits. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

/** Installation ID: a positive decimal integer. */
const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/u

/** Branch names longer than this are not synchronized. */
const BRANCH_NAME_MAX_LENGTH = 255

/** Repository a sync job reads, as the signed webhook named it. */
export type GitHubSyncJobRepository = {
  /** GitHub App installation the delivery came from. */
  installationId: string
  /** GitHub's numeric repository ID, as a decimal string. */
  repositoryId: string
  /** `owner/repo` at delivery time. */
  repository: string
}

/**
 * Work the sync worker does for one webhook delivery. Jobs carry only identifiers: the worker
 * reads the current state from GitHub, so a duplicated or reordered delivery is harmless.
 */
export type GitHubSyncJob = GitHubSyncJobRepository & {
  /** Retry count of a job requeued while the merge conflict state was still being computed. */
  attempt: number
} & (
  | {
    /** Read the named pull requests. */
    kind: 'pull-requests'
    /** Pull request numbers. */
    numbers: number[]
  }
  | {
    /** Read the open pull requests whose head is this commit. */
    kind: 'commit'
    /** Commit SHA. */
    sha: string
  }
  | {
    /** Read the open pull requests that target this branch, whose conflict state may have changed. */
    kind: 'base-branch'
    /** Branch name without `refs/heads/`. */
    branch: string
  }
  | {
    /** Read every open pull request; queued when an administrator links the repository. */
    kind: 'repository'
  }
)

/** Result of reading one webhook delivery. */
export type GitHubWebhookInterpretation =
  | { kind: 'job', job: GitHubSyncJob }
  | { kind: 'ping' }
  | { kind: 'ignored' }

/**
 * Turns a signature-verified webhook delivery into a sync job (ADR 0079).
 *
 * `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status`, and `push` are
 * read; every other event, and a delivery without an installation or repository, is ignored.
 *
 * @param eventName - `X-GitHub-Event` header.
 * @param payload - Parsed JSON body.
 * @returns The job, a ping, or ignored.
 */
export function interpretGitHubWebhook(eventName: string, payload: unknown): GitHubWebhookInterpretation {
  if (eventName === 'ping') return { kind: 'ping' }
  if (!isRecord(payload)) return { kind: 'ignored' }
  const repository = readRepository(payload)
  if (!repository) return { kind: 'ignored' }
  switch (eventName) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread': {
      const number = readNumber(isRecord(payload.pull_request) ? payload.pull_request.number : payload.number)
      return number === undefined ? { kind: 'ignored' } : job(repository, { kind: 'pull-requests', numbers: [number] })
    }
    case 'check_suite':
    case 'check_run': {
      const subject = eventName === 'check_suite' ? payload.check_suite : payload.check_run
      if (!isRecord(subject)) return { kind: 'ignored' }
      const numbers = readPullRequestNumbers(subject.pull_requests)
      if (numbers.length > 0) return job(repository, { kind: 'pull-requests', numbers })
      // GitHub leaves the list empty for a pull request from a fork, so the commit is looked up.
      const sha = readSha(subject.head_sha)
      return sha === undefined ? { kind: 'ignored' } : job(repository, { kind: 'commit', sha })
    }
    case 'status': {
      const sha = readSha(payload.sha)
      return sha === undefined ? { kind: 'ignored' } : job(repository, { kind: 'commit', sha })
    }
    case 'push': {
      if (payload.deleted === true || typeof payload.ref !== 'string' || !payload.ref.startsWith('refs/heads/')) {
        return { kind: 'ignored' }
      }
      const branch = payload.ref.slice('refs/heads/'.length)
      if (!isBranchName(branch)) return { kind: 'ignored' }
      // A push to a head branch also sends `pull_request` `synchronize`, so the push itself only
      // matters for pull requests that target the branch: their conflict state may have changed.
      return job(repository, { kind: 'base-branch', branch })
    }
    default:
      return { kind: 'ignored' }
  }
}

/**
 * Validates a sync job read back from the queue.
 *
 * @param value - Untrusted queue message body, parsed.
 * @returns The job.
 * @throws TypeError when the message is not a sync job.
 */
export function parseGitHubSyncJob(value: unknown): GitHubSyncJob {
  if (!isRecord(value)) throw new TypeError('GitHub sync job must be an object.')
  const { installationId, repositoryId, repository, attempt } = value
  if (
    typeof installationId !== 'string' || !INSTALLATION_ID_PATTERN.test(installationId) ||
    typeof repositoryId !== 'string' || !GITHUB_REPOSITORY_ID_PATTERN.test(repositoryId) ||
    typeof repository !== 'string' || !REPOSITORY_NAME_PATTERN.test(repository) ||
    typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0 || attempt >= GITHUB_SYNC_JOB_MAX_ATTEMPTS
  ) {
    throw new TypeError('GitHub sync job repository is invalid.')
  }
  const base = { installationId, repositoryId, repository, attempt }
  switch (value.kind) {
    case 'pull-requests': {
      if (!Array.isArray(value.numbers)) throw new TypeError('GitHub sync job numbers are invalid.')
      const numbers = value.numbers.map(readNumber)
      if (numbers.length === 0 || numbers.length > GITHUB_SYNC_JOB_MAX_NUMBERS || numbers.some((number) => number === undefined)) {
        throw new TypeError('GitHub sync job numbers are invalid.')
      }
      return { ...base, kind: 'pull-requests', numbers: numbers.filter((number) => number !== undefined) }
    }
    case 'commit': {
      const sha = readSha(value.sha)
      if (sha === undefined) throw new TypeError('GitHub sync job commit is invalid.')
      return { ...base, kind: 'commit', sha }
    }
    case 'base-branch': {
      if (typeof value.branch !== 'string' || !isBranchName(value.branch)) {
        throw new TypeError('GitHub sync job branch is invalid.')
      }
      return { ...base, kind: 'base-branch', branch: value.branch }
    }
    case 'repository':
      return { ...base, kind: 'repository' }
    default:
      throw new TypeError('GitHub sync job kind is invalid.')
  }
}

/**
 * Builds a first-attempt job.
 *
 * @param repository - Repository of the delivery.
 * @param target - What to read.
 * @returns The interpretation carrying the job.
 */
function job(
  repository: GitHubSyncJobRepository,
  target: { kind: 'pull-requests', numbers: number[] } | { kind: 'commit', sha: string } | { kind: 'base-branch', branch: string },
): GitHubWebhookInterpretation {
  return { kind: 'job', job: { ...repository, attempt: 0, ...target } }
}

/**
 * Reads the installation and repository every repository event carries.
 *
 * @param payload - Webhook body.
 * @returns The repository, or `undefined` when either is missing or malformed.
 */
function readRepository(payload: Record<string, unknown>): GitHubSyncJobRepository | undefined {
  const installation = isRecord(payload.installation) ? payload.installation.id : undefined
  const repository = isRecord(payload.repository) ? payload.repository : undefined
  if (!repository) return undefined
  const installationId = readId(installation)
  const repositoryId = readId(repository.id)
  const fullName = repository.full_name
  if (
    installationId === undefined ||
    repositoryId === undefined ||
    typeof fullName !== 'string' ||
    !REPOSITORY_NAME_PATTERN.test(fullName)
  ) {
    return undefined
  }
  return { installationId, repositoryId, repository: fullName }
}

/**
 * Reads the distinct pull request numbers of a check suite or check run.
 *
 * @param value - `pull_requests` array.
 * @returns Up to {@link GITHUB_SYNC_JOB_MAX_NUMBERS} numbers.
 */
function readPullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const numbers = new Set<number>()
  for (const entry of value) {
    const number = isRecord(entry) ? readNumber(entry.number) : undefined
    if (number !== undefined) numbers.add(number)
    if (numbers.size === GITHUB_SYNC_JOB_MAX_NUMBERS) break
  }
  return [...numbers]
}

/**
 * Reads a GitHub numeric ID as a decimal string.
 *
 * @param value - Candidate ID.
 * @returns The ID, or `undefined`.
 */
function readId(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined
  return String(value)
}

/**
 * Reads a pull request number.
 *
 * @param value - Candidate number.
 * @returns The number, or `undefined`.
 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * Reads a commit SHA.
 *
 * @param value - Candidate SHA.
 * @returns The SHA, or `undefined`.
 */
function readSha(value: unknown): string | undefined {
  return typeof value === 'string' && COMMIT_SHA_PATTERN.test(value) ? value : undefined
}

/**
 * Checks a branch name closely enough to pass it to GitHub as a GraphQL variable.
 *
 * @param value - Branch name.
 * @returns True for a non-empty name without control characters.
 */
function isBranchName(value: string): boolean {
  return value.length > 0 && value.length <= BRANCH_NAME_MAX_LENGTH && !/\p{Cc}/u.test(value)
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
