import { expect, test } from 'bun:test'
import type { ConnectorProviderRequest, ConnectorProviderResponse } from './connector-resource-protocol'
import { CONNECTOR_PROVIDER_HISTORY_TOO_LONG } from './connector-runtime-error'
import { readGitHubPullRequest } from './github-pull-request-reader'

/** Head commit of the pull request. */
const sha = 'b'.repeat(40)

/**
 * Builds a requester that answers GitHub paths from a table.
 *
 * @param responses - Payload or status by path.
 * @param requests - Receives each request.
 * @returns The requester.
 */
function requester(
  responses: Record<string, ConnectorProviderResponse>,
  requests: ConnectorProviderRequest[] = [],
) {
  return async (request: ConnectorProviderRequest): Promise<ConnectorProviderResponse> => {
    requests.push(request)
    const response = responses[request.path]
    if (!response) throw new Error(`Unexpected path ${request.path}`)
    return response
  }
}

/** Responses of an open pull request with passing checks and one approval. */
const openResponses: Record<string, ConnectorProviderResponse> = {
  'repos/org/repo/pulls/7': { status: 200, payload: { state: 'open', draft: true, merged: false, head: { sha } } },
  [`repos/org/repo/commits/${sha}/check-runs`]: {
    status: 200, payload: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
  },
  [`repos/org/repo/commits/${sha}/status`]: { status: 200, payload: { total_count: 0, state: 'pending' } },
  'repos/org/repo/pulls/7/reviews': {
    status: 200,
    payload: [
      { user: { id: 1 }, state: 'CHANGES_REQUESTED' },
      { user: { id: 1 }, state: 'APPROVED' },
      { user: { id: 2 }, state: 'COMMENTED' },
    ],
  },
}

test('reads state, combined checks, and each reviewer\'s latest decision', async () => {
  const requests: ConnectorProviderRequest[] = []
  expect(await readGitHubPullRequest(requester(openResponses, requests), { repository: 'org/repo', number: 7 })).toEqual({
    state: 'open', draft: true, headSha: sha, checks: 'success', review: 'approved',
  })
  expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET', 'GET'])
})

test('a failed status or a running check wins over passing runs, and a merge reports its commit', async () => {
  const failing = {
    ...openResponses,
    [`repos/org/repo/commits/${sha}/status`]: { status: 200, payload: { total_count: 1, state: 'failure' } },
  }
  expect((await readGitHubPullRequest(requester(failing), { repository: 'org/repo', number: 7 })).checks).toBe('failure')
  const running = {
    ...openResponses,
    [`repos/org/repo/commits/${sha}/check-runs`]: { status: 200, payload: { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }] } },
  }
  expect((await readGitHubPullRequest(requester(running), { repository: 'org/repo', number: 7 })).checks).toBe('pending')
  const merged = {
    ...openResponses,
    'repos/org/repo/pulls/7': {
      status: 200,
      payload: { state: 'closed', merged: true, merged_at: '2026-11-25T00:00:00Z', merge_commit_sha: 'c'.repeat(40), head: { sha } },
    },
  }
  expect(await readGitHubPullRequest(requester(merged), { repository: 'org/repo', number: 7 })).toMatchObject({
    state: 'merged', mergedAt: '2026-11-25T00:00:00Z', mergeCommitSha: 'c'.repeat(40),
  })
})

test('reads check runs past the first page, and fails rather than show a partial list', async () => {
  /**
   * Builds a requester whose check runs span pages.
   *
   * @param pages - Check runs of each page.
   * @returns The requester.
   */
  function pagedRuns(pages: Array<Array<Record<string, unknown>>>) {
    const total = pages.reduce((count, page) => count + page.length, 0)
    return async (request: ConnectorProviderRequest): Promise<ConnectorProviderResponse> => {
      if (request.path !== `repos/org/repo/commits/${sha}/check-runs`) return requester(openResponses)(request)
      const page = Number(request.query?.page ?? '1')
      return { status: 200, payload: { total_count: total, check_runs: pages[page - 1] ?? [] } }
    }
  }
  const passed = { status: 'completed', conclusion: 'success' }
  const fiftyOnePassed = [Array.from({ length: 50 }, () => passed), [passed]]
  expect((await readGitHubPullRequest(pagedRuns(fiftyOnePassed), { repository: 'org/repo', number: 7 })).checks).toBe('success')
  const failedOnSecondPage = [Array.from({ length: 50 }, () => passed), [{ status: 'completed', conclusion: 'failure' }]]
  expect((await readGitHubPullRequest(pagedRuns(failedOnSecondPage), { repository: 'org/repo', number: 7 })).checks).toBe('failure')
  const tooMany = Array.from({ length: 11 }, () => Array.from({ length: 50 }, () => passed))
  await expect(readGitHubPullRequest(pagedRuns(tooMany), { repository: 'org/repo', number: 7 }))
    .rejects.toMatchObject({ code: CONNECTOR_PROVIDER_HISTORY_TOO_LONG })
})

test('a hidden pull request, a bad reference, or a malformed payload fails with a connector error', async () => {
  await expect(readGitHubPullRequest(requester({ 'repos/org/repo/pulls/7': { status: 404, payload: undefined } }), { repository: 'org/repo', number: 7 }))
    .rejects.toMatchObject({ code: 'ConnectorExternalResourceMissing' })
  await expect(readGitHubPullRequest(requester({}), { repository: 'org/repo/extra', number: 7 }))
    .rejects.toMatchObject({ code: 'ConnectorExternalIdInvalid' })
  await expect(readGitHubPullRequest(
    requester({ ...openResponses, 'repos/org/repo/pulls/7': { status: 200, payload: { state: 'open', head: { sha: 'short' } } } }),
    { repository: 'org/repo', number: 7 },
  )).rejects.toMatchObject({ code: 'ConnectorProviderResponseMalformed' })
})

test('reads the review history to its end, and refuses to judge one too long to read in full', async () => {
  const page = (state: string) => Array.from({ length: 100 }, (_, index) => ({ user: { id: index }, state }))
  /** Answers review pages from a list; other paths come from the open pull request. */
  const paged = (pages: unknown[][]) => async (request: ConnectorProviderRequest): Promise<ConnectorProviderResponse> => {
    if (request.path !== 'repos/org/repo/pulls/7/reviews') return requester(openResponses)(request)
    return { status: 200, payload: pages[Number(request.query?.page) - 1] ?? [] }
  }
  // A change request on the fifth page replaces the approvals before it.
  expect((await readGitHubPullRequest(paged([
    page('APPROVED'), page('APPROVED'), page('APPROVED'), page('APPROVED'), [{ user: { id: 3 }, state: 'CHANGES_REQUESTED' }],
  ]), { repository: 'org/repo', number: 7 })).review).toBe('changes-requested')

  await expect(readGitHubPullRequest(paged(Array.from({ length: 10 }, () => page('APPROVED'))), { repository: 'org/repo', number: 7 }))
    .rejects.toMatchObject({ code: CONNECTOR_PROVIDER_HISTORY_TOO_LONG })
})
