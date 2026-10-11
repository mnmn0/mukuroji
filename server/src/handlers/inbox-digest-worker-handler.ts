import { createProductionInboxDigestWorkerHandler } from '../app/composition/inbox-digest-worker'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'

const getHandler = createLazySingleton(createProductionInboxDigestWorkerHandler)
const getGuardedHandler = createLazySingleton(() => createRuntimeControlGuardedHandler('notification-schedule', async () => getHandler()()))

/** Processes bounded Inbox digests only after explicit operator activation. */
export async function handler() {
  if (process.env.INBOX_DIGEST_WORKER_ENABLED !== 'true') return { processed: 0, delivered: 0, failed: 0, disabled: true }
  return getGuardedHandler()()
}
