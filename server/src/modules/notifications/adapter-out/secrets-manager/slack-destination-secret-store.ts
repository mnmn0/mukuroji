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

/** Waits before each retry while a just-deleted secret's name is released (about 3.5 s in all). */
const nameReleaseRetryDelaysMs: readonly number[] = [500, 1_000, 2_000]

/** Secrets Manager adapter for Slack webhook URLs. */
export class SecretsManagerSlackDestinationSecretStore implements SlackDestinationSecretStore {
  /** Configured Secrets Manager client. */
  readonly #client: Pick<SecretsManagerClient, 'send'>
  /** Waits between attempts while a deleted secret's name is released. */
  readonly #sleep: (milliseconds: number) => Promise<void>

  /**
   * Creates the adapter.
   * @param client - Secrets Manager client configured by the composition root.
   * @param sleep - Wait used between name-release retries; tests pass an immediate one.
   */
  constructor(
    client: Pick<SecretsManagerClient, 'send'>,
    sleep: (milliseconds: number) => Promise<void> = async (milliseconds) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds))
    },
  ) {
    this.#client = client
    this.#sleep = sleep
  }

  /** @inheritdoc */
  async put(secretId: string, webhookUrl: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.#putOnce(secretId, webhookUrl)
      if (outcome === 'stored') return
      // A secret deleted moments ago keeps its name until Secrets Manager releases it.
      if (attempt >= nameReleaseRetryDelaysMs.length) throw destinationUnavailable()
      await this.#sleep(nameReleaseRetryDelaysMs[attempt] ?? 0)
    }
  }

  /**
   * Updates the secret, or creates it when it does not exist.
   * @param secretId - Server-derived secret name.
   * @param webhookUrl - Validated webhook URL.
   * @returns `stored`, or `name-pending` while a just-deleted secret still holds the name.
   * @throws Error when Secrets Manager refuses for any other reason.
   */
  async #putOnce(secretId: string, webhookUrl: string): Promise<'stored' | 'name-pending'> {
    try {
      await this.#client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: webhookUrl }))
      return 'stored'
    } catch (error) {
      if (isNamedError(error, 'InvalidRequestException')) return await this.#pendingDeletionOrFail(secretId)
      if (!isNamedError(error, 'ResourceNotFoundException')) throw destinationUnavailable()
    }
    try {
      await this.#client.send(new CreateSecretCommand({
        Name: secretId,
        Description: 'mukuroji Slack notification destination',
        SecretString: webhookUrl,
      }))
      return 'stored'
    } catch (error) {
      if (isNamedError(error, 'InvalidRequestException') || isNamedError(error, 'ResourceExistsException')) {
        return await this.#pendingDeletionOrFail(secretId)
      }
      throw destinationUnavailable()
    }
  }

  /**
   * Tells a just-deleted secret whose name is not released yet from any other refusal.
   * @param secretId - Server-derived secret name.
   * @returns `name-pending` when the secret is marked deleted or already gone.
   * @throws Error for any other state, such as a secret managed by another service.
   */
  async #pendingDeletionOrFail(secretId: string): Promise<'name-pending'> {
    try {
      const described = await this.#client.send(new DescribeSecretCommand({ SecretId: secretId }))
      if (described.DeletedDate !== undefined) return 'name-pending'
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return 'name-pending'
    }
    throw destinationUnavailable()
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
