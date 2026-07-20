import {
  createEnterpriseScimGroupJobWorkerProcessor,
} from '../app/composition/enterprise-scim-group-job-worker'
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
 * AWS Lambda にデプロイする Enterprise SCIM group job 専用 handler です。
 */
export const handler: EnterpriseScimGroupJobWorkerHandler = async (event) => {
  defaultProcessor ??= createEnterpriseScimGroupJobWorkerProcessor()
  return await processEnterpriseScimGroupJobBatch(event, defaultProcessor)
}

export * from '../modules/enterprise-identity/adapter-in/events/scim-group-job-worker'
