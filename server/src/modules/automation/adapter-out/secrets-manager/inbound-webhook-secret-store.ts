import { randomBytes } from 'node:crypto'
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type {
  AutomationInboundWebhookSecretReference,
  AutomationInboundWebhookSecretStore,
} from '../../application/ports'
import { AutomationError } from '../../domain/automation-error'

/** Secrets Manager adapter for inbound Webhook signing secrets. */
export class SecretsManagerAutomationInboundWebhookSecretStore
implements AutomationInboundWebhookSecretStore {
  /** AWS Secrets Manager client. */
  private readonly client: SecretsManagerClient

  /**
   * Creates a Secrets Manager-backed inbound Webhook secret store.
   *
   * @param client - Optional configured Secrets Manager client.
   */
  constructor(client = createSecretsManagerClient()) {
    this.client = client
  }

  /** Provisions or recovers one reserved immutable secret generation. */
  async provision(reference: AutomationInboundWebhookSecretReference): Promise<string> {
    const existing = await this.read(reference, true)
    if (existing) return existing.toString('utf8')

    const signingSecret = randomBytes(32).toString('base64url')
    const secretExists = await this.describe(reference.secretId)
    try {
      if (secretExists) {
        await this.client.send(new PutSecretValueCommand({
          SecretId: reference.secretId,
          ClientRequestToken: reference.secretVersionId,
          SecretString: signingSecret,
        }))
      } else {
        await this.client.send(new CreateSecretCommand({
          Name: reference.secretId,
          ClientRequestToken: reference.secretVersionId,
          Description: 'mukuroji server-issued inbound webhook signing secret',
          SecretString: signingSecret,
        }))
      }
      return signingSecret
    } catch {
      const recovered = await this.read(reference, true)
      if (recovered) return recovered.toString('utf8')
      throw secretUnavailable()
    }
  }

  /** Reads one pinned secret generation. */
  async get(reference: AutomationInboundWebhookSecretReference): Promise<Uint8Array> {
    const secret = await this.read(reference, false)
    if (!secret) throw secretUnavailable()
    return secret
  }

  /** Deletes the secret resource belonging to a revoked endpoint. */
  async delete(reference: AutomationInboundWebhookSecretReference): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({
        SecretId: reference.secretId,
        ForceDeleteWithoutRecovery: true,
      }))
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return
      throw secretUnavailable()
    }
  }

  /** Tests whether a Secrets Manager resource exists. */
  private async describe(secretId: string): Promise<boolean> {
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: secretId }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return false
      throw secretUnavailable()
    }
  }

  /** Reads one immutable secret version. */
  private async read(
    reference: AutomationInboundWebhookSecretReference,
    missingIsUndefined: boolean,
  ): Promise<Buffer | undefined> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({
        SecretId: reference.secretId,
        VersionId: reference.secretVersionId,
      }))
      const secret = response.SecretString !== undefined
        ? Buffer.from(response.SecretString, 'utf8')
        : response.SecretBinary !== undefined
          ? Buffer.from(response.SecretBinary)
          : undefined
      if (!secret || secret.byteLength === 0) throw secretUnavailable()
      return secret
    } catch (error) {
      if (missingIsUndefined && isNamedError(error, 'ResourceNotFoundException')) {
        return undefined
      }
      if (error instanceof AutomationError) throw error
      throw secretUnavailable()
    }
  }
}

/** Creates the environment-configured Secrets Manager client. */
function createSecretsManagerClient(): SecretsManagerClient {
  const endpoint = [
    process.env.SECRETS_MANAGER_ENDPOINT,
    process.env.AWS_ENDPOINT_URL_SECRETSMANAGER,
    process.env.AWS_ENDPOINT_URL,
  ].map((value) => value?.trim()).find(Boolean)
  return new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

/** Creates the stable transient secret-store failure. */
function secretUnavailable(): AutomationError {
  return new AutomationError(
    'unavailable',
    'AutomationInboundWebhookSecretUnavailable',
    'Inbound webhook signing secret is unavailable.',
    true,
  )
}

/** Tests an unknown error name without exposing the provider error. */
function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === name
}
