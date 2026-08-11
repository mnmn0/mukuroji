import * as iam from 'aws-cdk-lib/aws-iam'
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import type * as lambda from 'aws-cdk-lib/aws-lambda'

/**
 * Grants only the attribute-restricted Planning META update used by canonical Work Item writes.
 *
 * The update is permitted only inside a DynamoDB transaction and only for the attributes
 * required by the META revision fence; callers cannot use this statement for ordinary writes.
 *
 * @param planningTable - Planning table containing the workspace META rows.
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
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    },
  }))
}
