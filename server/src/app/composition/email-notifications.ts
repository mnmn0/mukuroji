import { randomUUID } from 'node:crypto'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  DynamoDbChannelDeliveryStore,
  DynamoDbEmailSuppressionStore,
  EMAIL_RECIPIENT_TAG,
  createChannelDeliveryTelemetry,
  createEmailDigestSender,
  createEmailNotificationSender,
  encodeEmailRecipientTag,
  deliverDueEmailNotifications,
  type ChannelDelivery,
  type EmailMessage,
  type EmailRecipientLookup,
} from '../../modules/notifications'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { createMemberNotificationLocaleReader } from './notification-locale'
import { parseNotificationAppOrigin } from './notification-app-origin'
import { createProductionNotificationDeliveryAuthorizer } from './notification-delivery-authorization'
import { createConfiguredTimesheetReminderRevalidator } from './timesheet-reminders'
import { createConfiguredPlanningMilestoneNotificationRevalidator } from './planning-milestone-notifications'
import { createConfiguredWeeklyReportReminderRevalidator } from './weekly-report-reminders'

/**
 * Validates the deploy-time application origin used for Email deep links.
 * @param value - Configured origin.
 * @returns Normalized origin; HTTPS is required except for a loopback development host.
 */
export function parseEmailAppOrigin(value: string | undefined): string {
  return parseNotificationAppOrigin(value, 'NOTIFICATION_EMAIL_APP_ORIGIN')
}

/**
 * Creates a reader that resolves the recipient's Cognito username from the current Workspace
 * membership and returns only a verified address.
 * @param documentClient - DynamoDB document client.
 * @param workspaceAccessTableName - Workspace membership table.
 * @param userPoolId - Cognito user pool.
 * @param cognito - Cognito client.
 * @returns Recipient reader bound to the caller's deadline; transient failures propagate for retry.
 */
export function createCognitoEmailRecipientReader(
  documentClient: Pick<DynamoDBDocumentClient, 'send'>,
  workspaceAccessTableName: string,
  userPoolId: string,
  cognito: Pick<CognitoIdentityProviderClient, 'send'>,
): (delivery: ChannelDelivery, signal: AbortSignal) => Promise<EmailRecipientLookup> {
  return async (delivery, signal) => {
    const member = (await documentClient.send(new GetCommand({
      TableName: workspaceAccessTableName, ConsistentRead: true,
      Key: { workspaceId: delivery.workspaceId, recordKey: `MEMBER#${delivery.memberKey}` },
    }), { abortSignal: signal })).Item
    if (!member || member.status !== 'active') return { kind: 'missing' }
    const username = [member.username, member.email, delivery.memberKey]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
    if (!username) return { kind: 'missing' }
    let attributes: Array<{ Name?: string, Value?: string }>
    try {
      const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }), { abortSignal: signal })
      if (user.Enabled === false) return { kind: 'missing' }
      attributes = user.UserAttributes ?? []
    } catch (error) {
      if (error instanceof Error && error.name === 'UserNotFoundException') return { kind: 'missing' }
      throw error
    }
    const address = attributes.find((attribute) => attribute.Name === 'email')?.Value
    const verified = attributes.find((attribute) => attribute.Name === 'email_verified')?.Value === 'true'
    return address && verified ? { kind: 'verified', address } : { kind: 'unverified' }
  }
}

/**
 * Creates the scheduled Email sender. Without a configured sender address the job does nothing,
 * so deployments that have not opted in never read the queue or call the provider.
 * @returns A handler with current tenant authorization and verified recipient addresses.
 */
export function createProductionEmailNotificationHandler(): () => Promise<number> {
  const environment = loadServerConfig().environment
  const sender = environment.NOTIFICATION_EMAIL_SENDER?.trim()
  if (!sender) return async () => 0
  const tableName = environment.NOTIFICATIONS_TABLE_NAME?.trim()
  const identityTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const fileTableName = environment.FILE_PROOFING_TABLE_NAME?.trim()
  const workspaceAccessTableName = environment.WORKSPACE_ACCESS_TABLE_NAME?.trim()
  const userPoolId = environment.COGNITO_USER_POOL_ID?.trim()
  if (!tableName || !identityTableName || !fileTableName || !workspaceAccessTableName || !userPoolId) {
    throw new Error('Email notification runtime is not configured.')
  }
  const appOrigin = parseEmailAppOrigin(environment.NOTIFICATION_EMAIL_APP_ORIGIN)
  const region = loadServerConfig().awsRegion
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const store = new DynamoDbChannelDeliveryStore(documentClient, tableName, 'email')
  const isAuthorized = createProductionNotificationDeliveryAuthorizer(documentClient, {
    identityTableName,
    fileTableName,
    timesheetReminders: createConfiguredTimesheetReminderRevalidator(environment.ANALYTICS_TABLE_NAME?.trim()),
    weeklyReportReminders: createConfiguredWeeklyReportReminderRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
    planningMilestones: createConfiguredPlanningMilestoneNotificationRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
  })
  const ses = new SESv2Client({ region })
  // Bounce and complaint events reach the feedback job only through this configuration set.
  const configurationSetName = environment.NOTIFICATION_EMAIL_CONFIGURATION_SET?.trim()
  const suppressions = new DynamoDbEmailSuppressionStore(documentClient, tableName)
  const senderOptions = {
    sender, appOrigin,
    readLocale: createMemberNotificationLocaleReader(new DynamoDbProjectDirectoryClient(undefined, documentClient)),
    readRecipient: createCognitoEmailRecipientReader(documentClient, workspaceAccessTableName, userPoolId, new CognitoIdentityProviderClient({ region })),
    readSuppression: (delivery: ChannelDelivery, signal: AbortSignal) => suppressions.readActive(delivery.recipientKey, signal),
    async sendEmail(message: EmailMessage, signal: AbortSignal) {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: { Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
        } },
        ...(configurationSetName ? {
          ConfigurationSetName: configurationSetName,
          ...emailRecipientTags(message.recipientKey),
        } : {}),
      }), { abortSignal: signal })
    },
  }
  const send = createEmailNotificationSender(senderOptions)
  const sendDigest = createEmailDigestSender(senderOptions)
  return () => deliverDueEmailNotifications({
    store, send, telemetry: createChannelDeliveryTelemetry('Email'), createToken: randomUUID, now: () => new Date(), isAuthorized,
    digest: { listCompanions: (delivery, now, limit) => store.listCompanions(delivery, now, limit), send: sendDigest },
  })
}

/**
 * Builds the SES tag that lets bounce and complaint events find the recipient again.
 * @param recipientKey - Recipient partition of the notification.
 * @returns The tag list, or nothing when the partition does not fit an SES tag value.
 */
function emailRecipientTags(recipientKey: string): { EmailTags?: Array<{ Name: string, Value: string }> } {
  const value = encodeEmailRecipientTag(recipientKey)
  return value ? { EmailTags: [{ Name: EMAIL_RECIPIENT_TAG, Value: value }] } : {}
}
