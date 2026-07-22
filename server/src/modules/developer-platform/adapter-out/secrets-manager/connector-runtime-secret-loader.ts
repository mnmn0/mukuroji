import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import {
  ConnectorRuntimeConfigurationError,
  type ConnectorRuntimeSecretLoader,
} from '../../connector-runtime-configuration'

/** Secrets Manager adapter that reads connector runtime configuration JSON. */
export class SecretsManagerConnectorRuntimeSecretLoader
implements ConnectorRuntimeSecretLoader {
  /** AWS Secrets Manager client. */
  private readonly client: SecretsManagerClient

  /** Creates a Secrets Manager connector configuration adapter. */
  constructor(client: SecretsManagerClient = new SecretsManagerClient({})) {
    this.client = client
  }

  /** Reads one UTF-8 secret by identifier. */
  async readSecret(secretId: string) {
    try {
      const response = await this.client.send(new GetSecretValueCommand({
        SecretId: secretId,
      }))
      if (typeof response.SecretString === 'string') return response.SecretString
      if (response.SecretBinary instanceof Uint8Array) {
        return Buffer.from(response.SecretBinary).toString('utf8')
      }
      throw new TypeError('Secrets Manager secret has no value.')
    } catch (error) {
      if (error instanceof ConnectorRuntimeConfigurationError) throw error
      throw new ConnectorRuntimeConfigurationError(
        'ConnectorConfigurationUnavailable',
        'Connector runtime configuration could not be loaded.',
      )
    }
  }
}

/** Creates the production Secrets Manager connector configuration adapter. */
export function createSecretsManagerConnectorRuntimeSecretLoader() {
  return new SecretsManagerConnectorRuntimeSecretLoader()
}
