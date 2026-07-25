import { expect, test } from 'bun:test'
import type {
  RuntimeControlObservation,
} from '../../infrastructure/observability/runtime-control-observability'
import {
  RuntimeControlBlockedError,
  type RuntimeControlProvider,
  type RuntimeControlSnapshot,
} from '../../infrastructure/runtime/runtime-control'
import {
  createProductionRuntimeControlObservationRecorder,
  createProductionRuntimeControlProvider,
  createRuntimeControlAwareReadinessProbe,
  createRuntimeControlGuardedHandler,
} from './runtime-control'

/**
 * Creates a deterministic provider for one snapshot.
 *
 * @param snapshot - Snapshot returned for every evaluation.
 * @returns Runtime-control provider.
 */
function providerFor(
  snapshot: RuntimeControlSnapshot,
): RuntimeControlProvider {
  return {
    async getSnapshot() {
      return snapshot
    },
  }
}

test('uses an enabled static provider outside production', async () => {
  const provider = createProductionRuntimeControlProvider('api', {
    environment: { NODE_ENV: 'test' },
  })

  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 0,
    mode: 'enabled',
    revision: 1,
    status: 'current',
  })
})

test('fails production startup configuration closed without throwing', async () => {
  let clientCalls = 0
  const client = {
    async startConfigurationSession() {
      clientCalls += 1
      return { initialConfigurationToken: 'initial-token' }
    },
    async getLatestConfiguration() {
      clientCalls += 1
      return {
        nextPollConfigurationToken: 'next-token',
        nextPollIntervalInSeconds: 15,
      }
    },
  }
  const environments = [
    { NODE_ENV: 'production' },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'realtime',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
      MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS: '61',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
      MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS: '301',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
      MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS: '',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
      MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS: ' ',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID:
        'application:wrong-control',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
    },
    {
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID:
        'profile:wrong-control',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
    },
  ]

  for (const environment of environments) {
    const provider = createProductionRuntimeControlProvider('api', {
      client,
      environment,
    })
    expect(await provider.getSnapshot()).toEqual({
      mode: 'disabled',
      status: 'unavailable',
    })
  }
  expect(clientCalls).toBe(0)
})

test('derives observation identity from the exact AppConfig target', () => {
  const originalWrite = console.log
  const records: string[] = []
  console.log = (record?: unknown) => {
    if (typeof record === 'string') records.push(record)
  }
  try {
    const record = createProductionRuntimeControlObservationRecorder({
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application-a',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile-b',
    })
    record({
      observedAtMilliseconds: 1,
      outcome: 'allowed',
      snapshot: {
        mode: 'enabled',
        revision: 1,
        status: 'current',
      },
      surface: 'api',
    })
  } finally {
    console.log = originalWrite
  }

  expect(JSON.parse(records[0] ?? '{}')).toMatchObject({
    ControlId: 'application-a:profile-b',
    controlId: 'application-a:profile-b',
  })
})

test('constructs a fail-closed observation recorder without AppConfig IDs', () => {
  const originalWrite = console.log
  const records: string[] = []
  console.log = (record?: unknown) => {
    if (typeof record === 'string') records.push(record)
  }
  try {
    const record = createProductionRuntimeControlObservationRecorder({})
    record({
      observedAtMilliseconds: 1,
      outcome: 'blocked',
      snapshot: {
        mode: 'disabled',
        status: 'unavailable',
      },
      surface: 'api',
    })
  } finally {
    console.log = originalWrite
  }

  expect(JSON.parse(records[0] ?? '{}')).toMatchObject({
    ControlId: 'unconfigured',
    ProviderFailureCount: 1,
  })
})

