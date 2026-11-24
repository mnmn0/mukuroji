import { createProductionInboxDigestWorkerHandler } from '../app/composition/inbox-digest-worker'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import { readServerEnvironment } from '../infrastructure/config/server-config'

const getHandler = createLazySingleton(createProductionInboxDigestWorkerHandler)
const getGuardedHandler = createLazySingleton(() => createRuntimeControlGuardedHandler('notification-schedule', async () => getHandler()()))

/** Processes bounded Inbox digests while `INBOX_DIGEST_WORKER_ENABLED` is `true` (ADR 0066). */
export async function handler() {
  if (readServerEnvironment().INBOX_DIGEST_WORKER_ENABLED !== 'true') return { processed: 0, delivered: 0, failed: 0, disabled: true }
  return getGuardedHandler()()
}
