import { expect, test } from 'bun:test'
import {
  createRuntimeControlProvider,
  parseRuntimeControlDocument,
  runtimeControlAllowsExecution,
  runtimeControlIsReady,
  type RuntimeControlDocument,
  type RuntimeControlSnapshot,
  type RuntimeControlSourceResult,
} from './runtime-control'

/**
 * Encodes one candidate document as UTF-8 JSON.
 *
 * @param value - Candidate JSON value.
 * @returns UTF-8 bytes.
 */
function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

/**
 * Creates one provider configuration result.
 *
 * @param document - Runtime-control document to encode.
 * @param nextPollIntervalMilliseconds - Required next-poll delay.
 * @returns Source result containing fresh configuration bytes.
 */
function configurationResult(
  document: RuntimeControlDocument,
  nextPollIntervalMilliseconds = 15_000,
): RuntimeControlSourceResult {
  return {
    kind: 'configuration',
    configuration: encodeJson(document),
    nextPollIntervalMilliseconds,
  }
}

test('parses only the exact version-one document contract', () => {
  const parsed = parseRuntimeControlDocument(encodeJson({
    schemaVersion: 1,
    revision: 42,
    mode: 'enabled',
  }))

  expect(parsed).toEqual({
    schemaVersion: 1,
    revision: 42,
    mode: 'enabled',
  })
  expect(Object.isFrozen(parsed)).toBeTrue()

  for (const candidate of [
    null,
    [],
    {},
    { schemaVersion: 2, revision: 1, mode: 'enabled' },
    { schemaVersion: 1, revision: 0, mode: 'enabled' },
    { schemaVersion: 1, revision: 1.5, mode: 'enabled' },
    { schemaVersion: 1, revision: 1, mode: 'paused' },
    {
      schemaVersion: 1,
      revision: 1,
      mode: 'enabled',
      unexpected: true,
    },
  ]) {
    expect(() => parseRuntimeControlDocument(
      encodeJson(candidate),
    )).toThrow('Runtime control configuration is invalid.')
  }

  expect(() => parseRuntimeControlDocument(
    new Uint8Array([0xc3, 0x28]),
  )).toThrow('Runtime control configuration is invalid.')
  expect(() => parseRuntimeControlDocument(
    encodeJson({
      schemaVersion: 1,
      revision: 1,
      mode: 'enabled',
    }),
    5,
  )).toThrow('Runtime control configuration is invalid.')
})

test('fails closed on a cold-start provider failure', async () => {
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        throw new Error('provider detail must not escape')
      },
    },
    now: () => 0,
  })

  const snapshot = await provider.getSnapshot()

  expect(snapshot).toEqual({
    mode: 'disabled',
    status: 'unavailable',
  })
  expect(runtimeControlAllowsExecution(snapshot)).toBeFalse()
  expect(runtimeControlIsReady(snapshot)).toBeFalse()
})

test('classifies a cold-start unchanged response as unavailable', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll(): Promise<RuntimeControlSourceResult> {
        polls += 1
        return {
          kind: 'unchanged',
          nextPollIntervalMilliseconds: 20_000,
        }
      },
    },
    now: () => now,
  })

  const snapshot = await provider.getSnapshot()
  expect(snapshot).toEqual({
    mode: 'disabled',
    status: 'unavailable',
  })
  expect(runtimeControlAllowsExecution(snapshot)).toBeFalse()
  expect(runtimeControlIsReady(snapshot)).toBeFalse()
  now = 19_999
  expect((await provider.getSnapshot()).status).toBe('unavailable')
  expect(polls).toBe(1)
  now = 20_000
  expect((await provider.getSnapshot()).status).toBe('unavailable')
  expect(polls).toBe(2)
})

