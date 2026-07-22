import {
  requireConfiguredConnectorSyncEngine,
  runWithAppDependencies,
} from '../../api/api-router'
import { createConnectorEventHandlers } from '../../modules/developer-platform/adapter-in/events/connector-events'
import { DynamoDbDeveloperPlatformClient } from '../../modules/developer-platform/developer-platform'
import {
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from '../../modules/developer-platform/connector-sync-aws'
import { SqsConnectorSyncQueue } from '../../modules/developer-platform/connector-sync-worker'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  createProductionConnectorAppDependencies,
} from './api-dependencies'
import type { AppDependencies } from './app-dependencies'

/** Connector event handlers produced by the domain event adapter. */
type ConnectorEventHandlers = ReturnType<typeof createConnectorEventHandlers>

/**
 * Binds every Connector event handler to one immutable application dependency graph.
 *
 * Connector synchronization engines contain deferred application ports, so the context
 * must remain active for the complete asynchronous handler invocation.
 *
 * @param appDependencies - Production ports used by deferred Connector operations.
 * @param handlers - Unbound Connector queue, projection, and poll handlers.
 * @returns Connector handlers that preserve the dependency context across async work.
 */
export function bindConnectorEventHandlersToAppDependencies(
  appDependencies: AppDependencies,
  handlers: ConnectorEventHandlers,
): ConnectorEventHandlers {
  /**
   * Processes a Connector SQS batch inside the production dependency context.
   *
   * @param args - Connector queue handler arguments.
   * @returns The partial-batch response.
   */
  function queueHandler(...args: Parameters<typeof handlers.queueHandler>) {
    return runWithAppDependencies(
      appDependencies,
      () => handlers.queueHandler(...args),
    )
  }

  /**
   * Projects audit-stream changes inside the production dependency context.
   *
   * @param args - Connector audit projection handler arguments.
   * @returns The partial-batch response.
   */
  function auditProjectionHandler(
    ...args: Parameters<typeof handlers.auditProjectionHandler>
  ) {
    return runWithAppDependencies(
      appDependencies,
      () => handlers.auditProjectionHandler(...args),
    )
  }

  /**
   * Schedules Connector poll jobs inside the production dependency context.
   *
   * @param args - Connector poll handler arguments.
   * @returns The poll scheduling summary.
   */
  function pollHandler(...args: Parameters<typeof handlers.pollHandler>) {
    return runWithAppDependencies(
      appDependencies,
      () => handlers.pollHandler(...args),
    )
  }

  return { queueHandler, auditProjectionHandler, pollHandler }
}

/**
 * Creates production Connector queue, projection, and polling handlers.
 *
 * @returns Connector handlers bound only to their queue and persistence adapters.
 */
export function createProductionConnectorEventHandlers() {
  const config = loadServerConfig()
  const queueUrl = config.environment.CONNECTOR_SYNC_QUEUE_URL?.trim()
  if (!queueUrl) {
    throw new TypeError('Connector sync queue is not configured.')
  }
  const appDependencies = createProductionConnectorAppDependencies()
  const handlers = createConnectorEventHandlers({
    platform: new DynamoDbDeveloperPlatformClient(),
    getEngine: requireConfiguredConnectorSyncEngine,
    queue: new SqsConnectorSyncQueue(createSqsClient(), queueUrl),
    checkpoints: new DynamoDbConnectorPollCheckpointStore(),
    inventory: new DynamoDbConnectorPollInventory(),
  })

  return bindConnectorEventHandlersToAppDependencies(appDependencies, handlers)
}
