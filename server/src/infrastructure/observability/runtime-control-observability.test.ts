import { expect, test } from 'bun:test'
import {
  createRuntimeControlMetricControlId,
  createRuntimeControlObservationRecorder,
  recordRuntimeControlObservation,
} from './runtime-control-observability'
import type {
  RuntimeControlStatus,
} from '../runtime/runtime-control'

test('derives isolated metric identities from AppConfig application and profile IDs', () => {
  expect(createRuntimeControlMetricControlId(
    'application-a',
    'profile-a',
  )).toBe('application-a:profile-a')
  expect(createRuntimeControlMetricControlId(
    'application-a',
    'profile-b',
  )).toBe('application-a:profile-b')
  expect(createRuntimeControlMetricControlId(
    'application:invalid',
    'profile-a',
  )).toBeUndefined()
})

test('emits aggregate and per-surface runtime-control EMF dimensions', () => {
  const records: string[] = []
  const record = createRuntimeControlObservationRecorder(
    { controlId: 'stack:runtime-controls' },
    (serializedRecord) => records.push(serializedRecord),
  )

  record({
    observedAtMilliseconds: 123,
    outcome: 'blocked',
    snapshot: {
      mode: 'disabled',
      revision: 7,
      status: 'current',
    },
    surface: 'api',
  })

  expect(records).toHaveLength(1)
  expect(JSON.parse(records[0] ?? '{}')).toMatchObject({
    _aws: {
      Timestamp: 123,
      CloudWatchMetrics: [{
        Namespace: 'Mukuroji/RuntimeControl',
        Dimensions: [
          ['Service', 'ControlId'],
          ['Service', 'ControlId', 'Surface'],
        ],
        Metrics: [
          { Name: 'BlockedCount', Unit: 'Count' },
          { Name: 'ConfigurationFailureCount', Unit: 'Count' },
          { Name: 'DisabledCount', Unit: 'Count' },
          { Name: 'ProviderFailureCount', Unit: 'Count' },
          { Name: 'StaleCount', Unit: 'Count' },
        ],
      }],
    },
    event: 'runtime-control.evaluated',
    service: 'mukuroji-runtime-control',
    Service: 'mukuroji-runtime-control',
    controlId: 'stack:runtime-controls',
    ControlId: 'stack:runtime-controls',
    surface: 'api',
    Surface: 'api',
    outcome: 'blocked',
    mode: 'disabled',
    status: 'current',
    revision: 7,
    BlockedCount: 1,
    ConfigurationFailureCount: 0,
    DisabledCount: 1,
    ProviderFailureCount: 0,
    StaleCount: 0,
  })
})

test('bounds routine current-enabled records while preserving evidence heartbeats', () => {
  const records: string[] = []
  const record = createRuntimeControlObservationRecorder(
    { controlId: 'stack:runtime-controls' },
    (serializedRecord) => records.push(serializedRecord),
  )
  /**
   * Emits one deterministic current-enabled observation.
   *
   * @param observedAtMilliseconds - Observation timestamp.
   * @param revision - Accepted runtime-control revision.
   * @param surface - Execution surface being observed.
   * @returns Nothing.
   */
  const recordCurrent = (
    observedAtMilliseconds: number,
    revision: number,
    surface: 'api' | 'realtime' = 'api',
  ) => record({
    observedAtMilliseconds,
    outcome: 'allowed',
    snapshot: {
      mode: 'enabled',
      revision,
      status: 'current',
    },
    surface,
  })

  recordCurrent(0, 1)
  recordCurrent(59_999, 1)
  recordCurrent(60_000, 1)
  recordCurrent(60_001, 2)
  recordCurrent(60_001, 2, 'realtime')
  for (const observedAtMilliseconds of [60_002, 60_003]) {
    record({
      observedAtMilliseconds,
      outcome: 'blocked',
      snapshot: {
        mode: 'disabled',
        status: 'invalid',
      },
      surface: 'api',
    })
  }

  expect(records).toHaveLength(6)
  expect(records.map((serializedRecord) => {
    const parsed: unknown = JSON.parse(serializedRecord)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('outcome' in parsed)
    ) {
      throw new Error('Runtime-control observation was not serialized.')
    }
    return parsed.outcome
  })).toEqual([
    'allowed',
    'allowed',
    'allowed',
    'allowed',
    'blocked',
    'blocked',
  ])
})

test('counts only invalid states as configuration failures', () => {
  const failureStatuses: RuntimeControlStatus[] = ['invalid']
  for (const status of failureStatuses) {
    const records: string[] = []
    recordRuntimeControlObservation({
      observedAtMilliseconds: 1,
      outcome: 'blocked',
      snapshot: {
        mode: 'disabled',
        status,
      },
      surface: 'automation-event',
    }, (record) => records.push(record))

    expect(JSON.parse(records[0] ?? '{}')).toMatchObject({
      ConfigurationFailureCount: 1,
      DisabledCount: 0,
      ProviderFailureCount: 0,
      StaleCount: 0,
    })
  }
})

test('keeps stale grace and provider failure separate from configuration failure', () => {
  const staleRecords: string[] = []
  const unavailableRecords: string[] = []

  recordRuntimeControlObservation({
    observedAtMilliseconds: 1,
    outcome: 'allowed',
    snapshot: {
      ageMilliseconds: 10,
      mode: 'enabled',
      revision: 1,
      status: 'stale',
    },
    surface: 'realtime',
  }, (record) => staleRecords.push(record))
  recordRuntimeControlObservation({
    observedAtMilliseconds: 2,
    outcome: 'not-ready',
    snapshot: {
      mode: 'disabled',
      status: 'unavailable',
    },
    surface: 'readiness',
  }, (record) => unavailableRecords.push(record))

  expect(JSON.parse(staleRecords[0] ?? '{}')).toMatchObject({
    BlockedCount: 0,
    ConfigurationFailureCount: 0,
    ProviderFailureCount: 0,
    StaleCount: 1,
  })
  expect(JSON.parse(unavailableRecords[0] ?? '{}')).toMatchObject({
    BlockedCount: 1,
    ConfigurationFailureCount: 0,
    ProviderFailureCount: 1,
    StaleCount: 0,
  })
})
