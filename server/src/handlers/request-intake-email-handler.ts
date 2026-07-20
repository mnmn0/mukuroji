import {
  createRequestEmailHandler,
} from '../modules/request-intake/adapter-in/events/request-intake-email'
import {
  createDefaultRequestIntakeClient,
} from '../modules/request-intake/request-intake'

/** Signed inbound email を Request Intake application port へ渡します。 */
export const handler = createRequestEmailHandler(
  createDefaultRequestIntakeClient(),
)

export * from '../modules/request-intake/adapter-in/events/request-intake-email'
