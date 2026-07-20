import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { getConfiguredDynamoDbEndpoint } from '../modules/audit/audit'
import {
  createNotificationScheduleHandler,
} from '../modules/notifications/adapter-in/schedules/notification-schedule'

const configuredDynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  ...(configuredDynamoDbEndpoint ? { endpoint: configuredDynamoDbEndpoint } : {}),
})
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})

/** Canonical Work Item の期限通知 schedule を実行します。 */
export const handler = createNotificationScheduleHandler(documentClient)

export * from '../modules/notifications/adapter-in/schedules/notification-schedule'
