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
 * @returns A handler for due Work Item and Planning health update notifications.
 */
export function createProductionNotificationScheduleHandler() {
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  return createNotificationScheduleHandler(documentClient)
}
