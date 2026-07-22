import {
  createProductionWorkItemImportHandler,
} from '../app/composition/work-item-import'

/**
 * Processes one Work Item import SQS batch with the container-scoped worker.
 *
 * @param event - Work Item import SQS batch.
 * @returns The partial-batch response containing retryable record identifiers.
 */
export const workItemImportHandler = createProductionWorkItemImportHandler()
