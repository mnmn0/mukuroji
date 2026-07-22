import {
  createProductionWorkItemImportHandler,
} from '../app/composition/work-item-import'

/** Production Work Item import worker, initialized once per Lambda container. */
export const workItemImportHandler = createProductionWorkItemImportHandler()
