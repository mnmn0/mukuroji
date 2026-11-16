import {
  changePassword,
  disableSoftwareToken,
  startSoftwareTokenSetup,
  verifySoftwareTokenSetup,
  type AccountSecurityStatus,
  type ChangePasswordInput,
} from '../../../auth/api'
import { useAccountSecurity } from '../queries/useAccountSecurity'

/**
 * Writes an authenticator state the API confirmed into the cached sign-in settings.
 *
 * @param current - Cached settings, if any.
 * @param enabled - Whether the authenticator is now on.
 * @returns The settings to cache.
 */
export function withAuthenticatorState(current: AccountSecurityStatus | undefined, enabled: boolean) {
  return current && { ...current, softwareTokenMfaEnabled: enabled }
}

/**
 * Tells apart a first load that failed from a reload that failed while settings are shown.
 *
 * @param hasData - Whether settings are cached.
 * @param error - Error of the latest load, if any.
 * @returns Which failure to show.
 */
export function resolveAccountSecurityLoadFailure(hasData: boolean, error: unknown) {
  return {
    loadFailed: Boolean(error) && !hasData,
    reloadFailed: Boolean(error) && hasData,
  }
}

/**
 * Loads the signed-in user's sign-in settings and connects password and authenticator changes.
 *
 * After an authenticator change succeeds, the confirmed state is written into the cache before
 * it is reloaded, so that a failed reload cannot show the old state next to the success notice.
 * A failed reload is reported separately, with a way to try again, while the settings stay.
 *
 * @param accessToken - Access token of the session.
 * @returns The state and actions of the account security panel.
 */
export function useAccountSecurityController(accessToken: string) {
  const { data, error, isLoading, mutate } = useAccountSecurity(accessToken)

  /**
   * Stores the authenticator state the API just confirmed and reloads the rest.
   *
   * @param enabled - Whether the authenticator is now on.
   */
  const applyAuthenticatorState = (enabled: boolean) => {
    void mutate((current?: AccountSecurityStatus) => withAuthenticatorState(current, enabled), {
      revalidate: true,
    })
  }

  return {
    status: data,
    isLoading,
    ...resolveAccountSecurityLoadFailure(Boolean(data), error),
    onChangePassword: (input: ChangePasswordInput) => changePassword(accessToken, input),
    onStartMfaSetup: () => startSoftwareTokenSetup(accessToken),
    async onVerifyMfaSetup(code: string) {
      await verifySoftwareTokenSetup(accessToken, code)
      applyAuthenticatorState(true)
    },
    async onDisableMfa() {
      await disableSoftwareToken(accessToken)
      applyAuthenticatorState(false)
    },
    onRetry: () => void mutate(),
  }
}
