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
  shouldRetryOnError: false,
} as const

/**
 * Loads the active member's personal AI preference.
 *
 * @param accessToken - Bearer token for the active Workspace member.
 * @param enabled - Whether the settings route may load this resource.
 * @returns SWR state and its owned cache key.
 */
export function useAiAssistancePreference(accessToken?: string, enabled = true) {
  const token = accessToken ?? ''
  const key = token && enabled
    ? ['ai-assistance-preference', token] as const
    : null
  const query = useSWR<AiAssistancePreference>(
    key,
    () => getAiAssistancePreference(token),
    aiAssistanceSettingsQueryConfig,
  )

  return { ...query, key }
}

/**
 * Loads the Workspace AI policy only for an authorized settings administrator.
 *
 * @param accessToken - Bearer token for the active Workspace administrator.
 * @param enabled - Whether management permission allows this resource to load.
 * @returns SWR state and its owned cache key.
 */
export function useAiAssistancePolicy(accessToken?: string, enabled = true) {
  const token = accessToken ?? ''
  const key = token && enabled
    ? ['ai-assistance-policy', token] as const
    : null
  const query = useSWR<AiAssistancePolicy>(
    key,
    () => getAiAssistancePolicy(token),
    aiAssistanceSettingsQueryConfig,
  )

  return { ...query, key }
}
