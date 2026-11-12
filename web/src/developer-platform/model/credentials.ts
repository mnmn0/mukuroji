import type {
  ApiKeyOneTimeSecretOutput,
  CreateApiKeyInput,
  CreateOAuthAppInput,
  OAuthAppOneTimeSecretOutput,
  OAuthGrantType,
  PersonalCredentialAdministration,
  PersonalCredentialPolicy,
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

/**
 * Policy an administrator saved, with the personal-key classification that was loaded when it was saved.
 */
export type SavedPersonalCredentialPolicy = {
  /** Policy returned by the successful update. */
  policy: PersonalCredentialPolicy
  /** Classification that was on screen when the policy was saved. */
  basis: PersonalCredentialAdministration | undefined
}

/**
 * Shows a saved policy on top of a classification that has not reloaded since the save.
 *
 * The saved policy applies only while the loaded classification is still the one it was saved over, which
 * happens when reloading failed. Any newer classification already carries the server's policy and wins.
 *
 * @param current - Classification currently loaded, if any.
 * @param saved - Policy saved by the last successful update, if any.
 * @returns The classification to display.
 */
export function applySavedPersonalCredentialPolicy(
  current: PersonalCredentialAdministration | undefined,
  saved: SavedPersonalCredentialPolicy | undefined,
): PersonalCredentialAdministration | undefined {
  if (!current || !saved || saved.basis !== current) {
    return current
  }
  return { ...current, policy: saved.policy }
}
