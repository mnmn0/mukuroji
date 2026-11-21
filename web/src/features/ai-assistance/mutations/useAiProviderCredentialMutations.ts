import type {
  AiAssistanceExternalProvider,
  AiAssistanceProviderCredentials,
} from '@mukuroji/contracts'
import { useCallback } from 'react'
import type { KeyedMutator } from 'swr'
import { createMutationRequestContext } from '../../../shared/api/mutationHeaders'
import { AiAssistanceApiError } from '../api/errors'
import {
  deleteAiAssistanceProviderCredential,
  putAiAssistanceProviderCredential,
} from '../api/settings'

/** Result shown beside one provider row after a save or removal. */
export type AiProviderCredentialFeedback = 'saved' | 'removed' | 'invalid' | 'conflict' | 'error'

/** Inputs required by the provider key mutation controller. */
export type UseAiProviderCredentialMutationsOptions = {
  /** Bearer token for an authorized Workspace administrator. */
  accessToken: string
  /** Replaces or revalidates the provider key status cache. */
  mutateCredentials: KeyedMutator<AiAssistanceProviderCredentials>
  /** Wraps authenticated requests so the owning route can handle session expiry. */
  guardRequest?: <Result>(request: Promise<Result>) => Promise<Result>
}

/** Revision-fenced provider key actions. */
export type AiProviderCredentialMutations = {
  /** Registers or replaces one provider key and reports the outcome. */
  saveKey: (
    provider: AiAssistanceExternalProvider,
    apiKey: string,
    expectedRevision: number,
  ) => Promise<AiProviderCredentialFeedback>
  /** Removes one provider key and reports the outcome. */
  removeKey: (
    provider: AiAssistanceExternalProvider,
    expectedRevision: number,
  ) => Promise<AiProviderCredentialFeedback>
}

/**
 * Owns provider key writes and their cache updates; the key never enters the cache.
 *
 * @param options - Authentication, cache mutator, and session guard.
 * @returns Save and remove callbacks that resolve to row feedback.
 */
export function useAiProviderCredentialMutations({
  accessToken,
  guardRequest,
  mutateCredentials,
}: UseAiProviderCredentialMutationsOptions): AiProviderCredentialMutations {
  /** Runs one key request, stores its key-free response, and classifies failures. */
  const run = useCallback(async (
    request: () => Promise<AiAssistanceProviderCredentials>,
    success: AiProviderCredentialFeedback,
  ): Promise<AiProviderCredentialFeedback> => {
    try {
      const pending = request()
      const result = await (guardRequest ? guardRequest(pending) : pending)
      await mutateCredentials(
        (current) => mergeProviderCredentialStatuses(current, result),
        { revalidate: false },
      )
      return success
    } catch (error) {
      if (error instanceof AiAssistanceApiError && error.code === 'InvalidAiAssistanceProviderCredential') {
        return 'invalid'
      }
      if (error instanceof AiAssistanceApiError && error.status === 409) {
        void mutateCredentials()
        return 'conflict'
      }
      return 'error'
    }
  }, [guardRequest, mutateCredentials])

  const saveKey = useCallback((
    provider: AiAssistanceExternalProvider,
    apiKey: string,
    expectedRevision: number,
  ) => run(
    () => putAiAssistanceProviderCredential(
      accessToken,
      provider,
      apiKey,
      expectedRevision,
      createMutationRequestContext(),
    ),
    'saved',
  ), [accessToken, run])

  const removeKey = useCallback((
    provider: AiAssistanceExternalProvider,
    expectedRevision: number,
  ) => run(
    () => deleteAiAssistanceProviderCredential(
      accessToken,
      provider,
      expectedRevision,
      createMutationRequestContext(),
    ),
    'removed',
  ), [accessToken, run])

  return { saveKey, removeKey }
}

/**
 * Keeps the newer status per provider so a late response cannot roll back a parallel change.
 *
 * Each provider revision only grows, including on removal, so the higher revision is newer.
 *
 * @param current - Cached key-free status, if any.
 * @param incoming - Key-free status returned by the latest write.
 * @returns The incoming list with any newer cached provider rows kept.
 */
export function mergeProviderCredentialStatuses(
  current: AiAssistanceProviderCredentials | undefined,
  incoming: AiAssistanceProviderCredentials,
): AiAssistanceProviderCredentials {
  if (current === undefined) return incoming
  const cached = new Map(current.providers.map((status) => [status.provider, status]))
  return {
    ...incoming,
    providers: incoming.providers.map((status) => {
      const previous = cached.get(status.provider)
      return previous !== undefined && previous.revision > status.revision ? previous : status
    }),
  }
}
