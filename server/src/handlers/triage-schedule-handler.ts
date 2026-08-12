import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  createProductionTriageScheduleHandler,
  type TriageScheduleEvent,
} from '../modules/triage'

const getProductionHandler = createLazySingleton(
  createProductionTriageScheduleHandler,
)

/**
 * Processes due Triage snooze, SLA, and escalation wake-ups after admission.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The bounded Triage schedule processing result.
 */
async function processTriageSchedule(event: TriageScheduleEvent = {}) {
  return await getProductionHandler()(event)
}

/**
 * Runtime-control guarded Triage schedule entrypoint.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The bounded Triage schedule processing result.
 */
export const handler = createRuntimeControlGuardedHandler(
  'triage-schedule',
  processTriageSchedule,
)
