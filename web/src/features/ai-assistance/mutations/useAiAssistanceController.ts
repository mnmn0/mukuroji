import type {
  AiAssistanceGeneration,
  CreateAiAssistanceFeedbackRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import {
  createAiAssistanceFeedback,
  decideAiAssistanceGeneration,
  generateAiAssistance,
} from '../api/generations'
import { AiAssistanceApiError } from '../api/errors'

/** User-facing category for an AI assistance operation failure. */
export type AiAssistanceErrorKind =
  | 'permission'
  | 'conflict'
  | 'provider'
  | 'validation'
  | 'generic'

/** Safe classified failure exposed to the view. */
export type AiAssistanceControllerError = {
  /** UI-safe category used to select localized copy. */
  kind: AiAssistanceErrorKind
  /** Stable server code retained for diagnostics without exposing response content. */
  code?: string
}

/** Inputs required by the route-scoped AI assistance controller. */
export type UseAiAssistanceControllerOptions = {
  /** Bearer token for the active Workspace member. */
  accessToken?: string
}

/** Explicit AI generation, review-decision, and feedback actions consumed by a view. */
export type AiAssistanceController = {
  /** Cancels the active explicit generation request. */
  cancelGeneration: () => void
  /** Records approval or rejection without mutating a domain resource. */
  decide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Latest safe failure classification. */
  error?: AiAssistanceControllerError
  /** Feedback already accepted for the visible generation. */
  feedbackRating?: CreateAiAssistanceFeedbackRequest['rating']
  /** Runs a generation only when called from an explicit user action. */
  generate: (input: GenerateAiAssistanceRequest) => Promise<AiAssistanceGeneration | undefined>
  /** Current permission-aware generation returned by the server. */
  generation?: AiAssistanceGeneration
  /** Whether an approval or rejection request is in flight. */
  isDecisionPending: boolean
  /** Whether a feedback request is in flight. */
  isFeedbackPending: boolean
  /** Whether an explicit generation request is in flight. */
  isGenerating: boolean
  /** Clears transient content and errors without issuing a request. */
  reset: () => void
  /** Sends evaluation feedback tied to the visible audited generation. */
  sendFeedback: (rating: CreateAiAssistanceFeedbackRequest['rating']) => Promise<void>
}

/**
 * Owns explicit AI generation, human review decisions, and evaluation feedback.
 *
 * The controller never runs on render and never mutates a domain resource.
 *
 * @param options - Active Workspace authentication context.
 * @returns AI assistance state and explicit event handlers.
 */
export function useAiAssistanceController({
  accessToken,
}: UseAiAssistanceControllerOptions): AiAssistanceController {
  const mutationRunnerRef = useRef<ReturnType<typeof createMutationRequestRunner> | null>(null)
  if (mutationRunnerRef.current === null) {
    mutationRunnerRef.current = createMutationRequestRunner()
  }
  const mutationRunner = mutationRunnerRef.current
  const generationAbortRef = useRef<AbortController | undefined>(undefined)
  const generationPendingRef = useRef(false)
  const decisionPendingRef = useRef(false)
  const feedbackPendingRef = useRef(false)
  const operationEpochRef = useRef(0)
  const visibleGenerationIdRef = useRef<string | undefined>(undefined)
  const [generation, setGeneration] = useState<AiAssistanceGeneration>()
  const [error, setError] = useState<AiAssistanceControllerError>()
  const [feedbackRating, setFeedbackRating] = useState<CreateAiAssistanceFeedbackRequest['rating']>()
  const [isGenerating, setIsGenerating] = useState(false)
  const [isDecisionPending, setIsDecisionPending] = useState(false)
  const [isFeedbackPending, setIsFeedbackPending] = useState(false)
  const [sessionAccessToken, setSessionAccessToken] = useState(accessToken)

  const cancelGeneration = useCallback(() => {
    operationEpochRef.current += 1
    generationAbortRef.current?.abort()
    generationAbortRef.current = undefined
    generationPendingRef.current = false
    setIsGenerating(false)
  }, [])

  const reset = useCallback(() => {
    cancelGeneration()
    visibleGenerationIdRef.current = undefined
    setGeneration(undefined)
    setError(undefined)
    setFeedbackRating(undefined)
  }, [cancelGeneration])

  if (sessionAccessToken !== accessToken) {
    setSessionAccessToken(accessToken)
    setGeneration(undefined)
    setError(undefined)
    setFeedbackRating(undefined)
    setIsGenerating(false)
    setIsDecisionPending(false)
    setIsFeedbackPending(false)
  }

  useEffect(() => () => {
    operationEpochRef.current += 1
    generationAbortRef.current?.abort()
    generationAbortRef.current = undefined
    generationPendingRef.current = false
    decisionPendingRef.current = false
    feedbackPendingRef.current = false
    visibleGenerationIdRef.current = undefined
  }, [accessToken])

  const generate = useCallback(async (
    input: GenerateAiAssistanceRequest,
  ): Promise<AiAssistanceGeneration | undefined> => {
    if (
      !accessToken ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current
    ) return undefined

    const abortController = new AbortController()
    const operationEpoch = operationEpochRef.current + 1
    operationEpochRef.current = operationEpoch
    generationAbortRef.current?.abort()
    generationAbortRef.current = abortController
    generationPendingRef.current = true
    setIsGenerating(true)
    visibleGenerationIdRef.current = undefined
    setGeneration(undefined)
    setFeedbackRating(undefined)
    setError(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        JSON.stringify(input),
      )
      /** Executes or resumes this logical generation with its retained request context. */
      const runRequest = () => mutationRunner.run(
        'ai-assistance:generate',
        fingerprint,
        (mutationContext) => generateAiAssistance({
          accessToken,
          input,
          mutationContext,
          signal: abortController.signal,
        }),
      )
      let nextGeneration: AiAssistanceGeneration
      try {
        nextGeneration = await runRequest()
      } catch (requestError) {
        const inheritedCancelledRequest = isAbortError(requestError) &&
          !abortController.signal.aborted &&
          generationAbortRef.current === abortController
        if (!inheritedCancelledRequest) throw requestError
        nextGeneration = await runRequest()
      }
      if (
        generationAbortRef.current !== abortController ||
        operationEpochRef.current !== operationEpoch
      ) return undefined
      visibleGenerationIdRef.current = nextGeneration.id
      setGeneration(nextGeneration)
      return nextGeneration
    } catch (requestError) {
      if (
        !isAbortError(requestError) &&
        generationAbortRef.current === abortController &&
        operationEpochRef.current === operationEpoch
      ) {
        setError(classifyAiAssistanceError(requestError))
      }
      return undefined
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = undefined
        generationPendingRef.current = false
        setIsGenerating(false)
      }
    }
  }, [accessToken, mutationRunner])

  const decide = useCallback(async (
    outcome: 'approved' | 'rejected',
  ): Promise<AiAssistanceGeneration | undefined> => {
    if (
      !accessToken ||
      !generation ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current ||
      generation.decision
    ) {
      return undefined
    }

    const generationId = generation.id
    const operationEpoch = operationEpochRef.current
    decisionPendingRef.current = true
    setIsDecisionPending(true)
    setError(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        generation.id,
        String(generation.revision),
        outcome,
      )
      const nextGeneration = await mutationRunner.run(
        `ai-assistance:decision:${generationId}`,
        fingerprint,
        (mutationContext) => decideAiAssistanceGeneration({
          accessToken,
          generationId,
          input: { expectedRevision: generation.revision, outcome },
          mutationContext,
        }),
      )
      if (
        operationEpochRef.current !== operationEpoch ||
        visibleGenerationIdRef.current !== generationId
      ) return undefined
      visibleGenerationIdRef.current = nextGeneration.id
      setGeneration(nextGeneration)
      return nextGeneration
    } catch (requestError) {
      if (
        operationEpochRef.current === operationEpoch &&
        visibleGenerationIdRef.current === generationId
      ) {
        setError(classifyAiAssistanceError(requestError))
      }
      return undefined
    } finally {
      decisionPendingRef.current = false
      setIsDecisionPending(false)
    }
  }, [accessToken, generation, mutationRunner])

  const sendFeedback = useCallback(async (
    rating: CreateAiAssistanceFeedbackRequest['rating'],
  ): Promise<void> => {
    if (
      !accessToken ||
      !generation ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current ||
      feedbackRating
    ) return

    const generationId = generation.id
    const operationEpoch = operationEpochRef.current
    feedbackPendingRef.current = true
    setIsFeedbackPending(true)
    setError(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        generationId,
        rating,
      )
      await mutationRunner.run(
        `ai-assistance:feedback:${generationId}`,
        fingerprint,
        (mutationContext) => createAiAssistanceFeedback({
          accessToken,
          generationId,
          input: { rating },
          mutationContext,
        }),
      )
      if (
        operationEpochRef.current !== operationEpoch ||
        visibleGenerationIdRef.current !== generationId
      ) return
      setFeedbackRating(rating)
    } catch (requestError) {
      if (
        operationEpochRef.current === operationEpoch &&
        visibleGenerationIdRef.current === generationId
      ) {
        setError(classifyAiAssistanceError(requestError))
      }
    } finally {
      feedbackPendingRef.current = false
      setIsFeedbackPending(false)
    }
  }, [accessToken, feedbackRating, generation, mutationRunner])

  const isAccessTokenCurrent = sessionAccessToken === accessToken

  return {
    cancelGeneration,
    decide,
    error: isAccessTokenCurrent ? error : undefined,
    feedbackRating: isAccessTokenCurrent ? feedbackRating : undefined,
    generate,
    generation: isAccessTokenCurrent ? generation : undefined,
    isDecisionPending: isAccessTokenCurrent ? isDecisionPending : false,
    isFeedbackPending: isAccessTokenCurrent ? isFeedbackPending : false,
    isGenerating: isAccessTokenCurrent ? isGenerating : false,
    reset,
    sendFeedback,
  }
}

/**
 * Maps transport status and stable codes to non-sensitive UI failure categories.
 *
 * @param error - Unknown failure from an AI assistance operation.
 * @returns A safe error category and optional stable code.
 */
export function classifyAiAssistanceError(error: unknown): AiAssistanceControllerError {
  if (!(error instanceof AiAssistanceApiError)) return { kind: 'generic' }
  if (error.status === 403) return { code: error.code, kind: 'permission' }
  if (error.status === 409) return { code: error.code, kind: 'conflict' }
  if (error.status === 400 || error.status === 422 || error.code === 'InvalidAiAssistanceResponse') {
    return { code: error.code, kind: 'validation' }
  }
  if (error.code === 'AiAssistancePersistenceError') {
    return { code: error.code, kind: 'generic' }
  }
  if (error.status === 502 || error.status === 504) {
    return { code: error.code, kind: 'provider' }
  }

  return { code: error.code, kind: 'generic' }
}

/** Returns whether an unknown request failure represents an intentional cancellation. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
