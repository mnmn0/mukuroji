import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'
import { createAiAssistanceEmfObservability } from '../modules/ai-assistance'
import {
  processAiAssistanceObservabilityBatch,
} from '../modules/ai-assistance/adapter-in/events/ai-assistance-observability-projection'

const applicationCommitSha = process.env.MUKUROJI_APPLICATION_COMMIT_SHA
const observability = createAiAssistanceEmfObservability(
  applicationCommitSha === undefined ? {} : { applicationCommitSha },
)

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