test('honors both the local minimum and provider-required poll interval', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        return polls === 1
          ? configurationResult({
              schemaVersion: 1,
              revision: 1,
              mode: 'enabled',
            }, 30_000)
          : {
              kind: 'unchanged',
              nextPollIntervalMilliseconds: 20_000,
            }
      },
    },
    now: () => now,
    pollIntervalMilliseconds: 15_000,
  })

  const initialSnapshot = await provider.getSnapshot()
  expect(initialSnapshot).toMatchObject({
    mode: 'enabled',
    status: 'current',
    revision: 1,
  })
  expect(Object.isFrozen(initialSnapshot)).toBeTrue()
  now = 29_999
  expect((await provider.getSnapshot()).status).toBe('current')
  expect(polls).toBe(1)
  now = 30_000
  expect(await provider.getSnapshot()).toMatchObject({
    ageMilliseconds: 0,
    mode: 'enabled',
    status: 'current',
  })
  expect(polls).toBe(2)
  now = 49_999
  await provider.getSnapshot()
  expect(polls).toBe(2)
  now = 50_000
  await provider.getSnapshot()
  expect(polls).toBe(3)
})

test('de-duplicates concurrent refreshes with a single provider poll', async () => {
  let polls = 0
  let releasePoll: (() => void) | undefined
  const pendingPoll = new Promise<void>((resolve) => {
    releasePoll = resolve
  })
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        await pendingPoll
        return configurationResult({
          schemaVersion: 1,
          revision: 1,
          mode: 'enabled',
        })
      },
    },
    now: () => 0,
  })

  const first = provider.getSnapshot()
  const concurrent = provider.getSnapshot()
  expect(polls).toBe(1)
  const release = releasePoll
  if (!release) throw new Error('Test poll was not initialized.')
  release()

  const [firstSnapshot, concurrentSnapshot] = await Promise.all([
    first,
    concurrent,
  ])
  expect(firstSnapshot).toBe(concurrentSnapshot)
  expect(polls).toBe(1)
})

test('uses enabled last-known-good only within the sixty-second provider-failure bound', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        if (polls === 1) {
          return configurationResult({
            schemaVersion: 1,
            revision: 7,
            mode: 'enabled',
          })
        }
        throw new Error('network unavailable')
      },
    },
    now: () => now,
    maxStalenessMilliseconds: 60_000,
    retryInitialMilliseconds: 100,
    retryMaxMilliseconds: 100,
  })

  await provider.getSnapshot()
  now = 15_000
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 15_000,
    mode: 'enabled',
    revision: 7,
    status: 'stale',
  })
  now = 15_099
  expect((await provider.getSnapshot()).status).toBe('stale')
  expect(polls).toBe(2)
  now = 60_000
  expect(await provider.getSnapshot()).toMatchObject({
    mode: 'enabled',
    status: 'stale',
  })
  now = 60_001
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 60_001,
    mode: 'disabled',
    revision: 7,
    status: 'unavailable',
  })
})

test('measures provider failure staleness when the request completes', async () => {
  let now = 0
  let polls = 0
  let rejectPoll: ((error: Error) => void) | undefined
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        if (polls === 1) {
          return configurationResult({
            schemaVersion: 1,
            revision: 7,
            mode: 'enabled',
          })
        }
        return await new Promise<RuntimeControlSourceResult>(
          (_resolve, reject) => {
            rejectPoll = reject
          },
        )
      },
    },
    now: () => now,
    maxStalenessMilliseconds: 60_000,
  })

  await provider.getSnapshot()
  now = 59_999
  const pendingSnapshot = provider.getSnapshot()
  now = 61_000
  const reject = rejectPoll
  if (!reject) throw new Error('Provider failure poll did not start.')
  reject(new Error('provider timeout'))

  expect(await pendingSnapshot).toEqual({
    ageMilliseconds: 61_000,
    mode: 'disabled',
    revision: 7,
    status: 'unavailable',
  })
})

