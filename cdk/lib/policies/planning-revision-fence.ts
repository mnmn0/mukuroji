import * as iam from 'aws-cdk-lib/aws-iam'
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import type * as lambda from 'aws-cdk-lib/aws-lambda'

/**
 * Grants only the attribute-restricted Planning revision-fence update used by canonical Work Item writes.
 *
 * The update is permitted only inside a DynamoDB transaction and only for the attributes
 * required by the META revision fence; callers cannot use this statement for ordinary writes.
 *
 * @param planningTable - Planning table containing the isolated revision-fence rows.
 * @param target - Lambda that increments the canonical Work Item revision fence.
 */
export function grantPlanningRevisionFenceAccess(
  planningTable: dynamodb.ITable,
  target: lambda.Function,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [planningTable.tableArn],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': [
          'workspaceId',
          'recordKey',
          'entryType',
          'schemaVersion',
          'revision',
          'updatedAt',
        ],
      },
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['FENCE#*'],
      },
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    },
  }))
}

/**
 * Grants the bounded transaction permissions required to copy a legacy META row into its fence.
 *
 * The condition check is read-only and may inspect the legacy partition only inside the
 * migration transaction.  The legacy DeleteItem and accompanying PutItem are transaction-only;
 * PutItem is limited to fence partitions and the exact metadata attributes, so migration cannot
 * create or overwrite ordinary Planning rows.
 *
 * @param planningTable - Planning table containing legacy and isolated META rows.
 * @param target - Lambda that may lazily initialize the revision fence.
 */
export function grantPlanningRevisionFenceMigrationAccess(
  planningTable: dynamodb.ITable,
  target: lambda.Function,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem'],
    resources: [planningTable.tableArn],
    conditions: {
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    },
  }))
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [planningTable.tableArn],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': [
          'workspaceId',
          'recordKey',
          'entryType',
          'schemaVersion',
          'revision',
          'updatedAt',
        ],
      },
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['FENCE#*'],
      },
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    },
  }))
}
