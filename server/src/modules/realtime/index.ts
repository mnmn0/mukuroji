/** Realtime module public application and domain surface. */
export {
  createDocumentRealtimeScopeKey,
  REALTIME_DOCUMENT_AUTHORIZATION_TTL_SECONDS,
  RealtimeTicketError,
  type CreateRealtimeDocumentTicketInput,
  type CreateRealtimeTicketInput,
  type RealtimeTicket,
  type RealtimeTicketsClient,
} from './realtime-ticket'
export {
  createRealtimeTicketRouter,
  type IssueRealtimeTicketRequest,
  type RealtimeTicketPrincipal,
  type RealtimeTicketRouterDependencies,
} from './adapter-in/http/realtime-ticket-router'
