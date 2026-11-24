import { createHash } from 'node:crypto'
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import {
  channelDestinationTargetKey,
  isChannelDestinationSecretVersion,
  type ChannelDestinationTarget,
} from '../../domain/channel-destination'
import { NotificationError } from '../../domain/notification-error'

/** Port that keeps Slack webhook URLs in Secrets Manager and never returns them to clients. */
export type SlackDestinationSecretStore = {
  /**
   * Stores or replaces a webhook URL.
   * @param secretId - Server-derived secret name.
   * @param webhookUrl - Validated Incoming Webhook URL.
   */
  put(secretId: string, webhookUrl: string): Promise<void>
  /**
   * Reads a webhook URL.
   * @param secretId - Server-derived secret name.
   * @returns The stored URL, or undefined when none is stored.
   */
  read(secretId: string): Promise<string | undefined>
  /**
   * Reports whether a webhook is stored, without reading it.
   * @param secretId - Server-derived secret name.
   * @returns True when the secret exists.
   */
  exists(secretId: string): Promise<boolean>
  /**
   * Deletes a webhook; a missing secret is not an error.
   * @param secretId - Server-derived secret name.
   */
  delete(secretId: string): Promise<void>
}

/**
 * Hashes the Workspace so secret names never show the tenant identity.
 * @param workspaceId - Canonical Workspace ID.
 * @returns Lower-case hex SHA-256 of the trimmed ID.
 */
function workspaceHash(workspaceId: string): string {
  return createHash('sha256').update(workspaceId.trim()).digest('hex')
}

/**
 * Names the secret of a Team or Project channel destination inside the Workspace's existing
 * Automation webhook namespace, so Workspace closure deletes it with the others.
 *
 * @param workspaceId - Canonical Workspace ID.
 * @param target - Team or Project that owns the destination.
 * @param secretVersion - Version saved on the destination settings.
 * @returns Secret name that shows neither the Workspace nor the Team or Project.
 * @throws Error when the version is not a UUID.
 */
export function slackChannelDestinationSecretId(
  workspaceId: string,
  target: ChannelDestinationTarget,
  secretVersion: string,
): string {
  if (!isChannelDestinationSecretVersion(secretVersion)) throw new Error('Invalid webhook secret version.')
  const targetHash = createHash('sha256').update(channelDestinationTargetKey(target)).digest('hex')
  return `mukuroji/automation-webhooks/${workspaceHash(workspaceId)}/slack-channel/${targetHash}/${secretVersion}`
}

/** Secrets Manager adapter for Slack webhook URLs. */
export class SecretsManagerSlackDestinationSecretStore implements SlackDestinationSecretStore {
  /** Configured Secrets Manager client. */
  readonly #client: Pick<SecretsManagerClient, 'send'>

  /**
   * Creates the adapter.
   * @param client - Secrets Manager client configured by the composition root.
   */
  constructor(client: Pick<SecretsManagerClient, 'send'>) {
    this.#client = client
  }

  /** @inheritdoc */
  async put(secretId: string, webhookUrl: string): Promise<void> {
    try {
      await this.#client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: webhookUrl }))
      return
    } catch (error) {
      if (!isNamedError(error, 'ResourceNotFoundException')) throw destinationUnavailable()
    }
    try {
      await this.#client.send(new CreateSecretCommand({
        Name: secretId,
        Description: 'mukuroji Slack notification destination',
        SecretString: webhookUrl,
      }))
    } catch {
      // A secret deleted moments ago keeps its name for a short while; the caller may retry.
      throw destinationUnavailable()
    }
  }

  /** @inheritdoc */
  async read(secretId: string): Promise<string | undefined> {
    try {
      const response = await this.#client.send(new GetSecretValueCommand({ SecretId: secretId }), {
        abortSignal: AbortSignal.timeout(5_000),
      })
      return response.SecretString
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return undefined
      throw destinationUnavailable()
    }
  }

  /** @inheritdoc */
  async exists(secretId: string): Promise<boolean> {
    try {
      const response = await this.#client.send(new DescribeSecretCommand({ SecretId: secretId }))
      return response.DeletedDate === undefined
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return false
      throw destinationUnavailable()
    }
  }

  /** @inheritdoc */
  async delete(secretId: string): Promise<void> {
    try {
      await this.#client.send(new DeleteSecretCommand({ SecretId: secretId, ForceDeleteWithoutRecovery: true }))
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return
      throw destinationUnavailable()
    }
  }
}

/**
 * Builds the stable error for a Secrets Manager failure, without the provider message.
 * @returns A retryable 503 error.
 */
function destinationUnavailable(): NotificationError {
  return new NotificationError(503, 'NotificationDestinationUnavailable', 'The notification destination store is unavailable. Try again.')
}

/**
 * Tests an unknown error's name without exposing the provider error.
 * @param error - Caught value.
 * @param name - Expected error name.
 * @returns True when the error carries that name.
 */
function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}
