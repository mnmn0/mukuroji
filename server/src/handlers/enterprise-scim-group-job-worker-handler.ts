import {
  createEnterpriseScimGroupJobWorkerProcessor,
} from '../app/composition/enterprise-scim-group-job-worker'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type EnterpriseScimGroupJobWorkerHandler,
} from '../modules/enterprise-identity/adapter-in/events/scim-group-job-worker'
import {
  processEnterpriseScimGroupJobBatch,
} from '../modules/enterprise-identity/adapter-in/events/scim-group-job-batch'
import type {
  EnterpriseScimGroupJobProcessor,
} from '../modules/enterprise-identity/application/ports/scim-group-job-processor'

let defaultProcessor: EnterpriseScimGroupJobProcessor | undefined

/**
 * Processes one admitted Enterprise SCIM group job stream batch.
 *
 * @param event - Enterprise Identity DynamoDB stream batch.
 * @returns Partial-batch failures for retryable group jobs.
 */
const processEnterpriseScimGroupJob: EnterpriseScimGroupJobWorkerHandler = async (
  event,
) => {
  defaultProcessor ??= createEnterpriseScimGroupJobWorkerProcessor()
  return await processEnterpriseScimGroupJobBatch(event, defaultProcessor)
}

/**
 * Runtime-control guarded Enterprise SCIM group job entrypoint.
 *
 * @param event - Enterprise Identity DynamoDB stream batch.
 * @returns Partial-batch failures for retryable group jobs.
 */
export const handler = createRuntimeControlGuardedHandler(
  'enterprise-scim-group-job',
  processEnterpriseScimGroupJob,
)

export * from '../modules/enterprise-identity/adapter-in/events/scim-group-job-worker'
