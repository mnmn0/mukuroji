import { DynamoDbDocumentsClient } from '../modules/documents/documents'
import {
  createDefaultEnterpriseScimGroupJobProcessor,
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
  defaultProcessor ??= createDefaultEnterpriseScimGroupJobProcessor(
    new DynamoDbDocumentsClient(),
  )
  return await processEnterpriseScimGroupJobBatch(event, defaultProcessor)
}

export * from '../modules/enterprise-identity/adapter-in/events/scim-group-job-worker'