test('fails closed when provider polling would outlive the staleness bound', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        return polls === 1
          ? configurationResult({
              schemaVersion: 1,
              revision: 1,
              mode: 'enabled',
            }, 120_000)
          : {
              kind: 'unchanged',
              nextPollIntervalMilliseconds: 120_000,
            }
      },
    },
    now: () => now,
    maxStalenessMilliseconds: 60_000,
  })

  await provider.getSnapshot()
  now = 60_001
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 60_001,
    mode: 'disabled',
    revision: 1,
    status: 'unavailable',
  })
  expect(polls).toBe(1)
  now = 120_000
  expect(await provider.getSnapshot()).toMatchObject({
    mode: 'enabled',
    status: 'current',
  })
  expect(polls).toBe(2)
})

test('invalid configuration stays blocked until a new valid payload arrives', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll(): Promise<RuntimeControlSourceResult> {
        polls += 1
        if (polls === 1) {
          return configurationResult({
            schemaVersion: 1,
            revision: 2,
            mode: 'enabled',
          })
        }
        if (polls === 2) {
          return {
            kind: 'configuration',
            configuration: encodeJson({
              schemaVersion: 1,
              revision: 3,
              mode: 'enabled',
              unknown: true,
            }),
            nextPollIntervalMilliseconds: 15_000,
          }
        }
        if (polls === 3) {
          return {
            kind: 'unchanged',
            nextPollIntervalMilliseconds: 15_000,
          }
        }
        if (polls === 4) throw new Error('network unavailable')
        return configurationResult({
          schemaVersion: 1,
          revision: 1,
          mode: 'disabled',
        })
      },
    },
    now: () => now,
    retryInitialMilliseconds: 100,
    retryMaxMilliseconds: 100,
  })

  await provider.getSnapshot()
  now = 15_000
  expect(await provider.getSnapshot()).toMatchObject({
    mode: 'disabled',
    revision: 2,
    status: 'invalid',
  })
  now = 30_000
  expect(await provider.getSnapshot()).toMatchObject({
    mode: 'disabled',
    revision: 2,
    status: 'invalid',
  })
  now = 45_000
  expect(await provider.getSnapshot()).toMatchObject({
    mode: 'disabled',
    revision: 2,
    status: 'invalid',
  })
  now = 45_100
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 0,
    mode: 'disabled',
    revision: 1,
    status: 'current',
  })
})

test('converges on every valid provider-deployed revision and mode', async () => {
  let now = 0
  let polls = 0
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        polls += 1
        if (polls === 1) {
          return configurationResult({
            schemaVersion: 1,
            revision: 5,
            mode: 'enabled',
          })
        }
        if (polls === 2) {
          return configurationResult({
            schemaVersion: 1,
            revision: 4,
            mode: 'enabled',
          })
        }
        return configurationResult({
          schemaVersion: 1,
          revision: 4,
          mode: 'disabled',
        })
      },
    },
    now: () => now,
  })

  await provider.getSnapshot()
  now = 15_000
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 0,
    mode: 'enabled',
    revision: 4,
    status: 'current',
  })
  now = 30_000
  expect(await provider.getSnapshot()).toEqual({
    ageMilliseconds: 0,
    mode: 'disabled',
    revision: 4,
    status: 'current',
  })
})

test('normalizes malformed source intervals and regressing clocks to unavailable', async () => {
  let now = 1
  const provider = createRuntimeControlProvider({
    source: {
      async poll() {
        return {
          kind: 'configuration',
          configuration: encodeJson({
            schemaVersion: 1,
            revision: 1,
            mode: 'enabled',
          }),
          nextPollIntervalMilliseconds: 0,
        }
      },
    },
    now: () => now,
  })

  expect(await provider.getSnapshot()).toEqual({
    mode: 'disabled',
    status: 'unavailable',
  })
  now = 0
  expect(await provider.getSnapshot()).toEqual({
    mode: 'disabled',
    status: 'unavailable',
  })
})

test('allows stale enabled execution but requires current enabled readiness', () => {
  const staleEnabled = {
    ageMilliseconds: 10_000,
    mode: 'enabled',
    revision: 1,
    status: 'stale',
  } satisfies RuntimeControlSnapshot

  expect(runtimeControlAllowsExecution(staleEnabled)).toBeTrue()
  expect(runtimeControlIsReady(staleEnabled)).toBeFalse()
})
