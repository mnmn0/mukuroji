import {
  createWorkItemImportWorkerDependencies,
  runWithAppDependencies,
} from '../../api/api-router'
import {
  processWorkItemImportBatch,
  type WorkItemImportSqsEvent,
} from '../../modules/work-items/work-item-import'
import { createProductionAppDependencies } from './api-dependencies'

/**
 * Creates the production Work Item import worker without constructing the HTTP application.
 *
 * @returns A handler bound to its own immutable production dependency graph.
 */
export function createProductionWorkItemImportHandler() {
  const dependencies = createProductionAppDependencies()

  return (event: WorkItemImportSqsEvent) =>
    runWithAppDependencies(
      dependencies,
      () =>
        processWorkItemImportBatch(
          event,
          createWorkItemImportWorkerDependencies(),
        ),
    )
}
