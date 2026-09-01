import {
  createNotificationScheduleHandler,
} from '../../modules/notifications'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import {
  DynamoDbCustomerClient,
  type CustomerRetentionClient,
} from '../../modules/customers'
import type {
  NotificationScheduleEvent,
  NotificationScheduleResult,
} from '../../modules/notifications/adapter-in/schedules/notification-schedule'

/** Runs retention independently so a Customer failure cannot suppress notifications. */
export function createRetentionAwareNotificationScheduleHandler(
  retentionClient: Pick<CustomerRetentionClient, 'sweepExpiredRetention'>,
  notificationHandler: (
    event: NotificationScheduleEvent,
  ) => Promise<NotificationScheduleResult>,
): (event?: NotificationScheduleEvent) => Promise<NotificationScheduleResult> {
  return async (event: NotificationScheduleEvent = {}) => {
    let retentionError: unknown
    let retentionFailed = false
    try {
      await retentionClient.sweepExpiredRetention(event.time)
    } catch (error) {
      retentionFailed = true
      retentionError = error
      console.error(
        'Customer retention sweep failed; continuing notification delivery.',
        error instanceof Error ? error.name : 'unknown error',
      )
    }
    const result = await notificationHandler(event)
    if (retentionFailed) throw retentionError
    return result
  }
}

/**
 * Creates the production Notification schedule handler.
 *
 * @returns A handler for due notifications and time-driven Customer retention.
 */
export function createProductionNotificationScheduleHandler() {
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const customerClient = new DynamoDbCustomerClient({ documentClient })
  const notificationHandler = createNotificationScheduleHandler(
    documentClient,
    async ({ workspaceId, teamId, workItemId }) => {
      await customerClient.prepareCompletionNotifications(
        workspaceId,
        teamId,
        workItemId,
        'system:customer-completion-schedule',
      )
    },
  )
  return createRetentionAwareNotificationScheduleHandler(
    customerClient,
    notificationHandler,
  )
}
