import {
  processConnectorSyncAuditProjectionBatch,
  processConnectorSyncWorkerBatch,
  scheduleConnectorPollInventory,
  type ConnectorPollCheckpointStore,
  type ConnectorPollInventory,
  type ConnectorPollScheduleEvent,
  type ConnectorSyncDynamoStreamEvent,
  type ConnectorSyncQueue,
  type ConnectorSyncSqsEvent,
  type ConnectorTenantFeatureAvailability,
  type ConnectorSyncWorkerEngine,
  type ConnectorSyncWorkerPlatform,
} from '../../connector-sync-worker'

/** Connector event adapters が必要とする application ports です。 */
export interface ConnectorEventDependencies {
  /** Current connector installation と external link state を読む port です。 */
  platform: ConnectorSyncWorkerPlatform
  /** Provider credential が必要な時だけ sync engine を解決します。 */
  getEngine(): Promise<ConnectorSyncWorkerEngine>
  /** ID-only follow-up work を送る durable queue です。 */
  queue: ConnectorSyncQueue
  /** Provider cursor を queue 外へ保存する checkpoint port です。 */
  checkpoints: ConnectorPollCheckpointStore
  /** Workspace 横断 schedule が読む secret-free inventory です。 */
  inventory: ConnectorPollInventory
  /** Current tenant entitlement used by every provider-work boundary. */
  featureAvailability: ConnectorTenantFeatureAvailability
}

/**
 * 明示的な依存に束縛された connector SQS/stream/schedule handlers を生成します。
 */
export function createConnectorEventHandlers(dependencies: ConnectorEventDependencies) {
  return {
    /** ID-only connector sync SQS batch を処理します。 */
    async queueHandler(event: ConnectorSyncSqsEvent) {
      return await processConnectorSyncWorkerBatch(event, {
        ...dependencies,
        maximumPollPages: 10,
        maximumInventoryPages: 100,
        maximumDisconnectLinks: 25,
      })
    },
    /** AuditEvents stream の Work Item changes を connector jobs へ射影します。 */
    async auditProjectionHandler(event: ConnectorSyncDynamoStreamEvent) {
      return await processConnectorSyncAuditProjectionBatch(
        event,
        {
          featureAvailability: dependencies.featureAvailability,
          queue: dependencies.queue,
        },
      )
    },
    /** Global sparse inventory から bounded polling jobs を enqueue します。 */
    async pollHandler(event: ConnectorPollScheduleEvent = {}) {
      return await scheduleConnectorPollInventory(event, {
        featureAvailability: dependencies.featureAvailability,
        inventory: dependencies.inventory,
        queue: dependencies.queue,
        maximumPages: 100,
      })
    },
  }
}

export type {
  ConnectorPollScheduleEvent,
  ConnectorSyncDynamoStreamEvent,
  ConnectorSyncSqsEvent,
} from '../../connector-sync-worker'
