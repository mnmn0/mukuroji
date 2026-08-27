import { describe, expect, test } from 'bun:test'
import { parseAiAssistanceGenerationResponse } from '../src/features/ai-assistance/api/generationResponse'
import {
  aiPlanningGenerationFixture,
  aiSearchGenerationFixture,
} from '../src/features/ai-assistance/fixtures'

describe('AI assistance generation response boundary', () => {
  /** Rejects unknown nested response fields before they can enter React state. */
  test('rejects unknown generation fields instead of retaining raw payloads', () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available') {
      throw new Error('Search fixture must stay available.')
    }

    const response = {
      ...aiSearchGenerationFixture,
      content: {
        ...content,
        unexpected: { nested: 'x'.repeat(100_000) },
      },
    }

    expect(() => parseAiAssistanceGenerationResponse(response, 'search')).toThrow(
      'AI assistance API returned an invalid response.',
    )
  })

  /** Rejects a Planning response whose combined rows would overwhelm the review UI. */
  test('rejects an oversized aggregate Planning draft', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }

    const subtask = content.draft.subtasks[0]
    if (!subtask) {
      throw new Error('Planning fixture must include a subtask.')
    }

    const response = {
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: {
          ...content.draft,
          subtasks: Array.from({ length: 50 }, (_, index) => ({
            ...subtask,
            description: 'x'.repeat(6_000),
            id: `subtask-${index}`,
          })),
        },
      },
    }

    expect(() => parseAiAssistanceGenerationResponse(response, 'planning')).toThrow(
      'AI assistance API returned an invalid response.',
    )
  })

  /** Rejects response envelopes whose expiry is not a coherent future retention boundary. */
  test('rejects expired and incoherent retention windows', () => {
    const content = aiSearchGenerationFixture.content
    if (content.availability !== 'available') {
      throw new Error('Search fixture must stay available.')
    }

    const now = Date.now()
    const createdAt = new Date(now - 60_000).toISOString()
    const expired = {
      ...aiSearchGenerationFixture,
      createdAt,
      expiresAt: new Date(now - 1).toISOString(),
    }
    const incoherent = {
      ...aiSearchGenerationFixture,
      createdAt,
      expiresAt: new Date(now - 1).toISOString(),
    }

    expect(() => parseAiAssistanceGenerationResponse(expired, 'search')).toThrow(
      'AI assistance API returned an invalid response.',
    )
    expect(() => parseAiAssistanceGenerationResponse({
      ...incoherent,
      expiresAt: new Date(now - 120_000).toISOString(),
    }, 'search')).toThrow(
      'AI assistance API returned an invalid response.',
    )
  })
})
