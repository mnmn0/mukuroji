import type {
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type {
  DocumentAuthorizationRevisionMutationPort,
  PrepareDocumentAuthorizationRevisionMutationRequest,
} from '../../application/ports/document-ports'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'

/** DynamoDB transaction item owned by the Documents adapter. */
type DocumentAuthorizationRevisionTransactWrite = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/** Fixed sort key for each Workspace document-ACL generation row. */
export const DOCUMENT_AUTHORIZATION_REVISION_KEY =
  'DOCUMENT_AUTHORIZATION_REVISION' as const

/** Document ACL validation と mutation を直列化する generation snapshot です。 */
export type DocumentAuthorizationRevisionGuard = {
  /** Validation 前に読み込んだ generation です。 */
  expectedRevision: number
  /** Guarded mutation の timestamp です。 */
  updatedAt: string
}

/**
 * Document ACL generation を compare-and-swap で一つ進める transaction action を返します。
 */
export function createDocumentAuthorizationRevisionPut(
  tableName: string,
  workspaceId: string,
  guard: DocumentAuthorizationRevisionGuard,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number] {
  return {
    Put: {
      TableName: tableName,
      Item: {
        workspaceId,
        recordKey:
          DOCUMENT_AUTHORIZATION_REVISION_KEY,
        entryType:
          'document-authorization-revision',
        revision: guard.expectedRevision + 1,
        updatedAt: guard.updatedAt,
      },
      ConditionExpression:
        guard.expectedRevision === 0
          ? 'attribute_not_exists(workspaceId)'
          : 'revision = :expectedDocumentAuthorizationRevision',
      ...(guard.expectedRevision === 0
        ? {}
        : {
            ExpressionAttributeValues: {
              ':expectedDocumentAuthorizationRevision':
                guard.expectedRevision,
            },
          }),
    },
  }
}

/**
 * Prepares DocumentsTable authorization-revision mutations for a shared transaction.
 */
export class DynamoDbDocumentAuthorizationRevisionMutationAdapter implements
  DocumentAuthorizationRevisionMutationPort<
    DocumentAuthorizationRevisionTransactWrite
  > {
  /** Physical DocumentsTable name owned by this adapter. */
  private readonly tableName: string

  /**
   * Creates a DynamoDB mutation adapter for the configured DocumentsTable.
   *
   * @param tableName - Optional explicit DocumentsTable name.
   */
  constructor(tableName?: string) {
    this.tableName =
      tableName ?? configuredDocumentsTableName()
  }

  /**
   * Prepares the conditional DocumentsTable revision Put.
   *
   * @param input - Semantic revision mutation request.
   * @returns DynamoDB transaction contribution.
   */
  prepareAuthorizationRevisionMutation(
    input: PrepareDocumentAuthorizationRevisionMutationRequest,
  ): DocumentAuthorizationRevisionTransactWrite {
    return createDocumentAuthorizationRevisionPut(
      this.tableName,
      input.workspaceId,
      {
        expectedRevision: input.expectedRevision,
        updatedAt: input.updatedAt,
      },
    )
  }
}

/**
 * Resolves the DocumentsTable name owned by the DynamoDB adapter.
 *
 * @returns Configured or local-default DocumentsTable name.
 */
function configuredDocumentsTableName(): string {
  const environment = loadServerConfig().environment
  return environment.DOCUMENTS_TABLE_NAME ??
    environment.MUKUROJI_DOCUMENTS_TABLE ??
    'mukuroji-documents-local'
}
