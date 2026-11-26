/** Providers whose pull request or merge request URLs Mukuroji recognizes in reported artifacts. */
export const AGENT_RUN_ARTIFACT_PROVIDERS = ['github', 'gitlab'] as const

/** Provider of a recognized pull request or merge request URL. */
export type AgentRunArtifactProvider = (typeof AGENT_RUN_ARTIFACT_PROVIDERS)[number]

/**
 * Why Mukuroji could not verify a reported pull request; the report stays the agent's own claim.
 *
 * - `repository-not-allowed`: the Team's artifact repository allowlist does not list the repository.
 * - `no-connector`: the Workspace has no connected connector for the provider.
 * - `not-accessible`: the connector cannot read the pull request (missing or outside its access).
 * - `unsupported-provider`: Mukuroji does not read this provider yet.
 * - `unavailable`: the provider could not be read; a later refresh retries.
 */
export const AGENT_RUN_ARTIFACT_UNVERIFIED_REASONS = [
  'repository-not-allowed',
  'no-connector',
  'not-accessible',
  'unsupported-provider',
  'unavailable',
] as const

/** Reason a reported pull request is not verified. */
export type AgentRunArtifactUnverifiedReason = (typeof AGENT_RUN_ARTIFACT_UNVERIFIED_REASONS)[number]

/** States of a verified pull request. */
export const AGENT_RUN_PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const

/** State of a verified pull request. */
export type AgentRunPullRequestState = (typeof AGENT_RUN_PULL_REQUEST_STATES)[number]

/** Combined result of the checks and commit statuses on the pull request head. */
export const AGENT_RUN_PULL_REQUEST_CHECK_STATES = ['success', 'failure', 'pending', 'none'] as const

/** Combined check result of a verified pull request. */
export type AgentRunPullRequestCheckState = (typeof AGENT_RUN_PULL_REQUEST_CHECK_STATES)[number]

/** Review state from each reviewer's latest decisive review. */
export const AGENT_RUN_PULL_REQUEST_REVIEW_STATES = ['approved', 'changes-requested', 'none'] as const

/** Review state of a verified pull request. */
export type AgentRunPullRequestReviewState = (typeof AGENT_RUN_PULL_REQUEST_REVIEW_STATES)[number]

/** Provider state of a pull request that Mukuroji read through a connector. */
export type AgentRunPullRequestStatus = {
  /** Open, closed without merging, or merged. */
  state: AgentRunPullRequestState
  /** Whether the pull request is a draft. */
  draft: boolean
  /** Head commit SHA the checks were read for. */
  headSha: string
  /** Combined check runs and commit statuses on the head commit. */
  checks: AgentRunPullRequestCheckState
  /** Review state from each reviewer's latest approval or change request. */
  review: AgentRunPullRequestReviewState
  /** When the pull request was merged. */
  mergedAt?: string
  /** Merge commit SHA, once merged. */
  mergeCommitSha?: string
}

/** Verification of one pull request artifact that agents reported on a Work Item. */
export type AgentRunArtifactStatus = {
  /** Artifact URL exactly as reported. */
  url: string
  /** Provider the URL belongs to. */
  provider: AgentRunArtifactProvider
  /** Repository path, such as `owner/repo` or a GitLab project path, in lowercase. */
  repository: string
  /** Pull request or merge request number. */
  number: number
  /** Whether Mukuroji read the state from the provider, as opposed to the agent's claim alone. */
  verification: 'verified' | 'unverified'
  /** Why the artifact is not verified; present only when unverified. */
  unverifiedReason?: AgentRunArtifactUnverifiedReason
  /** Provider state; present only when verified. */
  pullRequest?: AgentRunPullRequestStatus
  /** When Mukuroji last checked the artifact. */
  checkedAt: string
}

/** Pull request artifacts of one Work Item and how each was verified. */
export type WorkItemArtifactStatusesResponse = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** One entry per distinct reported pull request URL, newest report first. */
  items: AgentRunArtifactStatus[]
  /**
   * Present when the Work Item has more reports than one read scans, so an older reported pull
   * request may be missing from `items`.
   */
  incomplete?: true
}

/** Most pull request artifacts of one Work Item that Mukuroji verifies. */
export const WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS = 20

/** Most repositories one Team lists as verifiable artifact repositories. */
export const AGENT_SETTINGS_ARTIFACT_REPOSITORIES_MAX = 50

/** Pattern of one allowlisted repository: `owner/repo`, or a GitLab group path ending in the project. */
export const AGENT_SETTINGS_ARTIFACT_REPOSITORY_PATTERN = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,8}$/

/** Longest allowlisted repository path, in characters. */
export const AGENT_SETTINGS_ARTIFACT_REPOSITORY_MAX_LENGTH = 256

/**
 * Checks that a value is one normalized allowlisted repository path: lowercase, within
 * {@link AGENT_SETTINGS_ARTIFACT_REPOSITORY_MAX_LENGTH}, and matching
 * {@link AGENT_SETTINGS_ARTIFACT_REPOSITORY_PATTERN}.
 *
 * @param value - Untrusted value.
 * @returns True for a repository path the Team allowlist may hold.
 */
export function isArtifactRepositoryPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= AGENT_SETTINGS_ARTIFACT_REPOSITORY_MAX_LENGTH &&
    AGENT_SETTINGS_ARTIFACT_REPOSITORY_PATTERN.test(value)
}
