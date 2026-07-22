import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { getConfiguredDynamoDbEndpoint } from '../../modules/audit/audit'
import {
  createNotificationScheduleHandler,
} from '../../modules/notifications/adapter-in/schedules/notification-schedule'

/**
 * Creates the production Notification schedule handler.
 *
 * @returns A handler for due canonical Work Item notifications.
 */
export function createProductionNotificationScheduleHandler() {
  const configuredDynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
  const dynamoDbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(configuredDynamoDbEndpoint ? { endpoint: configuredDynamoDbEndpoint } : {}),
  })
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
  return createNotificationScheduleHandler(documentClient)
}
