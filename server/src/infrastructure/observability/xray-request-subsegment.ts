import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import {
  readServerEnvironment,
  type ServerEnvironment,
} from '../config/server-config'
import type { ApiAccessObservation } from './api-observability'

/**
 * Parsed fields of the Lambda-managed `_X_AMZN_TRACE_ID` header.
 */
export interface XrayTraceHeader {
  /** Root trace identifier shared by every segment of the trace. */
  readonly root: string
  /** Identifier of the Lambda function segment that parents new subsegments. */
  readonly parent: string
  /** Whether the runtime sampled this trace for upload. */
  readonly sampled: boolean
}

/**
 * UDP endpoint of the X-Ray daemon that receives segment documents.
 */
export interface XrayDaemonAddress {
  /** Daemon host name or IP address. */
  readonly host: string
  /** Daemon UDP port. */
  readonly port: number
}

/**
 * X-Ray subsegment document emitted for one completed API request.
 */
export interface XrayApiRequestSubsegment {
  /** Random 16-hex-digit subsegment identifier. */
  readonly id: string
  /** Fixed subsegment name used to group API request telemetry. */
  readonly name: string
  /** Trace that contains the subsegment. */
  readonly trace_id: string
  /** Lambda function segment that parents the subsegment. */
  readonly parent_id: string
  /** Segment document kind required for independently sent subsegments. */
  readonly type: 'subsegment'
  /** Request start time in epoch seconds. */
  readonly start_time: number
  /** Request completion time in epoch seconds. */
  readonly end_time: number
  /** Indexed, searchable request identifiers. */
  readonly annotations: Readonly<Record<string, string>>
  /** HTTP method and status recorded without paths, headers, or bodies. */
  readonly http: {
    /** Request metadata. */
    readonly request: {
      /** Low-cardinality HTTP method. */
      readonly method: string
    }
    /** Response metadata. */
    readonly response: {
      /** Final HTTP status. */
      readonly status: number
    }
  }
  /** Whether the request ended with a client error. */
  readonly error: boolean
  /** Whether the request ended with a server error. */
  readonly fault: boolean
  /** Whether the request was throttled. */
  readonly throttle: boolean
}

/**
 * Sends one serialized segment document to the X-Ray daemon.
 *
 * @param document - Segment or subsegment document.
 */
export type XraySegmentSender = (document: XrayApiRequestSubsegment) => void

/**
 * Minimal UDP socket surface used by the daemon sender.
 */
export interface XrayUdpSocket {
  /**
   * Sends one datagram without waiting for delivery.
   *
   * @param message - Datagram payload.
   * @param port - Destination port.
   * @param host - Destination host.
   * @param callback - Completion callback that receives a send error.
   */
  send(
    message: Uint8Array,
    port: number,
    host: string,
    callback: (error: Error | null) => void,
  ): void
  /**
   * Registers a socket error listener.
   *
   * @param event - Socket event name.
   * @param listener - Error listener.
   */
  on(event: 'error', listener: (error: Error) => void): void
  /** Lets the process exit while the socket stays open. */
  unref(): void
}

/** Name shared by every API request subsegment. */
export const XRAY_API_REQUEST_SUBSEGMENT_NAME = 'mukuroji-api-request'

/** Header line that precedes each JSON document sent to the X-Ray daemon. */
const XRAY_DAEMON_DOCUMENT_HEADER = '{"format":"json","version":1}\n'

/** Annotation values accepted for indexing; server identifiers and route groups fit this set. */
const XRAY_ANNOTATION_VALUE_PATTERN = /^[A-Za-z0-9/_.:-]{1,256}$/u

/**
 * Parses the Lambda-managed X-Ray trace header.
 *
 * @param value - `_X_AMZN_TRACE_ID` value supplied by the runtime.
 * @returns The trace root, parent, and sampling decision, or undefined when the header is incomplete.
 */
export function parseXrayTraceHeader(
  value: string | undefined,
): XrayTraceHeader | undefined {
  if (!value) return undefined
  const fields = new Map<string, string>()
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0) {
      fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
    }
  }
  const root = fields.get('Root')
  const parent = fields.get('Parent')
  if (
    !root ||
    !/^1-[0-9a-f]{8}-[0-9a-f]{24}$/u.test(root) ||
    !parent ||
    !/^[0-9a-f]{16}$/u.test(parent)
  ) {
    return undefined
  }
  return { root, parent, sampled: fields.get('Sampled') === '1' }
}

/**
 * Parses the UDP endpoint from `AWS_XRAY_DAEMON_ADDRESS`.
 *
 * Accepts both `host:port` and the `tcp:host:port udp:host:port` form.
 *
 * @param value - Daemon address supplied by the Lambda runtime.
 * @returns The UDP endpoint, or undefined when the value is absent or malformed.
 */
