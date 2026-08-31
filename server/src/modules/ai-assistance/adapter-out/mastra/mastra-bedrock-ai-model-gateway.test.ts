import { describe, expect, test } from 'bun:test'
import type { AiModelGenerationInput } from '../../application/ports/ai-assistance-ports'
import type { AiAssistanceModelOutput } from '../../application/validation/ai-assistance-schema'
import { AiAssistanceError } from '../../errors'
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
    async onProviderDispatch() {},
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

  test('does not process a provider result before the dispatch marker completes', async () => {
    let releaseDispatchMarker = () => {}
    const dispatchMarkerBarrier = new Promise<void>((resolve) => {
      releaseDispatchMarker = resolve
    })
    let dispatchMarkerStarted = false
    let generationSettled = false
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: createOutput(),
        inputTokens: 1,
        outputTokens: 1,
      }),
    })

    const generation = gateway.generate({
      ...createInput(),
      async onProviderDispatch() {
        dispatchMarkerStarted = true
        await dispatchMarkerBarrier
      },
    })
    void generation.finally(() => {
      generationSettled = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(dispatchMarkerStarted).toBe(true)
    expect(generationSettled).toBe(false)

    releaseDispatchMarker()
    await expect(generation).resolves.toMatchObject({ draft: { kind: 'search' } })
  })

  test('times out when a settled provider result waits on the dispatch marker past the deadline', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: createOutput(),
        inputTokens: 1,
        outputTokens: 1,
      }),
    })

    await expect(gateway.generate({
      ...createInput(),
      timeoutMs: 1,
      async onProviderDispatch() {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20)
        })
      },
    })).rejects.toMatchObject({
      category: 'timeout',
      code: 'AiAssistanceProviderTimeout',
    })
  })

  test('accepts a dispatch marker that settles before the provider deadline', async () => {
    let dispatchMarkerCompleted = false
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: createOutput(),
        inputTokens: 1,
        outputTokens: 1,
      }),
    })

    const result = await gateway.generate({
      ...createInput(),
      timeoutMs: 1,
      async onProviderDispatch() {
        await Promise.resolve()
        dispatchMarkerCompleted = true
      },
    })

    expect(dispatchMarkerCompleted).toBe(true)
    expect(result).toMatchObject({ draft: { kind: 'search' } })
  })

  test('preserves a dispatch marker failure while aborting the in-flight provider', async () => {
    let providerAborted = false
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async (input) => await new Promise((_, reject) => {
        input.abortSignal.addEventListener('abort', () => {
          providerAborted = true
          reject(new Error('provider aborted after marker failure'))
        }, { once: true })
      }),
    })
    const markerError = new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'Provider dispatch marker could not be persisted.',
    )

    await expect(gateway.generate({
      ...createInput(),
      async onProviderDispatch() {
        throw markerError
      },
    })).rejects.toBe(markerError)
    expect(providerAborted).toBe(true)
  })

  test('retains provider usage when structured output validation fails', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: { ...createOutput(), unauthorized: 'field' },
        inputTokens: 12,
        outputTokens: 34,
        traceId: 'provider-invalid-output-trace',
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
        providerTraceId: 'provider-invalid-output-trace',
      })
    }
  })

  test('maps a content-filter finish reason to a bounded model refusal', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {},
        finishReason: 'content-filter',
        inputTokens: 12,
        outputTokens: 0,
        traceId: 'provider-refusal-trace',
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      category: 'upstream',
      code: 'AiAssistanceModelRefused',
      usage: {
        inputTokens: 12,
        outputTokens: 0,
        costUnavailableReason: 'pricing-not-configured',
      },
      providerTraceId: 'provider-refusal-trace',
    })
  })

  test('maps a rejected structured result with a content-filter reason to model refusal', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => {
        throw {
          cause: {
            finishReason: 'content-filter',
            message: 'customer-controlled provider detail',
            usage: { inputTokens: 8, outputTokens: 0 },
          },
        }
      },
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      category: 'upstream',
      code: 'AiAssistanceModelRefused',
      message: 'Bedrock Runtime refused generation because its content filter was activated.',
      usage: {
        inputTokens: 8,
        outputTokens: 0,
        costUnavailableReason: 'pricing-not-configured',
      },
    })
  })

  test('omits malformed provider trace identifiers before forwarding or persisting them', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: createOutput(),
        inputTokens: 1,
        outputTokens: 1,
        traceId: `${'x'.repeat(257)}\nprovider-secret`,
      }),
    })

    const result = await gateway.generate(createInput())

    expect(result.providerTraceId).toBeUndefined()
  })

  test('rejects non-finite or fractional provider usage before returning a draft', async () => {
    const invalidUsages: ReadonlyArray<[
      { inputTokens: number; outputTokens: number },
      string,
    ]> = [
      [{ inputTokens: -1, outputTokens: 1 }, 'invalid-usage-negative'],
      [{ inputTokens: 1.5, outputTokens: 1 }, 'invalid-usage-fractional'],
      [{ inputTokens: Number.NaN, outputTokens: 1 }, 'invalid-usage-nan'],
      [{ inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY }, 'invalid-usage-infinity'],
    ]
    for (const [usage, traceId] of invalidUsages) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: createOutput(),
          ...usage,
          traceId,
        }),
      })

      await expect(gateway.generate(createInput())).rejects.toMatchObject({
        code: 'InvalidAiAssistanceOutput',
        providerTraceId: traceId,
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

  test('rejects Search filters that exceed the canonical GET transport budget', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'search',
            interpretation: 'A broad filter.',
            filters: { statuses: Array.from({ length: 100 }, (_, index) => `status-${index}-${'x'.repeat(100)}`) },
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

  test('enforces operator-specific Search custom-field values', async () => {
    const invalidFilters = [
      { fieldId: 'field-1', operator: 'greater-than', value: '10' },
      { fieldId: 'field-1', operator: 'contains', value: [] },
      { fieldId: 'field-1', operator: 'contains', value: '   ' },
      { fieldId: 'field-1', operator: 'is-empty', value: true },
      { fieldId: 'field-1', operator: 'equals', value: '   ' },
    ]
    for (const filter of invalidFilters) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: {
            draft: {
              kind: 'search',
              interpretation: 'A custom-field filter.',
              filters: { customFields: [filter] },
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
  })

  test('accepts typed Search equality values for downstream field validation', async () => {
    for (const filter of [
      { fieldId: 'field-1', operator: 'equals', value: 10 },
      { fieldId: 'field-1', operator: 'not-equals', value: false },
      { fieldId: 'field-1', operator: 'equals', value: ['one'] },
      { fieldId: 'field-1', operator: 'not-equals', value: null },
    ]) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => ({
          object: {
            draft: {
              kind: 'search',
              interpretation: 'A typed custom-field filter.',
              filters: { customFields: [filter] },
              caveats: [],
            },
            uncertainty: { level: 'low', reason: 'Clear.' },
          },
        }),
      })

      await expect(gateway.generate(createInput())).resolves.toMatchObject({
        draft: { kind: 'search', filters: { customFields: [filter] } },
      })
    }
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

  test('enforces the Web limit for Planning subtask titles', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [{
              id: 'subtask-1',
              title: 'x'.repeat(257),
              priority: 'high',
              reason: 'The task is required.',
              confidence: 'high',
              citationIds: ['S1'],
            }],
            dependencies: [],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('rejects duplicate triage custom-field suggestions', async () => {
    const suggestion = {
      fieldId: 'field-1',
      value: 'value',
      reason: 'The field is relevant.',
      confidence: 'high',
      citationIds: ['S1'],
    }
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'triage',
            customFields: [suggestion, suggestion],
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

  test('rejects duplicate planning dependency edges', async () => {
    const dependency = {
      id: 'dependency-1',
      predecessor: { teamId: 'team-1', workItemId: 'work-item-1' },
      successor: { teamId: 'team-1', workItemId: 'work-item-2' },
      type: 'finish-to-start',
      lagDays: 0,
      reason: 'The predecessor must finish first.',
      confidence: 'high',
      citationIds: ['S1'],
    }
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [],
            dependencies: [
              dependency,
              { ...dependency, id: 'dependency-2', type: 'start-to-start' },
            ],
          },
          uncertainty: { level: 'low', reason: 'Clear.' },
        },
      }),
    })

    await expect(gateway.generate(createInput())).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('rejects cyclic planning dependency edges', async () => {
    const dependency = {
      id: 'dependency-1',
      predecessor: { teamId: 'team-1', workItemId: 'work-item-1' },
      successor: { teamId: 'team-1', workItemId: 'work-item-2' },
      type: 'finish-to-start',
      lagDays: 0,
      reason: 'The first item must finish first.',
      confidence: 'high',
      citationIds: ['S1'],
    }
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'planning',
            subtasks: [],
            dependencies: [
              dependency,
              {
                ...dependency,
                id: 'dependency-2',
                predecessor: dependency.successor,
                successor: dependency.predecessor,
              },
            ],
          },
          uncertainty: { level: 'low', reason: 'The graph is cyclic.' },
        },
      }),
    })

    await expect(gateway.generate({
      ...createInput(),
      task: 'planning',
      request: {
        task: 'planning',
        locale: 'ja',
        source: {
          type: 'work-item',
          teamId: 'team-1',
          workItemId: 'work-item-1',
          expectedRevision: 1,
        },
      },
    })).rejects.toMatchObject({
      code: 'InvalidAiAssistanceOutput',
    })
  })

  test('rejects unsafe control characters in generated prose', async () => {
    const gateway = createMastraBedrockAiModelGateway({
      runStructuredGeneration: async () => ({
        object: {
          draft: {
            kind: 'search',
            interpretation: 'Unsafe\u0001 interpretation.',
            filters: {},
            caveats: [],
          },
          uncertainty: { level: 'low', reason: 'Safe enough.' },
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

  test('rejects lone UTF-16 surrogates in Planning status text', async () => {
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
              summary: '\ud800',
              riskSummary: '',
              decisionSummary: '',
              helpNeeded: '',
              nextAction: 'Schedule the rehearsal.',
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

  test('normalizes structural Bedrock and AI SDK throttling signals', async () => {
    const providerErrors: unknown[] = [
      { statusCode: 429 },
      { status: 429 },
      { $metadata: { httpStatusCode: 429 } },
      { name: 'ThrottlingException' },
      { cause: { name: 'TooManyRequestsException' } },
    ]

    for (const providerError of providerErrors) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => {
          throw providerError
        },
      })

      await expect(gateway.generate(createInput())).rejects.toMatchObject({
        category: 'rate-limit',
        code: 'AiAssistanceProviderRateLimited',
      })
    }
  })

  test('does not infer throttling from an untrusted provider message', async () => {
    const providerErrors: unknown[] = [
      new Error('429 too many requests for customer-secret'),
      new Proxy({}, {
        get() {
          throw new Error('Untrusted provider getter.')
        },
      }),
    ]

    for (const providerError of providerErrors) {
      const gateway = createMastraBedrockAiModelGateway({
        runStructuredGeneration: async () => {
          throw providerError
        },
      })

      await expect(gateway.generate(createInput())).rejects.toMatchObject({
        category: 'upstream',
        code: 'AiAssistanceProviderError',
        message: 'Bedrock Runtime generation failed.',
      })
    }
  })
})
