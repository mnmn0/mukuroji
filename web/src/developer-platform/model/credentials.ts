import type {
  ApiKeyOneTimeSecretOutput,
  CreateApiKeyInput,
  CreateOAuthAppInput,
  OAuthAppOneTimeSecretOutput,
  OAuthGrantType,
} from '@mukuroji/contracts'

/**
 * Grant type supported by Developer Platform OAuth applications.
 */
export type DeveloperOAuthGrantType = Extract<
  OAuthGrantType,
  'client_credentials'
>

/**
 * Form value used to create a scoped API key.
 */
export type CreateDeveloperApiKeyInput = CreateApiKeyInput

/**
 * API key metadata paired with its one-time secret.
 */
export type IssuedApiKeySecret = ApiKeyOneTimeSecretOutput

/**
 * Form value used to create an OAuth application.
 */
export type CreateDeveloperOAuthAppInput = CreateOAuthAppInput

/**
 * OAuth application metadata paired with its one-time client secret.
 */
export type IssuedOAuthClientSecret = OAuthAppOneTimeSecretOutput

/**
 * Converts a date-only form value to an ISO timestamp at the local end of day.
 *
 * @param value - Date-only value in `YYYY-MM-DD` form.
 * @returns ISO 8601 timestamp representing the local end of that day.
 */
export function toLocalEndOfDayIso(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString()
}
