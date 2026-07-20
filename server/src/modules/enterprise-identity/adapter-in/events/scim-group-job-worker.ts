import {
  processEnterpriseScimGroupJobBatch,
  type EnterpriseScimGroupJobProcessor,
  type EnterpriseScimGroupJobStreamEvent,
} from './scim-group-job-batch'

/**
 * Enterprise SCIM group job 専用 Lambda handler の契約です。
 */
export type EnterpriseScimGroupJobWorkerHandler = (
  event: EnterpriseScimGroupJobStreamEvent,
) => ReturnType<typeof processEnterpriseScimGroupJobBatch>

/**
 * 専用 processor をDynamoDB Streams partial batch handlerへ接続します。
 */
export function createEnterpriseScimGroupJobWorkerHandler(
  processor: EnterpriseScimGroupJobProcessor,
): EnterpriseScimGroupJobWorkerHandler {
  return async (event) => await processEnterpriseScimGroupJobBatch(event, processor)
}
