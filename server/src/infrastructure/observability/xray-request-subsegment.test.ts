import { describe, expect, test } from 'bun:test'
import type { ApiAccessObservation } from './api-observability'
import {
  createXrayApiAccessRecorder,
  createXrayApiRequestSubsegment,
  createXrayDaemonSender,
  parseXrayDaemonAddress,
  parseXrayTraceHeader,
  XRAY_API_REQUEST_SUBSEGMENT_NAME,
  type XrayApiRequestSubsegment,
  type XrayUdpSocket,
} from './xray-request-subsegment'

const root = '1-6705a1b2-0123456789abcdef01234567'
const parent = '53995c3f42cd8ad8'
const sampledHeader = `Root=${root};Parent=${parent};Sampled=1;Lineage=a:1`

const observation: ApiAccessObservation = {
  correlationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  durationMilliseconds: 250,
  method: 'POST',
  observedAtMilliseconds: 1_728_000_000_250,
  requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  routeGroup: '/api/teams',
  sliEligible: true,
  status: 201,
  traceId: root,
}

describe('parseXrayTraceHeader', () => {
  test('reads root, parent, and sampling decision', () => {
    expect(parseXrayTraceHeader(sampledHeader)).toEqual({ root, parent, sampled: true })
    expect(parseXrayTraceHeader(`Root=${root};Parent=${parent};Sampled=0`)?.sampled).toBe(false)
  })

  test('rejects missing or malformed fields', () => {
    expect(parseXrayTraceHeader(undefined)).toBeUndefined()
    expect(parseXrayTraceHeader(`Root=${root};Sampled=1`)).toBeUndefined()
    expect(parseXrayTraceHeader(`Root=bad;Parent=${parent};Sampled=1`)).toBeUndefined()
    expect(parseXrayTraceHeader(`Root=${root};Parent=XYZ;Sampled=1`)).toBeUndefined()
  })
})

describe('parseXrayDaemonAddress', () => {
  test('accepts host:port and the tcp/udp pair form', () => {
    expect(parseXrayDaemonAddress('169.254.79.129:2000')).toEqual({ host: '169.254.79.129', port: 2000 })
    expect(parseXrayDaemonAddress('tcp:127.0.0.1:2000 udp:127.0.0.2:2001')).toEqual({ host: '127.0.0.2', port: 2001 })
  })

  test('rejects absent or malformed addresses', () => {
    expect(parseXrayDaemonAddress(undefined)).toBeUndefined()
    expect(parseXrayDaemonAddress('')).toBeUndefined()
    expect(parseXrayDaemonAddress('localhost')).toBeUndefined()
    expect(parseXrayDaemonAddress('localhost:0')).toBeUndefined()
    expect(parseXrayDaemonAddress('tcp:127.0.0.1:2000')).toBeUndefined()
  })
})

describe('createXrayApiRequestSubsegment', () => {
  test('annotates a sampled trace with the request identifiers', () => {
    const document = createXrayApiRequestSubsegment(
      observation,
      parseXrayTraceHeader(sampledHeader),
      () => 'abcdef0123456789',
    )

    expect(document).toEqual({
      id: 'abcdef0123456789',
      name: XRAY_API_REQUEST_SUBSEGMENT_NAME,
      trace_id: root,
      parent_id: parent,
      type: 'subsegment',
      start_time: 1_728_000_000,
      end_time: 1_728_000_000.25,
      annotations: {
        correlation_id: observation.correlationId,
        request_id: observation.requestId,
        route_group: '/api/teams',
      },
      http: { request: { method: 'POST' }, response: { status: 201 } },
      error: false,
      fault: false,
      throttle: false,
    })
  })

  test('flags client errors, throttles, and server faults', () => {
    const header = parseXrayTraceHeader(sampledHeader)
    expect(createXrayApiRequestSubsegment({ ...observation, status: 404 }, header)).toMatchObject({ error: true, fault: false, throttle: false })
    expect(createXrayApiRequestSubsegment({ ...observation, status: 429 }, header)).toMatchObject({ error: true, throttle: true })
    expect(createXrayApiRequestSubsegment({ ...observation, status: 503 }, header)).toMatchObject({ error: false, fault: true })
  })

  test('skips unsampled traces and traces from another invocation', () => {
    expect(createXrayApiRequestSubsegment(observation, parseXrayTraceHeader(`Root=${root};Parent=${parent};Sampled=0`))).toBeUndefined()
    expect(createXrayApiRequestSubsegment(observation, undefined)).toBeUndefined()
    expect(createXrayApiRequestSubsegment(
      { ...observation, traceId: '1-6705a1b2-ffffffffffffffffffffffff' },
      parseXrayTraceHeader(sampledHeader),
    )).toBeUndefined()
  })

  test('omits annotation values outside the indexable character set', () => {
    const document = createXrayApiRequestSubsegment(
      { ...observation, correlationId: 'has spaces and "quotes"' },
      parseXrayTraceHeader(sampledHeader),
    )
    expect(document?.annotations).toEqual({
      request_id: observation.requestId,
      route_group: '/api/teams',
    })
  })
})

describe('createXrayDaemonSender', () => {
  test('writes the daemon header and document to one unreferenced socket', () => {
    const sent: { message: string; port: number; host: string }[] = []
    let created = 0
    let unreferenced = 0
    const socket: XrayUdpSocket = {
      send(message, port, host, callback) {
        sent.push({ message: new TextDecoder().decode(message), port, host })
        callback(null)
      },
      on() {},
      unref() { unreferenced += 1 },
    }
    const send = createXrayDaemonSender({ host: '127.0.0.1', port: 2000 }, () => {
      created += 1
      return socket
    })
    const document = createXrayApiRequestSubsegment(observation, parseXrayTraceHeader(sampledHeader))
    if (!document) throw new Error('expected a subsegment')

    send(document)
    send(document)

    expect(created).toBe(1)
    expect(unreferenced).toBe(1)
    expect(sent).toHaveLength(2)
    const [header, body] = (sent[0]?.message ?? '').split('\n')
    expect(header).toBe('{"format":"json","version":1}')
    expect(JSON.parse(body ?? '')).toEqual(document)
    expect(sent[0]).toMatchObject({ port: 2000, host: '127.0.0.1' })
  })

  test('drops socket failures without throwing', () => {
    const send = createXrayDaemonSender({ host: '127.0.0.1', port: 2000 }, () => {
      throw new Error('socket unavailable')
    })
    const document = createXrayApiRequestSubsegment(observation, parseXrayTraceHeader(sampledHeader))
    if (!document) throw new Error('expected a subsegment')

    expect(() => send(document)).not.toThrow()
  })
})

describe('createXrayApiAccessRecorder', () => {
  test('is disabled when no daemon address is configured', () => {
    expect(createXrayApiAccessRecorder({ _X_AMZN_TRACE_ID: sampledHeader })).toBeUndefined()
  })

  test('reads the current trace header on every request', () => {
    const environment: Record<string, string | undefined> = {
      AWS_XRAY_DAEMON_ADDRESS: '127.0.0.1:2000',
      _X_AMZN_TRACE_ID: sampledHeader,
    }
    const sent: XrayApiRequestSubsegment[] = []
    const record = createXrayApiAccessRecorder(environment, (document) => sent.push(document))
    if (!record) throw new Error('expected a recorder')

    record(observation)
    environment._X_AMZN_TRACE_ID = `Root=${root};Parent=${parent};Sampled=0`
    record(observation)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.annotations.correlation_id).toBe(observation.correlationId)
  })
})
