import useSWR from 'swr'
import { getAccountSecurity } from '../../../auth/api'

/** SWR options for the account security status. */
const accountSecurityQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Reads how the signed-in user signs in: password, authenticator app, and the MFA policy.
 *
 * @param accessToken - Access token of the session.
 * @returns The SWR state of the account security status.
 */
export function useAccountSecurity(accessToken: string) {
  return useSWR(
    ['account-security', accessToken] as const,
    ([, token]) => getAccountSecurity(token),
    accountSecurityQueryConfig,
  )
}
