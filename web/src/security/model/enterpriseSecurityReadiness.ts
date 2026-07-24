import type { EnterpriseSecuritySnapshot } from '../api'

/**
 * SSO enforcement を安全に有効化する prerequisite の状態です。
 */
export type EnterpriseSsoPrerequisites = {
  /** Identity provider の接続テストが成功済みかどうかです。 */
  identityProviderVerified: boolean
  /** Verified domain が1件以上あるかどうかです。 */
  verifiedDomain: boolean
  /** MFA 済みの active break-glass login 経路が存在するかどうかです。 */
  breakGlassReady: boolean
  /** すべての prerequisite が成立しているかどうかです。 */
  complete: boolean
}

/**
 * Builds the SSO prerequisite view model from non-sensitive server readiness.
 *
 * @param snapshot - Enterprise security snapshot.
 * @returns Resolved prerequisites for SSO enforcement.
 */
export function resolveEnterpriseSsoPrerequisites(
  snapshot: EnterpriseSecuritySnapshot,
): EnterpriseSsoPrerequisites {
  const identityProviderVerified = snapshot.ssoPrerequisites.providerReady
  const verifiedDomain = snapshot.ssoPrerequisites.domainReady
  const breakGlassReady = snapshot.ssoPrerequisites.breakGlassReady

  return {
    breakGlassReady,
    complete: identityProviderVerified && verifiedDomain && breakGlassReady,
    identityProviderVerified,
    verifiedDomain,
  }
}
