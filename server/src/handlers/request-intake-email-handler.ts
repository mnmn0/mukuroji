import {
  createRequestEmailHandler,
  type SignedRequestEmailEvent,
} from '../modules/request-intake/adapter-in/events/request-intake-email'
import {
  createDefaultRequestIntakeClient,
} from '../modules/request-intake/request-intake'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'

const getProductionHandler = createLazySingleton(() =>
  createRequestEmailHandler(createDefaultRequestIntakeClient()))

/**
 * Passes one admitted signed email to the Request Intake application port.
 *
 * @param event - Signed Request Intake email event.
 * @returns The requester reply receipt.
 */
async function processRequestEmail(event: SignedRequestEmailEvent) {
  return await getProductionHandler()(event)
}

/**
 * Runtime-control guarded Request Intake email ingestion entrypoint.
 *
 * @param event - Signed Request Intake email event.
 * @returns The requester reply receipt.
 */
export const handler = createRuntimeControlGuardedHandler(
  'request-intake-email',
  processRequestEmail,
)

export * from '../modules/request-intake/adapter-in/events/request-intake-email'
