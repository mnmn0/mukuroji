/**
 * Read-only Slack channel ingest (#828, ADR 0113): the Events API receiver, the SQS worker,
 * channel mapping administration, and the Work Item message read.
 */
export { SlackIngestError, SlackRateLimitedError, type SlackIngestErrorCategory } from './errors'
export {
  receiveSlackEvent,
  SLACK_EVENT_BODY_MAX_LENGTH,
  type SlackEventRequest,
  type SlackEventResponse,
  type SlackEventReceiverPorts,
} from './application/slack-event-receiver'
export {
  readSlackIngestStatus,
  updateSlackChannelTarget,
  updateSlackIngestSettings,
  type SlackIngestAdminPorts,
} from './application/slack-ingest-admin'
export { listWorkItemSlackMessages, type SlackMessageReadPorts } from './application/slack-message-read'
export { runSlackIngestJob, type SlackIngestWorkerPorts } from './application/slack-ingest-worker'
export type {
  SlackIngestConfig,
  SlackIngestConfigSource,
  SlackIngestJob,
  SlackIngestQueue,
  SlackIngestStore,
} from './application/ports/slack-ingest-ports'
export {
  processSlackIngestBatch,
  type SlackIngestBatchResponse,
  type SlackIngestSqsEvent,
} from './adapter-in/events/slack-ingest-sqs'
export { DynamoDbSlackIngestStore } from './adapter-out/dynamodb/slack-ingest-store'
export { FetchSlackWebApi } from './adapter-out/slack/slack-web-api'
export { SqsSlackIngestQueue } from './adapter-out/sqs/sqs-slack-ingest-queue'
export {
  SecretsManagerSlackIngestConfigSource,
  SLACK_INGEST_SECRET_NAME,
  unconfiguredSlackIngestConfigSource,
} from './adapter-out/secrets-manager/secrets-manager-slack-ingest-config'
