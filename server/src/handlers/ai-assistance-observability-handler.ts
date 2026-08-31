import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'
import {
  createAiAssistanceEmfObservability,
  processAiAssistanceObservabilityBatch,
} from '../modules/ai-assistance'

const observability = createAiAssistanceEmfObservability()

/**
 * Emits content-free AI assistance metrics from Workspace Search stream images.
 *
 * @remarks DynamoDB Streams invokes this handler with at-least-once delivery;
 * partial failures are returned by sequence number for record-level retries.
 * @param event - Workspace Search DynamoDB stream batch.
 * @returns Partial batch failures for retryable records.
 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  return await processAiAssistanceObservabilityBatch(event, observability)
}

export {
  processAiAssistanceObservabilityBatch,
} from '../modules/ai-assistance'
