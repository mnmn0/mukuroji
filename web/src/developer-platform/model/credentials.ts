import type { ApiKeySummary, ApiScope, OAuthAppSummary } from '@mukuroji/contracts'

/**
 * Grant type supported by Developer Platform OAuth applications.
 */
export type DeveloperOAuthGrantType = Extract<
  OAuthAppSummary['grantTypes'][number],
  'client_credentials'
>

/**
 * Form value used to create a scoped API key.
 */
export type CreateDeveloperApiKeyInput = {
  /** Human-readable API key name. */
  name: string
  /** Least-privilege scopes granted to the API key. */
  scopes: ApiScope[]
  /** Optional ISO 8601 expiration timestamp. */
  expiresAt?: string
}

/**
 * API key metadata paired with its one-time secret.
 */
export type IssuedApiKeySecret = {
  /** Metadata for the issued API key. */
  apiKey: ApiKeySummary
  /** Secret value that is shown only once. */
  secret: string
}

/**
 * Form value used to create an OAuth application.
 */
export type CreateDeveloperOAuthAppInput = {
  /** Human-readable OAuth application name. */
  name: string
  /** OAuth grant types enabled for the application. */
  grantTypes: DeveloperOAuthGrantType[]
  /** API scopes granted to the OAuth application. */
  scopes: ApiScope[]
  /** Optional ISO 8601 credential expiration timestamp. */
  expiresAt?: string
}

/**
 * OAuth application metadata paired with its one-time client secret.
 */
export type IssuedOAuthClientSecret = {
  /** Metadata for the issued OAuth application. */
  oauthApp: OAuthAppSummary
  /** Client secret that is shown only once. */
  clientSecret: string
}

/**
 * Converts a date-only form value to an ISO timestamp at the local end of day.
 *
 * @param value - Date-only value in `YYYY-MM-DD` form.
 * @returns ISO 8601 timestamp representing the local end of that day.
 */
export function toLocalEndOfDayIso(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString()
}
