import {
  createProductionConnectorEventHandlers,
} from '../app/composition/connector-events'

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

/** ID-only Connector synchronization SQS batch handler. */
export const queueHandler = (...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['queueHandler']
>) => {
  return getConnectorEventHandlers().queueHandler(...args)
}

/** Audit event stream Connector projection handler. */
export const auditProjectionHandler = (...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['auditProjectionHandler']
>) => {
  return getConnectorEventHandlers().auditProjectionHandler(...args)
}

/** Connector global inventory schedule handler. */
export const pollHandler = (...args: Parameters<
  ReturnType<typeof createProductionConnectorEventHandlers>['pollHandler']
>) => {
  return getConnectorEventHandlers().pollHandler(...args)
}

export * from '../modules/developer-platform/adapter-in/events/connector-events'
