import { describe, expect, test } from 'bun:test'
import type { DocumentRealtimeTicket } from '../src/documents/api/realtime'
import {
  startDocumentRealtimeSubscription,
  type DocumentRealtimeSocket,
} from '../src/documents/model/realtimeSubscription'

/** Socket event names the subscription listens to. */
type SocketEvent = 'open' | 'close' | 'error' | 'message'

/** Fake socket whose events the test fires by hand. */
class FakeSocket implements DocumentRealtimeSocket {
  /** URL the subscription opened. */
  readonly url: string
  /** Whether the subscription closed this socket. */
  closed = false
  /** Frames the subscription sent. */
  readonly sent: string[] = []
  /** Registered listeners by event name. */
  private readonly listeners = new Map<SocketEvent, Array<(event: { data?: unknown }) => void>>()

  /**
   * Creates a fake socket for one URL.
   *
   * @param url - Ticketed WebSocket URL.
   */
  constructor(url: string) {
    this.url = url
  }

  /**
   * Registers a listener.
   *
   * @param type - Event name.
   * @param listener - Callback.
   */
  addEventListener(type: SocketEvent, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  /**
   * Records a sent frame.
   *
   * @param data - Frame text.
   */
  send(data: string): void {
    this.sent.push(data)
  }

  /** Marks the socket closed. */
  close(): void {
    this.closed = true
  }

  /**
   * Fires an event at the registered listeners.
   *
   * @param type - Event name.
   * @param data - Message payload.
   */
  emit(type: SocketEvent, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

/** One timer scheduled through the fake clock. */
type FakeTimer = {
  /** Time it fires. */
  at: number
  /** Callback. */
  callback: () => void
  /** Whether it was cancelled. */
  cancelled: boolean
}

/** Observations and controls of one subscription under test. */
type Harness = {
  /** Sockets in the order they were created. */
  sockets: FakeSocket[]
  /** Parts reported as changed. */
  changes: string[]
  /** Connected states reported. */
  connected: boolean[]
  /** Number of ticket requests. */
  ticketRequests: () => number
  /** Moves the fake clock forward and runs due timers. */
  advance: (ms: number) => Promise<void>
  /** Stops the subscription. */
  stop: () => void
}

/**
 * Lets pending promise callbacks run.
 *
 * @returns A promise that settles after queued microtasks.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

/**
 * Starts a subscription with fake sockets, timers and tickets.
 *
 * @param tickets - Answers to successive ticket requests; an Error rejects.
 * @returns The harness.
 */
async function startHarness(
  tickets: Array<DocumentRealtimeTicket | undefined | Error>,
): Promise<Harness> {
  let clock = Date.parse('2026-11-21T09:00:00.000Z')
  const timers: FakeTimer[] = []
  const sockets: FakeSocket[] = []
  const changes: string[] = []
  const connected: boolean[] = []
  let requests = 0
  const stop = startDocumentRealtimeSubscription({
    documentId: 'doc-1',
    clientId: 'client-self',
    requestTicket: async () => {
      const answer = tickets[Math.min(requests, tickets.length - 1)]
      requests += 1
      if (answer instanceof Error) throw answer
      return answer
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    onChange: (part) => changes.push(part),
    onConnectedChange: (value) => connected.push(value),
    now: () => clock,
    setTimer: (callback, delayMs) => {
      const timer = { at: clock + delayMs, callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const timer = timers.find((candidate) => candidate === handle)
      if (timer) timer.cancelled = true
    },
  })
  await flush()
  const advance = async (ms: number) => {
    const target = clock + ms
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (!due) break
      due.cancelled = true
      clock = due.at
      due.callback()
      await flush()
    }
    clock = target
  }
  return { sockets, changes, connected, ticketRequests: () => requests, advance, stop }
}

/**
 * Builds a ticket that expires a number of minutes after the fake clock's start.
 *
 * @param name - Ticket value.
 * @param minutes - Lifetime in minutes.
 * @returns The ticket.
 */
function ticket(name: string, minutes = 5): DocumentRealtimeTicket {
  const start = Date.parse('2026-11-21T09:00:00.000Z')
  return {
    ticket: name,
    websocketUrl: 'wss://realtime.example.com/production',
    expiresAt: new Date(start + 60_000).toISOString(),
    sessionExpiresAt: new Date(start + minutes * 60_000).toISOString(),
  }
}

/**
 * Builds a change signal message.
 *
 * @param fields - Signal fields to override.
 * @returns The JSON message text.
 */
function signal(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'document.changed',
    documentId: 'doc-1',
    part: 'document',
    occurredAt: '2026-11-21T09:00:01.000Z',
    ...fields,
  })
}

describe('Document realtime subscription', () => {
  test('reports other editors\' changes and ignores its own and other Documents', async () => {
    const harness = await startHarness([ticket('t1')])
    const socket = harness.sockets[0]
    expect(socket?.url).toBe('wss://realtime.example.com/production?ticket=t1')
    socket?.emit('open')
    expect(harness.connected).toEqual([true])

    socket?.emit('message', signal({ part: 'comments', originClientId: 'client-other' }))
    socket?.emit('message', signal({ originClientId: 'client-self' }))
    socket?.emit('message', signal({ documentId: 'doc-2' }))
    socket?.emit('message', 'not json')
    expect(harness.changes).toEqual(['comments'])
    // The first connection does not re-read: the page just loaded.
    harness.stop()
    expect(socket?.closed).toBeTrue()
  })

  test('opens a replacement before the subscription expires without a gap', async () => {
    const harness = await startHarness([ticket('t1'), ticket('t2', 10)])
    harness.sockets[0]?.emit('open')
    await harness.advance(4 * 60_000 + 30_000)
    expect(harness.ticketRequests()).toBe(2)
    const replacement = harness.sockets[1]
    replacement?.emit('open')
    expect(harness.sockets[0]?.closed).toBeTrue()
    expect(harness.connected).toEqual([true, true])
    expect(harness.changes).toEqual([])
    // The old socket's expiry no longer affects the replacement.
    await harness.advance(30_000)
    expect(harness.connected).toEqual([true, true])
    harness.sockets[0]?.emit('message', signal({ originClientId: 'client-other' }))
    expect(harness.changes).toEqual([])
    harness.stop()
  })

  test('measures the remaining subscription when a slow handshake finishes', async () => {
    const harness = await startHarness([ticket('t1'), ticket('t2', 10)])
    const socket = harness.sockets[0]
    await harness.advance(35_000)
    socket?.emit('open')
    // 300 s were left when the ticket arrived; renewal still starts 30 s before second 300.
    await harness.advance(234_999)
    expect(harness.ticketRequests()).toBe(1)
    await harness.advance(1)
    expect(harness.ticketRequests()).toBe(2)
    // Without a replacement the client stops treating the socket as connected at second 300.
    await harness.advance(30_000)
    expect(harness.connected).toEqual([true, false])
    harness.stop()
  })

  test('drops a socket that opens after its subscription expired', async () => {
    const harness = await startHarness([ticket('t1', 1), ticket('t2', 10)])
    await harness.advance(61_000)
    harness.sockets[0]?.emit('open')
    expect(harness.connected).toEqual([])
    expect(harness.sockets[0]?.closed).toBeTrue()
    await harness.advance(5_000)
    expect(harness.ticketRequests()).toBe(2)
    harness.stop()
  })

  test('re-reads every part after reconnecting from a gap', async () => {
    const harness = await startHarness([ticket('t1'), ticket('t2')])
    harness.sockets[0]?.emit('open')
    harness.sockets[0]?.emit('close')
    expect(harness.connected).toEqual([true, false])
    await harness.advance(5_000)
    harness.sockets[1]?.emit('open')
    expect(harness.connected).toEqual([true, false, true])
    expect(harness.changes).toEqual(['document', 'comments', 'presence'])
    harness.stop()
  })

  test('backs off after failed ticket requests', async () => {
    const failure = new Error('network')
    const harness = await startHarness([failure, failure, ticket('t1')])
    expect(harness.ticketRequests()).toBe(1)
    await harness.advance(4_999)
    expect(harness.ticketRequests()).toBe(1)
    await harness.advance(1)
    expect(harness.ticketRequests()).toBe(2)
    await harness.advance(9_999)
    expect(harness.ticketRequests()).toBe(2)
    await harness.advance(1)
    expect(harness.ticketRequests()).toBe(3)
    expect(harness.sockets).toHaveLength(1)
    harness.stop()
  })

  test('pings the open socket so the server keeps the subscription active', async () => {
    const harness = await startHarness([ticket('t1'), ticket('t2')])
    const socket = harness.sockets[0]
    socket?.emit('open')
    await harness.advance(29_999)
    expect(socket?.sent).toEqual([])
    await harness.advance(1)
    expect(socket?.sent).toEqual([JSON.stringify({ action: 'ping' })])
    await harness.advance(30_000)
    expect(socket?.sent).toHaveLength(2)
    harness.stop()
    await harness.advance(60_000)
    expect(socket?.sent).toHaveLength(2)
  })

  test('stays on polling when the deployment has no WebSocket', async () => {
    const harness = await startHarness([undefined])
    await harness.advance(60 * 60_000)
    expect(harness.ticketRequests()).toBe(1)
    expect(harness.sockets).toHaveLength(0)
    expect(harness.connected).toEqual([])
  })
})
