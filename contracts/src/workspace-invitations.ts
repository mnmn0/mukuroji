/** Longest email address a Workspace invitation accepts, after trimming (RFC 5321 path limit). */
export const WORKSPACE_INVITATION_EMAIL_MAX_LENGTH = 254

/** Longest display name a Workspace invitation accepts, after trimming. */
export const WORKSPACE_INVITATION_NAME_MAX_LENGTH = 128

/** Most invitations one bulk invitation in the Web app sends. */
export const WORKSPACE_BULK_INVITATION_MAX_ROWS = 200

/**
 * Normalizes an invitation email address the way the API stores it.
 *
 * @param value - Raw email address.
 * @returns The trimmed, lower-cased address.
 */
export function normalizeWorkspaceInvitationEmail(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Tells whether a normalized email address can receive a Workspace invitation.
 *
 * It accepts one `@` between a non-empty local part and a domain with at least one dot, no
 * whitespace or control characters, and no more than
 * {@link WORKSPACE_INVITATION_EMAIL_MAX_LENGTH} characters. It does not try to accept every
 * address RFC 5322 allows; it rejects what is clearly not a deliverable address.
 *
 * @param email - Address normalized with {@link normalizeWorkspaceInvitationEmail}.
 * @returns Whether the address is acceptable.
 */
export function isWorkspaceInvitationEmail(email: string): boolean {
  if (email.length === 0 || email.length > WORKSPACE_INVITATION_EMAIL_MAX_LENGTH) {
    return false
  }
  // Whitespace, control characters, quotes and angle brackets point at a pasted "Name <a@b>" or a
  // broken CSV cell rather than an address.
  if (/[\s\p{Cc}"<>(),;:\\[\]]/u.test(email)) {
    return false
  }
  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@')) {
    return false
  }
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false
  }
  const labels = domain.split('.')
  return labels.length >= 2 && labels.every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  )
}
