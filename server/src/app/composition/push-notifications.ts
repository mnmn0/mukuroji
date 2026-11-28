import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  DynamoDbChannelDeliveryStore,
  createChannelDeliveryTelemetry,
  createWebPushNotificationSender,
  deliverDuePushNotifications,
  isPushTransportConfigured,
  readVapidKeys,
  type VapidKeys,
  type WebPushHttpClient,
} from '../../modules/notifications'
import { DynamoDbPushSubscriptionStore } from '../../modules/notifications/adapter-out/dynamodb/push-subscription-store'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { createMemberNotificationLocaleReader } from './notification-locale'
import { parseNotificationAppOrigin } from './notification-app-origin'
import { createProductionNotificationDeliveryAuthorizer } from './notification-delivery-authorization'
import { createConfiguredTimesheetReminderRevalidator } from './timesheet-reminders'
import { createConfiguredPlanningMilestoneNotificationRevalidator } from './planning-milestone-notifications'
import { createConfiguredGitHubPullRequestNotificationRevalidator } from './github-pull-request-notifications'
import { createConfiguredWeeklyReportReminderRevalidator } from './weekly-report-reminders'

/** Default Secrets Manager name of the VAPID private key; the CDK grant covers this name. */
export const DEFAULT_WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID = 'mukuroji/web-push/vapid-private-key'

/**
 * Creates a loader that reads the VAPID private key once per warm Lambda and checks it against
 * the deploy-time public key. A failed read is not cached, so the next delivery tries again.
 * @param publicKey - Deploy-time VAPID public key.
 * @param readSecret - Reads the private key secret string.
 * @returns Cached key pair loader.
 */
export function createVapidKeyLoader(publicKey: string, readSecret: () => Promise<string | undefined>): () => Promise<VapidKeys> {
  let keys: Promise<VapidKeys> | undefined
  return () => {
    keys ??= (async () => {
      const secret = await readSecret()
      if (!secret) throw new Error('VAPID private key secret is empty.')
      return readVapidKeys(publicKey, secret)
    })().catch((error: unknown) => {
      keys = undefined
      throw error
    })
    return keys
  }
}

/**
 * Posts one encrypted message with `fetch`, never following redirects away from the validated endpoint.
 * @param endpoint - Validated push endpoint.
 * @param request - Headers, body, and deadline.
 * @returns Push service status and headers.
 */
const postWebPush: WebPushHttpClient = async (endpoint, request) => {
  const response = await fetch(endpoint, {
    method: 'POST', headers: request.headers, body: new Uint8Array(request.body), signal: request.signal, redirect: 'error',
  })
  // The body is never read; cancel it so the connection is released.
  await response.body?.cancel().catch(() => undefined)
  return response
}

/**
 * Creates the scheduled Web Push sender. Without a VAPID public key the job does nothing, so
 * deployments that have not opted in never read the queue, the secret, or call a push service.
 * @returns A handler with current tenant authorization and owned device registrations.
 */
export function createProductionPushNotificationHandler(): () => Promise<number> {
  const environment = loadServerConfig().environment
  const publicKey = environment.WEB_PUSH_VAPID_PUBLIC_KEY?.trim()
  if (!isPushTransportConfigured(publicKey)) return async () => 0
  const tableName = environment.NOTIFICATIONS_TABLE_NAME?.trim()
  const subscriptionsTableName = environment.PUSH_SUBSCRIPTIONS_TABLE_NAME?.trim()
  const identityTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const fileTableName = environment.FILE_PROOFING_TABLE_NAME?.trim()
  if (!publicKey || !tableName || !subscriptionsTableName || !identityTableName || !fileTableName) {
    throw new Error('Web Push notification runtime is not configured.')
  }
  const appOrigin = parseNotificationAppOrigin(environment.NOTIFICATION_PUSH_APP_ORIGIN, 'NOTIFICATION_PUSH_APP_ORIGIN')
  const secretId = environment.WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID?.trim() || DEFAULT_WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const store = new DynamoDbChannelDeliveryStore(documentClient, tableName, 'push')
  const isAuthorized = createProductionNotificationDeliveryAuthorizer(documentClient, {
    identityTableName,
    fileTableName,
    timesheetReminders: createConfiguredTimesheetReminderRevalidator(environment.ANALYTICS_TABLE_NAME?.trim()),
    weeklyReportReminders: createConfiguredWeeklyReportReminderRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
    planningMilestones: createConfiguredPlanningMilestoneNotificationRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
    githubPullRequests: createConfiguredGitHubPullRequestNotificationRevalidator(environment.PLANNING_TABLE_NAME?.trim(), documentClient),
  })
  const secrets = createSecretsManagerClient()
  const send = createWebPushNotificationSender({
    appOrigin,
    loadKeys: createVapidKeyLoader(publicKey, async () => (await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }), { abortSignal: AbortSignal.timeout(5_000) },
    )).SecretString),
    devices: new DynamoDbPushSubscriptionStore(documentClient, subscriptionsTableName),
    post: postWebPush,
    readLocale: createMemberNotificationLocaleReader(new DynamoDbProjectDirectoryClient(undefined, documentClient)),
  })
  return () => deliverDuePushNotifications({
    store, send, telemetry: createChannelDeliveryTelemetry('Push'), createToken: randomUUID, now: () => new Date(), isAuthorized,
  })
}
