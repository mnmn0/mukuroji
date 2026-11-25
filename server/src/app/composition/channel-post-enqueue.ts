import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { DynamoDbChannelPostStore, type ChannelPostEnqueueDependencies } from '../../modules/notifications'

/**
 * Builds what the collaboration projection needs to queue Team and Project channel posts.
 * @param notificationsTableName - NotificationsTable name, or undefined when notifications are not deployed.
 * @returns Enqueue dependencies, or undefined so the projection skips channel posts.
 */
export function createConfiguredChannelPostEnqueueDependencies(
  notificationsTableName: string | undefined,
): ChannelPostEnqueueDependencies | undefined {
  if (!notificationsTableName) return undefined
  const store = new DynamoDbChannelPostStore(createDynamoDbDocumentClient(createDynamoDbClient()), notificationsTableName)
  return { destinations: store, posts: store, now: () => new Date() }
}
