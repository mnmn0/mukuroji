import { expect, spyOn, test } from 'bun:test'
import type {
  DynamoAttributeValue,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import type {
  AiAssistanceDecisionObservation,
  AiAssistanceObservability,
  AiAssistanceProviderAttemptObservation,
  AiAssistanceProviderAttemptOutcome,
} from '../../application/ports/ai-assistance-ports'
import { processAiAssistanceObservabilityBatch } from './ai-assistance-observability-projection'

/** Creates one DynamoDB string attribute for a focused stream fixture. */
function stringAttribute(value: string): DynamoAttributeValue {
  return { S: value }
}

/** Creates one DynamoDB number attribute for a focused stream fixture. */
function numberAttribute(value: string): DynamoAttributeValue {
  return { N: value }
}

/** Creates one DynamoDB map attribute for a focused stream fixture. */
function mapAttribute(
  value: Record<string, DynamoAttributeValue>,
): DynamoAttributeValue {
  return { M: value }
}

/** Creates one succeeded terminal provider receipt stream record. */
function createSucceededProviderRecord(
  sequenceNumber: string,
  latency = '120',
): DynamoStreamRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        recordType: stringAttribute('ai-assistance-generation-idempotency'),
        status: stringAttribute('completed'),
        attempt: mapAttribute({
          task: stringAttribute('summary'),
          modelId: stringAttribute('anthropic.claude-model'),
          status: stringAttribute('succeeded'),
          endedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
          latencyMs: numberAttribute(latency),
          providerOutcome: stringAttribute('succeeded'),
          usage: mapAttribute({
            inputTokens: numberAttribute('42'),
            outputTokens: numberAttribute('13'),
            latencyMs: numberAttribute('120'),
            costUsd: numberAttribute('0.0042'),
          }),
        }),
      },
    },
  }
}

/** Creates one failed terminal provider receipt stream record. */
function createFailedProviderRecord(
  sequenceNumber: string,
  providerOutcome: AiAssistanceProviderAttemptOutcome,
  failureCategory: NonNullable<AiAssistanceProviderAttemptObservation['failureCategory']> =
    'rate-limit',
  failureCode: NonNullable<AiAssistanceProviderAttemptObservation['failureCode']> =
    'AiAssistanceProviderRateLimited',
): DynamoStreamRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        recordType: stringAttribute('ai-assistance-generation-idempotency'),
        status: stringAttribute('failed'),
        failedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
        failureCategory: stringAttribute(failureCategory),
        failureCode: stringAttribute(failureCode),
        attempt: mapAttribute({
          task: stringAttribute('triage'),
          modelId: stringAttribute('anthropic.claude-model'),
          status: stringAttribute('failed'),
          endedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
          latencyMs: numberAttribute('900'),
          usageUnavailableReason: stringAttribute('provider-did-not-report'),
          providerOutcome: stringAttribute(providerOutcome),
          failureCategory: stringAttribute(failureCategory),
          failureCode: stringAttribute(failureCode),
        }),
      },
    },
  }
}

/** Creates one terminal receipt whose attempt did not reach a known provider call. */
function createNoProviderReceipt(sequenceNumber: string): DynamoStreamRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        recordType: stringAttribute('ai-assistance-generation-idempotency'),
        status: stringAttribute('failed'),
        failedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
        failureCategory: stringAttribute('upstream'),
        failureCode: stringAttribute('AiAssistanceAttemptFailed'),
        attempt: mapAttribute({
          task: stringAttribute('search'),
          modelId: stringAttribute('anthropic.claude-model'),
          status: stringAttribute('failed'),
          endedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
          latencyMs: numberAttribute('0'),
          usageUnavailableReason: stringAttribute('provider-did-not-report'),
          failureCategory: stringAttribute('upstream'),
          failureCode: stringAttribute('AiAssistanceAttemptFailed'),
        }),
      },
    },
  }
}

/** Creates one lease-expiry receipt whose provider dispatch cannot be determined. */
function createIndeterminateProviderRecord(sequenceNumber: string): DynamoStreamRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        recordType: stringAttribute('ai-assistance-generation-idempotency'),
        status: stringAttribute('failed'),
        failedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
        failureCategory: stringAttribute('upstream'),
        failureCode: stringAttribute('AiAssistanceAttemptFailed'),
        attempt: mapAttribute({
          task: stringAttribute('search'),
          modelId: stringAttribute('anthropic.claude-model'),
          status: stringAttribute('failed'),
          endedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
          usageUnavailableReason: stringAttribute('attempt-outcome-indeterminate'),
          providerOutcome: stringAttribute('indeterminate'),
          failureCategory: stringAttribute('upstream'),
          failureCode: stringAttribute('AiAssistanceAttemptFailed'),
          customerContent: stringAttribute('must-not-be-projected'),
        }),
      },
    },
  }
}

