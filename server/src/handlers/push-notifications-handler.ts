import { createProductionPushNotificationHandler } from '../app/composition/push-notifications'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getHandler = createLazySingleton(createProductionPushNotificationHandler)

/** Sends due Web Push notifications under the existing notification runtime control. */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  async () => getHandler()(),
)
