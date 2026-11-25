import { createProductionEmailFeedbackHandler } from '../app/composition/email-feedback'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getHandler = createLazySingleton(createProductionEmailFeedbackHandler)

/** Records SES bounces and complaints under the existing notification runtime control. */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  async () => getHandler()(),
)
