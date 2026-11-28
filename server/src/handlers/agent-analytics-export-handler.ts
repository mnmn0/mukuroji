import { createProductionAgentAnalyticsExportHandler } from '../app/composition/agent-analytics-export'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getProductionHandler = createLazySingleton(createProductionAgentAnalyticsExportHandler)

/**
 * Writes the day's run state and Work Item values to the S3 analytics store.
 *
 * @returns Counts of the export.
 */
async function processAgentAnalyticsExport() {
  return await getProductionHandler()()
}

/**
 * Runtime-control guarded daily analytics export. It shares the Agent Run triage surface: both are
 * Software factory jobs over the Agent Runs table, so one switch stops them together.
 */
export const handler = createRuntimeControlGuardedHandler(
  'agent-run-triage',
  processAgentAnalyticsExport,
)