/** Creates one generation stream record with an optional decision outcome. */
function createGenerationRecord(
  sequenceNumber: string,
  outcome?: string,
): DynamoStreamRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        recordType: stringAttribute('ai-assistance-generation'),
        generation: mapAttribute({
          task: stringAttribute('planning'),
          ...(outcome === undefined
            ? {}
            : {
                decision: mapAttribute({
                  outcome: stringAttribute(outcome),
                  decidedAt: stringAttribute('2026-08-31T01:02:03.000Z'),
                }),
              }),
        }),
      },
    },
  }
}

/** Creates a collecting observability boundary for projection tests. */
function createCollectingObservability(
  providerAttempts: AiAssistanceProviderAttemptObservation[],
  decisions: AiAssistanceDecisionObservation[],
): AiAssistanceObservability {
  return {
    recordGenerationRequest() {},
    recordProviderAttempt(observation) {
      providerAttempts.push(observation)
    },
    recordDecision(observation) {
      decisions.push(observation)
    },
  }
}

test('projects succeeded provider attempts and durable human decisions', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []

  const result = await processAiAssistanceObservabilityBatch({
    Records: [
      createSucceededProviderRecord('provider-success'),
      createGenerationRecord('decision-approved', 'approved'),
    ],
  }, createCollectingObservability(providerAttempts, decisions))

  expect(result).toEqual({ batchItemFailures: [] })
  expect(providerAttempts).toEqual([{
    task: 'summary',
    modelId: 'anthropic.claude-model',
    outcome: 'succeeded',
    latencyMs: 120,
    usage: {
      inputTokens: 42,
      outputTokens: 13,
      latencyMs: 120,
      costUsd: 0.0042,
    },
  }])
  expect(decisions).toEqual([{ task: 'planning', outcome: 'approved' }])
})

test('maps failed provider metadata and documents at-least-once redelivery behavior', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []
  const observability = createCollectingObservability(providerAttempts, decisions)
  const event = { Records: [createFailedProviderRecord('provider-failed', 'throttled')] }

  expect(await processAiAssistanceObservabilityBatch(event, observability)).toEqual({
    batchItemFailures: [],
  })
  expect(await processAiAssistanceObservabilityBatch(event, observability)).toEqual({
    batchItemFailures: [],
  })

  expect(providerAttempts).toEqual([
    {
      task: 'triage',
      modelId: 'anthropic.claude-model',
      outcome: 'throttled',
      latencyMs: 900,
      usageUnavailableReason: 'provider-did-not-report',
      failureCategory: 'rate-limit',
      failureCode: 'AiAssistanceProviderRateLimited',
    },
    {
      task: 'triage',
      modelId: 'anthropic.claude-model',
      outcome: 'throttled',
      latencyMs: 900,
      usageUnavailableReason: 'provider-did-not-report',
      failureCategory: 'rate-limit',
      failureCode: 'AiAssistanceProviderRateLimited',
    },
  ])
})

test('projects a model refusal as a distinct bounded provider outcome', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []

  const result = await processAiAssistanceObservabilityBatch({
    Records: [createFailedProviderRecord(
      'provider-refused',
      'refused',
      'upstream',
      'AiAssistanceModelRefused',
    )],
  }, createCollectingObservability(providerAttempts, decisions))

  expect(result).toEqual({ batchItemFailures: [] })
  expect(providerAttempts).toEqual([{
    task: 'triage',
    modelId: 'anthropic.claude-model',
    outcome: 'refused',
    latencyMs: 900,
    usageUnavailableReason: 'provider-did-not-report',
    failureCategory: 'upstream',
    failureCode: 'AiAssistanceModelRefused',
  }])
  expect(decisions).toEqual([])
})

test('projects indeterminate lease expiry without inventing usage or latency', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []

  const result = await processAiAssistanceObservabilityBatch({
    Records: [createIndeterminateProviderRecord('indeterminate-provider')],
  }, createCollectingObservability(providerAttempts, decisions))

  expect(result).toEqual({ batchItemFailures: [] })
  expect(providerAttempts).toEqual([{
    task: 'search',
    modelId: 'anthropic.claude-model',
    outcome: 'indeterminate',
    usageUnavailableReason: 'attempt-outcome-indeterminate',
    failureCategory: 'upstream',
    failureCode: 'AiAssistanceAttemptFailed',
  }])
  expect(JSON.stringify(providerAttempts)).not.toContain('must-not-be-projected')
  expect(decisions).toEqual([])
})

