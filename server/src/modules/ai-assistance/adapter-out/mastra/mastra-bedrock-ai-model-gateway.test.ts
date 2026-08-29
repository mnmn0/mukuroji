import { describe, expect, test } from 'bun:test'
import type { AiModelGenerationInput } from '../../application/ports/ai-assistance-ports'
import type { AiAssistanceModelOutput } from '../../application/validation/ai-assistance-schema'
import {
  AI_ASSISTANCE_SYSTEM_INSTRUCTIONS,
  createAiAssistanceGenerationPrompt,
  createMastraBedrockAiModelGateway,
} from './mastra-bedrock-ai-model-gateway'

/** Creates one complete gateway input without sensitive member identifiers. */
function createInput(): AiModelGenerationInput {
  return {
    modelId: 'model-1',
    task: 'search',
    locale: 'ja',
    promptVersion: 'ai-assistance-v1',
    request: { task: 'search', locale: 'ja', query: '未完了の項目' },
    promptContext: 'Visible search catalog.',
    citations: [],
    allowedValues: {
      assigneeUserIds: ['U1'],
      creatorUserIds: ['C1'],
      teamIds: ['team-1'],
      projectIds: ['project-1'],
      customFieldIds: [],
      relationIds: [],
      statuses: ['todo'],
      workItemEndpoints: [],
    },
    traceId: 'trace-1',
    maxOutputTokens: 1_000,
    timeoutMs: 100,
  }
}

/** Creates one strict search draft returned by an injected Mastra runner. */
function createOutput(): AiAssistanceModelOutput {
  return {
    draft: {
      kind: 'search',
      interpretation: '未完了の項目です。',
      filters: { statuses: ['todo'] },
      caveats: [],
    },
    uncertainty: { level: 'low', reason: '明確です。' },
  }
}

