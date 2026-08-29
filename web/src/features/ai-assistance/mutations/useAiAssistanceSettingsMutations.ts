import type {
  AiAssistancePolicy,
  AiAssistancePreference,
  UpdateAiAssistancePolicyRequest,
  UpdateAiAssistancePreferenceRequest,
} from '@mukuroji/contracts'
import { useCallback, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import {
  updateAiAssistancePolicy,
  updateAiAssistancePreference,
} from '../api/settings'
import { AiAssistanceApiError } from '../api/errors'

/** Settings mutation feedback shown beside one explicit save action. */
export type AiAssistanceSettingsMutationFeedback = 'saved' | 'conflict' | 'error'

/** Inputs required by the AI settings mutation controller. */
export type UseAiAssistanceSettingsMutationsOptions = {
  /** Bearer token for the active Workspace member. */
  accessToken: string
  /** Replaces or revalidates the manager-only Workspace policy cache. */
  mutatePolicy: KeyedMutator<AiAssistancePolicy>
  /** Replaces or revalidates the active member's preference cache. */
  mutatePreference: KeyedMutator<AiAssistancePreference>
  /** Wraps authenticated saves so the owning route can handle session expiry. */
  guardRequest?: <Result>(request: Promise<Result>) => Promise<Result>
}

/** Explicit revision-fenced save actions and scoped feedback for AI settings. */
export type AiAssistanceSettingsMutations = {
  /** Clears policy save feedback after the operator edits the latest values. */
  clearPolicyFeedback: () => void
  /** Clears personal preference feedback after the operator edits the latest value. */
  clearPreferenceFeedback: () => void
  /** Whether the Workspace policy save is in flight. */
  isPolicySaving: boolean
  /** Whether the personal preference save is in flight. */
  isPreferenceSaving: boolean
  /** Latest Workspace policy save result. */
  policyFeedback?: AiAssistanceSettingsMutationFeedback
  /** Latest personal preference save result. */
  preferenceFeedback?: AiAssistanceSettingsMutationFeedback
  /** Explicitly replaces the manager-only Workspace policy. */
  savePolicy: (input: UpdateAiAssistancePolicyRequest) => Promise<boolean>
  /** Explicitly replaces the active member's personal preference. */
  savePreference: (input: UpdateAiAssistancePreferenceRequest) => Promise<boolean>
}

/**
 * Owns separate, explicit revision-fenced saves for AI preference and policy settings.
 *
 * @param options - Authentication and SWR cache ownership for both resources.
 * @returns Pending state, scoped feedback, and explicit save callbacks.
 */
export function useAiAssistanceSettingsMutations({
  accessToken,
  guardRequest,
  mutatePolicy,
  mutatePreference,
}: UseAiAssistanceSettingsMutationsOptions): AiAssistanceSettingsMutations {
  const mutationRunnerRef = useRef<ReturnType<typeof createMutationRequestRunner> | null>(null)
  if (mutationRunnerRef.current === null) {
    mutationRunnerRef.current = createMutationRequestRunner()
  }
  const mutationRunner = mutationRunnerRef.current
  const policySavingRef = useRef(false)
  const preferenceSavingRef = useRef(false)
  const [isPolicySaving, setIsPolicySaving] = useState(false)
  const [isPreferenceSaving, setIsPreferenceSaving] = useState(false)
  const [policyFeedback, setPolicyFeedback] = useState<AiAssistanceSettingsMutationFeedback>()
  const [preferenceFeedback, setPreferenceFeedback] = useState<AiAssistanceSettingsMutationFeedback>()

  const savePreference = useCallback(async (
    input: UpdateAiAssistancePreferenceRequest,
  ): Promise<boolean> => {
    if (preferenceSavingRef.current) return false
    preferenceSavingRef.current = true
    setIsPreferenceSaving(true)
    setPreferenceFeedback(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        JSON.stringify(input),
      )
      const request = mutationRunner.run(
        'ai-assistance:preference',
        fingerprint,
        (mutationContext) => updateAiAssistancePreference(
          accessToken,
          input,
          mutationContext,
        ),
      )
      const preference = await (guardRequest ? guardRequest(request) : request)
      await mutatePreference(preference, { revalidate: false })
      setPreferenceFeedback('saved')
      return true
    } catch (error) {
      if (isRevisionConflict(error)) {
        const refreshed = await mutatePreference().catch(() => undefined)
        setPreferenceFeedback(refreshed ? 'conflict' : 'error')
      } else {
        setPreferenceFeedback('error')
      }
      return false
    } finally {
      preferenceSavingRef.current = false
      setIsPreferenceSaving(false)
    }
  }, [accessToken, guardRequest, mutatePreference, mutationRunner])

  const savePolicy = useCallback(async (
    input: UpdateAiAssistancePolicyRequest,
  ): Promise<boolean> => {
    if (policySavingRef.current) return false
    policySavingRef.current = true
    setIsPolicySaving(true)
    setPolicyFeedback(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        JSON.stringify(input),
      )
      const request = mutationRunner.run(
        'ai-assistance:policy',
        fingerprint,
        (mutationContext) => updateAiAssistancePolicy(
          accessToken,
          input,
          mutationContext,
        ),
      )
      const policy = await (guardRequest ? guardRequest(request) : request)
      await mutatePolicy(policy, { revalidate: false })
      setPolicyFeedback('saved')
      return true
    } catch (error) {
      if (isRevisionConflict(error)) {
        const refreshed = await mutatePolicy().catch(() => undefined)
        setPolicyFeedback(refreshed ? 'conflict' : 'error')
      } else {
        setPolicyFeedback('error')
      }
      return false
    } finally {
      policySavingRef.current = false
      setIsPolicySaving(false)
    }
  }, [accessToken, guardRequest, mutatePolicy, mutationRunner])

  return {
    clearPolicyFeedback: () => setPolicyFeedback(undefined),
    clearPreferenceFeedback: () => setPreferenceFeedback(undefined),
    isPolicySaving,
    isPreferenceSaving,
    policyFeedback,
    preferenceFeedback,
    savePolicy,
    savePreference,
  }
}

/** Returns whether a settings mutation failed optimistic concurrency. */
function isRevisionConflict(error: unknown): boolean {
  return error instanceof AiAssistanceApiError && (
    error.status === 409 || error.code === 'AiAssistanceRevisionConflict'
  )
}
