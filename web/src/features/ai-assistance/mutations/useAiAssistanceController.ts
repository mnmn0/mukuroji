import type {
  AiAssistanceGeneration,
  CreateAiAssistanceFeedbackRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import {
  AiAssistanceDecisionResponseError,
  createAiAssistanceWithheldError,
  createAiAssistanceFeedback,
  decideAiAssistanceGeneration,
  generateAiAssistance,
  revalidateApprovedAiAssistanceGeneration,
} from '../api/generations'
import { AiAssistanceApiError } from '../api/errors'

/** User-facing category for an AI assistance operation failure. */
export type AiAssistanceErrorKind =
  | 'permission'
  | 'conflict'
  | 'rate-limit'
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
  /** Reports authenticated transport failures to the owning route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
}

/** Operation kinds that require independent pending-state ownership. */
export type AiAssistanceOperationKind = 'decision' | 'feedback'

/** Mutable, render-local fence that prevents an older session operation from publishing state. */
export type AiAssistanceOperationFence = {
  /** Access token whose operations currently own this controller. */
  accessToken?: string
  /** Monotonic session and generation epoch. */
  epoch: number
  /** Identifier of the decision or revalidation operation that owns pending state. */
  decisionOperationId?: number
  /** Identifier of the feedback operation that owns pending state. */
  feedbackOperationId?: number
  /** Monotonic source for operation ownership identifiers. */
  nextOperationId: number
  /** Generation whose content is currently retained by the controller. */
  visibleGenerationId?: string
}

/** Immutable ownership token for one asynchronous controller operation. */
export type AiAssistanceOperationLease = {
  /** Controller epoch captured before the operation started. */
  epoch: number
  /** Unique operation ownership identifier. */
  id: number
  /** Pending-state channel owned by this operation. */
  kind: AiAssistanceOperationKind
}

/** Result of one decision request and any mandatory approval revalidation. */
export type AiAssistanceDecisionAttemptResult =
  | {
      /** Indicates that no generation may be returned to an adoption callback. */
      kind: 'failed'
      /** Safe failure propagated to the controller's classifier. */
      error: unknown
      /** Whether the previously visible generation must be removed. */
      clearGeneration: boolean
    }
  | {
      /** Indicates that the decision and approval revalidation both succeeded. */
      kind: 'succeeded'
      /** Exact current generation safe to return to an adoption callback. */
      generation: AiAssistanceGeneration
    }

/** Inputs for one phase-aware decision attempt. */
export type ExecuteAiAssistanceDecisionAttemptOptions = {
  /** Available generation reviewed by the operator. */
  generation: AiAssistanceGeneration
  /** Requested human decision. */
  outcome: 'approved' | 'rejected'
  /** Sends or replays the revision-fenced decision mutation. */
  decide: (
    generation: AiAssistanceGeneration,
    outcome: 'approved' | 'rejected',
  ) => Promise<AiAssistanceGeneration>
  /** Re-reads an approved decision through the current disclosure boundary. */
  revalidate: (generation: AiAssistanceGeneration) => Promise<AiAssistanceGeneration>
}

const disclosureChangingAiAssistanceErrorCodes: readonly string[] = [
  'AiAssistanceGenerationNotFound',
  'AiAssistanceAuthorizationChanged',
  'AiAssistanceSourceChanged',
  'AiAssistanceRetentionExpired',
]

const decisionInvalidatingAiAssistanceErrorCodes: readonly string[] = [
  ...disclosureChangingAiAssistanceErrorCodes,
  'AiAssistanceRevisionConflict',
  'AiAssistanceDecisionAlreadyRecorded',
  'AiAssistanceIdempotencyConflict',
]

/**
 * Creates an operation fence for the initial authentication session.
 *
 * @param accessToken - Access token supplied by the initial render.
 * @returns A mutable fence with no active operation or retained generation.
 */
export function createAiAssistanceOperationFence(
  accessToken: string | undefined,
): AiAssistanceOperationFence {
  return {
    accessToken,
    epoch: 0,
    nextOperationId: 0,
  }
}

/**
 * Invalidates every retained generation and operation synchronously when authentication changes.
 *
 * @param fence - Mutable controller fence.
 * @param accessToken - Access token supplied by the current render.
 * @returns Whether a different authentication session was installed.
 */
export function synchronizeAiAssistanceOperationSession(
  fence: AiAssistanceOperationFence,
  accessToken: string | undefined,
): boolean {
  if (fence.accessToken === accessToken) return false
  fence.accessToken = accessToken
  fence.epoch += 1
  fence.decisionOperationId = undefined
  fence.feedbackOperationId = undefined
  fence.visibleGenerationId = undefined
  return true
}

/**
 * Checks that a callback still belongs to the committed authentication session and generation.
 *
 * @param fence - Current controller fence.
 * @param accessToken - Access token captured by the callback's render.
 * @param expectedGenerationId - Optional generation captured by the callback's render.
 * @returns Whether the callback may start or continue an operation.
 */
export function isAiAssistanceSessionCurrent(
  fence: AiAssistanceOperationFence,
  accessToken: string | undefined,
  expectedGenerationId?: string,
): boolean {
  return fence.accessToken === accessToken && (
    expectedGenerationId === undefined ||
    fence.visibleGenerationId === expectedGenerationId
  )
}

/**
 * Starts a generation only for the committed authentication session.
 *
 * @param fence - Current controller fence.
 * @param accessToken - Access token captured by the generation callback.
 * @returns The new generation epoch, or undefined for a stale callback.
 */
export function beginAiAssistanceGenerationOperation(
  fence: AiAssistanceOperationFence,
  accessToken: string | undefined,
): number | undefined {
  if (!isAiAssistanceSessionCurrent(fence, accessToken)) return undefined
  fence.epoch += 1
  fence.visibleGenerationId = undefined
  return fence.epoch
}

/**
 * Starts one independently owned decision, revalidation, or feedback operation.
 *
 * @param fence - Current controller fence.
 * @param kind - Pending-state channel owned by the new operation.
 * @returns An immutable lease used to fence asynchronous continuations.
 */
export function beginAiAssistanceOperation(
  fence: AiAssistanceOperationFence,
  kind: AiAssistanceOperationKind,
): AiAssistanceOperationLease {
  const id = fence.nextOperationId + 1
  fence.nextOperationId = id
  if (kind === 'decision') fence.decisionOperationId = id
  else fence.feedbackOperationId = id
  return { epoch: fence.epoch, id, kind }
}

/**
 * Starts a generation-dependent operation only for its captured session and visible generation.
 *
 * @param fence - Current controller fence.
 * @param accessToken - Access token captured by the operation callback.
 * @param expectedGenerationId - Generation captured by the operation callback.
 * @param kind - Pending-state channel owned by the new operation.
 * @returns An operation lease, or undefined when the callback is stale.
 */
export function beginAiAssistanceSessionOperation(
  fence: AiAssistanceOperationFence,
  accessToken: string | undefined,
  expectedGenerationId: string,
  kind: AiAssistanceOperationKind,
): AiAssistanceOperationLease | undefined {
  if (!isAiAssistanceSessionCurrent(
    fence,
    accessToken,
    expectedGenerationId,
  )) return undefined
  return beginAiAssistanceOperation(fence, kind)
}

/**
 * Checks both session ownership and the optional expected visible generation.
 *
 * @param fence - Current controller fence.
 * @param lease - Ownership token captured before awaiting.
 * @param expectedGenerationId - Generation that must still be visible.
 * @returns Whether the asynchronous continuation may publish or return data.
 */
export function isAiAssistanceOperationCurrent(
  fence: AiAssistanceOperationFence,
  lease: AiAssistanceOperationLease,
  expectedGenerationId?: string,
): boolean {
  const operationId = lease.kind === 'decision'
    ? fence.decisionOperationId
    : fence.feedbackOperationId
  return fence.epoch === lease.epoch &&
    operationId === lease.id &&
    (expectedGenerationId === undefined || fence.visibleGenerationId === expectedGenerationId)
}

/**
 * Releases pending-state ownership only when no newer session or operation replaced it.
 *
 * @param fence - Current controller fence.
 * @param lease - Operation attempting to release its pending-state channel.
 * @returns Whether the lease was current and released its channel.
 */
export function releaseAiAssistanceOperation(
  fence: AiAssistanceOperationFence,
  lease: AiAssistanceOperationLease,
): boolean {
  if (!isAiAssistanceOperationCurrent(fence, lease)) return false
  if (lease.kind === 'decision') fence.decisionOperationId = undefined
  else fence.feedbackOperationId = undefined
  return true
}

/**
 * Returns whether a stable failure proves that retained content is no longer disclosable.
 *
 * @param error - Unknown feedback or generation failure.
 * @returns Whether the visible generation and its citations must be removed.
 */
export function isAiAssistanceDisclosureChangingError(error: unknown): boolean {
  return error instanceof AiAssistanceApiError &&
    error.code !== undefined &&
    disclosureChangingAiAssistanceErrorCodes.some((code) => code === error.code)
}

/**
 * Returns whether a pre-response decision failure makes the reviewed generation unsafe to retry.
 *
 * @param error - Unknown decision mutation failure.
 * @returns Whether stable server state invalidates the reviewed generation.
 */
export function isAiAssistanceDecisionInvalidatingError(error: unknown): boolean {
  return error instanceof AiAssistanceDecisionResponseError || (
    error instanceof AiAssistanceApiError &&
    error.code !== undefined &&
    decisionInvalidatingAiAssistanceErrorCodes.some((code) => code === error.code)
  )
}

/**
 * Returns whether a generation retry must preserve its original idempotency context.
 *
 * Stable terminal provider, policy, validation, and budget failures require a new logical
 * generation. Only response ambiguity, an in-progress receipt, or persistence uncertainty keeps
 * the original key so a lost response cannot create a duplicate provider attempt.
 *
 * @param error - Unknown failure returned by the generation boundary.
 * @returns Whether the next identical-input retry must reuse the same mutation context.
 */
export function shouldRetainAiAssistanceGenerationContext(error: unknown): boolean {
  if (isAbortError(error)) return true
  if (!(error instanceof AiAssistanceApiError)) return false
  if (
    error.code === 'AiAssistancePersistenceError' &&
    error.idempotencyReplayed
  ) return false
  if (error.status === 0) return true
  if (error.code === 'AiAssistanceGenerationInProgress') return true
  if (error.code === 'AiAssistancePersistenceError') return true
  return error.code === 'InvalidAiAssistanceResponse' && (
    error.successfulResponseReceived ||
    (error.status >= 200 && error.status < 300)
  )
}

/**
 * Executes a decision in two explicit phases so ambiguous response loss remains retryable.
 *
 * @param options - Reviewed generation, outcome, decision transport, and revalidation transport.
 * @returns A safe success or a failure that tells the controller whether to remove content.
 */
export async function executeAiAssistanceDecisionAttempt(
  options: ExecuteAiAssistanceDecisionAttemptOptions,
): Promise<AiAssistanceDecisionAttemptResult> {
  let receivedValidDecisionResponse = false
  try {
    let nextGeneration = await options.decide(options.generation, options.outcome)
    receivedValidDecisionResponse = true
    if (nextGeneration.id !== options.generation.id) {
      throw new AiAssistanceApiError(
        502,
        'AI assistance decision returned a different generation.',
        'InvalidAiAssistanceResponse',
      )
    }
    if (nextGeneration.content.availability === 'withheld') {
      throw createAiAssistanceWithheldError(nextGeneration.content.reasonCode)
    }
    if (options.outcome === 'approved') {
      nextGeneration = await options.revalidate(nextGeneration)
    }
    return { generation: nextGeneration, kind: 'succeeded' }
  } catch (error) {
    return {
      clearGeneration: receivedValidDecisionResponse ||
        isAiAssistanceDecisionInvalidatingError(error),
      error,
      kind: 'failed',
    }
  }
}

/** Explicit AI generation, review-decision, and feedback actions consumed by a view. */
export type AiAssistanceController = {
  /** Cancels the active explicit generation request. */
  cancelGeneration: () => void
  /** Records approval or rejection without mutating a domain resource; matching decisions are idempotent. */
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
  /** Re-reads an approved generation and returns it only while its exact content remains available. */
  revalidateGeneration: () => Promise<AiAssistanceGeneration | undefined>
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
  onAuthenticatedApiError,
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
  const operationFenceRef = useRef(createAiAssistanceOperationFence(accessToken))
  const [generation, setGeneration] = useState<AiAssistanceGeneration>()
  const [error, setError] = useState<AiAssistanceControllerError>()
  const [feedbackRating, setFeedbackRating] = useState<CreateAiAssistanceFeedbackRequest['rating']>()
  const [isGenerating, setIsGenerating] = useState(false)
  const [isDecisionPending, setIsDecisionPending] = useState(false)
  const [isFeedbackPending, setIsFeedbackPending] = useState(false)
  const [sessionAccessToken, setSessionAccessToken] = useState(accessToken)

  const cancelGeneration = useCallback(() => {
    const operationFence = operationFenceRef.current
    if (!isAiAssistanceSessionCurrent(operationFence, accessToken)) return
    operationFence.epoch += 1
    generationAbortRef.current?.abort()
    generationAbortRef.current = undefined
    generationPendingRef.current = false
    setIsGenerating(false)
  }, [accessToken])

  /**
   * Clears all locally retained content and citations for the expected visible generation.
   *
   * @param expectedGenerationId - Optional generation that must still own visible state.
   * @returns Whether visible state matched and was cleared.
   */
  const clearVisibleGeneration = useCallback((expectedGenerationId?: string): boolean => {
    const operationFence = operationFenceRef.current
    if (
      expectedGenerationId !== undefined &&
      operationFence.visibleGenerationId !== expectedGenerationId
    ) return false
    operationFence.visibleGenerationId = undefined
    setGeneration(undefined)
    setFeedbackRating(undefined)
    return true
  }, [])

  const reset = useCallback(() => {
    const operationFence = operationFenceRef.current
    if (!isAiAssistanceSessionCurrent(operationFence, accessToken)) return
    cancelGeneration()
    operationFence.decisionOperationId = undefined
    operationFence.feedbackOperationId = undefined
    decisionPendingRef.current = false
    feedbackPendingRef.current = false
    clearVisibleGeneration()
    setError(undefined)
    setIsDecisionPending(false)
    setIsFeedbackPending(false)
  }, [accessToken, cancelGeneration, clearVisibleGeneration])

  if (sessionAccessToken !== accessToken) {
    setSessionAccessToken(accessToken)
    setGeneration(undefined)
    setError(undefined)
    setFeedbackRating(undefined)
    setIsGenerating(false)
    setIsDecisionPending(false)
    setIsFeedbackPending(false)
  }

  // Commit-time synchronization keeps abandoned renders from aborting the visible session while
  // still fencing old callbacks before the browser can dispatch events for the new session.
  useLayoutEffect(() => {
    const operationFence = operationFenceRef.current
    if (!synchronizeAiAssistanceOperationSession(operationFence, accessToken)) return
    generationAbortRef.current?.abort()
    generationAbortRef.current = undefined
    generationPendingRef.current = false
    decisionPendingRef.current = false
    feedbackPendingRef.current = false
  }, [accessToken])

  useLayoutEffect(() => () => {
    const operationFence = operationFenceRef.current
    operationFence.epoch += 1
    operationFence.decisionOperationId = undefined
    operationFence.feedbackOperationId = undefined
    operationFence.visibleGenerationId = undefined
    generationAbortRef.current?.abort()
    generationAbortRef.current = undefined
    generationPendingRef.current = false
    decisionPendingRef.current = false
    feedbackPendingRef.current = false
  }, [])

  const generate = useCallback(async (
    input: GenerateAiAssistanceRequest,
  ): Promise<AiAssistanceGeneration | undefined> => {
    const operationFence = operationFenceRef.current
    if (
      !accessToken ||
      !isAiAssistanceSessionCurrent(operationFence, accessToken) ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current
    ) return undefined

    const operationEpoch = beginAiAssistanceGenerationOperation(
      operationFence,
      accessToken,
    )
    if (operationEpoch === undefined) return undefined
    const abortController = new AbortController()
    generationAbortRef.current?.abort()
    generationAbortRef.current = abortController
    generationPendingRef.current = true
    setIsGenerating(true)
    setGeneration(undefined)
    setFeedbackRating(undefined)
    setError(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        JSON.stringify(input),
      )
      if (
        !isAiAssistanceSessionCurrent(operationFence, accessToken) ||
        generationAbortRef.current !== abortController ||
        operationFence.epoch !== operationEpoch
      ) return undefined
      /** Executes or resumes this logical generation with its retained request context. */
      const runRequest = () => mutationRunner.run(
        'ai-assistance:generate',
        fingerprint,
        (mutationContext) => {
          if (
            !isAiAssistanceSessionCurrent(operationFence, accessToken) ||
            generationAbortRef.current !== abortController ||
            operationFence.epoch !== operationEpoch
          ) throw createAiAssistanceStaleOperationError()
          return generateAiAssistance({
            accessToken,
            input,
            mutationContext,
            signal: abortController.signal,
          })
        },
        shouldRetainAiAssistanceGenerationContext,
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
        !isAiAssistanceSessionCurrent(operationFence, accessToken) ||
        generationAbortRef.current !== abortController ||
        operationFence.epoch !== operationEpoch
      ) return undefined
      operationFence.visibleGenerationId = nextGeneration.id
      setGeneration(nextGeneration)
      return nextGeneration
    } catch (requestError) {
      const operationIsCurrent =
        !isAbortError(requestError) &&
        isAiAssistanceSessionCurrent(operationFence, accessToken) &&
        generationAbortRef.current === abortController &&
        operationFence.epoch === operationEpoch
      if (operationIsCurrent) {
        onAuthenticatedApiError?.(requestError)
        setError(classifyAiAssistanceError(requestError))
      }
      return undefined
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = undefined
        generationPendingRef.current = false
        if (operationFence.epoch === operationEpoch) setIsGenerating(false)
      }
    }
  }, [accessToken, mutationRunner, onAuthenticatedApiError])

  /**
   * Revalidates the exact approved generation while fencing every adjacent AI operation.
   *
   * @returns The freshly authorized generation, or undefined when revalidation cannot publish.
   */
  const revalidateGeneration = useCallback(async (
  ): Promise<AiAssistanceGeneration | undefined> => {
    const operationFence = operationFenceRef.current
    if (
      !accessToken ||
      !generation ||
      !isAiAssistanceSessionCurrent(operationFence, accessToken, generation.id) ||
      generation.decision?.outcome !== 'approved' ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current
    ) return undefined

    const generationId = generation.id
    const operationLease = beginAiAssistanceSessionOperation(
      operationFence,
      accessToken,
      generationId,
      'decision',
    )
    if (operationLease === undefined) return undefined
    decisionPendingRef.current = true
    setIsDecisionPending(true)
    setError(undefined)
    try {
      const nextGeneration = await revalidateApprovedAiAssistanceGeneration({
        accessToken,
        expectedGeneration: generation,
      })
      if (!isAiAssistanceOperationCurrent(
        operationFence,
        operationLease,
        generationId,
      )) return undefined
      setGeneration(nextGeneration)
      return nextGeneration
    } catch (requestError) {
      if (isAiAssistanceOperationCurrent(operationFence, operationLease, generationId)) {
        onAuthenticatedApiError?.(requestError)
        clearVisibleGeneration(generationId)
        setError(classifyAiAssistanceError(requestError))
      }
      return undefined
    } finally {
      if (releaseAiAssistanceOperation(operationFence, operationLease)) {
        decisionPendingRef.current = false
        setIsDecisionPending(false)
      }
    }
  }, [
    accessToken,
    clearVisibleGeneration,
    generation,
    onAuthenticatedApiError,
  ])

  const decide = useCallback(async (
    outcome: 'approved' | 'rejected',
  ): Promise<AiAssistanceGeneration | undefined> => {
    const operationFence = operationFenceRef.current
    if (
      !accessToken ||
      !generation ||
      !isAiAssistanceSessionCurrent(operationFence, accessToken, generation.id) ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current
    ) {
      return undefined
    }

    // A late-edit confirmation can arrive after the approval response has
    // already been committed. Reuse the same reviewed generation instead of
    // issuing a second decision request, but revalidate an approval again
    // immediately before the delayed local adoption continues.
    const existingDecision = resolveExistingAiAssistanceDecision(generation, outcome)
    if (existingDecision) {
      return outcome === 'approved'
        ? await revalidateGeneration()
        : existingDecision
    }

    const generationId = generation.id
    const operationLease = beginAiAssistanceSessionOperation(
      operationFence,
      accessToken,
      generationId,
      'decision',
    )
    if (operationLease === undefined) return undefined
    decisionPendingRef.current = true
    setIsDecisionPending(true)
    setError(undefined)
    try {
      const result = await executeAiAssistanceDecisionAttempt({
        decide: async (reviewedGeneration, expectedOutcome) => {
          const fingerprint = await createMutationFingerprint(
            accessToken,
            reviewedGeneration.id,
            String(reviewedGeneration.revision),
            expectedOutcome,
          )
          if (
            !isAiAssistanceSessionCurrent(operationFence, accessToken, generationId) ||
            !isAiAssistanceOperationCurrent(
              operationFence,
              operationLease,
              generationId,
            )
          ) throw createAiAssistanceStaleOperationError()
          return await mutationRunner.run(
            `ai-assistance:decision:${generationId}`,
            fingerprint,
            (mutationContext) => {
              if (
                !isAiAssistanceSessionCurrent(
                  operationFence,
                  accessToken,
                  generationId,
                ) ||
                !isAiAssistanceOperationCurrent(
                  operationFence,
                  operationLease,
                  generationId,
                )
              ) throw createAiAssistanceStaleOperationError()
              return decideAiAssistanceGeneration({
                accessToken,
                generationId,
                expectedGeneration: reviewedGeneration,
                expectedTask: reviewedGeneration.task,
                expectedOutcome,
                input: {
                  expectedRevision: reviewedGeneration.revision,
                  outcome: expectedOutcome,
                },
                mutationContext,
              })
            },
            (error) => !isAbortError(error) &&
              !isAiAssistanceDecisionInvalidatingError(error),
          )
        },
        generation,
        outcome,
        revalidate: (approvedGeneration) => {
          if (
            !isAiAssistanceSessionCurrent(operationFence, accessToken, generationId) ||
            !isAiAssistanceOperationCurrent(
              operationFence,
              operationLease,
              generationId,
            )
          ) throw createAiAssistanceStaleOperationError()
          return revalidateApprovedAiAssistanceGeneration({
            accessToken,
            expectedGeneration: approvedGeneration,
          })
        },
      })
      if (!isAiAssistanceOperationCurrent(
        operationFence,
        operationLease,
        generationId,
      )) return undefined
      if (result.kind === 'failed') {
        onAuthenticatedApiError?.(result.error)
        if (result.clearGeneration) clearVisibleGeneration(generationId)
        setError(classifyAiAssistanceError(result.error))
        return undefined
      }
      operationFence.visibleGenerationId = result.generation.id
      setGeneration(result.generation)
      return result.generation
    } finally {
      if (releaseAiAssistanceOperation(operationFence, operationLease)) {
        decisionPendingRef.current = false
        setIsDecisionPending(false)
      }
    }
  }, [
    accessToken,
    clearVisibleGeneration,
    generation,
    mutationRunner,
    onAuthenticatedApiError,
    revalidateGeneration,
  ])

  const sendFeedback = useCallback(async (
    rating: CreateAiAssistanceFeedbackRequest['rating'],
  ): Promise<void> => {
    const operationFence = operationFenceRef.current
    if (
      !accessToken ||
      !generation ||
      !isAiAssistanceSessionCurrent(operationFence, accessToken, generation.id) ||
      generationPendingRef.current ||
      decisionPendingRef.current ||
      feedbackPendingRef.current ||
      feedbackRating
    ) return

    const generationId = generation.id
    const operationLease = beginAiAssistanceSessionOperation(
      operationFence,
      accessToken,
      generationId,
      'feedback',
    )
    if (operationLease === undefined) return
    feedbackPendingRef.current = true
    setIsFeedbackPending(true)
    setError(undefined)
    try {
      const fingerprint = await createMutationFingerprint(
        accessToken,
        generationId,
        rating,
      )
      if (
        !isAiAssistanceSessionCurrent(operationFence, accessToken, generationId) ||
        !isAiAssistanceOperationCurrent(
          operationFence,
          operationLease,
          generationId,
        )
      ) return
      await mutationRunner.run(
        `ai-assistance:feedback:${generationId}`,
        fingerprint,
        (mutationContext) => {
          if (
            !isAiAssistanceSessionCurrent(operationFence, accessToken, generationId) ||
            !isAiAssistanceOperationCurrent(
              operationFence,
              operationLease,
              generationId,
            )
          ) throw createAiAssistanceStaleOperationError()
          return createAiAssistanceFeedback({
            accessToken,
            generationId,
            input: { rating },
            mutationContext,
          })
        },
        (requestError) => !isAbortError(requestError) &&
          !isAiAssistanceDisclosureChangingError(requestError),
      )
      if (!isAiAssistanceOperationCurrent(
        operationFence,
        operationLease,
        generationId,
      )) return
      setFeedbackRating(rating)
    } catch (requestError) {
      if (isAiAssistanceOperationCurrent(operationFence, operationLease, generationId)) {
        onAuthenticatedApiError?.(requestError)
        if (isAiAssistanceDisclosureChangingError(requestError)) {
          clearVisibleGeneration(generationId)
        }
        setError(classifyAiAssistanceError(requestError))
      }
    } finally {
      if (releaseAiAssistanceOperation(operationFence, operationLease)) {
        feedbackPendingRef.current = false
        setIsFeedbackPending(false)
      }
    }
  }, [
    accessToken,
    clearVisibleGeneration,
    feedbackRating,
    generation,
    mutationRunner,
    onAuthenticatedApiError,
  ])

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
    revalidateGeneration,
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
  if (error.status === 401) return { code: error.code, kind: 'permission' }
  if (error.status === 403) return { code: error.code, kind: 'permission' }
  if (error.status === 409) return { code: error.code, kind: 'conflict' }
  if (error.status === 429) return { code: error.code, kind: 'rate-limit' }
  if (error.code === 'AiAssistancePersistenceError') {
    return { code: error.code, kind: 'generic' }
  }
  if (
    error.status === 502 ||
    error.status === 504 ||
    error.code === 'InvalidAiAssistanceOutput'
  ) {
    return { code: error.code, kind: 'provider' }
  }
  if (error.status === 400 || error.status === 422) {
    return { code: error.code, kind: 'validation' }
  }

  return { code: error.code, kind: 'generic' }
}

/**
 * Reuses a generation when the requested decision was already recorded with the same outcome.
 *
 * @param generation - Current generation held by the controller.
 * @param outcome - Decision outcome requested by the adopting workflow.
 * @returns The generation for a matching decision, or undefined for a missing or conflicting decision.
 */
export function resolveExistingAiAssistanceDecision(
  generation: AiAssistanceGeneration | undefined,
  outcome: 'approved' | 'rejected',
): AiAssistanceGeneration | undefined {
  return generation?.decision?.outcome === outcome ? generation : undefined
}

/**
 * Creates an internal cancellation when a captured callback no longer owns its session.
 *
 * @returns An abort-shaped error that is never exposed as an operation failure.
 */
function createAiAssistanceStaleOperationError(): DOMException {
  return new DOMException('AI assistance operation is no longer current.', 'AbortError')
}

/** Returns whether an unknown request failure represents an intentional cancellation. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
