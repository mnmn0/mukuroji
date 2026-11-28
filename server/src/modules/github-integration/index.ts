/** GitHub App integration: webhook receipt, pull request snapshots, and the review inbox (ADR 0079). */
export { GitHubIntegrationError, type GitHubIntegrationErrorCategory } from './domain/github-integration-error'
export {
  createGitHubPullRequestRecordKey,
  createGitHubRepositoryLinkRecordKey,
  GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX,
  GITHUB_REPOSITORY_LINK_ENTRY_TYPE,
  readGitHubNotificationPullRequest,
} from './domain/notification-scope'
export type {
  GitHubAppCredentialSource,
  GitHubAppGateway,
  GitHubIntegrationStore,
  GitHubPullRequestNotificationSink,
  GitHubSyncQueue,
} from './application/ports'
export {
  receiveGitHubWebhook,
  type GitHubWebhookReceipt,
} from './application/pull-request-sync'
export {
  deleteGitHubLogin,
  deleteGitHubLoginHolder,
  deleteGitHubRepositoryLink,
  listGitHubRepositoryLinks,
  readGitHubLogin,
  readGitHubPullRequestInbox,
  saveGitHubLogin,
  saveGitHubRepositoryLink,
} from './application/pull-request-inbox'
export { readGitHubWebhookBody } from './adapter-in/http/webhook-body'
export {
  createGitHubReconcileHandler,
  createGitHubSyncQueueHandler,
  type GitHubSyncSqsEvent,
} from './adapter-in/events/github-sync-worker'
export {
  DynamoDbGitHubIntegrationStore,
  InMemoryGitHubIntegrationStore,
} from './adapter-out/dynamodb/github-integration-store'
export {
  DynamoDbGitHubNotificationSink,
  InMemoryGitHubNotificationSink,
} from './adapter-out/dynamodb/github-notification-sink'
export { GitHubAppHttpGateway } from './adapter-out/github/github-app-gateway'
export { CachedGitHubAppCredentialSource } from './adapter-out/secrets-manager/github-app-credential-source'
export { InMemoryGitHubSyncQueue, SqsGitHubSyncQueue } from './adapter-out/sqs/github-sync-queue'
