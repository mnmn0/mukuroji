import { describe, expect, test } from 'bun:test'
import {
  ConnectorRuntimeConfigurationError,
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
        })
      },
    })

    expect(environment.EXISTING_VALUE).toBe('kept')
    expect(environment.CONNECTOR_OAUTH_STATE_SIGNING_SECRET).toBe('state-secret')
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
})
