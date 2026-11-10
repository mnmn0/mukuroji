import {
  createRuntimeControlGuardedHandler,
  type RuntimeControlGuardDependencies,
} from '../app/composition/runtime-control'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'
import {
  readServerEnvironment,
  type ServerEnvironment,
} from '../infrastructure/config/server-config'
import type {
  AuditProjectionBatchProcessor,
} from '../modules/audit/adapter-in/events/audit-projection'

/**
 * Returns whether the deployment includes the connector projection.
 *
 * The stack sets `CONNECTOR_SYNC_ENABLED=false` when the optional connectors
 * module, and so its sync queue, is not deployed. Any other value, including an
 * unset variable in local runtimes, keeps the projection.
 *
 * @param environment - Runtime environment that carries the deployment flag.
 * @returns Whether Audit events fan out to the connector projection.
 */
export function isConnectorProjectionEnabled(
  environment: ServerEnvironment = readServerEnvironment(),
): boolean {
  return environment.CONNECTOR_SYNC_ENABLED !== 'false'
}

/**
 * Constructs the Audit projection fan-out after runtime admission.
 *
 * Dynamic imports keep every projection composition, including its transitive
 * AWS clients, behind the outer runtime-control decision.
 *
 * @returns The production Audit projection batch processor.
 */
async function createProductionAuditProjectionHandler(
): Promise<AuditProjectionBatchProcessor> {
  const [
    auditProjection,
    collaborationProjection,
    connectorProjection,
    webhook,
  ] = await Promise.all([
    import('../modules/audit/adapter-in/events/audit-projection'),
    import('./collaboration-projection-handler'),
    isConnectorProjectionEnabled()
      ? import('./connector-handler')
      : Promise.resolve(undefined),
    import('../app/composition/webhook'),
  ])
  const webhookProjectionHandler =
    webhook.createProductionWebhookProjectionHandler()

  return async (event) => await auditProjection.processAuditProjectionBatch(
    event,
    [
      collaborationProjection.handler,
      webhookProjectionHandler,
      ...(connectorProjection ? [connectorProjection.auditProjectionHandler] : []),
    ],
  )
}

/**
 * Creates an outer-guarded Audit projection entrypoint.
 *
 * The projection loader remains behind the runtime decision so a blocked
 * invocation cannot construct or invoke any fan-out dependency.
 *
 * @param getProjectionHandler - Lazy production or test fan-out loader.
 * @param runtimeControl - Optional runtime-control replacements for tests.
 * @returns A runtime-controlled Audit projection batch processor.
 */
export function createAuditProjectionEntrypoint(
  getProjectionHandler: () => Promise<AuditProjectionBatchProcessor>,
  runtimeControl: RuntimeControlGuardDependencies = {},
): AuditProjectionBatchProcessor {
  let projectionHandler: AuditProjectionBatchProcessor | undefined
  let projectionHandlerPromise:
    | Promise<AuditProjectionBatchProcessor>
    | undefined

  /**
   * Single-flights lazy fan-out construction and permits retry after failure.
   *
   * @returns The initialized Audit projection batch processor.
   */
  async function resolveProjectionHandler(
  ): Promise<AuditProjectionBatchProcessor> {
    if (projectionHandler) return projectionHandler
    const pending = projectionHandlerPromise ??= getProjectionHandler()
    try {
      projectionHandler = await pending
      return projectionHandler
    } catch (error) {
      if (projectionHandlerPromise === pending) {
        projectionHandlerPromise = undefined
      }
      throw error
    }
  }

  return createRuntimeControlGuardedHandler(
    'audit-projection',
    async (event: DynamoStreamEvent): Promise<BatchResponse> => {
      const resolvedHandler = await resolveProjectionHandler()
      return await resolvedHandler(event)
    },
    runtimeControl,
  )
}

/**
 * Runtime-control guarded outer AuditEvents projection entrypoint.
 *
 * The inner collaboration, webhook, and connector projections intentionally
 * remain unguarded because this boundary must take one decision before any
 * fan-out dependency is constructed.
 *
 * @param event - DynamoDB stream batch.
 * @returns Merged partial-batch failures from every downstream projection.
 */
export const handler = createAuditProjectionEntrypoint(
  createProductionAuditProjectionHandler,
)

export * from '../modules/audit/adapter-in/events/audit-projection'
