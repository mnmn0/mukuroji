/** Realtime module public application and domain surface. */
export {
  listScopeConnections,
  postRealtimeMessage,
} from './adapter-in/events/realtime'
export {
  RealtimeTicketError,
  type CreateRealtimeTicketInput,
  type RealtimeTicket,
  type RealtimeTicketsClient,
} from './realtime-ticket'
