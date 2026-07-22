import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../../../../infrastructure/aws/dynamodb-stream'

/** 一つの AuditEvents stream batch を処理する projection 境界です。 */
export type AuditProjectionBatchProcessor = (
  event: DynamoStreamEvent,
) => Promise<BatchResponse>

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
