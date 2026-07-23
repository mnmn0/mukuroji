import {
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from '@aws-sdk/client-secrets-manager'
import {
  loadServerConfig,
  type ServerConfig,
} from '../config/server-config'

/**
 * Builds the Secrets Manager transport configuration without performing network access.
 *
 * Explicit static credentials must include both the access key and secret key.
 * Otherwise AWS endpoints use the SDK provider chain, while an explicitly
 * validated local emulator receives the conventional non-secret test pair.
 *
 * @param config - Validated server configuration.
 * @returns Configuration for an AWS Secrets Manager client.
 */
export function createSecretsManagerClientConfig(
  config: ServerConfig = loadServerConfig(),
): SecretsManagerClientConfig {
  const accessKeyId = readCredentialValue(config.environment.AWS_ACCESS_KEY_ID)
  const secretAccessKey = readCredentialValue(config.environment.AWS_SECRET_ACCESS_KEY)
  const sessionToken = readCredentialValue(config.environment.AWS_SESSION_TOKEN)

  if (
    (accessKeyId === undefined) !== (secretAccessKey === undefined) ||
    (sessionToken !== undefined && (accessKeyId === undefined || secretAccessKey === undefined))
  ) {
    throw new TypeError(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together; AWS_SESSION_TOKEN also requires both.',
    )
  }

  const endpoint = config.secretsManagerEndpoint
  const transport = {
    region: config.awsRegion,
    ...(endpoint ? { endpoint } : {}),
  }

  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    return {
      ...transport,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
    }
  }

  if (config.secretsManagerEndpointIsLocal) {
    return {
      ...transport,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    }
  }

  return transport
}

/**
 * Creates a Secrets Manager client from centralized validated configuration.
 *
 * @returns A configured Secrets Manager client.
 */
export function createSecretsManagerClient(): SecretsManagerClient {
  return new SecretsManagerClient(createSecretsManagerClientConfig())
}

/** Returns a trimmed non-blank static credential value. */
function readCredentialValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
