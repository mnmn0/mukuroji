import { describe, expect, test } from 'bun:test'
import {
  ConnectorRuntimeConfigurationError,
  createConnectorRuntimeCache,
  loadConnectorRuntimeEnvironment,
  parseConnectorRuntimeSecret,
} from './connector-runtime-configuration'

describe('connector runtime configuration', () => {
  test('loads a secret into an isolated environment without mutating the base', async () => {
    const base: NodeJS.ProcessEnv = {
      CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN: 'secret-id',
      EXISTING_VALUE: 'kept',
    }
    const environment = await loadConnectorRuntimeEnvironment(base, {
      async readSecret(secretId) {
        expect(secretId).toBe('secret-id')
        return JSON.stringify({
          MUKUROJI_CONNECTOR_PROVIDERS_JSON: '[]',
          CONNECTOR_OAUTH_STATE_SIGNING_SECRET: 'state-secret',
          CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON:
            '["previous-state-secret"]',
          CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON:
            '["previous-origin-secret"]',
          CONNECTOR_SYNC_CURSOR_PREVIOUS_SIGNING_SECRETS_JSON:
            '["previous-cursor-secret"]',
        })
      },
    })

    expect(environment.EXISTING_VALUE).toBe('kept')
    expect(environment.CONNECTOR_OAUTH_STATE_SIGNING_SECRET).toBe('state-secret')
    expect(
      environment.CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON,
    ).toBe('["previous-state-secret"]')
    expect(
      environment.CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON,
    ).toBe('["previous-origin-secret"]')
    expect(
      environment.CONNECTOR_SYNC_CURSOR_PREVIOUS_SIGNING_SECRETS_JSON,
    ).toBe('["previous-cursor-secret"]')
    expect(base.CONNECTOR_OAUTH_STATE_SIGNING_SECRET).toBeUndefined()
  })

  test('returns a copy when no secret is configured', async () => {
    const base: NodeJS.ProcessEnv = { EXISTING_VALUE: 'kept' }
    const environment = await loadConnectorRuntimeEnvironment(base, {
      async readSecret() {
        throw new Error('must not run')
      },
    })

    expect(environment).toEqual(base)
    expect(environment).not.toBe(base)
  })

  test('rejects unknown keys and non-string values without echoing secrets', () => {
    for (const secret of [
      '{"AWS_ACCESS_KEY_ID":"hidden"}',
      '{"MUKUROJI_CONNECTOR_GITHUB_SECRET":42}',
    ]) {
      try {
        parseConnectorRuntimeSecret(secret)
        throw new Error('expected parser to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectorRuntimeConfigurationError)
        expect(String(error)).not.toContain('hidden')
      }
    }
  })

  test('fails closed when Secrets Manager is unavailable', async () => {
    await expect(loadConnectorRuntimeEnvironment(
      { CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN: 'secret-id' },
      {
        async readSecret() {
          throw new Error('provider credential leaked here')
        },
      },
    )).rejects.toMatchObject({
      code: 'ConnectorConfigurationUnavailable',
      message: 'Connector runtime configuration could not be loaded.',
    })
  })

  test('drops rejected promises and retries with bounded exponential backoff', async () => {
    let now = 0
    let attempts = 0
    const cache = createConnectorRuntimeCache({
      clock: () => now,
      retryInitialMs: 100,
      retryMaxMs: 200,
      ttlMs: 1_000,
      async load() {
        attempts += 1
        if (attempts <= 3) {
          throw new Error(`temporary failure ${attempts}`)
        }
        return `runtime-${attempts}`
      },
    })

    await expect(cache.get()).rejects.toThrow('temporary failure 1')
    await expect(cache.get()).rejects.toThrow('temporary failure 1')
    expect(attempts).toBe(1)

    now = 100
    await expect(cache.get()).rejects.toThrow('temporary failure 2')
    expect(attempts).toBe(2)

    now = 299
    await expect(cache.get()).rejects.toThrow('temporary failure 2')
    expect(attempts).toBe(2)

    now = 300
    await expect(cache.get()).rejects.toThrow('temporary failure 3')
    expect(attempts).toBe(3)

    now = 499
    await expect(cache.get()).rejects.toThrow('temporary failure 3')
    expect(attempts).toBe(3)

    now = 500
    await expect(cache.get()).resolves.toBe('runtime-4')
    expect(attempts).toBe(4)
  })

  test('refreshes a successful runtime after the TTL and shares concurrent loads', async () => {
    let now = 0
    let attempts = 0
    let resolveFirst: ((value: string) => void) | undefined
    const cache = createConnectorRuntimeCache({
      clock: () => now,
      ttlMs: 1_000,
      async load() {
        attempts += 1
        if (attempts === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve
          })
        }
        return `runtime-${attempts}`
      },
    })

    const first = cache.get()
    const concurrent = cache.get()
    expect(concurrent).toBe(first)
    await Promise.resolve()
    resolveFirst?.('runtime-1')
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      'runtime-1',
      'runtime-1',
    ])
    expect(attempts).toBe(1)

    now = 999
    await expect(cache.get()).resolves.toBe('runtime-1')
    expect(attempts).toBe(1)

    now = 1_000
    await expect(cache.get()).resolves.toBe('runtime-2')
    expect(attempts).toBe(2)
  })
})
