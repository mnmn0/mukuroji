import type { GitHubRepositoryLink } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  deleteGitHubLogin,
  deleteGitHubRepositoryLink,
  GitHubReviewsApiError,
  saveGitHubLogin,
  saveGitHubRepositoryLink,
} from '../api/githubReviews'
import { useGitHubLoginQuery, useGitHubRepositoryLinksQuery } from '../queries/useGitHubReviewsQueries'

/** Failure of the last GitHub settings operation, in the form the panels show. */
export type GitHubSettingsOperationError = 'login-taken' | 'conflict' | 'not-configured' | 'failed'

/**
 * Returns whether a failed request may be sent again with the same idempotency key.
 *
 * @param error - Thrown error.
 * @returns Whether the request did not reach the server or failed transiently.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof GitHubReviewsApiError && (error.status === 0 || error.status === 503)
}

/**
 * Classifies a failed operation for the panel.
 *
 * @param error - Thrown error.
 * @returns The failure to show.
 */
function classifyError(error: unknown): GitHubSettingsOperationError {
  if (!(error instanceof GitHubReviewsApiError)) return 'failed'
  if (error.code === 'GitHubLoginTaken') return 'login-taken'
  if (error.code === 'GitHubAppNotConfigured') return 'not-configured'
  return error.status === 409 ? 'conflict' : 'failed'
}

/**
 * Runs GitHub settings mutations one at a time and reloads after each.
 *
 * @param reload - Reloads the data the mutation changed.
 * @returns The busy key, the last failure, and the runner.
 */
function useOperationRunner(reload: () => Promise<unknown>) {
  const requestRunner = useMemo(() => createMutationRequestRunner(), [])
  const [busyOperation, setBusyOperation] = useState<string>()
  const [operationError, setOperationError] = useState<GitHubSettingsOperationError>()

  /**
   * Runs one mutation, then reloads.
   *
   * @param operationKey - Logical mutation key.
   * @param fingerprint - Payload fingerprint.
   * @param request - API call.
   * @returns Whether the mutation succeeded.
   */
  async function run(
    operationKey: string,
    fingerprint: string,
    request: (context: MutationRequestContext) => Promise<unknown>,
  ): Promise<boolean> {
    setBusyOperation(operationKey)
    setOperationError(undefined)
    let succeeded = false
    try {
      await requestRunner.run(operationKey, fingerprint, request, isRetryable)
      succeeded = true
    } catch (error) {
      setOperationError(classifyError(error))
    }
    try {
      await reload()
    } catch {
      // The load error is shown by the query state.
    } finally {
      setBusyOperation(undefined)
    }
    return succeeded
  }

  return { busyOperation, operationError, run }
}

/**
 * Loads the member's GitHub login and saves or removes it.
 *
 * @param accessToken - Access token of the signed-in member.
 * @returns The login, its load state, the operation state, and the actions.
 */
export function useGitHubLogin(accessToken: string) {
  const { data, error, isLoading, mutate } = useGitHubLoginQuery(accessToken)
  const { busyOperation, operationError, run } = useOperationRunner(() => mutate())
  return {
    githubLogin: data?.githubLogin,
    isLoading,
    hasLoadError: Boolean(error),
    busyOperation,
    operationError,
    reload: () => mutate(),
    save: (githubLogin: string) => run('save', githubLogin, (context) => saveGitHubLogin(accessToken, githubLogin, context)),
    remove: () => run('remove', data?.githubLogin ?? '', (context) => deleteGitHubLogin(accessToken, context)),
  }
}

/**
 * Loads the App's repositories and links them to Teams or removes the links.
 *
 * @param accessToken - Access token of a Workspace administrator.
 * @returns The listing, its load state, the operation state, and the actions.
 */
export function useGitHubRepositoryLinks(accessToken: string) {
  const { data, error, isLoading, mutate } = useGitHubRepositoryLinksQuery(accessToken)
  const { busyOperation, operationError, run } = useOperationRunner(() => mutate())
  return {
    listing: data,
    isLoading,
    hasLoadError: Boolean(error),
    busyOperation,
    operationError,
    reload: () => mutate(),
    link: (repository: GitHubRepositoryLink, teamId: string) => {
      const input = { teamId, ...(repository.revision === undefined ? {} : { expectedRevision: repository.revision }) }
      return run(`link:${repository.repositoryId}`, JSON.stringify(input), (context) =>
        saveGitHubRepositoryLink(accessToken, repository.repositoryId, input, context))
    },
    unlink: (repository: GitHubRepositoryLink) => {
      const revision = repository.revision
      if (revision === undefined) return Promise.resolve(false)
      return run(`unlink:${repository.repositoryId}`, String(revision), (context) =>
        deleteGitHubRepositoryLink(accessToken, repository.repositoryId, revision, context))
    },
  }
}
