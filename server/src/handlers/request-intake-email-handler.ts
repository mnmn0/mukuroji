import {
  createRequestEmailHandler,
  type SignedRequestEmailEvent,
} from '../modules/request-intake/adapter-in/events/request-intake-email'
import {
  createDefaultRequestIntakeClient,
} from '../modules/request-intake/request-intake'
import { createProductionTenantAvailability } from '../app/composition/tenant-administration'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  createWorkerSecretEnvironmentHydrator,
} from '../app/composition/worker-secret-environment'

const hydrateSecrets = createWorkerSecretEnvironmentHydrator([
  'REQUEST_EMAIL_WEBHOOK_SECRET',
  'REQUEST_TOKEN_HASH_SECRET',
])

const getProductionHandler = createLazySingleton(() =>
  createRequestEmailHandler(createDefaultRequestIntakeClient(
    createProductionTenantAvailability(),
  )))

/**
 * Passes one admitted signed email to the Request Intake application port.
 *
 * @param event - Signed Request Intake email event.
 * @returns The requester reply receipt.
 */
async function processRequestEmail(event: SignedRequestEmailEvent) {
  await hydrateSecrets()
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
