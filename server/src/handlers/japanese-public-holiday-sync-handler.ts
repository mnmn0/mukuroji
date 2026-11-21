import { createProductionJapanesePublicHolidaySync } from '../app/composition/japanese-public-holidays'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getProductionSync = createLazySingleton(createProductionJapanesePublicHolidaySync)

/**
 * Fetches the Cabinet Office national holiday list when this month's copy is not stored yet.
 *
 * @returns Whether the stored list was current or replaced.
 */
async function processJapanesePublicHolidaySync() {
  return await getProductionSync()()
}

/** Runtime-control guarded national holiday sync; it shares the automation schedule scope. */
export const handler = createRuntimeControlGuardedHandler(
  'automation-schedule',
  processJapanesePublicHolidaySync,
)
