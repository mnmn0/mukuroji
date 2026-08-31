import { describe, expect, test } from 'bun:test'
import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import { AiAssistanceApiError } from '../src/features/ai-assistance/api/errors'
import {
  AiAssistanceDecisionResponseError,
  isApprovedAiAssistanceRevalidationConsistent,
} from '../src/features/ai-assistance/api/generations'
import { aiSearchGenerationFixture } from '../src/features/ai-assistance/fixtures'
import {
  type AiAssistanceOperationKind,
  beginAiAssistanceGenerationOperation,
  beginAiAssistanceOperation,
  beginAiAssistanceSessionOperation,
  classifyAiAssistanceError,
  createAiAssistanceOperationFence,
  executeAiAssistanceDecisionAttempt,
  isAiAssistanceDisclosureChangingError,
  isAiAssistanceOperationCurrent,
  isAiAssistanceSessionCurrent,
  releaseAiAssistanceOperation,
  shouldRetainAiAssistanceGenerationContext,
  synchronizeAiAssistanceOperationSession,
} from '../src/features/ai-assistance/mutations/useAiAssistanceController'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../src/shared/api/mutationHeaders'

const approvedSearchGeneration = {
  ...aiSearchGenerationFixture,
  revision: 4,
  decision: {
    outcome: 'approved',
    decidedAt: '2026-08-25T02:05:00.000Z',
  },
} satisfies AiAssistanceGeneration

