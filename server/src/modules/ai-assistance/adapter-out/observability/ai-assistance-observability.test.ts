import { describe, expect, test } from 'bun:test'
import { createAiAssistanceEmfObservability } from './ai-assistance-observability'

const APPLICATION_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'

describe('createAiAssistanceEmfObservability', () => {
  test('emits Service-aggregate and bounded provider dimensions with complete usage', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      applicationCommitSha: APPLICATION_COMMIT_SHA,
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
            ['Service', 'ApplicationCommitSha'],
            ['Service', 'Task'],
            ['Service', 'Task', 'Outcome'],
            ['Service', 'Task', 'Outcome', 'Model'],
          ],
        }],
      },
      Service: 'mukuroji-ai-assistance',
      ApplicationCommitSha: APPLICATION_COMMIT_SHA,
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
      applicationCommitSha: APPLICATION_COMMIT_SHA,
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
      applicationCommitSha: APPLICATION_COMMIT_SHA,
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
      _aws: {
        CloudWatchMetrics: [{
          Dimensions: [
            ['Service'],
            ['Service', 'ApplicationCommitSha'],
            ['Service', 'Task'],
            ['Service', 'Task', 'Outcome'],
          ],
        }],
      },
      Service: 'mukuroji-ai-assistance',
      ApplicationCommitSha: APPLICATION_COMMIT_SHA,
      Task: 'planning',
      Outcome: 'replayed',
      GenerationRequestCount: 1,
      GenerationSuccessCount: 0,
      GenerationReplayCount: 1,
      GenerationFailureCount: 0,
    })
    expect(JSON.parse(records[1] ?? '')).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{
          Dimensions: [
            ['Service'],
            ['Service', 'ApplicationCommitSha'],
            ['Service', 'Task'],
            ['Service', 'Task', 'Outcome'],
          ],
        }],
      },
      ApplicationCommitSha: APPLICATION_COMMIT_SHA,
      Service: 'mukuroji-ai-assistance',
      Task: 'planning',
      Outcome: 'rejected',
      DecisionCount: 1,
      DecisionApprovedCount: 0,
      DecisionRejectedCount: 1,
    })
  })

  test('emits a content-free aggregate for partial-batch projection failures', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      applicationCommitSha: APPLICATION_COMMIT_SHA,
      nowMilliseconds: () => 1_700_000_000_000,
      sink: (record) => records.push(record),
    })

    observability.recordProjectionFailures(3)

    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0] ?? '')).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [{
          Namespace: 'Mukuroji/AIAssistance',
          Dimensions: [
            ['Service'],
            ['Service', 'ApplicationCommitSha'],
          ],
          Metrics: [{ Name: 'ProjectionFailureCount', Unit: 'Count' }],
        }],
      },
      event: 'ai-assistance.observability.projection-failed',
      service: 'mukuroji-ai-assistance',
      Service: 'mukuroji-ai-assistance',
      ApplicationCommitSha: APPLICATION_COMMIT_SHA,
      ProjectionFailureCount: 3,
    })
  })

  test('uses one bounded unavailable dimension when commit provenance is omitted', () => {
    const records: string[] = []
    const observability = createAiAssistanceEmfObservability({
      sink: (record) => records.push(record),
    })

    observability.recordDecision({ task: 'planning', outcome: 'approved' })

    expect(JSON.parse(records[0] ?? '')).toMatchObject({
      ApplicationCommitSha: 'unavailable',
    })
  })

  test('rejects malformed provided commit provenance', () => {
    expect(() => createAiAssistanceEmfObservability({
      applicationCommitSha: '',
    })).toThrow(
      'applicationCommitSha must be one full lowercase 40-character Git commit SHA.',
    )
    expect(() => createAiAssistanceEmfObservability({
      applicationCommitSha: 'not-a-full-lowercase-commit-sha',
    })).toThrow(
      'applicationCommitSha must be one full lowercase 40-character Git commit SHA.',
    )
    expect(() => createAiAssistanceEmfObservability({
      applicationCommitSha: ` ${APPLICATION_COMMIT_SHA}`,
    })).toThrow(
      'applicationCommitSha must be one full lowercase 40-character Git commit SHA.',
    )
  })
})
