import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import {
  DynamoDbChannelPostStore,
  SecretsManagerSlackDestinationSecretStore,
  channelPostShards,
  createSlackChannelPostSender,
  createSlackDeliveryTelemetry,
  createSlackNotificationSender,
  deleteDueRetiredChannelSecrets,
  deliverDueChannelPosts,
  deliverDueSlackNotifications,
  slackChannelDestinationSecretId,
} from '../../modules/notifications'
import { DynamoDbSlackDeliveryStore } from '../../modules/notifications/adapter-out/dynamodb/slack-delivery-store'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { createMemberNotificationLocaleReader } from './notification-locale'
import { parseNotificationAppOrigin } from './notification-app-origin'
import { createProductionNotificationDeliveryAuthorizer } from './notification-delivery-authorization'
import { isCurrentChannelPostSource } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { createProductionTenantAvailability } from './tenant-administration'
import { createConfiguredTimesheetReminderRevalidator } from './timesheet-reminders'
import { createConfiguredPlanningMilestoneNotificationRevalidator } from './planning-milestone-notifications'
import { createConfiguredWeeklyReportReminderRevalidator } from './weekly-report-reminders'

/**
 * Creates a scheduled sender for opted-in recipients' durable Inbox notifications and for the
 * Team and Project channel posts.
 * @returns A handler with current tenant authorization and recipient-scoped credentials.
 */
export function createProductionSlackNotificationHandler() {
  const environment = loadServerConfig().environment
  const tableName = environment.NOTIFICATIONS_TABLE_NAME?.trim()
  const identityTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const fileTableName = environment.FILE_PROOFING_TABLE_NAME?.trim()
  if (!tableName || !identityTableName || !fileTableName) throw new Error('Slack notification runtime is not configured.')
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const store = new DynamoDbSlackDeliveryStore(documentClient, tableName)
  const planningMilestones = createConfiguredPlanningMilestoneNotificationRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient)
  const isAuthorized = createProductionNotificationDeliveryAuthorizer(documentClient, {
    identityTableName,
    fileTableName,
    timesheetReminders: createConfiguredTimesheetReminderRevalidator(environment.ANALYTICS_TABLE_NAME?.trim()),
    weeklyReportReminders: createConfiguredWeeklyReportReminderRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
    planningMilestones,
  })
  const tenant = createProductionTenantAvailability()
  // Without an origin (local runs), messages keep their text and omit links.
  const appOrigin = environment.NOTIFICATION_SLACK_APP_ORIGIN?.trim()
    ? parseNotificationAppOrigin(environment.NOTIFICATION_SLACK_APP_ORIGIN, 'NOTIFICATION_SLACK_APP_ORIGIN')
    : undefined
  const secrets = createSecretsManagerClient()
  const send = createSlackNotificationSender(async (secretId) => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(5_000),
    })
    return response.SecretString
  }, fetch, appOrigin, createMemberNotificationLocaleReader(new DynamoDbProjectDirectoryClient(undefined, documentClient)))
  const channelPostStore = new DynamoDbChannelPostStore(documentClient, tableName)
  const channelSecrets = new SecretsManagerSlackDestinationSecretStore(secrets)
  const sendChannelPost = createSlackChannelPostSender(channelSecrets, fetch, appOrigin)
  return async () => {
    // Personal and channel queues run independently, so a failure in one never holds the other back.
    const [personal, channel, retiredSecrets] = await Promise.allSettled([
      deliverDueSlackNotifications({
        store, send, telemetry: createSlackDeliveryTelemetry(), createToken: randomUUID, now: () => new Date(), isAuthorized,
      }),
      deliverDueChannelPosts({
        destinations: channelPostStore,
        posts: channelPostStore,
        send: sendChannelPost,
        // The Workspace must still be active, and the source must still sit where it was queued.
        isAuthorized: async (post) => await tenant.isActive(post.workspaceId) &&
          await isCurrentChannelPostSource({ workspaceId: post.workspaceId, eventType: post.eventType, ...post.source }, planningMilestones),
        shards: channelPostShards(),
        reportFailure: (failure) => console.log(JSON.stringify({ event: 'SlackChannelPostFailed', ...failure })),
        createToken: randomUUID,
        now: () => new Date(),
      }),
      // Webhooks of removed or replaced channel destinations whose deletion failed (ADR 0121).
      deleteDueRetiredChannelSecrets({
        store: channelPostStore,
        secrets: channelSecrets,
        secretIdOf: slackChannelDestinationSecretId,
        now: () => new Date(),
      }),
    ])
    if (personal.status === 'rejected') throw personal.reason
    if (channel.status === 'rejected') throw channel.reason
    if (retiredSecrets.status === 'rejected') throw retiredSecrets.reason
    return personal.value + channel.value
  }
}
