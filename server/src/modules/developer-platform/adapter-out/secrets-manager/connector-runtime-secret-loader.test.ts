import { describe, expect, test } from 'bun:test'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { SecretsManagerConnectorRuntimeSecretLoader } from './connector-runtime-secret-loader'

describe('SecretsManagerConnectorRuntimeSecretLoader', () => {
  test('logs a sanitized failure with the AWS request ID and returns a stable error', async () => {
    const upstreamError = Object.assign(new Error('upstream unavailable'), {
      $metadata: { requestId: 'aws-request-123' },
    })
    const client = {
      async send(command: GetSecretValueCommand) {
        expect(command).toBeInstanceOf(GetSecretValueCommand)
        throw upstreamError
      },
    }
    const failures: Array<{
      /** Correlation identifier extracted from AWS metadata. */
      correlationId: string
      /** Fixed secret-safe failure classification. */
      failureType: 'SecretsManagerRequestFailed'
    }> = []
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
      failureType: 'SecretsManagerRequestFailed',
    }])
    expect(JSON.stringify(failures)).not.toContain(upstreamError.message)
  })
})
