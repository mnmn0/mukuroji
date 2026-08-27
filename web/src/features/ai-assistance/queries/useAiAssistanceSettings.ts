import type {
  AiAssistancePolicy,
  AiAssistancePreference,
} from '@mukuroji/contracts'
import useSWR, { type SWRConfiguration } from 'swr'
import { AiAssistanceApiError } from '../api/errors'
import {
  getAiAssistancePolicy,
  getAiAssistancePreference,
} from '../api/settings'

/**
 * Returns whether a settings request failure is safe to retry.
 *
 * @param error - Unknown failure returned by the settings request.
 * @returns Whether retrying the request is safe for the current error.
 */
export function isRetryableAiAssistanceSettingsError(error: unknown): boolean {
  return !(error instanceof AiAssistanceApiError && error.status >= 400 && error.status < 500)
}

const aiAssistanceSettingsQueryConfig = {
  dedupingInterval: 10_000,
  // Settings failures are non-blocking for the Workspace shell, so SWR must
  // retry transient preference/policy reads instead of silently disabling AI.
  shouldRetryOnError: true,
  errorRetryCount: 3,
  errorRetryInterval: 5_000,
  onErrorRetry: (error, _key, config, revalidate, { retryCount }) => {
    if (!isRetryableAiAssistanceSettingsError(error) || retryCount >= 3) return
    setTimeout(() => {
      void revalidate({ dedupe: true, retryCount })
    }, config.errorRetryInterval)
  },
} satisfies SWRConfiguration

/** Stable cache key for the active member's AI preference. */
type AiAssistancePreferenceQueryKey = readonly [
  'ai-assistance-preference',
  string,
  string,
]

/** Stable cache key for the Workspace AI policy. */
type AiAssistancePolicyQueryKey = readonly [
  'ai-assistance-policy',
  string,
  string,
]

/** Wraps an authenticated request so the owning route can handle session expiry. */
type AuthenticatedRequestGuard = <Result>(request: Promise<Result>) => Promise<Result>

/**
 * Loads the active member's personal AI preference.
 *
 * @param accessToken - Bearer token for the active Workspace member.
 * @param enabled - Whether the settings route may load this resource.
 * @param guardRequest - Optional session guard for authenticated failures.
 * @param cacheScope - Stable member scope used for the client cache key; never use the bearer token.
 * @param workspaceId - Stable Workspace scope used for the client cache key.
 * @returns SWR state and its owned cache key.
 */
export function useAiAssistancePreference(
  accessToken?: string,
  enabled = true,
  guardRequest?: AuthenticatedRequestGuard,
  cacheScope?: string,
  workspaceId?: string,
) {
  const token = accessToken ?? ''
  const key: AiAssistancePreferenceQueryKey | null = token && enabled && cacheScope && workspaceId
    ? ['ai-assistance-preference', workspaceId, cacheScope]
    : null
  const query = useSWR<AiAssistancePreference>(
    key,
    () => {
      const request = getAiAssistancePreference(token)
      return guardRequest ? guardRequest(request) : request
    },
    aiAssistanceSettingsQueryConfig,
  )

  return { ...query, key }
}

/**
 * Loads the Workspace AI policy only for an authorized settings administrator.
 *
 * @param accessToken - Bearer token for the active Workspace administrator.
 * @param enabled - Whether management permission allows this resource to load.
 * @param guardRequest - Optional session guard for authenticated failures.
 * @param cacheScope - Stable member scope used for the client cache key; never use the bearer token.
 * @param workspaceId - Stable Workspace scope used for the client cache key.
 * @returns SWR state and its owned cache key.
 */
export function useAiAssistancePolicy(
  accessToken?: string,
  enabled = true,
  guardRequest?: AuthenticatedRequestGuard,
  cacheScope?: string,
  workspaceId?: string,
) {
  const token = accessToken ?? ''
  const key: AiAssistancePolicyQueryKey | null = token && enabled && cacheScope && workspaceId
    ? ['ai-assistance-policy', workspaceId, cacheScope]
    : null
  const query = useSWR<AiAssistancePolicy>(
    key,
    () => {
      const request = getAiAssistancePolicy(token)
      return guardRequest ? guardRequest(request) : request
    },
    aiAssistanceSettingsQueryConfig,
  )

  return { ...query, key }
}
