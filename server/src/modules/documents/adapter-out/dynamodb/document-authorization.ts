import type {
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'

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