describe('createMastraBedrockAiModelGateway', () => {
  test('builds one delimited prompt and records provider usage and estimated cost', async () => {
    let capturedPrompt = ''
    let capturedSystemInstructions = ''
    let clock = 1_000
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async (input) => {
        capturedPrompt = input.prompt
        capturedSystemInstructions = input.systemInstructions
        clock = 1_025
        return {
          object: createOutput(),
          inputTokens: 10,
          outputTokens: 20,
          traceId: 'provider-trace-1',
        }
      },
      pricingByModelId: {
        'model-1': {
          inputPerMillionTokensUsd: 2,
          outputPerMillionTokensUsd: 4,
        },
      },
      nowMilliseconds: () => clock,
    })

    const result = await gateway.generate(createInput())

    expect(capturedSystemInstructions).toBe(AI_ASSISTANCE_SYSTEM_INSTRUCTIONS)
    expect(capturedPrompt).toBe(createAiAssistanceGenerationPrompt(createInput()))
    expect(capturedPrompt).toContain('REQUEST_JSON_BEGIN')
    expect(capturedPrompt).toContain('AUTHORIZED_CONTEXT_BEGIN')
    expect(capturedPrompt).toContain('ALLOWED_VALUES_JSON_BEGIN')
    expect(capturedPrompt).toContain('"assigneeUserIds":["U1"]')
    expect(result.providerTraceId).toBe('provider-trace-1')
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 25,
      costUsd: 0.0001,
    })
  })

  test('retains provider usage when structured output validation fails', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: { ...createOutput(), unauthorized: 'field' },
        inputTokens: 12,
        outputTokens: 34,
      }),
    })

    try {
      await gateway.generate(createInput())
      throw new Error('Expected structured output validation to fail.')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'InvalidAiAssistanceOutput',
        usage: {
          inputTokens: 12,
          outputTokens: 34,
          costUnavailableReason: 'pricing-not-configured',
        },
      })
    }
  })

  test('rejects non-finite or fractional provider usage before returning a draft', async () => {
    for (const usage of [
      { inputTokens: -1, outputTokens: 1 },
      { inputTokens: 1.5, outputTokens: 1 },
      { inputTokens: Number.NaN, outputTokens: 1 },
      { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY },
    ]) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: createOutput(),
          ...usage,
        }),
      })

      await expect(gateway.generate(createInput())).rejects.toMatchObject({
        code: 'InvalidAiAssistanceOutput',
      })
    }
  })

  test('accepts provider row identifiers that the application replaces after parsing', async () => {
    const duplicateSubtask = {
      id: 'subtask-1',
      title: 'Review the launch checklist',
      priority: 'high',
      reason: 'The checklist remains incomplete.',
      confidence: 'high',
      citationIds: ['source-1'],
    }
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [duplicateSubtask, duplicateSubtask],
            dependencies: [],
          },
          uncertainty: { level: 'low', reason: 'The source is incomplete.' },
        },
      }),
    })

    const result = await gateway.generate(createInput())

    expect(result.draft).toMatchObject({
      kind: 'planning',
      subtasks: [{ id: 'subtask-1' }, { id: 'subtask-1' }],
    })
  })

  test('accepts only real fixed-width calendar dates in Search output', async () => {
    for (const invalidDate of [
      'victim@example.com',
      '2026-2-01',
      '2026-02-29',
      '2026-02-30',
      '2026-13-01',
      '2026-08-25T00:00:00Z',
    ]) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: {
            draft: {
              kind: 'search',
              interpretation: 'Date filter.',
              filters: {
                date: { field: 'createdAt', from: invalidDate },
              },
              caveats: [],
            },
            uncertainty: { level: 'low', reason: 'Clear.' },
          },
        }),
      })

      await expect(gateway.generate(createInput())).rejects.toMatchObject({
        code: 'InvalidAiAssistanceOutput',
      })
    }

    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'search',
            interpretation: 'Leap-day filter.',
            filters: {
              date: {
                field: 'createdAt',
                from: '2000-02-29',
                to: '2028-02-29',
              },
            },
            caveats: [],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).resolves.toMatchObject({
      draft: {
        filters: {
          date: {
            field: 'createdAt',
            from: '2000-02-29',
            to: '2028-02-29',
          },
        },
      },
    })

    const invalidRanges: Array<{
      field: 'createdAt' | 'updatedAt' | 'dueDate'
      from?: string
      to?: string
    }> = [
      { field: 'updatedAt' },
      { field: 'createdAt', from: '2026-09-01', to: '2026-08-31' },
    ]
    for (const date of invalidRanges) {
      const invalidRangeGateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: {
            draft: {
              kind: 'search',
              interpretation: 'Invalid date range.',
              filters: { date },
              caveats: [],
            },
            uncertainty: { level: 'low', reason: 'Invalid.' },
          },
        }),
      })

      await expect(invalidRangeGateway.generate(createInput())).rejects.toMatchObject({
        code: 'InvalidAiAssistanceOutput',
      })
    }
  })

  test('rejects a Search keyword longer than the canonical route limit', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'search',
            interpretation: 'Long keyword.',
            filters: { keyword: 'x'.repeat(257) },
            caveats: [],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('enforces the Web title limit at the model boundary', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'triage',
            title: {
              value: 'x'.repeat(257),
              reason: 'The title is descriptive.',
              confidence: 'high',
              citationIds: ['S1'],
            },
            customFields: [],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('rejects self-referential planning dependencies', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [],
            dependencies: [{
              id: 'dependency-1',
              predecessor: { teamId: 'team-1', workItemId: 'work-item-1' },
              successor: { teamId: 'team-1', workItemId: 'work-item-1' },
              type: 'finish-to-start',
              lagDays: 0,
              reason: 'The same item is blocked by itself.',
              confidence: 'high',
              citationIds: ['S1'],
            }],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('requires a nonempty Planning next action', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [],
            dependencies: [],
            statusUpdate: {
              health: 'on-track',
              risk: 'none',
              summary: 'The work remains on track.',
              riskSummary: '',
              decisionSummary: '',
              helpNeeded: '',
              nextAction: '   ',
              confidence: 'high',
              citationIds: ['S1'],
            },
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('classifies an aborted provider run as a stable timeout', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: (input) => new Promise((_resolve, reject) => {
        input.abortSignal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        }, { once: true })
      }),
    })

    await expect(gateway.generate({ ...createInput(), timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'AiAssistanceProviderTimeout' })
  })
})
