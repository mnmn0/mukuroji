import {
  createNotificationScheduleHandler,
} from '../../modules/notifications'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { DynamoDbCustomerClient } from '../../modules/customers'
import type {
  NotificationScheduleEvent,
} from '../../modules/notifications/adapter-in/schedules/notification-schedule'

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
  return async (event: NotificationScheduleEvent = {}) => {
    await customerClient.sweepExpiredRetention(event.time)
    return await notificationHandler(event)
  }
}