test('constructs an AppConfig provider for an exact production scope', async () => {
  const provider = createProductionRuntimeControlProvider('api', {
    environment: {
      AWS_REGION: 'ap-northeast-1',
      NODE_ENV: 'production',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: 'application',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: 'environment',
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: 'profile',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
    },
    now: () => 0,
    client: {
      async startConfigurationSession(input) {
        expect(input).toMatchObject({
          applicationIdentifier: 'application',
          configurationProfileIdentifier: 'profile',
          environmentIdentifier: 'environment',
          minimumPollIntervalSeconds: 15,
        })
        return { initialConfigurationToken: 'initial-token' }
      },
      async getLatestConfiguration() {
        return {
          configuration: new TextEncoder().encode(
            '{"schemaVersion":1,"revision":9,"mode":"enabled"}',
          ),
          nextPollConfigurationToken: 'next-token',
          nextPollIntervalInSeconds: 15,
        }
      },
    },
  })

  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 0,
    mode: 'enabled',
    revision: 9,
    status: 'current',
  })
})

test('blocks a delegate before invocation and records one bounded decision', async () => {
  let delegateCalls = 0
  const observations: RuntimeControlObservation[] = []
  const guarded = createRuntimeControlGuardedHandler(
    'webhook-delivery',
    async () => {
      delegateCalls += 1
      return 'unexpected'
    },
    {
      now: () => 123,
      provider: providerFor({
        mode: 'disabled',
        revision: 3,
        status: 'current',
      }),
      recordObservation: (observation) => observations.push(observation),
    },
  )

  await expect(guarded()).rejects.toBeInstanceOf(
    RuntimeControlBlockedError,
  )
  expect(delegateCalls).toBe(0)
  expect(observations).toEqual([{
    observedAtMilliseconds: 123,
    outcome: 'blocked',
    snapshot: {
      mode: 'disabled',
      revision: 3,
      status: 'current',
    },
    surface: 'webhook-delivery',
  }])
})

test('delegates enabled work and does not let telemetry failure disrupt it', async () => {
  let delegateCalls = 0
  const guarded = createRuntimeControlGuardedHandler(
    'automation-event',
    async (value: number) => {
      delegateCalls += 1
      return value + 1
    },
    {
      provider: providerFor({
        ageMilliseconds: 10,
        mode: 'enabled',
        revision: 4,
        status: 'stale',
      }),
      recordObservation() {
        throw new Error('telemetry unavailable')
      },
    },
  )

  expect(await guarded(41)).toBe(42)
  expect(delegateCalls).toBe(1)
})

test('fails a guarded handler closed when its provider rejects', async () => {
  let delegateCalls = 0
  const guarded = createRuntimeControlGuardedHandler(
    'realtime',
    () => {
      delegateCalls += 1
    },
    {
      provider: {
        async getSnapshot() {
          throw new Error('provider detail')
        },
      },
      recordObservation() {},
    },
  )

  await expect(guarded()).rejects.toMatchObject({
    code: 'RuntimeControlBlocked',
    mode: 'disabled',
    status: 'unavailable',
  })
  expect(delegateCalls).toBe(0)
})

test('readiness requires current enabled control before checking dependencies', async () => {
  let dependencyCalls = 0
  const readiness = {
    async check(correlationId?: string) {
      dependencyCalls += 1
      expect(correlationId).toBe('correlation-id')
      return {
        checks: [{ name: 'database', ready: true }],
        ready: true,
      }
    },
  }
  const enabledProbe = createRuntimeControlAwareReadinessProbe(
    readiness,
    providerFor({
      mode: 'enabled',
      revision: 1,
      status: 'current',
    }),
  )

  expect(await enabledProbe.check('correlation-id')).toEqual({
    checks: [
      { name: 'database', ready: true },
      { name: 'runtime-control', ready: true },
    ],
    ready: true,
  })
  expect(dependencyCalls).toBe(1)

  for (const snapshot of [
    {
      ageMilliseconds: 1,
      mode: 'enabled',
      revision: 1,
      status: 'stale',
    },
    {
      mode: 'disabled',
      revision: 2,
      status: 'current',
    },
    {
      mode: 'disabled',
      status: 'unavailable',
    },
  ] satisfies RuntimeControlSnapshot[]) {
    const probe = createRuntimeControlAwareReadinessProbe(
      readiness,
      providerFor(snapshot),
    )
    expect(await probe.check()).toEqual({
      checks: [{ name: 'runtime-control', ready: false }],
      ready: false,
    })
  }
  expect(dependencyCalls).toBe(1)
})
