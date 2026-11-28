import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { isSlackTeamOrAppId } from '../../domain/slack-events'
import { SlackIngestError } from '../../errors'
import type { SlackIngestConfig, SlackIngestConfigSource } from '../../application/ports/slack-ingest-ports'

/** Name of the operator-created secret that holds the Slack app settings (ADR 0113). */
export const SLACK_INGEST_SECRET_NAME = 'mukuroji/slack-ingest'

/** Milliseconds a read secret is reused before reading it again. */
const CACHE_MS = 5 * 60_000

/** Workspace ID shape accepted from the secret. */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

/**
 * Reports whether an error is a named AWS SDK error.
 *
 * @param error - Thrown value.
 * @param name - Error name.
 * @returns Whether the error has the name.
 */
function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

/**
 * Parses the secret JSON.
 *
 * @param text - Secret string.
 * @returns The settings.
 * @throws SlackIngestError `not-configured` when a field is missing or malformed.
 */
export function parseSlackIngestSecret(text: string): SlackIngestConfig {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidSecret()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidSecret()
  const signingSecret = Reflect.get(value, 'signingSecret')
  const botToken = Reflect.get(value, 'botToken')
  const teamId = Reflect.get(value, 'teamId')
  const appId = Reflect.get(value, 'appId')
  const workspaceId = Reflect.get(value, 'workspaceId')
  if (
    typeof signingSecret !== 'string' || !/^[0-9a-f]{16,128}$/u.test(signingSecret) ||
    typeof botToken !== 'string' || !/^xoxb-[A-Za-z0-9-]{10,256}$/u.test(botToken) ||
    !isSlackTeamOrAppId(teamId) ||
    (appId !== undefined && !isSlackTeamOrAppId(appId)) ||
    typeof workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    throw invalidSecret()
  }
  return { signingSecret, botToken, teamId, ...(isSlackTeamOrAppId(appId) ? { appId } : {}), workspaceId }
}

/**
 * Creates the error for a secret that exists but cannot be used.
 *
 * @returns The error, without any secret value.
 */
function invalidSecret(): SlackIngestError {
  return new SlackIngestError('not-configured', 'SlackIngestSecretInvalid', 'The Slack app secret is not valid JSON with the expected fields.')
}

/** Reads the Slack app settings from Secrets Manager, caching them for five minutes. */
export class SecretsManagerSlackIngestConfigSource implements SlackIngestConfigSource {
  /** Secrets Manager client. */
  private readonly client: SecretsManagerClient
  /** Secret name. */
  private readonly secretId: string
  /** Clock in milliseconds. */
  private readonly nowMs: () => number
  /** Last read value and when it was read. */
  private cached: { value: SlackIngestConfig | undefined, readAt: number } | undefined

  /**
   * Creates the source.
   *
   * @param client - Secrets Manager client.
   * @param secretId - Secret name.
   * @param nowMs - Clock, replaced in tests.
   */
  constructor(client: SecretsManagerClient, secretId = SLACK_INGEST_SECRET_NAME, nowMs: () => number = Date.now) {
    this.client = client
    this.secretId = secretId
    this.nowMs = nowMs
  }

  /**
   * Reads the settings.
   *
   * @returns The settings, or `undefined` when the secret does not exist.
   * @throws SlackIngestError when the secret exists but is malformed.
   */
  async read(): Promise<SlackIngestConfig | undefined> {
    const now = this.nowMs()
    if (this.cached && now - this.cached.readAt < CACHE_MS) return this.cached.value
    let value: SlackIngestConfig | undefined
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }))
      if (typeof response.SecretString !== 'string') throw invalidSecret()
      value = parseSlackIngestSecret(response.SecretString)
    } catch (error) {
      if (!isNamedError(error, 'ResourceNotFoundException')) throw error
      value = undefined
    }
    this.cached = { value, readAt: now }
    return value
  }
}

/** Source used where the deployment has no Slack ingest queue: always not configured. */
export const unconfiguredSlackIngestConfigSource: SlackIngestConfigSource = {
  /**
   * Reads nothing.
   *
   * @returns `undefined`.
   */
  async read() {
    return undefined
  },
}
