import { randomUUID } from 'node:crypto'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  DynamoDbChannelDeliveryStore,
  createChannelDeliveryTelemetry,
  createEmailNotificationSender,
  deliverDueEmailNotifications,
  type ChannelDelivery,
  type EmailRecipientLookup,
} from '../../modules/notifications'
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
  let url: URL
  try {
    url = new URL(value?.trim() ?? '')
  } catch {
    throw new Error('NOTIFICATION_EMAIL_APP_ORIGIN must be an absolute URL.')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('NOTIFICATION_EMAIL_APP_ORIGIN must use HTTPS.')
  }
  return url.origin
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
  const send = createEmailNotificationSender({
    sender, appOrigin,
    readRecipient: createCognitoEmailRecipientReader(documentClient, workspaceAccessTableName, userPoolId, new CognitoIdentityProviderClient({ region })),
    async sendEmail(message, signal) {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: { Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
        } },
      }), { abortSignal: signal })
    },
  })
  return () => deliverDueEmailNotifications({
    store, send, telemetry: createChannelDeliveryTelemetry('Email'), createToken: randomUUID, now: () => new Date(), isAuthorized,
  })
}
