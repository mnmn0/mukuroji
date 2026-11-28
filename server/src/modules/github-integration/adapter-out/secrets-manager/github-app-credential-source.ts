import { createPrivateKey } from 'node:crypto'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import type { GitHubAppCredentialSource, GitHubAppCredentials } from '../../application/ports'

/** Milliseconds a read secret is reused, so a new value takes effect within this time. */
const CACHE_MILLISECONDS = 5 * 60_000

/** Numeric GitHub App ID. */
const APP_ID_PATTERN = /^[1-9][0-9]{0,19}$/u

/** Shortest webhook secret accepted. */
const WEBHOOK_SECRET_MIN_LENGTH = 20

/** Reads the raw secret string, or `undefined` when there is none. */
export type GitHubAppSecretLoader = () => Promise<string | undefined>

/**
 * Parses the App secret (ADR 0079): a JSON object with `appId`, `privateKey`, `webhookSecret`, and
 * optionally `previousWebhookSecret` during a webhook secret rotation.
 *
 * The placeholder the stack creates has none of these fields, which means "not configured". A
 * secret that has some but not all of them, or invalid ones, is an operator error and fails
 * closed instead of silently turning the App off.
 *
 * @param secretString - Secret string.
 * @returns The credentials, or `null` for the placeholder.
 * @throws GitHubIntegrationError `unavailable` for an invalid secret.
 */
export function parseGitHubAppSecret(secretString: string): GitHubAppCredentials | null {
  let value: unknown
  try {
    value = JSON.parse(secretString)
  } catch (error) {
    throw invalidSecret(error)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidSecret()
  const record: Record<string, unknown> = { ...value }
  const { appId, privateKey, webhookSecret, previousWebhookSecret } = record
  if (appId === undefined && privateKey === undefined && webhookSecret === undefined) return null
  if (
    typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) ||
    typeof privateKey !== 'string' ||
    typeof webhookSecret !== 'string' || webhookSecret.length < WEBHOOK_SECRET_MIN_LENGTH ||
    (previousWebhookSecret !== undefined &&
      (typeof previousWebhookSecret !== 'string' || previousWebhookSecret.length < WEBHOOK_SECRET_MIN_LENGTH))
  ) {
    throw invalidSecret()
  }
  try {
    const key = createPrivateKey(privateKey)
    if (key.asymmetricKeyType !== 'rsa') throw new TypeError('not RSA')
  } catch (error) {
    throw invalidSecret(error)
  }
  return {
    appId,
    privateKey,
    webhookSecrets: previousWebhookSecret === undefined ? [webhookSecret] : [webhookSecret, previousWebhookSecret],
  }
}

/**
 * Reads the App credentials from Secrets Manager and reuses them for five minutes.
 *
 * A failed read is not cached, so the next request tries again.
 */
export class CachedGitHubAppCredentialSource implements GitHubAppCredentialSource {
  /** Secret loader. */
  private readonly load: GitHubAppSecretLoader

  /** Clock. */
  private readonly now: () => number

  /** Last read and when it expires. */
  private cached: { value: GitHubAppCredentials | null, expiresAt: number } | undefined

  /** Read in progress. */
  private pending: Promise<GitHubAppCredentials | null> | undefined

  /**
   * Creates the source.
   *
   * @param load - Reads the raw secret; `undefined` means the deployment has no App module.
   * @param now - Clock, replaced in tests.
   */
  constructor(load: GitHubAppSecretLoader, now: () => number = Date.now) {
    this.load = load
    this.now = now
  }

  /**
   * Reads the credentials.
   *
   * @returns The credentials, or `null` when the App is not configured.
   */
  async read(): Promise<GitHubAppCredentials | null> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.value
    const current = this.pending ??= this.refresh()
    try {
      return await current
    } finally {
      if (this.pending === current) this.pending = undefined
    }
  }

  /**
   * Loads and parses the secret, then caches it.
   *
   * @returns The credentials, or `null`.
   */
  private async refresh(): Promise<GitHubAppCredentials | null> {
    let secretString: string | undefined
    try {
      secretString = await this.load()
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubAppCredentialsUnavailable', 'The GitHub App credentials could not be read.', { cause: error })
    }
    const value = secretString === undefined ? null : parseGitHubAppSecret(secretString)
    this.cached = { value, expiresAt: this.now() + CACHE_MILLISECONDS }
    return value
  }
}

/**
 * Builds the error of a malformed App secret without its contents.
 *
 * @param cause - Underlying parse error.
 * @returns The error.
 */
function invalidSecret(cause?: unknown): GitHubIntegrationError {
  return new GitHubIntegrationError(
    'unavailable',
    'GitHubAppCredentialsInvalid',
    'The GitHub App secret must hold appId, an RSA privateKey, and a webhookSecret of at least 20 characters.',
    cause === undefined ? {} : { cause },
  )
}
