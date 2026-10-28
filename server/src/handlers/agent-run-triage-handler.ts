import { createProductionAgentRunTriageHandler } from '../app/composition/agent-run-triage'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'

const getProductionHandler = createLazySingleton(
  createProductionAgentRunTriageHandler,
)

/**
 * Files failed and stalled Agent Runs of opted-in Teams to Triage.
 *
 * @returns Counts of the bounded sweep.
 */
async function processAgentRunTriage() {
  return await getProductionHandler()()
}

/**
 * Runtime-control guarded Agent Run triage entrypoint.
 *
 * @returns Counts of the bounded sweep.
 */
export const handler = createRuntimeControlGuardedHandler(
  'agent-run-triage',
  processAgentRunTriage,
)
