import { createHash } from 'node:crypto'

/** Fixed DynamoDB operation owned by the migration rate contract. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_OPERATION =
  'DescribeTable'

/**
 * Derives the stable policy-independent ledger key for one AWS scope.
 *
 * @param account - Exact validated twelve-digit AWS account.
 * @param region - Exact validated AWS region.
 * @returns Lowercase SHA-256 digest without account or region plaintext.
 */
export function createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
  account: string,
  region: string,
): string {
  return createHash('sha256')
    .update(
      `workspace-search-describe-table-rate-scope-v1\0${account}\0${region}`,
      'utf8',
    )
    .digest('hex')
}

/**
 * Derives the fixed transport contract bound to one AWS scope.
 *
 * @param account - Exact validated twelve-digit AWS account.
 * @param region - Exact validated AWS region.
 * @param endpoint - Internally derived official DynamoDB endpoint.
 * @param maximumAttempts - Transport-owned physical SDK attempt limit.
 * @returns Lowercase SHA-256 digest of the fixed transport descriptor.
 */
export function createWorkspaceSearchMigrationDescribeTableTransportBindingDigest(
  account: string,
  region: string,
  endpoint: string,
  maximumAttempts: number,
): string {
  return createHash('sha256')
    .update(
      [
        'workspace-search-describe-table-transport-v1',
        account,
        region,
        endpoint,
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_OPERATION,
        String(maximumAttempts),
      ].join('\0'),
      'utf8',
    )
    .digest('hex')
}

/**
 * Constructs the partition-aware official DynamoDB regional endpoint.
 *
 * @param region - Exact validated AWS region.
 * @returns Official non-dualstack DynamoDB endpoint URL.
 */
export function resolveWorkspaceSearchMigrationOfficialDynamoDbEndpoint(
  region: string,
): string {
  return `https://dynamodb.${region}.${resolveOfficialAwsDnsSuffix(region)}/`
}

/**
 * Resolves the official DNS suffix for supported AWS partitions.
 *
 * @param region - Exact validated AWS region.
 * @returns Official non-dualstack DNS suffix.
 */
function resolveOfficialAwsDnsSuffix(region: string): string {
  if (region.startsWith('cn-')) return 'amazonaws.com.cn'
  if (region.startsWith('eusc-')) return 'amazonaws.eu'
  if (region.startsWith('us-iso-')) return 'c2s.ic.gov'
  if (region.startsWith('us-isob-')) return 'sc2s.sgov.gov'
  if (region.startsWith('eu-isoe-')) return 'cloud.adc-e.uk'
  if (region.startsWith('us-isof-')) return 'csp.hci.ic.gov'
  return 'amazonaws.com'
}
