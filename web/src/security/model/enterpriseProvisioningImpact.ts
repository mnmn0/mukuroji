import type { EnterpriseProvisioningImpact } from '../api'

/**
 * Reports whether a provisioning preview has expired.
 *
 * @param impact - Dry-run preview to evaluate.
 * @param currentTime - Epoch milliseconds used for the comparison.
 * @returns `true` when the expiry is invalid or no longer in the future.
 */
export function isEnterpriseProvisioningImpactExpired(
  impact: EnterpriseProvisioningImpact,
  currentTime = Date.now(),
): boolean {
  const expiresAt = Date.parse(impact.expiresAt)

  return !Number.isFinite(expiresAt) || expiresAt <= currentTime
}
