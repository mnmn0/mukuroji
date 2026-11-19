import { createProductionEmailNotificationHandler } from '../app/composition/email-notifications'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getHandler = createLazySingleton(createProductionEmailNotificationHandler)

/** Sends due Email notifications under the existing notification runtime control. */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  async () => getHandler()(),
)
