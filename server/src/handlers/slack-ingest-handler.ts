import { createProductionSlackIngestHandler } from '../app/composition/slack-ingest'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import type { SlackIngestSqsEvent } from '../modules/slack-ingest'

let productionHandler: ReturnType<typeof createProductionSlackIngestHandler> | undefined

/**
 * Processes one Slack ingest SQS batch.
 *
 * @param event - Slack ingest queue batch.
 * @returns Partial-batch failures to retry.
 */
async function processSlackIngest(event: SlackIngestSqsEvent) {
  productionHandler ??= createProductionSlackIngestHandler()
  return await productionHandler(event)
}

/**
 * Runtime-control guarded Slack ingest SQS entrypoint (#828, ADR 0113).
 *
 * @param event - Slack ingest queue batch.
 * @returns Partial-batch failures to retry.
 */
export const slackIngestHandler = createRuntimeControlGuardedHandler(
  'slack-ingest',
  processSlackIngest,
)
