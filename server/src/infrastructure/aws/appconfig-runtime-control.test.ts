import { expect, test } from 'bun:test'
import {
  createAppConfigRuntimeControlSource,
  type AppConfigRuntimeControlPollInput,
  type AppConfigRuntimeControlSessionInput,
} from './appconfig-runtime-control'

test('starts one session, rotates one-use tokens, and preserves provider intervals', async () => {
  const sessions: AppConfigRuntimeControlSessionInput[] = []
  const polls: AppConfigRuntimeControlPollInput[] = []
  const signals: AbortSignal[] = []
  const source = createAppConfigRuntimeControlSource({
    applicationIdentifier: 'application',
    configurationProfileIdentifier: 'profile',
    environmentIdentifier: 'environment',
    minimumPollIntervalSeconds: 15,
    client: {
      async startConfigurationSession(input, abortSignal) {
        sessions.push(input)
        signals.push(abortSignal)
        return { initialConfigurationToken: 'initial-token' }
      },
      async getLatestConfiguration(input, abortSignal) {
        polls.push(input)
        signals.push(abortSignal)
        return polls.length === 1
          ? {
              configuration: new TextEncoder().encode(
                '{"schemaVersion":1,"revision":1,"mode":"enabled"}',
              ),
              nextPollConfigurationToken: 'second-token',
              nextPollIntervalInSeconds: 17,
            }
          : {
              configuration: new Uint8Array(),
              nextPollConfigurationToken: 'third-token',
              nextPollIntervalInSeconds: 30,
            }
      },
    },
  })

  expect(await source.poll()).toEqual({
    kind: 'configuration',
    configuration: new TextEncoder().encode(
      '{"schemaVersion":1,"revision":1,"mode":"enabled"}',
    ),
    nextPollIntervalMilliseconds: 17_000,
  })
  expect(await source.poll()).toEqual({
    kind: 'unchanged',
    nextPollIntervalMilliseconds: 30_000,
  })
  expect(sessions).toEqual([{
    applicationIdentifier: 'application',
    configurationProfileIdentifier: 'profile',
    environmentIdentifier: 'environment',
    minimumPollIntervalSeconds: 15,
  }])
  expect(polls).toEqual([
    { configurationToken: 'initial-token' },
    { configurationToken: 'second-token' },
  ])
  expect(signals).toHaveLength(3)
  expect(signals.every((signal) => !signal.aborted)).toBeTrue()
})

test('discards a consumed session after failure and redacts provider details', async () => {
  let sessions = 0
  let polls = 0
  const source = createAppConfigRuntimeControlSource({
    applicationIdentifier: 'application',
    configurationProfileIdentifier: 'profile',
    environmentIdentifier: 'environment',
    client: {
      async startConfigurationSession() {
        sessions += 1
        return {
          initialConfigurationToken: `session-${sessions}`,
        }
      },
      async getLatestConfiguration(input) {
        polls += 1
        if (polls === 1) {
          throw new Error(`secret provider detail ${input.configurationToken}`)
        }
        return {
          nextPollConfigurationToken: 'next-token',
          nextPollIntervalInSeconds: 15,
        }
      },
    },
  })

  let firstFailure: unknown
  try {
    await source.poll()
  } catch (error) {
    firstFailure = error
  }
  expect(firstFailure).toBeInstanceOf(Error)
  expect(String(firstFailure)).not.toContain('secret provider detail')
  expect(await source.poll()).toEqual({
    kind: 'unchanged',
    nextPollIntervalMilliseconds: 15_000,
  })
  expect(sessions).toBe(2)
})

test('applies a bounded abort signal to AppConfig requests', async () => {
  let receivedSignal: AbortSignal | undefined
  const source = createAppConfigRuntimeControlSource({
    applicationIdentifier: 'application',
    configurationProfileIdentifier: 'profile',
    environmentIdentifier: 'environment',
    requestTimeoutMilliseconds: 5,
    client: {
      async startConfigurationSession() {
        return { initialConfigurationToken: 'initial-token' }
      },
      async getLatestConfiguration(_input, abortSignal) {
        receivedSignal = abortSignal
        return await new Promise((_resolve, reject) => {
          abortSignal.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true },
          )
        })
      },
    },
  })

  await expect(source.poll()).rejects.toThrow(
    'AppConfig runtime-control configuration is unavailable.',
  )
  expect(receivedSignal?.aborted).toBeTrue()
})

test('rejects missing tokens, invalid intervals, and oversized tokens safely', async () => {
  for (const response of [
    {
      nextPollConfigurationToken: 'next-token',
      nextPollIntervalInSeconds: 14,
    },
    {
      nextPollConfigurationToken: '',
      nextPollIntervalInSeconds: 15,
    },
    {
      nextPollConfigurationToken: 'x'.repeat(8 * 1024 + 1),
      nextPollIntervalInSeconds: 15,
    },
  ]) {
    const source = createAppConfigRuntimeControlSource({
      applicationIdentifier: 'application',
      configurationProfileIdentifier: 'profile',
      environmentIdentifier: 'environment',
      client: {
        async startConfigurationSession() {
          return { initialConfigurationToken: 'initial-token' }
        },
        async getLatestConfiguration() {
          return response
        },
      },
    })

    await expect(source.poll()).rejects.toThrow(
      'AppConfig runtime-control configuration is unavailable.',
    )
  }
})

test('validates source identifiers, minimum interval, and timeout', () => {
  const base = {
    applicationIdentifier: 'application',
    configurationProfileIdentifier: 'profile',
    environmentIdentifier: 'environment',
  }

  expect(() => createAppConfigRuntimeControlSource({
    ...base,
    applicationIdentifier: ' ',
  })).toThrow('AppConfig application identifier is invalid.')
  expect(() => createAppConfigRuntimeControlSource({
    ...base,
    minimumPollIntervalSeconds: 14,
  })).toThrow('AppConfig polling interval is invalid.')
  expect(() => createAppConfigRuntimeControlSource({
    ...base,
    requestTimeoutMilliseconds: 30_001,
  })).toThrow('AppConfig request timeout is invalid.')
})
