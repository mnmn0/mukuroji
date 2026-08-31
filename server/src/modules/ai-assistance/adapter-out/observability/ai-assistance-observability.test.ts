import { describe, expect, test } from 'bun:test'
import { createAiAssistanceEmfObservability } from './ai-assistance-observability'

describe('createAiAssistanceEmfObservability', () => {
  test('emits Service-aggregate and bounded provider dimensions with complete usage', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      nowMilliseconds: () => 1_700_000_000_000,
      sink: (record) => records.push(record),
    })

    observability.recordProviderAttempt({
      task: 'summary',
      modelId: 'anthropic.claude-model-v1:0',
      outcome: 'succeeded',
      latencyMs: 84,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        latencyMs: 84,
        costUsd: 0.0042,
      },
    })

    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0] ?? '')).toMatchObject({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [{
          Namespace: 'Mukuroji/AIAssistance',
          Dimensions: [
            ['Service'],
            ['Service', 'Task'],
            ['Service', 'Task', 'Outcome'],
            ['Service', 'Task', 'Outcome', 'Model'],
          ],
        }],
      },
      Service: 'mukuroji-ai-assistance',
      Task: 'summary',
      Outcome: 'succeeded',
      Model: 'anthropic.claude-model-v1:0',
      ProviderAttemptCount: 1,
      ProviderSuccessCount: 1,
      ProviderFailureCount: 0,
      ProviderThrottledCount: 0,
      ProviderTimeoutCount: 0,
      ProviderRefusedCount: 0,
      ProviderInvalidOutputCount: 0,
      ProviderLatency: 84,
      InputTokenCount: 12,
      OutputTokenCount: 8,
      EstimatedCostUsd: 0.0042,
      UsageUnavailableCount: 0,
    })
  })

  test('counts model refusal with only its bounded content-filter reason', () => {
    const records: string[] = []
    const customerContentMarker = 'customer-refusal-response-must-not-be-logged'
    const observability = createAiAssistanceEmfObservability({
      sink: (record) => records.push(record),
    })

    observability.recordProviderAttempt({
      task: 'summary',
      modelId: `invalid model\n${customerContentMarker}`,
      outcome: 'refused',
      latencyMs: 42,
      usage: {
        inputTokens: 12,
        outputTokens: 0,
        latencyMs: 42,
        costUsd: 0.0002,
      },
      failureCategory: 'upstream',
      failureCode: 'AiAssistanceModelRefused',
    })

    const record = JSON.parse(records[0] ?? '')
    expect(record).toMatchObject({
      Outcome: 'refused',
      Model: 'other',
      refusalReason: 'content-filter',
      ProviderAttemptCount: 1,
      ProviderSuccessCount: 0,
      ProviderFailureCount: 1,
      ProviderRefusedCount: 1,
      failureCategory: 'upstream',
      failureCode: 'AiAssistanceModelRefused',
    })
    expect(records[0]).not.toContain(customerContentMarker)
  })

  test('counts throttling and incomplete token or cost usage without logging content', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      sink: (record) => records.push(record),
    })

    observability.recordProviderAttempt({
      task: 'search',
      modelId: 'invalid model\ncustomer-content',
      outcome: 'throttled',
      latencyMs: 17,
      usage: {
        latencyMs: 17,
        costUnavailableReason: 'pricing-not-configured',
      },
      failureCategory: 'rate-limit',
      failureCode: 'AiAssistanceProviderRateLimited',
    })

    const record = JSON.parse(records[0] ?? '')
    expect(record).toMatchObject({
      Model: 'other',
      ProviderAttemptCount: 1,
      ProviderFailureCount: 1,
      ProviderThrottledCount: 1,
      UsageUnavailableCount: 1,
      usageUnavailableReason: 'token-or-cost-missing',
      failureCategory: 'rate-limit',
      failureCode: 'AiAssistanceProviderRateLimited',
    })
    expect(record).not.toHaveProperty('InputTokenCount')
    expect(record).not.toHaveProperty('OutputTokenCount')
    expect(record).not.toHaveProperty('EstimatedCostUsd')
    expect(records[0]).not.toContain('customer-content')
  })

  test('counts an indeterminate dispatch as failure with unavailable usage', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      sink: (record) => records.push(record),
    })

    observability.recordProviderAttempt({
      task: 'search',
      modelId: 'invalid model\ncustomer-content',
      outcome: 'indeterminate',
      usageUnavailableReason: 'attempt-outcome-indeterminate',
      failureCategory: 'upstream',
      failureCode: 'AiAssistanceAttemptFailed',
    })

    const record = JSON.parse(records[0] ?? '')
    expect(record).toMatchObject({
      Model: 'other',
      Outcome: 'indeterminate',
      ProviderAttemptCount: 1,
      ProviderSuccessCount: 0,
      ProviderFailureCount: 1,
      UsageUnavailableCount: 1,
      usageUnavailableReason: 'attempt-outcome-indeterminate',
    })
    expect(record).not.toHaveProperty('ProviderLatency')
    expect(record).not.toHaveProperty('InputTokenCount')
    expect(record).not.toHaveProperty('OutputTokenCount')
    expect(record).not.toHaveProperty('EstimatedCostUsd')
    expect(records[0]).not.toContain('customer-content')
  })

  test('emits request replay and durable human-decision counters', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      sink: (record) => records.push(record),
    })

    observability.recordGenerationRequest({
      task: 'planning',
      outcome: 'replayed',
      latencyMs: 3,
      replayed: true,
    })
    observability.recordDecision({
      task: 'planning',
      outcome: 'rejected',
    })

    expect(JSON.parse(records[0] ?? '')).toMatchObject({
      Service: 'mukuroji-ai-assistance',
      Task: 'planning',
      Outcome: 'replayed',
      GenerationRequestCount: 1,
      GenerationSuccessCount: 0,
      GenerationReplayCount: 1,
      GenerationFailureCount: 0,
    })
    expect(JSON.parse(records[1] ?? '')).toMatchObject({
      Service: 'mukuroji-ai-assistance',
      Task: 'planning',
      Outcome: 'rejected',
      DecisionCount: 1,
      DecisionApprovedCount: 0,
      DecisionRejectedCount: 1,
    })
  })
})
