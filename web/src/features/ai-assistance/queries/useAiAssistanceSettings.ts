import type {
  AiAssistancePolicy,
  AiAssistancePreference,
} from '@mukuroji/contracts'
import useSWR from 'swr'
import {
  getAiAssistancePolicy,
  getAiAssistancePreference,
} from '../api/settings'

const aiAssistanceSettingsQueryConfig = {
  dedupingInterval: 10_000,
  // Settings failures are non-blocking for the Workspace shell, so SWR must
  // retry transient preference/policy reads instead of silently disabling AI.
  shouldRetryOnError: true,
  errorRetryCount: 3,
  errorRetryInterval: 5_000,
} as const

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
  const key = token && enabled && cacheScope && workspaceId
    ? ['ai-assistance-preference', workspaceId, cacheScope] as const
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
  const key = token && enabled && cacheScope && workspaceId
    ? ['ai-assistance-policy', workspaceId, cacheScope] as const
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
