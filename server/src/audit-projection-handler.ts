import {
  handler as processCollaborationProjection,
  type BatchResponse,
  type DynamoStreamEvent,
} from './collaboration-projection-handler'
import { auditProjectionHandler as processConnectorProjection } from './connector-handler'
import { projectionHandler as processWebhookProjection } from './webhook-handler'

/** 一つの AuditEvents stream batch を処理する projection 境界です。 */
type AuditProjectionBatchProcessor = (
  event: DynamoStreamEvent,
) => Promise<BatchResponse>

const defaultProcessors: readonly AuditProjectionBatchProcessor[] = [
  processCollaborationProjection,
  processWebhookProjection,
  processConnectorProjection,
]

/**
 * 一つの AuditEvents stream consumer から全 downstream projection を実行します。
 *
 * @remarks
 * DynamoDB Streams の同一 shard を読む標準 Lambda consumer を2つ以下に保ちながら、
 * 各 projection の record-level retry checkpoint を一つの応答へ統合します。
 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  return await processAuditProjectionBatch(event, defaultProcessors)
}

/**
 * Projection ごとの partial batch failure を重複なしの一つの応答へ統合します。
 */
export async function processAuditProjectionBatch(
  event: DynamoStreamEvent,
  processors: readonly AuditProjectionBatchProcessor[],
): Promise<BatchResponse> {
  const responses = await Promise.all(
    processors.map(async (processor) => await processor(event)),
  )
  const failedIdentifiers = new Set(
    responses.flatMap(({ batchItemFailures }) =>
      batchItemFailures.map(({ itemIdentifier }) => itemIdentifier)
    ),
  )
  return {
    batchItemFailures: [...failedIdentifiers].map((itemIdentifier) => ({
      itemIdentifier,
    })),
  }
}
