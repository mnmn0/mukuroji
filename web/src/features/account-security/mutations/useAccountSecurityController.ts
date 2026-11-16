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
 * Loads the signed-in user's sign-in settings and connects password and authenticator changes.
 *
 * After an authenticator change succeeds, the confirmed state is written into the cache before
 * it is reloaded, so that a failed reload cannot show the old state next to the success notice.
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
    void mutate(
      (current?: AccountSecurityStatus) => current && { ...current, softwareTokenMfaEnabled: enabled },
      { revalidate: true },
    )
  }

  return {
    status: data,
    isLoading,
    loadFailed: Boolean(error) && !data,
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