test('ignores pending, non-AI, undecided, removed, and no-provider records', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []

  const result = await processAiAssistanceObservabilityBatch({
    Records: [
      {
        eventName: 'MODIFY',
        dynamodb: {
          SequenceNumber: 'pending',
          NewImage: {
            recordType: stringAttribute('ai-assistance-generation-idempotency'),
            status: stringAttribute('pending'),
            customerContent: stringAttribute('must-not-be-read'),
          },
        },
      },
      createNoProviderReceipt('no-provider'),
      createGenerationRecord('undecided'),
      {
        eventName: 'MODIFY',
        dynamodb: {
          SequenceNumber: 'non-ai',
          NewImage: {
            recordType: stringAttribute('workspace-search-document'),
            malformed: mapAttribute({ secret: stringAttribute('must-not-be-read') }),
          },
        },
      },
      {
        ...createSucceededProviderRecord('removed'),
        eventName: 'REMOVE',
      },
    ],
  }, createCollectingObservability(providerAttempts, decisions))

  expect(result).toEqual({ batchItemFailures: [] })
  expect(providerAttempts).toEqual([])
  expect(decisions).toEqual([])
})

test('returns isolated failures for malformed matching rows without logging content', async () => {
  const providerAttempts: AiAssistanceProviderAttemptObservation[] = []
  const decisions: AiAssistanceDecisionObservation[] = []
  const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
  const customerContentMarker = 'customer-content-must-not-be-logged'

  try {
    const malformedReceipt = createSucceededProviderRecord(
      'malformed-provider',
      '-1',
    )
    const malformedDecision = createGenerationRecord(
      'malformed-decision',
      'maybe',
    )
    const malformedReceiptImage = malformedReceipt.dynamodb?.NewImage
    const malformedDecisionImage = malformedDecision.dynamodb?.NewImage
    if (!malformedReceiptImage || !malformedDecisionImage) {
      throw new Error('Malformed projection fixtures require NEW_IMAGE values.')
    }
    malformedReceiptImage.customerContent = stringAttribute(customerContentMarker)
    malformedDecisionImage.customerContent = stringAttribute(customerContentMarker)
    const result = await processAiAssistanceObservabilityBatch({
      Records: [
        malformedReceipt,
        createFailedProviderRecord('mismatched-provider-outcome', 'timeout'),
        createGenerationRecord('valid-decision', 'rejected'),
        malformedDecision,
      ],
    }, createCollectingObservability(providerAttempts, decisions))

    expect(result).toEqual({
      batchItemFailures: [
        { itemIdentifier: 'malformed-provider' },
        { itemIdentifier: 'mismatched-provider-outcome' },
        { itemIdentifier: 'malformed-decision' },
      ],
    })
    expect(providerAttempts).toEqual([])
    expect(decisions).toEqual([{ task: 'planning', outcome: 'rejected' }])
    expect(errorLog).toHaveBeenCalledTimes(3)
    expect(errorLog.mock.calls).toEqual(Array.from({ length: 3 }, () => [
      'AI assistance observability projection failed.',
      {
        code: 'AiAssistanceObservabilityProjectionFailed',
        category: 'malformed-record',
      },
    ]))
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(customerContentMarker)
  } finally {
    errorLog.mockRestore()
  }
})

test('isolates observability sink failures and continues later records', async () => {
  const decisions: AiAssistanceDecisionObservation[] = []
  const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
  const observability: AiAssistanceObservability = {
    recordGenerationRequest() {},
    recordProviderAttempt() {
      throw new Error('sink payload must not be logged')
    },
    recordDecision(observation) {
      decisions.push(observation)
    },
  }

  try {
    const result = await processAiAssistanceObservabilityBatch({
      Records: [
        createSucceededProviderRecord('failed-sink'),
        createGenerationRecord('later-decision', 'approved'),
      ],
    }, observability)

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'failed-sink' }],
    })
    expect(decisions).toEqual([{ task: 'planning', outcome: 'approved' }])
    expect(errorLog).toHaveBeenCalledWith(
      'AI assistance observability projection failed.',
      {
        code: 'AiAssistanceObservabilityProjectionFailed',
        category: 'observability-sink',
      },
    )
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('sink payload')
  } finally {
    errorLog.mockRestore()
  }
})

test('rejects a failed record that cannot be identified for partial retry', async () => {
  const record = createSucceededProviderRecord('discarded', '-1')
  if (record.dynamodb) record.dynamodb.SequenceNumber = undefined
  const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    await expect(processAiAssistanceObservabilityBatch(
      { Records: [record] },
      createCollectingObservability([], []),
    )).rejects.toThrow('missing its sequence number')
  } finally {
    errorLog.mockRestore()
  }
})
