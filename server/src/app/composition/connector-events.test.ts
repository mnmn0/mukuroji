import { expect, test } from 'bun:test'
import {
  createWorkItemImportWorkerDependencies,
} from '../../api/api-router'
import {
  bindConnectorEventHandlersToAppDependencies,
} from './connector-events'
import { createTestAppDependencies } from './api-dependencies'

test('keeps the application dependency context active for Connector async handlers', async () => {
  const appDependencies = createTestAppDependencies()
  let observedImportDependencies:
    | ReturnType<typeof createWorkItemImportWorkerDependencies>
    | undefined
  const handlers = bindConnectorEventHandlersToAppDependencies(
    appDependencies,
    {
      async queueHandler() {
        await Promise.resolve()
        observedImportDependencies = createWorkItemImportWorkerDependencies()
        return { batchItemFailures: [] }
      },
      async auditProjectionHandler() {
        return { batchItemFailures: [] }
      },
      async pollHandler() {
        return { scheduled: 0 }
      },
    },
  )

  await handlers.queueHandler({ Records: [] })

  expect(observedImportDependencies?.executions).toBe(
    appDependencies.developerPlatform.workItemImportExecutions,
  )
  expect(observedImportDependencies?.sources).toBe(
    appDependencies.developerPlatform.workItemImportSources,
  )
})
