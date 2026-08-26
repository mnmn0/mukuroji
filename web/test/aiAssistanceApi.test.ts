import { afterEach, describe, expect, test } from 'bun:test'
import {
  AiAssistanceApiError,
  createAiAssistanceFeedback,
  decideAiAssistanceGeneration,
  generateAiAssistance,
  updateAiAssistancePolicy,
  updateAiAssistancePreference,
} from '../src/features/ai-assistance/api'
import {
  aiAssistancePolicyFixture,
  aiAssistancePreferenceFixture,
  aiPlanningGenerationFixture,
  aiSearchGenerationFixture,
  aiSummaryGenerationFixture,
  aiTriageGenerationFixture,
} from '../src/features/ai-assistance/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'ai-correlation-1',
  idempotencyKey: 'ai-idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('AI assistance API', () => {
  test('issues generation only through the explicit authenticated POST boundary', async () => {
    const requests = installFetchRecorder([aiSearchGenerationFixture])

    const generation = await generateAiAssistance({
      accessToken: 'access-token',
      input: {
        locale: 'en',
        query: 'Open Work Items updated this week',
        task: 'search',
      },
      mutationContext,
    })

    expect(generation.id).toBe(aiSearchGenerationFixture.id)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/ai-assistance/generations')
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      locale: 'en',
      query: 'Open Work Items updated this week',
      task: 'search',
    })
    const headers = new Headers(requests[0]?.init.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(headers.get('Idempotency-Key')).toBe('ai-idempotency-1')
    expect(headers.get('X-Correlation-Id')).toBe('ai-correlation-1')
  })

  test('records a revision-fenced decision and accepts an empty feedback response', async () => {
    const approvedGeneration = {
      ...aiSearchGenerationFixture,
      revision: 4,
      decision: {
        outcome: 'approved',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } as const
    const requests = installFetchRecorder([approvedGeneration, undefined])

    await decideAiAssistanceGeneration({
      accessToken: 'access-token',
      generationId: 'generation/1',
      input: { expectedRevision: 3, outcome: 'approved' },
      mutationContext,
    })
    await createAiAssistanceFeedback({
      accessToken: 'access-token',
      generationId: 'generation/1',
      input: { rating: 'helpful' },
      mutationContext,
    })

    expect(requests.map(({ url }) => url)).toEqual([
      '/api/ai-assistance/generations/generation%2F1/decision',
      '/api/ai-assistance/generations/generation%2F1/feedback',
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      expectedRevision: 3,
      outcome: 'approved',
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ rating: 'helpful' })
  })

  test('rejects a generation containing a non-application citation path', async () => {
    installFetchRecorder([{
      ...aiSearchGenerationFixture,
      content: aiSearchGenerationFixture.content.availability === 'available'
        ? {
            ...aiSearchGenerationFixture.content,
            citations: [{
              id: 'unsafe',
              sourceType: 'document',
              label: 'Unsafe source',
              href: 'https://attacker.example/source',
              capturedRevision: 1,
            }],
          }
        : aiSearchGenerationFixture.content,
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: { locale: 'en', query: 'unsafe', task: 'search' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AiAssistanceApiError)
    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  test('rejects task confusion, duplicate citations, and ungrounded generated claims', async () => {
    const malformedGenerations = [
      {
        ...aiSearchGenerationFixture,
        task: 'summary',
      },
      {
        ...aiSummaryGenerationFixture,
        content: aiSummaryGenerationFixture.content.availability === 'available'
          ? {
              ...aiSummaryGenerationFixture.content,
              citations: [
                ...aiSummaryGenerationFixture.content.citations,
                aiSummaryGenerationFixture.content.citations[0],
              ],
            }
          : aiSummaryGenerationFixture.content,
      },
      {
        ...aiSummaryGenerationFixture,
        content: aiSummaryGenerationFixture.content.availability === 'available'
          ? {
              ...aiSummaryGenerationFixture.content,
              draft: {
                ...aiSummaryGenerationFixture.content.draft,
                actions: [
                  aiSummaryGenerationFixture.content.draft.actions[0],
                  aiSummaryGenerationFixture.content.draft.actions[0],
                ],
              },
            }
          : aiSummaryGenerationFixture.content,
      },
      {
        ...aiSummaryGenerationFixture,
        content: aiSummaryGenerationFixture.content.availability === 'available'
          ? {
              ...aiSummaryGenerationFixture.content,
              draft: {
                ...aiSummaryGenerationFixture.content.draft,
                overview: {
                  ...aiSummaryGenerationFixture.content.draft.overview,
                  citationIds: ['missing-citation'],
                },
              },
            }
          : aiSummaryGenerationFixture.content,
      },
    ]

    for (const malformedGeneration of malformedGenerations) {
      installFetchRecorder([malformedGeneration])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: { locale: 'en', query: 'review this', task: 'summary' },
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  /** Rejects a valid generation whose workflow differs from the requested task. */
  test('rejects a valid generation for a different requested task', async () => {
    installFetchRecorder([aiSummaryGenerationFixture])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: { locale: 'en', query: 'find open work items', task: 'search' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  test('rejects malformed Search dates before they reach the review surface', async () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'search') {
      throw new Error('Search fixture must stay available.')
    }

    for (const date of [
      { field: 'createdAt', from: 'tomorrow' },
      { field: 'createdAt', from: '2026-02-30' },
      { field: 'createdAt', from: '2026-09-01', to: '2026-08-01' },
    ]) {
      installFetchRecorder([{
        ...aiSearchGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            filters: { ...content.draft.filters, date },
          },
        },
      }])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: { locale: 'en', query: 'date', task: 'search' },
        mutationContext,
      }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  test('rejects value-less Search custom-field comparisons before review', async () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'search') {
      throw new Error('Search fixture must stay available.')
    }

    installFetchRecorder([{
      ...aiSearchGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          filters: {
            ...content.draft.filters,
            customFields: [{ fieldId: 'risk', operator: 'equals' }],
          },
        },
      },
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: { locale: 'en', query: 'risk', task: 'search' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  test('rejects duplicate planning row identifiers at the browser API boundary', async () => {
    const content = aiPlanningGenerationFixture.content
    installFetchRecorder([{
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          subtasks: [content.draft.subtasks[0], content.draft.subtasks[0]],
        },
      },
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: {
        locale: 'en',
        source: {
          expectedRevision: 1,
          teamId: 'core-team',
          type: 'work-item',
          workItemId: 'launch-review',
        },
        task: 'planning',
      },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  /** Rejects whitespace-only workflow status identifiers before they reach review. */
  test('rejects whitespace-only planning statuses at the browser API boundary', async () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning' || !content.draft.status) {
      throw new Error('Planning fixture must stay available with a status suggestion.')
    }

    installFetchRecorder([{
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          status: { ...content.draft.status, value: '   ' },
        },
      },
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: {
        locale: 'en',
        source: {
          expectedRevision: 1,
          teamId: 'core-team',
          type: 'work-item',
          workItemId: 'launch-review',
        },
        task: 'planning',
      },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  test('rejects duplicate triage custom-field suggestions at the browser API boundary', async () => {
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }

    installFetchRecorder([{
      ...aiTriageGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          customFields: [
            {
              fieldId: 'risk',
              value: 'high',
              reason: 'First suggestion',
              confidence: 'high',
              citationIds: ['citation-triage-1'],
            },
            {
              fieldId: 'risk',
              value: 'medium',
              reason: 'Duplicate suggestion',
              confidence: 'low',
              citationIds: ['citation-triage-1'],
            },
          ],
        },
      },
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: { locale: 'en', query: 'triage', task: 'triage' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  test('rejects whitespace-only triage routing identifiers before review', async () => {
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }

    for (const field of ['assigneeUserId', 'teamId', 'projectId'] as const) {
      installFetchRecorder([{
        ...aiTriageGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            [field]: {
              ...content.draft[field],
              value: '   ',
            },
          },
        },
      }])

      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: { locale: 'en', query: 'triage', task: 'triage' },
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  test('replaces preference and policy only through explicit revision-fenced PUT requests', async () => {
    const requests = installFetchRecorder([
      { ...aiAssistancePreferenceFixture, enabled: false, revision: 3 },
      { ...aiAssistancePolicyFixture, retentionDays: 45, revision: 5 },
    ])

    await updateAiAssistancePreference(
      'access-token',
      { enabled: false, expectedRevision: 2 },
      mutationContext,
    )
    await updateAiAssistancePolicy(
      'access-token',
      {
        allowedModelIds: aiAssistancePolicyFixture.allowedModelIds,
        defaultModelId: aiAssistancePolicyFixture.defaultModelId,
        enabled: true,
        enabledTasks: aiAssistancePolicyFixture.enabledTasks,
        expectedRevision: 4,
        retentionDays: 45,
      },
      mutationContext,
    )

    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
      ['/api/ai-assistance/preferences/me', 'PUT'],
      ['/api/ai-assistance/policy', 'PUT'],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      enabled: false,
      expectedRevision: 2,
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      expectedRevision: 4,
      retentionDays: 45,
    })
    const headers = new Headers(requests[1]?.init.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(headers.get('Idempotency-Key')).toBe('ai-idempotency-1')
  })

  test('fails closed on duplicate policy values and malformed settings timestamps', async () => {
    installFetchRecorder([{
      ...aiAssistancePolicyFixture,
      allowedModelIds: [
        aiAssistancePolicyFixture.defaultModelId,
        aiAssistancePolicyFixture.defaultModelId,
      ],
    }])
    const duplicateError = await updateAiAssistancePolicy(
      'access-token',
      {
        allowedModelIds: aiAssistancePolicyFixture.allowedModelIds,
        defaultModelId: aiAssistancePolicyFixture.defaultModelId,
        enabled: true,
        enabledTasks: aiAssistancePolicyFixture.enabledTasks,
        expectedRevision: 4,
        retentionDays: 30,
      },
      mutationContext,
    ).catch((caught: unknown) => caught)

    installFetchRecorder([{
      ...aiAssistancePreferenceFixture,
      updatedAt: 'not-an-iso-timestamp',
    }])
    const timestampError = await updateAiAssistancePreference(
      'access-token',
      { enabled: true, expectedRevision: 2 },
      mutationContext,
    ).catch((caught: unknown) => caught)

    expect(duplicateError).toMatchObject({
      code: 'InvalidAiAssistanceResponse',
      status: 502,
    })
    expect(timestampError).toMatchObject({
      code: 'InvalidAiAssistanceResponse',
      status: 502,
    })
  })
})

/** Installs a deterministic JSON fetch recorder for the AI transport boundary. */
function installFetchRecorder(responses: readonly unknown[]) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  let responseIndex = 0
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init })
    const value = responses[responseIndex]
    responseIndex += 1
    return value === undefined
      ? new Response(null, { status: 204 })
      : Response.json(value, { status: responseIndex === 1 ? 201 : 200 })
  }) as typeof fetch

  return requests
}
