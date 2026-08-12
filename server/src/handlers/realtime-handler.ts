import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  handler as processRealtimeEvent,
} from '../modules/realtime/adapter-in/events/realtime'

/**
 * Runtime-control guarded API Gateway WebSocket entrypoint.
 *
 * @param event - API Gateway WebSocket event.
 * @returns The WebSocket integration response.
 */
export const handler = createRuntimeControlGuardedHandler(
  'realtime',
  processRealtimeEvent,
)

export * from '../modules/realtime/adapter-in/events/realtime'