export function parseXrayDaemonAddress(
  value: string | undefined,
): XrayDaemonAddress | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const udpEntry = trimmed
    .split(/\s+/u)
    .find((entry) => entry.startsWith('udp:'))
  const endpoint = udpEntry
    ? udpEntry.slice('udp:'.length)
    : trimmed.includes(' ')
      ? undefined
      : trimmed
  const match = endpoint?.match(/^([A-Za-z0-9.-]+):(\d{1,5})$/u)
  if (!match?.[1] || !match[2]) return undefined
  const port = Number(match[2])
  if (port < 1 || port > 65_535) return undefined
  return { host: match[1], port }
}

/**
 * Builds the X-Ray subsegment that annotates one API request with its identifiers.
 *
 * @param observation - Completed API request observation from the common middleware.
 * @param traceHeader - Parsed trace header for the current invocation.
 * @param createId - Subsegment identifier factory.
 * @returns The subsegment document, or undefined when the trace is not sampled.
 */
export function createXrayApiRequestSubsegment(
  observation: ApiAccessObservation,
  traceHeader: XrayTraceHeader | undefined,
  createId: () => string = createXraySubsegmentId,
): XrayApiRequestSubsegment | undefined {
  if (!traceHeader?.sampled) return undefined
  if (observation.traceId && observation.traceId !== traceHeader.root) {
    return undefined
  }
  const annotations: Record<string, string> = {}
  addAnnotation(annotations, 'correlation_id', observation.correlationId)
  addAnnotation(annotations, 'request_id', observation.requestId)
  addAnnotation(annotations, 'route_group', observation.routeGroup)
  const endTime = observation.observedAtMilliseconds / 1_000
  return {
    id: createId(),
    name: XRAY_API_REQUEST_SUBSEGMENT_NAME,
    trace_id: traceHeader.root,
    parent_id: traceHeader.parent,
    type: 'subsegment',
    start_time: endTime - observation.durationMilliseconds / 1_000,
    end_time: endTime,
    annotations,
    http: {
      request: { method: observation.method },
      response: { status: observation.status },
    },
    error: observation.status >= 400 && observation.status < 500,
    fault: observation.status >= 500,
    throttle: observation.status === 429,
  }
}

/**
 * Creates a fire-and-forget sender that writes segment documents to the X-Ray daemon.
 *
 * Send failures are dropped so that tracing never affects the API response.
 *
 * @param address - Daemon UDP endpoint.
 * @param createUdpSocket - Socket factory used by tests to avoid real network I/O.
 * @returns A sender that lazily opens one unreferenced UDP socket.
 */
export function createXrayDaemonSender(
  address: XrayDaemonAddress,
  createUdpSocket: () => XrayUdpSocket = () => createSocket('udp4'),
): XraySegmentSender {
  let socket: XrayUdpSocket | undefined
  return (document) => {
    try {
      if (!socket) {
        socket = createUdpSocket()
        socket.on('error', () => {})
        socket.unref()
      }
      const message = new TextEncoder().encode(
        `${XRAY_DAEMON_DOCUMENT_HEADER}${JSON.stringify(document)}`,
      )
      socket.send(message, address.port, address.host, () => {})
    } catch {
      // Tracing is best-effort and must not fail the request.
    }
  }
}

/**
 * Creates the API access recorder that annotates sampled X-Ray traces.
 *
 * @param environment - Runtime environment that carries the trace header and daemon address.
 * @param send - Optional sender override used by tests.
 * @returns A recorder for completed API requests, or undefined when no daemon is configured.
 */
export function createXrayApiAccessRecorder(
  environment: ServerEnvironment = readServerEnvironment(),
  send?: XraySegmentSender,
): ((observation: ApiAccessObservation) => void) | undefined {
  const address = parseXrayDaemonAddress(environment.AWS_XRAY_DAEMON_ADDRESS)
  if (!address) return undefined
  const sender = send ?? createXrayDaemonSender(address)
  return (observation) => {
    const document = createXrayApiRequestSubsegment(
      observation,
      parseXrayTraceHeader(environment._X_AMZN_TRACE_ID),
    )
    if (document) sender(document)
  }
}

/**
 * Creates a random X-Ray subsegment identifier.
 *
 * @returns Sixteen lowercase hexadecimal digits.
 */
function createXraySubsegmentId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Adds an annotation when its value is safe to index.
 *
 * @param annotations - Annotation map being built.
 * @param key - Annotation key.
 * @param value - Candidate annotation value.
 */
function addAnnotation(
  annotations: Record<string, string>,
  key: string,
  value: string,
): void {
  if (XRAY_ANNOTATION_VALUE_PATTERN.test(value)) annotations[key] = value
}
