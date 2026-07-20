import type { EnterpriseSecurityApiError } from '../api'

/**
 * Security 管理 API の error が fresh authentication で再開可能か判定します。
 *
 * @param error - Security 管理 API が返した authorization error です。
 * @returns Password/MFA をやり直す必要がある場合は true です。
 */
export function requiresFreshEnterpriseAuthentication(
  error?: EnterpriseSecurityApiError,
) {
  return error?.status === 401 ||
    error?.code === 'EnterpriseSessionMfaRequired' ||
    error?.code === 'EnterpriseSessionExpired' ||
    error?.code === 'EnterpriseSessionIdleTimeout' ||
    error?.code === 'EnterpriseSessionReauthenticationRequired' ||
    error?.code === 'EnterpriseBreakGlassMfaRequired' ||
    error?.code === 'EnterpriseBreakGlassReauthenticationRequired'
}
