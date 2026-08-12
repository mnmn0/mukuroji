import {
  createProductionConnectorEventHandlers,
} from '../app/composition/connector-events'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'

let connectorEventHandlers:
  | ReturnType<typeof createProductionConnectorEventHandlers>
  | undefined

/**
 * Lazily creates the Connector handler composition shared by warm invocations.
 *
 * @returns Production Connector event handlers.
 */
function getConnectorEventHandlers() {
  if (connectorEventHandlers) return connectorEventHandlers
  connectorEventHandlers = createProductionConnectorEventHandlers()
  return connectorEventHandlers
}

/**
 * Delegates one admitted ID-only Connector synchronization SQS batch.
 *
 * @param args - Connector queue handler arguments.
 * @returns The Connector queue partial-batch response.
 */
function processConnectorQueue(...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['queueHandler']
>) {
  return getConnectorEventHandlers().queueHandler(...args)
}

/**
 * Runtime-control guarded Connector synchronization SQS entrypoint.
 *
 * @param args - Connector queue handler arguments.
 * @returns The Connector queue partial-batch response.
 */
export const queueHandler = createRuntimeControlGuardedHandler(
  'connector-sync',
  processConnectorQueue,
)

/**
 * Audit event stream Connector projection handler.
 *
 * @param args - Connector projection handler arguments.
 * @returns The Connector projection partial-batch response.
 */
export const auditProjectionHandler = (...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['auditProjectionHandler']
>) => {
  return getConnectorEventHandlers().auditProjectionHandler(...args)
}

/**
 * Delegates one admitted Connector global inventory schedule invocation.
 *
 * @param args - Connector poll handler arguments.
 * @returns The Connector poll scheduling result.
 */
function processConnectorPoll(...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['pollHandler']
>) {
  return getConnectorEventHandlers().pollHandler(...args)
}

/**
 * Runtime-control guarded Connector inventory polling entrypoint.
 *
 * @param args - Connector poll handler arguments.
 * @returns The Connector poll scheduling result.
 */
export const pollHandler = createRuntimeControlGuardedHandler(
  'connector-poll',
  processConnectorPoll,
)

export * from '../modules/developer-platform/adapter-in/events/connector-events'
