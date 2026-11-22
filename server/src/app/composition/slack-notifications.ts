import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { createSlackDeliveryTelemetry, createSlackNotificationSender, deliverDueSlackNotifications } from '../../modules/notifications'
import { DynamoDbSlackDeliveryStore } from '../../modules/notifications/adapter-out/dynamodb/slack-delivery-store'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createProductionNotificationDeliveryAuthorizer } from './notification-delivery-authorization'
import { createConfiguredTimesheetReminderRevalidator } from './timesheet-reminders'
import { createConfiguredPlanningMilestoneNotificationRevalidator } from './planning-milestone-notifications'
import { createConfiguredWeeklyReportReminderRevalidator } from './weekly-report-reminders'

/**
 * Creates a scheduled sender for opted-in recipients' durable Inbox notifications.
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
  const isAuthorized = createProductionNotificationDeliveryAuthorizer(documentClient, {
    identityTableName,
    fileTableName,
    timesheetReminders: createConfiguredTimesheetReminderRevalidator(environment.ANALYTICS_TABLE_NAME?.trim()),
    weeklyReportReminders: createConfiguredWeeklyReportReminderRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
    planningMilestones: createConfiguredPlanningMilestoneNotificationRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
  })
  const secrets = createSecretsManagerClient()
  const send = createSlackNotificationSender(async (secretId) => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(5_000),
    })
    return response.SecretString
  })
  return () => {
    return deliverDueSlackNotifications({
      store, send, telemetry: createSlackDeliveryTelemetry(), createToken: randomUUID, now: () => new Date(), isAuthorized,
    })
  }
}
