/**
 * Compatibility surface for the rate-controller-owned DescribeTable transport.
 *
 * Attempt execution authority and the AWS client live in the rate-budget module
 * so no exported cross-module executor can bypass durable accounting.
 */
export {
  createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
  WorkspaceSearchMigrationDescribeTableSingleAttempt,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
  type WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  type WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
  type WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials,
  type WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
} from './migration-describe-table-rate-budget'
