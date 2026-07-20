import { createHash } from 'node:crypto'

/** Connector poll target を分散する global inventory shard 数です。 */
export const CONNECTOR_POLL_TARGET_SHARD_COUNT = 32

/** Connector poll target が扱う provider resource 種別です。 */
export type ConnectorPollProjectionResourceType =
  | 'issue'
  | 'merge-request'
  | 'commit'
  | 'deploy'

/** Installation/resource ごとの materialized poll target row key を返します。 */
export function createConnectorPollTargetRecordKey(
  installationId: string,
  resourceType: ConnectorPollProjectionResourceType,
) {
  return `CONNECTORPOLLTARGET#${installationId}#${resourceType}`
}

/** Poll target identity を分散した GSI partition key を返します。 */
export function createConnectorPollTargetLookupKey(
  workspaceId: string,
  installationId: string,
  resourceType: ConnectorPollProjectionResourceType,
) {
  const identity = `${workspaceId}\0${installationId}\0${resourceType}`
  const shard = createHash('sha256').update(identity).digest()[0]! %
    CONNECTOR_POLL_TARGET_SHARD_COUNT
  return createConnectorPollTargetShardLookupKey(shard)
}

/** 指定 shard の GSI partition key を返します。 */
export function createConnectorPollTargetShardLookupKey(shard: number) {
  if (
    !Number.isSafeInteger(shard) ||
    shard < 0 ||
    shard >= CONNECTOR_POLL_TARGET_SHARD_COUNT
  ) {
    throw new TypeError('Connector poll target shard is invalid.')
  }
  return `CONNECTOR_SYNC_POLL_TARGET#${String(shard).padStart(2, '0')}`
}
