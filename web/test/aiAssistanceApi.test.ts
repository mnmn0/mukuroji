import { afterEach, describe, expect, test } from 'bun:test'
import type {
  AiAssistanceGeneration,
  AiPlanningStatusUpdateDraft,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
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
    } satisfies AiAssistanceGeneration
    const requests = installFetchRecorder([approvedGeneration, undefined])

    await decideAiAssistanceGeneration({
      accessToken: 'access-token',
      generationId: 'generation/1',
      expectedGeneration: aiSearchGenerationFixture,
      expectedTask: 'search',
      expectedOutcome: 'approved',
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

  /** Verifies decision responses remain bound to the requested task and outcome. */
  test('rejects a decision response for a different task or requested outcome', async () => {
    const generationWithRejectedDecision = {
      ...aiSearchGenerationFixture,
      decision: {
        outcome: 'rejected',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration
    const generationWithDifferentTask = {
      ...aiSummaryGenerationFixture,
      decision: {
        outcome: 'approved',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration

    for (const response of [generationWithRejectedDecision, generationWithDifferentTask]) {
      installFetchRecorder([response])
      const error = await decideAiAssistanceGeneration({
        accessToken: 'access-token',
        generationId: 'generation/1',
        expectedGeneration: aiSearchGenerationFixture,
        expectedTask: 'search',
        expectedOutcome: 'approved',
        input: { expectedRevision: 3, outcome: 'approved' },
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  /** Rejects a decision response that changes reviewed draft content or citations. */
  test('rejects a decision response with content different from the reviewed generation', async () => {
    const changedGeneration = {
      ...aiSearchGenerationFixture,
      content: aiSearchGenerationFixture.content.availability === 'available'
        ? {
            ...aiSearchGenerationFixture.content,
            draft: {
              ...aiSearchGenerationFixture.content.draft,
              interpretation: 'Changed after the operator reviewed the draft.',
            },
          }
        : aiSearchGenerationFixture.content,
      decision: {
        outcome: 'approved',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration
    installFetchRecorder([changedGeneration])

    const error = await decideAiAssistanceGeneration({
      accessToken: 'access-token',
      generationId: 'generation/1',
      expectedGeneration: aiSearchGenerationFixture,
      expectedTask: 'search',
      expectedOutcome: 'approved',
      input: { expectedRevision: 3, outcome: 'approved' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  /** Rejects a decision response whose reviewed citation set is replaced. */
  test('rejects a decision response with different reviewed citations', async () => {
    const content = aiSummaryGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'summary') {
      throw new Error('Summary fixture must stay available.')
    }
    const changedCitationGeneration = {
      ...aiSummaryGenerationFixture,
      content: {
        ...content,
        citations: [{
          ...content.citations[0],
          label: 'A different source than the one reviewed.',
        }],
      },
      decision: {
        outcome: 'approved',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration
    installFetchRecorder([changedCitationGeneration])

    const error = await decideAiAssistanceGeneration({
      accessToken: 'access-token',
      generationId: 'generation/summary-1',
      expectedGeneration: aiSummaryGenerationFixture,
      expectedTask: 'summary',
      expectedOutcome: 'approved',
      input: { expectedRevision: 1, outcome: 'approved' },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  /** Accepts a server-authoritative withholding when access changes during review. */
  test('accepts a withheld decision response after authorization changes', async () => {
    const withheldGeneration = {
      ...aiSearchGenerationFixture,
      content: {
        availability: 'withheld',
        reasonCode: 'permission-changed',
      },
      decision: {
        outcome: 'approved',
        decidedAt: '2026-08-25T02:05:00.000Z',
      },
    } satisfies AiAssistanceGeneration
    installFetchRecorder([withheldGeneration])

    const generation = await decideAiAssistanceGeneration({
      accessToken: 'access-token',
      generationId: 'generation/search-1',
      expectedGeneration: aiSearchGenerationFixture,
      expectedTask: 'search',
      expectedOutcome: 'approved',
      input: { expectedRevision: 3, outcome: 'approved' },
      mutationContext,
    })

    expect(generation.content).toEqual(withheldGeneration.content)
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

  /** Rejects oversized citation collections and fields before review components render them. */
  test('rejects oversized citation collections, references, and fields', async () => {
    const content = aiSummaryGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'summary') {
      throw new Error('Summary fixture must stay available.')
    }

    const tooManyCitations = Array.from({ length: 101 }, (_, index) => ({
      ...content.citations[0],
      id: `citation-${index}`,
    }))
    const tooManyReferences = Array.from({ length: 21 }, (_, index) => ({
      ...content.citations[0],
      id: `reference-${index}`,
    }))
    const malformedGenerations = [
      {
        ...aiSummaryGenerationFixture,
        content: {
          ...content,
          citations: tooManyCitations,
        },
      },
      {
        ...aiSummaryGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            overview: {
              ...content.draft.overview,
              citationIds: tooManyReferences.map((citation) => citation.id),
            },
          },
          citations: tooManyReferences,
        },
      },
      {
        ...aiSummaryGenerationFixture,
        content: {
          ...content,
          citations: [{
            ...content.citations[0],
            label: 'L'.repeat(501),
          }],
        },
      },
      {
        ...aiSummaryGenerationFixture,
        content: {
          ...content,
          citations: [{
            ...content.citations[0],
            href: `/${'h'.repeat(2_000)}`,
          }],
        },
      },
      {
        ...aiSummaryGenerationFixture,
        content: {
          ...content,
          citations: [{
            ...content.citations[0],
            excerpt: 'E'.repeat(2_001),
          }],
        },
      },
    ]

    for (const generation of malformedGenerations) {
      installFetchRecorder([generation])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: { locale: 'en', sources: [], task: 'summary' },
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  /** Rejects oversized workflow collections before review components render them. */
  test('rejects oversized model-generated draft collections', async () => {
    const summaryContent = aiSummaryGenerationFixture.content
    const searchContent = aiSearchGenerationFixture.content
    const planningContent = aiPlanningGenerationFixture.content
    const triageContent = aiTriageGenerationFixture.content
    if (
      summaryContent.availability !== 'available' ||
      summaryContent.draft.kind !== 'summary' ||
      searchContent.availability !== 'available' ||
      searchContent.draft.kind !== 'search' ||
      planningContent.availability !== 'available' ||
      planningContent.draft.kind !== 'planning' ||
      triageContent.availability !== 'available' ||
      triageContent.draft.kind !== 'triage'
    ) {
      throw new Error('AI fixtures must stay available.')
    }

    const malformedGenerations: Array<{
      generation: unknown
      input: GenerateAiAssistanceRequest
    }> = [
      {
        generation: {
          ...aiSummaryGenerationFixture,
          content: {
            ...summaryContent,
            draft: {
              ...summaryContent.draft,
              decisions: Array.from({ length: 101 }, (_, index) => ({
                ...summaryContent.draft.decisions[0],
                id: `decision-${index}`,
              })),
            },
          },
        },
        input: { locale: 'en', sources: [], task: 'summary' },
      },
      {
        generation: {
          ...aiSearchGenerationFixture,
          content: {
            ...searchContent,
            draft: {
              ...searchContent.draft,
              caveats: Array.from({ length: 21 }, () => 'A bounded caveat.'),
            },
          },
        },
        input: { locale: 'en', query: 'too many caveats', task: 'search' },
      },
      {
        generation: {
          ...aiPlanningGenerationFixture,
          content: {
            ...planningContent,
            draft: {
              ...planningContent.draft,
              subtasks: Array.from({ length: 51 }, (_, index) => ({
                ...planningContent.draft.subtasks[0],
                id: `subtask-${index}`,
              })),
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 2,
            teamId: 'core-team',
            workItemId: 'accessibility-review',
            type: 'work-item',
          },
          task: 'planning',
        },
      },
      {
        generation: {
          ...aiTriageGenerationFixture,
          content: {
            ...triageContent,
            draft: {
              ...triageContent.draft,
              customFields: Array.from({ length: 51 }, (_, index) => ({
                fieldId: `field-${index}`,
                value: 'enterprise',
                reason: 'Visible request context supports this value.',
                confidence: 'medium',
                citationIds: ['citation-triage-1'],
              })),
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 1,
            teamId: 'core-team',
            triageEntryId: 'triage-chat-1',
            type: 'triage-entry',
          },
          task: 'triage',
        },
      },
      {
        generation: {
          ...aiTriageGenerationFixture,
          content: {
            ...triageContent,
            draft: {
              ...triageContent.draft,
              title: {
                ...triageContent.draft.title,
                reason: 'R'.repeat(2_001),
              },
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 1,
            teamId: 'core-team',
            triageEntryId: 'triage-chat-1',
            type: 'triage-entry',
          },
          task: 'triage',
        },
      },
      {
        generation: {
          ...aiPlanningGenerationFixture,
          content: {
            ...planningContent,
            draft: {
              ...planningContent.draft,
              title: {
                ...planningContent.draft.title,
                value: 'T'.repeat(257),
              },
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 2,
            teamId: 'core-team',
            workItemId: 'accessibility-review',
            type: 'work-item',
          },
          task: 'planning',
        },
      },
      {
        generation: {
          ...aiPlanningGenerationFixture,
          content: {
            ...planningContent,
            draft: {
              ...planningContent.draft,
              description: {
                ...planningContent.draft.description,
                value: 'D'.repeat(20_001),
              },
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 2,
            teamId: 'core-team',
            workItemId: 'accessibility-review',
            type: 'work-item',
          },
          task: 'planning',
        },
      },
    ]

    for (const { generation, input } of malformedGenerations) {
      installFetchRecorder([generation])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input,
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
  })

  /** Rejects empty model prose before a summary or triage draft becomes reviewable. */
  test('rejects blank summary claims and triage fields at the browser API boundary', async () => {
    const summaryContent = aiSummaryGenerationFixture.content
    const triageContent = aiTriageGenerationFixture.content
    if (
      summaryContent.availability !== 'available' ||
      summaryContent.draft.kind !== 'summary' ||
      triageContent.availability !== 'available' ||
      triageContent.draft.kind !== 'triage'
    ) {
      throw new Error('AI fixtures must stay available.')
    }

    const malformedGenerations: Array<{
      generation: AiAssistanceGeneration
      input: GenerateAiAssistanceRequest
    }> = [
      {
        generation: {
          ...aiSummaryGenerationFixture,
          content: {
            ...summaryContent,
            draft: {
              ...summaryContent.draft,
              overview: { ...summaryContent.draft.overview, text: '   ' },
            },
          },
        },
        input: { locale: 'en', sources: [], task: 'summary' },
      },
      {
        generation: {
          ...aiTriageGenerationFixture,
          content: {
            ...triageContent,
            draft: {
              ...triageContent.draft,
              title: {
                ...triageContent.draft.title,
                value: '   ',
              },
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 1,
            teamId: 'core-team',
            triageEntryId: 'triage-1',
            type: 'triage-entry',
          },
          task: 'triage',
        },
      },
      {
        generation: {
          ...aiTriageGenerationFixture,
          content: {
            ...triageContent,
            draft: {
              ...triageContent.draft,
              description: {
                ...triageContent.draft.description,
                value: '   ',
              },
            },
          },
        },
        input: {
          locale: 'en',
          source: {
            expectedRevision: 1,
            teamId: 'core-team',
            triageEntryId: 'triage-1',
            type: 'triage-entry',
          },
          task: 'triage',
        },
      },
    ]

    for (const { generation, input } of malformedGenerations) {
      installFetchRecorder([generation])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input,
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

  test('rejects operator-incompatible Search custom-field values before review', async () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'search') {
      throw new Error('Search fixture must stay available.')
    }

    for (const customField of [
      { fieldId: 'risk', operator: 'greater-than', value: 'high' },
      { fieldId: 'risk', operator: 'contains', value: 3 },
    ]) {
      installFetchRecorder([{
        ...aiSearchGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            filters: { ...content.draft.filters, customFields: [customField] },
          },
        },
      }])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: { locale: 'en', query: 'risk', task: 'search' },
        mutationContext,
      }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
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

  /** Verifies model output cannot introduce a self-referential planning dependency. */
  test('rejects a planning dependency that points to the same Work Item', async () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }
    const dependency = content.draft.dependencies[0]
    if (!dependency) throw new Error('Planning fixture must include a dependency.')

    installFetchRecorder([{
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          dependencies: [{
            ...dependency,
            successor: { ...dependency.predecessor },
          }],
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

  /** Rejects Planning status text that the publish endpoint would reject by UTF-8 size. */
  test('rejects Planning status text over the server UTF-8 byte limit', async () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning' || !content.draft.statusUpdate) {
      throw new Error('Planning fixture must stay available with a status update.')
    }
    const statusUpdate = content.draft.statusUpdate
    const oversizedText = 'あ'.repeat(2_667)
    const textFields: readonly (keyof Pick<
      AiPlanningStatusUpdateDraft,
      'summary' | 'riskSummary' | 'decisionSummary' | 'helpNeeded' | 'nextAction'
    >)[] = ['summary', 'riskSummary', 'decisionSummary', 'helpNeeded', 'nextAction']

    for (const field of textFields) {
      installFetchRecorder([{
        ...aiPlanningGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            statusUpdate: {
              ...statusUpdate,
              [field]: oversizedText,
            },
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
    }
  })

  /** Rejects lone UTF-16 surrogates that the Planning publish endpoint cannot accept. */
  test('rejects malformed Unicode in Planning status text', async () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning' || !content.draft.statusUpdate) {
      throw new Error('Planning fixture must stay available with a status update.')
    }

    installFetchRecorder([{
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          statusUpdate: {
            ...content.draft.statusUpdate,
            summary: '\uD800',
          },
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

  /** Rejects an oversized Search interpretation before it reaches the review surface. */
  test('rejects an oversized Search interpretation at the browser API boundary', async () => {
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
          interpretation: 'x'.repeat(4_001),
        },
      },
    }])

    const error = await generateAiAssistance({
      accessToken: 'access-token',
      input: {
        locale: 'en',
        query: 'Find incomplete Work Items',
        task: 'search',
      },
      mutationContext,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
  })

  /** Rejects Search statuses that URL serialization would silently remove. */
  test('rejects Search statuses outside the canonical URL identifier grammar', async () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'search') {
      throw new Error('Search fixture must stay available.')
    }

    for (const invalidStatus of ['in progress', 'x'.repeat(129)]) {
      installFetchRecorder([{
        ...aiSearchGenerationFixture,
        content: {
          ...content,
          draft: {
            ...content.draft,
            filters: {
              ...content.draft.filters,
              statuses: [invalidStatus],
            },
          },
        },
      }])
      const error = await generateAiAssistance({
        accessToken: 'access-token',
        input: {
          locale: 'en',
          query: 'Find incomplete Work Items',
          task: 'search',
        },
        mutationContext,
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'InvalidAiAssistanceResponse', status: 502 })
    }
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

/**
 * Installs a deterministic JSON fetch mock and records every request it receives.
 *
 * @param responses - JSON response values returned in request order.
 * @returns Mutable request records captured by the installed fetch mock.
 */
function installFetchRecorder(responses: readonly unknown[]) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  let responseIndex = 0
  const fetchRecorder: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(input), init: init ?? {} })
    const value = responses[responseIndex]
    responseIndex += 1
    return value === undefined
      ? new Response(null, { status: 204 })
      : Response.json(value, { status: responseIndex === 1 ? 201 : 200 })
  }
  globalThis.fetch = fetchRecorder

  return requests
}
