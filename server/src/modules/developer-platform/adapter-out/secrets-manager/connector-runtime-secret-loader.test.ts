import { describe, expect, test } from 'bun:test'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SecretsManagerConnectorRuntimeSecretLoader } from './connector-runtime-secret-loader'

describe('SecretsManagerConnectorRuntimeSecretLoader', () => {
  test('logs the original AWS failure with its request ID and returns a stable error', async () => {
    const upstreamError = Object.assign(new Error('upstream unavailable'), {
      $metadata: { requestId: 'aws-request-123' },
    })
    const client = {
      async send() {
        throw upstreamError
      },
    } as unknown as SecretsManagerClient
    const failures: Array<{ correlationId: string; error: unknown }> = []
    const loader = new SecretsManagerConnectorRuntimeSecretLoader(
      client,
      (failure) => failures.push(failure),
    )

    await expect(loader.readSecret('connector-runtime-secret')).rejects.toMatchObject({
      code: 'ConnectorConfigurationUnavailable',
      message: 'Connector runtime configuration could not be loaded.',
    })
    expect(failures).toEqual([{
      correlationId: 'aws-request-123',
      error: upstreamError,
    }])
  })
})
