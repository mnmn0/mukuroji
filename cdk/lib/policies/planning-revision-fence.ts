import * as iam from 'aws-cdk-lib/aws-iam'
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb'

/**
 * Grants only the attribute-restricted Planning revision-fence update used by canonical Work Item writes.
 *
 * The update is permitted only inside a DynamoDB transaction and only for the attributes
 * required by the META revision fence; callers cannot use this statement for ordinary writes.
 *
 * @param planningTable - Planning table containing the isolated revision-fence rows.
 * @param target - Lambda or role that increments the canonical Work Item revision fence.
 */
export function grantPlanningRevisionFenceAccess(
  planningTable: dynamodb.ITable,
  target: iam.IGrantable,
): void {
  target.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
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
