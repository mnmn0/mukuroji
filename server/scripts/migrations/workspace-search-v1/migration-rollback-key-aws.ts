import type {
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import {
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
} from './migration-rollback-key'

/**
 * Exact validated identity needed by the rollback-start sentinel guard.
 */
export type WorkspaceSearchMigrationRollbackStartSentinelAbsentAwsConditionCheckInput =
  {
    /** Physical migration-state table name used by DynamoDB. */
    readonly stateTableName: string
    /** Immutable physical migration-state table identifier. */
    readonly stateTableId: string
    /** Reviewed measured-configuration digest. */
    readonly configurationHash: string
    /** Operator-selected migration run. */
    readonly runId: string
    /** Digest of the immutable execution admission. */
    readonly executionRunDigest: string
  }

/**
 * Creates the shared absent rollback-start sentinel ConditionCheck.
 *
 * Apply and full verification call this factory with their detached validated
 * bindings. The rollback public adapter validates its external input before
 * delegating here, keeping the exact key and condition expression single-owned.
 *
 * @param input - Exact validated run and migration-state table identity.
 * @returns Deterministic absent rollback-start sentinel ConditionCheck.
 */
export function createWorkspaceSearchMigrationRollbackStartSentinelAbsentAwsConditionCheck(
  input: WorkspaceSearchMigrationRollbackStartSentinelAbsentAwsConditionCheckInput,
): TransactWriteItem {
  const keys =
    createWorkspaceSearchMigrationRollbackConflictRecordKeys({
      stateTableId: input.stateTableId,
      configurationHash: input.configurationHash,
      runId: input.runId,
      executionRunDigest: input.executionRunDigest,
    })
  return {
    ConditionCheck: {
      TableName: input.stateTableName,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: { S: keys.start },
      },
      ConditionExpression:
        'attribute_not_exists(#migrationId) AND ' +
        'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#migrationId': 'migrationId',
        '#recordKey': 'recordKey',
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}
