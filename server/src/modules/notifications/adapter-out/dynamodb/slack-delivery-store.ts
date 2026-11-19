import { DynamoDbChannelDeliveryStore } from './channel-delivery-store'

/** DynamoDB-backed Slack due queue with per-notification delivery leases. */
export class DynamoDbSlackDeliveryStore extends DynamoDbChannelDeliveryStore {
  /**
   * Creates the Slack queue adapter for the existing Notifications table.
   * @param client - Document client configured by the composition root.
   * @param tableName - Notifications table name.
   */
  constructor(client: ConstructorParameters<typeof DynamoDbChannelDeliveryStore>[0], tableName: string) {
    super(client, tableName, 'slack')
  }
}
