import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Exact DynamoDB tables measured and protected by the Workspace Search writer fence.
 */
export interface WorkspaceSearchWriterFenceResources {
  /** Work Item collaboration source table. */
  readonly collaborationTable: dynamodb.ITable;
  /** Current Documents source table. */
  readonly documentsTable: dynamodb.ITable;
  /** Durable migration control and writer-fence state table. */
  readonly migrationStateTable: dynamodb.ITable;
  /** Team and Project directory source table. */
  readonly projectDirectoryTable: dynamodb.ITable;
  /** CloudFormation-tokenized rollout mode constrained by the stack parameter. */
  readonly runtimeMode: string;
  /** Canonical Work Items source table. */
  readonly workItemsTable: dynamodb.ITable;
  /** Workspace Search projection target table. */
  readonly workspaceSearchTable: dynamodb.ITable;
}

/**
 * Adds the exact six-table strict writer-client configuration to one Lambda.
 *
 * @param resources - Exact source, target, and migration-state tables.
 * @param target - Lambda whose composition constructs a strict writer client.
 * @returns Nothing.
 */
export function configureWorkspaceSearchWriterFence(
  resources: WorkspaceSearchWriterFenceResources,
  target: lambda.Function,
): void {
  target.addEnvironment(
    'COLLABORATION_TABLE_NAME',
    resources.collaborationTable.tableName,
  );
  target.addEnvironment(
    'DOCUMENTS_TABLE_NAME',
    resources.documentsTable.tableName,
  );
  target.addEnvironment(
    'PROJECT_DIRECTORY_TABLE_NAME',
    resources.projectDirectoryTable.tableName,
  );
  target.addEnvironment(
    'WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME',
    resources.migrationStateTable.tableName,
  );
  target.addEnvironment(
    'WORKSPACE_SEARCH_TABLE_NAME',
    resources.workspaceSearchTable.tableName,
  );
  target.addEnvironment(
    'WORK_ITEMS_TABLE_NAME',
    resources.workItemsTable.tableName,
  );
  target.addEnvironment(
    'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE',
    resources.runtimeMode,
  );
}

/**
 * Grants least-privilege writer-fence state access to one Lambda.
 *
 * @param resources - Exact source, target, and migration-state tables.
 * @param target - Application writer Lambda that must acquire and enforce the fence.
 * @returns Nothing.
 */
export function grantWorkspaceSearchWriterFenceAccess(
  resources: WorkspaceSearchWriterFenceResources,
  target: lambda.Function,
): void {
  const sourceTableArns = [
    resources.projectDirectoryTable.tableArn,
    resources.workItemsTable.tableArn,
    resources.collaborationTable.tableArn,
    resources.documentsTable.tableArn,
    resources.migrationStateTable.tableArn,
    resources.workspaceSearchTable.tableArn,
  ];
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:DescribeTable'],
    resources: sourceTableArns,
  }));
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [resources.migrationStateTable.tableArn],
  }));
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem'],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    resources: [resources.migrationStateTable.tableArn],
  }));
}

/**
 * Grants the collaboration projection Lambda access to mutate Workspace
 * Search projection documents.
 *
 * @param resources - Exact Workspace Search target table.
 * @param target - Collaboration projection Lambda that owns the projection.
 * @returns Nothing.
 */
export function grantWorkspaceSearchProjectionAccess(
  resources: WorkspaceSearchWriterFenceResources,
  target: lambda.Function,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
    resources: [resources.workspaceSearchTable.tableArn],
  }));
}

/**
 * Adds strict writer-fence configuration and least-privilege state access to
 * one Lambda that writes a fenced table.
 *
 * @param resources - Exact source, target, and migration-state tables.
 * @param target - Application writer Lambda that must acquire and enforce the fence.
 * @returns Nothing.
 */
export function bindWorkspaceSearchWriterFence(
  resources: WorkspaceSearchWriterFenceResources,
  target: lambda.Function,
): void {
  configureWorkspaceSearchWriterFence(resources, target);
  grantWorkspaceSearchWriterFenceAccess(resources, target);
}
