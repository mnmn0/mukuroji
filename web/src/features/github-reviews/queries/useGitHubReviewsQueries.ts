import type { GitHubPullRequestInboxView } from '@mukuroji/contracts'
import useSWR from 'swr'
import { listGitHubRepositoryLinks, readGitHubLogin, readPullRequestInbox } from '../api/githubReviews'

/**
 * Loads one tab of the signed-in member's pull request review inbox.
 *
 * @param accessToken - Access token of the member, or `undefined` before sign-in.
 * @param view - `created` or `to-review`.
 * @returns The SWR state of the inbox.
 */
export function usePullRequestInboxQuery(accessToken: string | undefined, view: GitHubPullRequestInboxView) {
  return useSWR(
    accessToken ? ['github-pull-request-inbox', accessToken, view] as const : null,
    ([, token, tab]) => readPullRequestInbox(token, tab),
    { shouldRetryOnError: false, refreshInterval: 60_000 },
  )
}

/**
 * Loads the signed-in member's GitHub login.
 *
 * @param accessToken - Access token of the member.
 * @returns The SWR state of the login.
 */
export function useGitHubLoginQuery(accessToken: string) {
  return useSWR(
    ['github-login', accessToken] as const,
    ([, token]) => readGitHubLogin(token),
    { shouldRetryOnError: false },
  )
}

/**
 * Loads the repositories the GitHub App can read, with their Team links.
 *
 * @param accessToken - Access token of a Workspace administrator.
 * @returns The SWR state of the listing.
 */
export function useGitHubRepositoryLinksQuery(accessToken: string) {
  return useSWR(
    ['github-repository-links', accessToken] as const,
    ([, token]) => listGitHubRepositoryLinks(token),
    { shouldRetryOnError: false },
  )
}
