import type {
  DocumentChangePart,
  DocumentRealtimeTicket,
} from '../api/realtime'
import { parseDocumentChangeSignal } from '../api/realtime'

/** Subscription length assumed when the ticket does not state one. */
const defaultSessionLifetimeMs = 4 * 60_000
/** How long before the subscription expires a replacement socket is opened. */
const renewalLeadMs = 30_000
/** Shortest wait before reconnecting after a failure. */
const minimumRetryDelayMs = 5_000
/** Longest wait before reconnecting after repeated failures. */
const maximumRetryDelayMs = 5 * 60_000
/**
 * Interval of socket pings. A receive-only socket must still refresh its server-side
 * activity, or a Workspace idle timeout as short as one minute drops the subscription.
 */
export const documentRealtimePingIntervalMs = 30_000

/** Minimal WebSocket surface the subscription uses, so tests can supply a fake. */
export type DocumentRealtimeSocket = {
  /** Registers a socket event listener. */
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { data?: unknown }) => void,
  ): void
  /** Sends a text frame. */
  send(data: string): void
  /** Closes the socket. */
  close(): void
}

/** Dependencies and callbacks of one Document change-signal subscription. */
export type DocumentRealtimeSubscriptionOptions = {
  /** Open Document. */
  documentId: string
  /** This editor's client ID, so its own changes are not read again. */
  clientId: string
  /** Requests a ticket; resolves to undefined when the deployment has no WebSocket. */
  requestTicket: () => Promise<DocumentRealtimeTicket | undefined>
  /** Opens a socket for a ticketed URL. */
  createSocket: (url: string) => DocumentRealtimeSocket
  /** Called for each change made by someone else. */
  onChange: (part: DocumentChangePart) => void
  /** Called when a subscription opens or is lost. */
  onConnectedChange: (connected: boolean) => void
  /** Current time in epoch milliseconds. */
  now?: () => number
  /** Schedules a callback. */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  /** Cancels a scheduled callback. */
  clearTimer?: (handle: unknown) => void
}

/**
 * Keeps a Document change-signal subscription open until it is stopped.
 *
 * The socket is replaced before the server-side subscription expires, and a lost socket is
 * retried with backoff. After a gap with no open socket every part is read again, because
 * signals sent while disconnected are lost.
 *
 * @param options - Ticket and socket factories plus callbacks.
 * @returns A function that stops the subscription.
 */
export function startDocumentRealtimeSubscription(
  options: DocumentRealtimeSubscriptionOptions,
): () => void {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle) => {
    if (typeof handle === 'number' || handle === undefined) clearTimeout(handle)
  })
  let stopped = false
  let active: DocumentRealtimeSocket | null = null
  let renewal: unknown
  let failures = 0
  let hasConnected = false

  const schedule = (delayMs: number) => {
    clearTimer(renewal)
    renewal = setTimer(() => {
      void open()
    }, delayMs)
  }
  const retryAfterFailure = () => {
    failures += 1
    schedule(Math.min(maximumRetryDelayMs, minimumRetryDelayMs * 2 ** (failures - 1)))
  }
  const loseActive = (socket: DocumentRealtimeSocket) => {
    if (stopped || active !== socket) return
    active = null
    options.onConnectedChange(false)
    socket.close()
    retryAfterFailure()
  }
  const open = async () => {
    let ticket: DocumentRealtimeTicket | undefined
    try {
      ticket = await options.requestTicket()
    } catch {
      if (!stopped) retryAfterFailure()
      return
    }
    // No WebSocket in this deployment: the page stays on polling.
    if (stopped || !ticket) return

    const url = new URL(ticket.websocketUrl)
    url.searchParams.set('ticket', ticket.ticket)
    const socket = options.createSocket(url.toString())
    const sessionExpiresAt = ticket.sessionExpiresAt
      ? Date.parse(ticket.sessionExpiresAt)
      : Number.NaN
    const lifetimeMs = Number.isFinite(sessionExpiresAt)
      ? sessionExpiresAt - now()
      : defaultSessionLifetimeMs
    let opened = false

    socket.addEventListener('open', () => {
      if (stopped) {
        socket.close()
        return
      }
      opened = true
      const previous = active
      active = socket
      failures = 0
      options.onConnectedChange(true)
      previous?.close()
      if (hasConnected && !previous) {
        options.onChange('document')
        options.onChange('comments')
        options.onChange('presence')
      }
      hasConnected = true
      schedule(Math.max(minimumRetryDelayMs, lifetimeMs - renewalLeadMs))
      const ping = () => {
        if (stopped || active !== socket) return
        try {
          socket.send(JSON.stringify({ action: 'ping' }))
        } catch {
          loseActive(socket)
          return
        }
        setTimer(ping, documentRealtimePingIntervalMs)
      }
      setTimer(ping, documentRealtimePingIntervalMs)
      // The server stops signalling an expired subscription even if the socket stays open.
      setTimer(() => loseActive(socket), Math.max(minimumRetryDelayMs, lifetimeMs))
    })
    socket.addEventListener('message', (event) => {
      if (active !== socket) return
      const signal = parseDocumentChangeSignal(event.data)
      if (
        !signal ||
        signal.documentId !== options.documentId ||
        signal.originClientId === options.clientId
      ) {
        return
      }
      options.onChange(signal.part)
    })
    socket.addEventListener('close', () => {
      if (active === socket) {
        loseActive(socket)
        return
      }
      // A replacement that never opened: retry while the current socket keeps working.
      if (!opened && !stopped) retryAfterFailure()
    })
  }

  void open()

  return () => {
    stopped = true
    clearTimer(renewal)
    active?.close()
    active = null
  }
}
