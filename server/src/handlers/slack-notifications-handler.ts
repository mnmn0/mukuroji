import { createProductionSlackNotificationHandler } from '../app/composition/slack-notifications'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getHandler = createLazySingleton(createProductionSlackNotificationHandler)

/** Sends due Slack notifications under the existing notification runtime control. */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  async () => getHandler()(),
)
