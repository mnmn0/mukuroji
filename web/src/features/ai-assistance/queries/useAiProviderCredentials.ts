import type { AiAssistanceProviderCredentials } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getAiAssistanceProviderCredentials } from '../api/settings'

/** Stable cache key for the Workspace's key-free provider key status. */
type AiProviderCredentialsQueryKey = readonly [
  'ai-assistance-provider-credentials',
  string,
  string,
]

/** Wraps an authenticated request so the owning route can handle session expiry. */
type AuthenticatedRequestGuard = <Result>(request: Promise<Result>) => Promise<Result>

/**
 * Loads whether each external AI provider has a Workspace API key, without the key itself.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @param guardRequest - Optional session guard for authenticated failures.
 * @param cacheScope - Stable member scope used for the client cache key; never the bearer token.
 * @param workspaceId - Stable Workspace scope used for the client cache key.
 * @returns Whether the query can run, its SWR state, and the cache mutator.
 */
export function useAiProviderCredentials(
  accessToken?: string,
  guardRequest?: AuthenticatedRequestGuard,
  cacheScope?: string,
  workspaceId?: string,
) {
  const token = accessToken ?? ''
  const key: AiProviderCredentialsQueryKey | null = token && cacheScope && workspaceId
    ? ['ai-assistance-provider-credentials', workspaceId, cacheScope]
    : null
  const query = useSWR<AiAssistanceProviderCredentials>(
    key,
    () => {
      const request = getAiAssistanceProviderCredentials(token)
      return guardRequest ? guardRequest(request) : request
    },
    { shouldRetryOnError: false },
  )
  return {
    enabled: key !== null,
    data: query.data,
    error: query.error,
    mutate: query.mutate,
  }
}
