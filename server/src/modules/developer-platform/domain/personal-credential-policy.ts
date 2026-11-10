import {
  PERSONAL_API_KEY_MAX_LIFETIME_DAYS,
  PERSONAL_API_KEY_SCOPES,
  type PersonalApiKeyScope,
  type PersonalCredentialIssuanceBlock,
  type PersonalCredentialPolicy,
} from '@mukuroji/contracts'

/** Whether a member may issue or rotate a personal API key, and why not when they cannot. */
export type PersonalCredentialIssuanceDecision = {
  /** Whether issuance and rotation are allowed. */
  canIssue: boolean
  /** Reason issuance is blocked; omitted when allowed. */
  blockedReason?: PersonalCredentialIssuanceBlock
}

/**
 * Decides whether the current member may issue a personal API key.
 *
 * Guests are never allowed, regardless of the Workspace policy, because their access is external.
 *
 * @param eligibleMember - Whether the member is an active non-guest Workspace member.
 * @param policy - Current Workspace personal credential policy.
 * @returns The issuance decision.
 */
export function decidePersonalCredentialIssuance(
  eligibleMember: boolean,
  policy: PersonalCredentialPolicy,
): PersonalCredentialIssuanceDecision {
  if (!eligibleMember) return { canIssue: false, blockedReason: 'guest' }
  if (!policy.selfIssuanceEnabled) return { canIssue: false, blockedReason: 'policy-disabled' }
  return { canIssue: true }
}

/**
 * Checks that a personal API key expiry is in the future and within the maximum lifetime.
 *
 * @param expiresAt - Normalized ISO 8601 expiry.
 * @param now - Issuance or rotation time.
 * @returns Whether the expiry is allowed.
 */
export function isAllowedPersonalApiKeyExpiry(expiresAt: string, now: Date) {
  const expiry = Date.parse(expiresAt)
  const latest = now.getTime() + PERSONAL_API_KEY_MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1_000
  return Number.isFinite(expiry) && expiry > now.getTime() && expiry <= latest
}

/**
 * Narrows a scope string to a scope a member may grant to a personal API key.
 *
 * @param value - Candidate scope.
 * @returns Whether the scope is a personal API key scope.
 */
export function isPersonalApiKeyScope(value: string): value is PersonalApiKeyScope {
  return PERSONAL_API_KEY_SCOPES.some((scope) => scope === value)
}
