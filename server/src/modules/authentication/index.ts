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
  type InitiateAuthResponse,
  type ListCognitoUsersInput,
  type SoftwareTokenAssociation,
  type SoftwareTokenTarget,
} from './adapter-out/cognito/cognito-client'
