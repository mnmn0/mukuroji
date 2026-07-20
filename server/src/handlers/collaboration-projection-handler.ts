import {
  createDefaultDeletedFileCleanupDependencies,
  processCollaborationProjectionBatch,
  type DynamoStreamEvent,
} from '../modules/collaboration/adapter-in/events/collaboration-projection'
import {
  listScopeConnections,
  postRealtimeMessage,
} from '../modules/realtime/adapter-in/events/realtime'

const deletedFileCleanup = createDefaultDeletedFileCleanupDependencies()

const realtime = {
  async publish(scopeKey: string, payload: Readonly<Record<string, unknown>>) {
    const callbackEndpoint = process.env.WEBSOCKET_CALLBACK_ENDPOINT?.trim()
    if (!callbackEndpoint) return
    const connections = await listScopeConnections(scopeKey)
    await Promise.all(connections.map((connection) =>
      postRealtimeMessage(callbackEndpoint, connection.connectionId, payload)
    ))
  },
}

/** AuditEvents stream を notification と realtime invalidation に投影します。 */
export async function handler(event: DynamoStreamEvent) {
  return await processCollaborationProjectionBatch(event, {
    deletedFileCleanup,
    realtime,
  })
}

export * from '../modules/collaboration/adapter-in/events/collaboration-projection'