describe('AI assistance controller safety', () => {
  test('classifies capacity, provider, permission, conflict, and validation failures distinctly', () => {
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      429,
      'limited',
      'AiAssistanceRateLimitExceeded',
    ))).toEqual({
      code: 'AiAssistanceRateLimitExceeded',
      kind: 'rate-limit',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      400,
      'invalid provider output',
      'InvalidAiAssistanceOutput',
    ))).toEqual({
      code: 'InvalidAiAssistanceOutput',
      kind: 'provider',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      502,
      'invalid response',
      'InvalidAiAssistanceResponse',
    ))).toEqual({
      code: 'InvalidAiAssistanceResponse',
      kind: 'provider',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      504,
      'provider timeout',
      'AiAssistanceProviderTimeout',
    ))).toEqual({
      code: 'AiAssistanceProviderTimeout',
      kind: 'provider',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      502,
      'model refused generation',
      'AiAssistanceModelRefused',
    ))).toEqual({
      code: 'AiAssistanceModelRefused',
      kind: 'provider',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      502,
      'persistence unavailable',
      'AiAssistancePersistenceError',
    ))).toEqual({
      code: 'AiAssistancePersistenceError',
      kind: 'generic',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      403,
      'permission changed',
      'AiAssistanceAuthorizationChanged',
    ))).toEqual({
      code: 'AiAssistanceAuthorizationChanged',
      kind: 'permission',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      409,
      'source changed',
      'AiAssistanceSourceChanged',
    ))).toEqual({
      code: 'AiAssistanceSourceChanged',
      kind: 'conflict',
    })
    expect(classifyAiAssistanceError(new AiAssistanceApiError(
      422,
      'invalid citation',
      'AiAssistanceCitationInvalid',
    ))).toEqual({
      code: 'AiAssistanceCitationInvalid',
      kind: 'validation',
    })
  })

  test('accepts only the exact available generation returned by the approval decision', () => {
    expect(isApprovedAiAssistanceRevalidationConsistent(
      approvedSearchGeneration,
      approvedSearchGeneration,
    )).toBe(true)
    expect(isApprovedAiAssistanceRevalidationConsistent(
      { ...approvedSearchGeneration, expiresAt: '2026-09-20T02:00:00.000Z' },
      approvedSearchGeneration,
    )).toBe(true)
    expect(isApprovedAiAssistanceRevalidationConsistent(
      { ...approvedSearchGeneration, expiresAt: '2026-10-01T02:00:00.000Z' },
      approvedSearchGeneration,
    )).toBe(false)
    expect(isApprovedAiAssistanceRevalidationConsistent(
      { ...approvedSearchGeneration, revision: 5 },
      approvedSearchGeneration,
    )).toBe(false)
    expect(isApprovedAiAssistanceRevalidationConsistent(
      { ...approvedSearchGeneration, decision: undefined },
      approvedSearchGeneration,
    )).toBe(false)
    expect(isApprovedAiAssistanceRevalidationConsistent(
      {
        ...approvedSearchGeneration,
        content: {
          availability: 'withheld',
          reasonCode: 'retention-expired',
        },
      },
      approvedSearchGeneration,
    )).toBe(false)
  })

  test('clears feedback content only for stable disclosure-changing failures', () => {
    const disclosureChangingFailures = [
      new AiAssistanceApiError(
        404,
        'generation missing',
        'AiAssistanceGenerationNotFound',
      ),
      new AiAssistanceApiError(
        403,
        'permission changed',
        'AiAssistanceAuthorizationChanged',
      ),
      new AiAssistanceApiError(
        409,
        'source changed',
        'AiAssistanceSourceChanged',
      ),
      new AiAssistanceApiError(
        409,
        'retention expired',
        'AiAssistanceRetentionExpired',
      ),
    ]

    for (const failure of disclosureChangingFailures) {
      expect(isAiAssistanceDisclosureChangingError(failure)).toBe(true)
    }

    expect(isAiAssistanceDisclosureChangingError(new AiAssistanceApiError(
      403,
      'feature disabled',
      'AiAssistanceDisabled',
    ))).toBe(false)
    expect(isAiAssistanceDisclosureChangingError(new AiAssistanceApiError(
      409,
      'revision conflict',
      'AiAssistanceRevisionConflict',
    ))).toBe(false)
    expect(isAiAssistanceDisclosureChangingError(new AiAssistanceApiError(
      0,
      'response lost',
      'AiAssistanceNetworkError',
    ))).toBe(false)
    expect(isAiAssistanceDisclosureChangingError(new Error('unexpected'))).toBe(false)
  })

  test('reuses a generation key after response loss but replaces it after a stable provider failure', async () => {
    let nextContextId = 0
    const createContext = (): MutationRequestContext => {
      nextContextId += 1
      return {
        correlationId: `generation-correlation-${nextContextId}`,
        idempotencyKey: `generation-request-${nextContextId}`,
      }
    }
    const networkRunner = createMutationRequestRunner(createContext)
    const networkContexts: MutationRequestContext[] = []
    let networkAttempt = 0
    const runNetworkAttempt = () => networkRunner.run(
      'ai-assistance:generate',
      'same-input',
      async (context) => {
        networkContexts.push(context)
        networkAttempt += 1
        if (networkAttempt === 1) {
          throw new AiAssistanceApiError(
            0,
            'generation response lost',
            'AiAssistanceNetworkError',
          )
        }
        return 'replayed'
      },
      shouldRetainAiAssistanceGenerationContext,
    )

    await expect(runNetworkAttempt()).rejects.toMatchObject({
      code: 'AiAssistanceNetworkError',
    })
    expect(await runNetworkAttempt()).toBe('replayed')
    expect(networkContexts[0]).toBe(networkContexts[1])

    const providerRunner = createMutationRequestRunner(createContext)
    const providerContexts: MutationRequestContext[] = []
    let providerAttempt = 0
    const runProviderAttempt = () => providerRunner.run(
      'ai-assistance:generate',
      'same-input',
      async (context) => {
        providerContexts.push(context)
        providerAttempt += 1
        if (providerAttempt === 1) {
          throw new AiAssistanceApiError(
            504,
            'provider timed out',
            'AiAssistanceProviderTimeout',
          )
        }
        return 'new-generation'
      },
      shouldRetainAiAssistanceGenerationContext,
    )

    await expect(runProviderAttempt()).rejects.toMatchObject({
      code: 'AiAssistanceProviderTimeout',
    })
    expect(await runProviderAttempt()).toBe('new-generation')
    expect(providerContexts[0]).not.toBe(providerContexts[1])
  })

  test('retains initial persistence uncertainty but replaces a durably replayed failure key', async () => {
    let nextContextId = 0
    const runner = createMutationRequestRunner(() => {
      nextContextId += 1
      return {
        correlationId: `persistence-correlation-${nextContextId}`,
        idempotencyKey: `persistence-request-${nextContextId}`,
      }
    })
    const observedContexts: MutationRequestContext[] = []
    let attempt = 0
    const runAttempt = () => runner.run(
      'ai-assistance:generate',
      'same-input',
      async (context) => {
        observedContexts.push(context)
        attempt += 1
        if (attempt === 1) {
          throw new AiAssistanceApiError(
            502,
            'generation persistence is uncertain',
            'AiAssistancePersistenceError',
          )
        }
        if (attempt === 2) {
          throw new AiAssistanceApiError(
            502,
            'generation persistence failure replayed',
            'AiAssistancePersistenceError',
            { idempotencyReplayed: true },
          )
        }
        return 'new-logical-generation'
      },
      shouldRetainAiAssistanceGenerationContext,
    )

    await expect(runAttempt()).rejects.toMatchObject({
      code: 'AiAssistancePersistenceError',
      idempotencyReplayed: false,
    })
    await expect(runAttempt()).rejects.toMatchObject({
      code: 'AiAssistancePersistenceError',
      idempotencyReplayed: true,
    })
    expect(await runAttempt()).toBe('new-logical-generation')
    expect(observedContexts[0]).toBe(observedContexts[1])
    expect(observedContexts[1]).not.toBe(observedContexts[2])
  })

  test('retains a generation key for an invalid successful response', async () => {
    let nextContextId = 0
    const runner = createMutationRequestRunner(() => {
      nextContextId += 1
      return {
        correlationId: `success-response-correlation-${nextContextId}`,
        idempotencyKey: `success-response-request-${nextContextId}`,
      }
    })
    const observedContexts: MutationRequestContext[] = []
    let attempt = 0
    const runAttempt = () => runner.run(
      'ai-assistance:generate',
      'same-input',
      async (context) => {
        observedContexts.push(context)
        attempt += 1
        if (attempt === 1) {
          throw new AiAssistanceApiError(
            502,
            'generation success response was malformed',
            'InvalidAiAssistanceResponse',
            { successfulResponseReceived: true },
          )
        }
        return 'replayed-generation'
      },
      shouldRetainAiAssistanceGenerationContext,
    )

    await expect(runAttempt()).rejects.toMatchObject({
      code: 'InvalidAiAssistanceResponse',
      status: 502,
      successfulResponseReceived: true,
    })
    expect(await runAttempt()).toBe('replayed-generation')
    expect(observedContexts[0]).toBe(observedContexts[1])
  })

  test('replaces generation keys after stable 502 validation and provider failures', async () => {
    const stableFailures = [
      new AiAssistanceApiError(
        502,
        'generation response was invalid',
        'InvalidAiAssistanceResponse',
      ),
      new AiAssistanceApiError(
        502,
        'provider output was invalid',
        'InvalidAiAssistanceOutput',
      ),
    ]

    for (const stableFailure of stableFailures) {
      let nextContextId = 0
      const runner = createMutationRequestRunner(() => {
        nextContextId += 1
        return {
          correlationId: `stable-failure-correlation-${nextContextId}`,
          idempotencyKey: `stable-failure-request-${nextContextId}`,
        }
      })
      const observedContexts: MutationRequestContext[] = []
      let attempt = 0
      const runAttempt = () => runner.run(
        'ai-assistance:generate',
        'same-input',
        async (context) => {
          observedContexts.push(context)
          attempt += 1
          if (attempt === 1) throw stableFailure
          return 'new-generation'
        },
        shouldRetainAiAssistanceGenerationContext,
      )

      await expect(runAttempt()).rejects.toBe(stableFailure)
      expect(await runAttempt()).toBe('new-generation')
      expect(observedContexts[0]).not.toBe(observedContexts[1])
    }
  })

  test('retains an ambiguous decision failure and retries with the same mutation context', async () => {
    const requestContext: MutationRequestContext = {
      correlationId: 'decision-correlation-1',
      idempotencyKey: 'decision-request-1',
    }
    const runner = createMutationRequestRunner(() => requestContext)
    const observedContexts: MutationRequestContext[] = []
    const responseLoss = new AiAssistanceApiError(
      0,
      'decision response lost',
      'AiAssistanceNetworkError',
    )
    let requestCount = 0
    let revalidationCount = 0

    /**
     * Simulates the controller's revision-fenced decision mutation.
     *
     * @param generation - Reviewed generation included in the mutation fingerprint.
     * @param outcome - Requested decision included in the mutation fingerprint.
     * @returns The durable approved generation after one ambiguous response loss.
     */
    const decide = (
      generation: AiAssistanceGeneration,
      outcome: 'approved' | 'rejected',
    ): Promise<AiAssistanceGeneration> => runner.run(
      `ai-assistance:decision:${generation.id}`,
      `${generation.revision}:${outcome}`,
      async (context) => {
        observedContexts.push(context)
        requestCount += 1
        if (requestCount === 1) throw responseLoss
        return approvedSearchGeneration
      },
    )

    const firstAttempt = await executeAiAssistanceDecisionAttempt({
      decide,
      generation: aiSearchGenerationFixture,
      outcome: 'approved',
      revalidate: async (generation) => {
        revalidationCount += 1
        return generation
      },
    })

    expect(firstAttempt).toEqual({
      clearGeneration: false,
      error: responseLoss,
      kind: 'failed',
    })

    const retryAttempt = await executeAiAssistanceDecisionAttempt({
      decide,
      generation: aiSearchGenerationFixture,
      outcome: 'approved',
      revalidate: async (generation) => {
        revalidationCount += 1
        return generation
      },
    })

    expect(retryAttempt).toEqual({
      generation: approvedSearchGeneration,
      kind: 'succeeded',
    })
    expect(observedContexts).toEqual([requestContext, requestContext])
    expect(revalidationCount).toBe(1)
  })

  test('distinguishes a retryable malformed body from validated invalid decision state', async () => {
    const malformedBody = new AiAssistanceApiError(
      200,
      'decision response body was malformed',
      'InvalidAiAssistanceResponse',
    )
    const invalidDecisionState = new AiAssistanceDecisionResponseError(
      'decision response contained another outcome',
    )

    const malformedBodyResult = await executeAiAssistanceDecisionAttempt({
      decide: async () => { throw malformedBody },
      generation: aiSearchGenerationFixture,
      outcome: 'approved',
      revalidate: async (generation) => generation,
    })
    const invalidStateResult = await executeAiAssistanceDecisionAttempt({
      decide: async () => { throw invalidDecisionState },
      generation: aiSearchGenerationFixture,
      outcome: 'approved',
      revalidate: async (generation) => generation,
    })

    expect(malformedBodyResult).toEqual({
      clearGeneration: false,
      error: malformedBody,
      kind: 'failed',
    })
    expect(invalidStateResult).toEqual({
      clearGeneration: true,
      error: invalidDecisionState,
      kind: 'failed',
    })
  })

  test('clears a reviewed generation after stable decision-state conflicts', async () => {
    const invalidatingFailures = [
      new AiAssistanceApiError(
        403,
        'permission changed',
        'AiAssistanceAuthorizationChanged',
      ),
      new AiAssistanceApiError(
        409,
        'source changed',
        'AiAssistanceSourceChanged',
      ),
      new AiAssistanceApiError(
        409,
        'revision conflict',
        'AiAssistanceRevisionConflict',
      ),
      new AiAssistanceApiError(
        409,
        'another outcome already exists',
        'AiAssistanceDecisionAlreadyRecorded',
      ),
      new AiAssistanceApiError(
        409,
        'idempotency input changed',
        'AiAssistanceIdempotencyConflict',
      ),
      new AiAssistanceDecisionResponseError(
        'decision returned another outcome',
      ),
    ]

    for (const failure of invalidatingFailures) {
      const result = await executeAiAssistanceDecisionAttempt({
        decide: async () => { throw failure },
        generation: aiSearchGenerationFixture,
        outcome: 'approved',
        revalidate: async () => {
          throw new Error('A failed decision must not be revalidated.')
        },
      })

      expect(result).toEqual({
        clearGeneration: true,
        error: failure,
        kind: 'failed',
      })
    }
  })

  test('clears an approved draft when its mandatory post-decision GET fails', async () => {
    const revalidationFailure = new AiAssistanceApiError(
      0,
      'generation revalidation failed',
      'AiAssistanceNetworkError',
    )
    let approvedResponseObserved = false

    const result = await executeAiAssistanceDecisionAttempt({
      decide: async () => approvedSearchGeneration,
      generation: aiSearchGenerationFixture,
      outcome: 'approved',
      revalidate: async (generation) => {
        approvedResponseObserved = generation === approvedSearchGeneration
        throw revalidationFailure
      },
    })

    expect(approvedResponseObserved).toBe(true)
    expect(result).toEqual({
      clearGeneration: true,
      error: revalidationFailure,
      kind: 'failed',
    })
  })

  test('releases pending ownership after the current operation clears visible content', () => {
    const operationKinds: readonly AiAssistanceOperationKind[] = [
      'decision',
      'feedback',
    ]

    for (const kind of operationKinds) {
      const fence = createAiAssistanceOperationFence('access-token')
      fence.visibleGenerationId = aiSearchGenerationFixture.id
      const lease = beginAiAssistanceOperation(fence, kind)

      fence.visibleGenerationId = undefined

      expect(isAiAssistanceOperationCurrent(
        fence,
        lease,
        aiSearchGenerationFixture.id,
      )).toBe(false)
      expect(releaseAiAssistanceOperation(fence, lease)).toBe(true)
      expect(isAiAssistanceOperationCurrent(fence, lease)).toBe(false)
    }
  })

  test('refuses to start stale token and generation callbacks after session synchronization', () => {
    const fence = createAiAssistanceOperationFence('token-a')
    fence.visibleGenerationId = 'generation-a'

    expect(synchronizeAiAssistanceOperationSession(fence, 'token-b')).toBe(true)
    fence.visibleGenerationId = 'generation-b'
    const synchronizedEpoch = fence.epoch

    expect(isAiAssistanceSessionCurrent(fence, 'token-a')).toBe(false)
    expect(isAiAssistanceSessionCurrent(
      fence,
      'token-b',
      'generation-a',
    )).toBe(false)
    expect(beginAiAssistanceGenerationOperation(fence, 'token-a')).toBeUndefined()
    expect(beginAiAssistanceSessionOperation(
      fence,
      'token-a',
      'generation-a',
      'decision',
    )).toBeUndefined()
    expect(beginAiAssistanceSessionOperation(
      fence,
      'token-b',
      'generation-a',
      'feedback',
    )).toBeUndefined()
    expect(fence.epoch).toBe(synchronizedEpoch)
    expect(fence.visibleGenerationId).toBe('generation-b')
    expect(fence.decisionOperationId).toBeUndefined()
    expect(fence.feedbackOperationId).toBeUndefined()
  })

  test('fences old-session results and preserves a newer operation during old finally cleanup', () => {
    const fence = createAiAssistanceOperationFence('old-access-token')
    fence.visibleGenerationId = aiSearchGenerationFixture.id
    const oldDecisionLease = beginAiAssistanceOperation(fence, 'decision')
    const oldFeedbackLease = beginAiAssistanceOperation(fence, 'feedback')
    const oldEpoch = fence.epoch

    expect(isAiAssistanceOperationCurrent(
      fence,
      oldDecisionLease,
      aiSearchGenerationFixture.id,
    )).toBe(true)
    expect(isAiAssistanceOperationCurrent(
      fence,
      oldFeedbackLease,
      aiSearchGenerationFixture.id,
    )).toBe(true)
    expect(synchronizeAiAssistanceOperationSession(
      fence,
      'old-access-token',
    )).toBe(false)
    expect(synchronizeAiAssistanceOperationSession(
      fence,
      'new-access-token',
    )).toBe(true)
    expect(fence.epoch).toBe(oldEpoch + 1)
    expect(isAiAssistanceOperationCurrent(
      fence,
      oldDecisionLease,
      aiSearchGenerationFixture.id,
    )).toBe(false)
    expect(isAiAssistanceOperationCurrent(
      fence,
      oldFeedbackLease,
      aiSearchGenerationFixture.id,
    )).toBe(false)

    fence.visibleGenerationId = 'new-session-generation'
    const newDecisionLease = beginAiAssistanceOperation(fence, 'decision')
    const newFeedbackLease = beginAiAssistanceOperation(fence, 'feedback')

    expect(newDecisionLease.id).toBeGreaterThan(oldFeedbackLease.id)
    expect(releaseAiAssistanceOperation(fence, oldDecisionLease)).toBe(false)
    expect(releaseAiAssistanceOperation(fence, oldFeedbackLease)).toBe(false)
    expect(fence.decisionOperationId).toBe(newDecisionLease.id)
    expect(fence.feedbackOperationId).toBe(newFeedbackLease.id)
    expect(isAiAssistanceOperationCurrent(
      fence,
      newDecisionLease,
      'new-session-generation',
    )).toBe(true)
    expect(isAiAssistanceOperationCurrent(
      fence,
      newFeedbackLease,
      'new-session-generation',
    )).toBe(true)
    expect(releaseAiAssistanceOperation(fence, newDecisionLease)).toBe(true)
    expect(releaseAiAssistanceOperation(fence, newFeedbackLease)).toBe(true)
    expect(fence.decisionOperationId).toBeUndefined()
    expect(fence.feedbackOperationId).toBeUndefined()
  })
})
