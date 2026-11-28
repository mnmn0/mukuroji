import { createGitHubSyncWorkerHandlers } from '../app/composition/github-integration'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import type { GitHubSyncSqsEvent } from '../modules/github-integration'

let handlers: ReturnType<typeof createGitHubSyncWorkerHandlers> | undefined

/**
 * Lazily creates the GitHub sync worker composition shared by warm invocations.
 *
 * @returns The worker handlers.
 */
function getHandlers(): ReturnType<typeof createGitHubSyncWorkerHandlers> {
  handlers ??= createGitHubSyncWorkerHandlers()
  return handlers
}

/**
 * Runtime-control guarded SQS entrypoint of the GitHub sync queue (ADR 0079). It shares the
 * connector sync runtime-control surface.
 *
 * @param event - SQS batch.
 * @returns The partial batch response.
 */
export const queueHandler = createRuntimeControlGuardedHandler(
  'connector-sync',
  (event: GitHubSyncSqsEvent) => getHandlers().queueHandler(event),
)

/**
 * Runtime-control guarded hourly reconcile entrypoint (ADR 0079). It shares the connector poll
 * runtime-control surface.
 *
 * @returns The reconcile result.
 */
export const reconcileHandler = createRuntimeControlGuardedHandler(
  'connector-poll',
  () => getHandlers().reconcileHandler(),
)
