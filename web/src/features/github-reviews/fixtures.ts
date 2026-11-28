import type {
  GitHubPullRequestInboxResponse,
  GitHubPullRequestSummary,
  GitHubRepositoryLinkListResponse,
} from '@mukuroji/contracts'

/** Teams of the fixtures. */
export const githubReviewTeamsFixture = [
  { id: 'core-team', name: 'Core' },
  { id: 'web-team', name: 'Web' },
] as const

/**
 * Builds an open, mergeable pull request of the fixtures.
 *
 * @param overrides - Fields to replace.
 * @returns The pull request.
 */
function pullRequest(overrides: Partial<GitHubPullRequestSummary>): GitHubPullRequestSummary {
  return {
    repositoryId: '42',
    repository: 'acme/app',
    number: 5,
    title: 'Add the review inbox',
    url: 'https://github.com/acme/app/pull/5',
    state: 'open',
    draft: false,
    authorLogin: 'alice',
    headRef: 'feature/inbox',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    mergeable: 'mergeable',
    reviewDecision: 'review-required',
    requestedReviewerLogins: ['demo-user'],
    requestedTeamSlugs: [],
    reviews: [],
    checks: { state: 'success', failedNames: [], total: 3 },
    teamId: 'core-team',
    section: 'open',
    createdAt: '2026-11-26T01:00:00.000Z',
    updatedAt: '2026-11-28T01:00:00.000Z',
    syncedAt: '2026-11-28T01:05:00.000Z',
    ...overrides,
  }
}

/** `To review` inbox with an open, a failing, and a ready pull request. */
export const toReviewInboxFixture: GitHubPullRequestInboxResponse = {
  configured: true,
  githubLogin: 'demo-user',
  view: 'to-review',
  items: [
    pullRequest({
      number: 12,
      title: 'Fix the timesheet total',
      url: 'https://github.com/acme/app/pull/12',
      reviewDecision: 'approved',
      section: 'ready-to-merge',
      updatedAt: '2026-11-28T02:00:00.000Z',
    }),
    pullRequest({}),
    pullRequest({
      repositoryId: '43',
      repository: 'acme/web',
      number: 31,
      title: 'Move the settings panels',
      url: 'https://github.com/acme/web/pull/31',
      teamId: 'web-team',
      mergeable: 'conflicting',
      checks: { state: 'failure', failedNames: ['unit-tests', 'lint'], total: 4 },
      updatedAt: '2026-11-27T09:00:00.000Z',
    }),
  ],
}

/** `Created` inbox with a draft and a merged pull request. */
export const createdInboxFixture: GitHubPullRequestInboxResponse = {
  configured: true,
  githubLogin: 'demo-user',
  view: 'created',
  items: [
    pullRequest({ number: 40, title: 'Draft: try the new parser', authorLogin: 'demo-user', draft: true, checks: { state: 'pending', failedNames: [], total: 2 } }),
    pullRequest({
      number: 38,
      title: 'Bump dependencies',
      authorLogin: 'demo-user',
      state: 'merged',
      section: 'merged',
      mergedAt: '2026-11-27T03:00:00.000Z',
      closedAt: '2026-11-27T03:00:00.000Z',
    }),
  ],
}

/** Repository listing with one linked and one unlinked repository. */
export const repositoryLinksFixture: GitHubRepositoryLinkListResponse = {
  configured: true,
  repositories: [
    { repositoryId: '42', repository: 'acme/app', installationId: '7', private: true, teamId: 'core-team', revision: 1, linkedAt: '2026-11-27T00:00:00.000Z' },
    { repositoryId: '43', repository: 'acme/web', installationId: '7', private: false },
  ],
}
