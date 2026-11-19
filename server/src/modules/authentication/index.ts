/** Authentication module public domain surface. */
export {
  readCognitoMfaChallengeName,
  resolveCognitoMfaResponseKey,
  type CognitoMfaChallengeName,
} from './domain/mfa-challenge'
export {
  AwsCognitoClient,
  clampCognitoPageLimit,
  CognitoServiceError,
  createCognitoClient,
  FlociCognitoClient,
  getSystemAdminGroups,
  isCognitoUserNotFoundError,
  normalizeCognitoUserId,
  type AuthTokenSet,
  type CognitoClient,
  type CognitoUserProfile,
  type CognitoUsersResponse,
  type EnterpriseCognitoSsoAppClientBinding,
  type GetUserResponse,
  type VerifiedAccessTokenUser,
  type InitiateAuthResponse,
  type ListCognitoUsersInput,
  type SoftwareTokenAssociation,
  type SoftwareTokenTarget,
} from './adapter-out/cognito/cognito-client'
export {
  confirmSoftwareTokenEnrollment,
  SoftwareTokenEnrollmentError,
  startSoftwareTokenEnrollment,
  type SoftwareTokenEnrollee,
  type SoftwareTokenEnrollmentErrorCode,
  type SoftwareTokenEnrollmentPorts,
} from './application/software-token-enrollment'
export {
  AccountCredentialChangeError,
  changeAccountPassword,
  confirmAccountPasswordReset,
  removeSoftwareToken,
  requestAccountPasswordReset,
  type AccountCredentialChangeErrorCode,
  type AccountCredentialChangeErrorStatus,
  type PasswordChangePorts,
  type PasswordChanger,
  type PasswordResetPorts,
  type SoftwareTokenRemovalPorts,
  type SoftwareTokenRemover,
} from './application/account-credential-changes'
export {
  confirmMfaSetupChallenge,
  MfaSetupChallengeError,
  startMfaSetupChallenge,
  type MfaSetupChallengeAnswer,
  type MfaSetupChallengeErrorCode,
  type MfaSetupChallengePorts,
  type MfaSetupChallengeSignIn,
} from './application/mfa-setup-challenge'
export {
  decidePolicyMfaSetup,
  type PolicyMfaSetupDecision,
  type PolicyMfaSetupPorts,
} from './application/policy-mfa-setup'
