import {
  createNotificationScheduleHandler,
} from '../../modules/notifications'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'

/**
 * Creates the production Notification schedule handler.
 *
 * @returns A handler for due canonical Work Item notifications.
 */
export function createProductionNotificationScheduleHandler() {
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  return createNotificationScheduleHandler(documentClient)
}
