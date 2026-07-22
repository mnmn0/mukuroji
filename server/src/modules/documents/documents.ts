import type {
  DocumentApplicationClient,
} from './application/ports/document-ports'
import type {
  DocumentWorkItemDeletionFenceTransactWrite,
} from './adapter-out/dynamodb/dynamo-db-documents-client'
import type {
  PrepareDocumentWorkItemDeletionFenceRequest,
} from './document-types'

/**
 * Backward-compatible Documents client surface used by the current composition root.
 *
 * New consumers should depend on the focused port that matches their capability.
 */
export interface DocumentClient extends DocumentApplicationClient {
  /**
   * Builds the DynamoDB transaction contribution that fences Work Item deletion.
   *
   * @param request - Canonical Work Item deletion-fence request.
   * @returns Adapter-specific transaction contribution.
   */
  prepareWorkItemDeletionFenceTransactWrite(
    request: PrepareDocumentWorkItemDeletionFenceRequest,
  ): Promise<DocumentWorkItemDeletionFenceTransactWrite>
}

export * from './application/ports/document-ports'
export {
  DynamoDbDocumentsClient,
} from './adapter-out/dynamodb/dynamo-db-documents-client'
export * from './document-types'
export * from './domain/document-content'
export * from './domain/document-limits'
export * from './errors'
