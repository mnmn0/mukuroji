import { randomUUID } from 'node:crypto'
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import {
  ConnectorRuntimeConfigurationError,
  type ConnectorRuntimeSecretLoader,
} from '../../connector-runtime-configuration'

/** Internal diagnostic emitted when Secrets Manager cannot load runtime configuration. */
type ConnectorRuntimeSecretLoadFailure = {
  /** AWS request ID when available, otherwise a generated diagnostic identifier. */
  correlationId: string
  /** Fixed secret-safe classification for the failed upstream request. */
  failureType: 'SecretsManagerRequestFailed'
}

/** Reports one secret-loading failure without exposing the secret identifier. */
type ConnectorRuntimeSecretLoadFailureReporter = (
  failure: ConnectorRuntimeSecretLoadFailure,
) => void

/** Secret value fields consumed from one Secrets Manager response. */
type ConnectorRuntimeSecretValue = {
  /** UTF-8 connector runtime configuration JSON when stored as text. */
  SecretString?: string
  /** UTF-8 connector runtime configuration JSON when stored as binary data. */
  SecretBinary?: Uint8Array
}

/** Narrow Secrets Manager dependency required by the runtime secret adapter. */
type ConnectorRuntimeSecretsManagerClient = {
  /** Sends one secret-value request and returns only the consumed response fields. */
  send(command: GetSecretValueCommand): Promise<ConnectorRuntimeSecretValue>
}

/** Secrets Manager adapter that reads connector runtime configuration JSON. */
export class SecretsManagerConnectorRuntimeSecretLoader
implements ConnectorRuntimeSecretLoader {
  /** AWS Secrets Manager client. */
  private readonly client: ConnectorRuntimeSecretsManagerClient
  /** Internal failure reporter used before returning a stable boundary error. */
  private readonly reportFailure: ConnectorRuntimeSecretLoadFailureReporter

  /**
   * Creates a Secrets Manager connector configuration adapter.
   *
   * @param client - Secrets Manager client used for retrieval.
   * @param reportFailure - Internal diagnostic reporter for upstream failures.
   */
  constructor(
    client: ConnectorRuntimeSecretsManagerClient = new SecretsManagerClient({}),
    reportFailure: ConnectorRuntimeSecretLoadFailureReporter =
      reportConnectorRuntimeSecretLoadFailure,
  ) {
    this.client = client
    this.reportFailure = reportFailure
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
      this.reportFailure({
        correlationId: readAwsRequestId(error) ?? randomUUID(),
        failureType: 'SecretsManagerRequestFailed',
      })
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

/** Writes an internal diagnostic without adding the secret identifier to the log. */
function reportConnectorRuntimeSecretLoadFailure(
  failure: ConnectorRuntimeSecretLoadFailure,
) {
  console.error('Connector runtime secret load failed.', failure)
}

/** Reads the AWS request ID from an SDK error when one is available. */
function readAwsRequestId(error: unknown) {
  if (!isRecord(error) || !isRecord(error.$metadata)) return undefined
  const requestId = error.$metadata.requestId
  return typeof requestId === 'string' && requestId.trim()
    ? requestId.trim()
    : undefined
}

/** Returns whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
