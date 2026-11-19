import { createProductionCycleScheduleHandler } from '../app/composition/cycle-schedule'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import type { CycleScheduleEvent } from '../modules/planning/adapter-in/schedules/cycle-schedule'

const getProductionHandler = createLazySingleton(createProductionCycleScheduleHandler)

/**
 * Creates due next Cycles and carries over unfinished Work Items after admission.
 *
 * @param event - Optional EventBridge schedule time.
 * @returns Counts of the run.
 */
async function processCycleSchedule(event: CycleScheduleEvent = {}) {
  return await getProductionHandler()(event)
}

/** Runtime-control guarded Cycle automation entrypoint; it shares the automation scope. */
export const handler = createRuntimeControlGuardedHandler(
  'automation-schedule',
  processCycleSchedule,
)
