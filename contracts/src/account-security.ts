/**
 * Password reset, password change, and authenticator (TOTP) contracts shared by the API and the
 * Web.
 */

/** Response of `GET /api/auth/account-security`: how the signed-in user signs in. */
export type AccountSecurityStatus = {
  /** Whether the user signs in with a mukuroji password; false for an enterprise SSO session. */
  passwordManaged: boolean
  /** Whether an authenticator app (TOTP) is registered and enabled. */
  softwareTokenMfaEnabled: boolean
  /** Whether the Workspace security policy requires MFA, so TOTP cannot be turned off. */
  mfaRequiredByPolicy: boolean
}

/** Response that starts authenticator (TOTP) registration. */
export type SoftwareTokenSetupStart = {
  /** Base32 shared secret to add to the authenticator app. */
  secretCode: string
  /** Account name to show in the authenticator app, the user's email address. */
  accountName: string
  /** Updated Cognito session, returned only while answering the sign-in MFA_SETUP challenge. */
  session?: string
}

/**
 * Sign-in challenge asking the user to register an authenticator app before the session can be
 * used.
 *
 * Exactly one of `session` and `setupAccessToken` is present. `session` comes from Cognito's
 * own MFA_SETUP challenge. `setupAccessToken` is returned when the Workspace policy requires MFA
 * and the user has none yet: it only works for the authenticator endpoints, and the user signs
 * in again with the new code after registration.
 */
export type MfaSetupChallenge = {
  /** Challenge name. */
  challenge: 'MFA_SETUP'
  /** Normalized email address of the user. */
  email: string
  /** Cognito challenge session. */
  session?: string
  /** Access token of a password-only sign-in, limited to authenticator setup. */
  setupAccessToken?: string
}

/** MFA state of one Workspace member, as administrators see it. */
export type WorkspaceMemberMfaStatus =
  /** An authenticator app is registered. */
  | 'enrolled'
  /** No authenticator app is registered. */
  | 'not-enrolled'
  /** The member signs in through enforced enterprise SSO; the identity provider owns MFA. */
  | 'sso'
  /** The state could not be read. */
  | 'unknown'

/** Whether an administrator can send a password reset to a member. */
export type WorkspaceMemberPasswordResetAvailability =
  /** A reset can be sent. */
  | 'available'
  /** The member has not accepted the invitation yet; resend the invitation instead. */
  | 'invitation-pending'
  /** The member signs in through enforced enterprise SSO. */
  | 'sso'
  /** The Cognito user is missing or disabled. */
  | 'unavailable'

/** Sign-in security state of one active Workspace member. */
export type WorkspaceMemberSignInSecurity = {
  /** Member key of the member. */
  memberKey: string
  /** MFA state. */
  mfa: WorkspaceMemberMfaStatus
  /** Whether an administrator can send a password reset. */
  passwordReset: WorkspaceMemberPasswordResetAvailability
}

/** Response of `GET /api/workspace/members/sign-in-security`. */
export type WorkspaceMembersSignInSecurityResponse = {
  /** State of each active member. */
  members: WorkspaceMemberSignInSecurity[]
  /**
   * Member keys of the active members who are system administrators (ADR 0067). Absent when the
   * system administrator groups could not be read.
   */
  systemAdministratorMemberKeys?: string[]
}

/** Request body of `PUT /api/workspace/members/:memberKey/system-administrator`. */
export type WorkspaceMemberSystemAdministratorRequest = {
  /** Whether the member should be a system administrator. */
  systemAdministrator: boolean
}

/** Response of `PUT /api/workspace/members/:memberKey/system-administrator`. */
export type WorkspaceMemberSystemAdministratorResponse = {
  /** Whether the member is a system administrator afterwards. */
  systemAdministrator: boolean
  /** Whether the request changed the member; false when the member already had that state. */
  changed: boolean
}

/** MFA part of the security policy preview, present when the change turns MFA on. */
export type EnterpriseMfaRequirementImpact = {
  /** Active members inspected. */
  activeMemberCount: number
  /**
   * Active members without any MFA method; they must register an authenticator app at their next
   * sign-in. Members with SMS or email MFA are not counted.
   */
  unenrolledMemberCount: number
  /** Active members whose state could not be read. */
  unknownMemberCount: number
}
