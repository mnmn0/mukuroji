/** Enterprise Identity module public application and domain surface. */
export {
  DynamoDbEnterpriseIdentityReadClient,
  DynamoDbEnterpriseIdentityMaintenanceClient,
  EnterpriseIdentityError,
  assertEnterpriseCognitoProviderBinding,
  assertEnterpriseCognitoFederationBinding,
  assertEnterpriseIdentityProviderReady,
  canAssignEnterpriseRole,
  evaluateEnterpriseAccess,
  ipMatchesCidr,
  isEnterpriseRoleCompatibleWithScope,
  resolveEnterpriseDirectoryPrincipal,
  resolveEnterpriseRolePermissions,
  resolveRoutePermission,
  resolveRoutePermissions,
  validateEnterpriseSession,
  type EnterpriseAuthorizationResource,
  type EnterpriseCognitoFederationBinding,
  type EnterpriseDirectoryGroupMembership,
  type EnterpriseDirectoryPrincipalResolution,
  type EnterpriseEffectiveAccess,
  type EnterpriseIdentityClient,
  type EnterpriseIdentityReadClient,
  type EnterprisePrincipalContext,
  type EnterpriseScimGroupJobApplyInput,
  type EnterpriseScimGroupJobApplyUser,
  type EnterpriseScimGroupJobProcessResult,
  type EnterpriseScimGroupPage,
  type EnterpriseScimGroupListFilter,
  type EnterpriseScimGroupListInput,
  type EnterpriseScimResourceLimits,
  type EnterpriseScimUserListFilter,
  type EnterpriseScimUserListInput,
  type EnterpriseScimUserPage,
  type EnterpriseSessionContext,
  type EnterpriseSessionValidation,
  type EvaluateEnterpriseAccessInput,
} from './enterprise-identity'
export {
  processEnterpriseIdentityMaintenanceBatch,
} from './adapter-in/events/identity-maintenance'
export {
  EnterpriseSessionActivityError,
  type EnterpriseSessionActivityClient,
  type EnterpriseSessionActivityInput,
  type EnterpriseSessionAssuranceInput,
} from './enterprise-session-activity'
export {
  EnterpriseSsoError,
  buildCognitoAuthorizeUrl,
  createEnterpriseSsoAuthenticationMethod,
  createEnterpriseSsoState,
  isEnterpriseSsoAuthenticationMethod,
  normalizeEnterpriseSsoReturnTo,
  parseEnterpriseSsoTokenResponse,
  validateEnterpriseSsoState,
  type BuildCognitoAuthorizeUrlInput,
  type CreateEnterpriseSsoStateInput,
  type EnterpriseSsoAuthenticationResult,
  type EnterpriseSsoStateBundle,
  type ParseEnterpriseSsoTokenResponseInput,
  type ValidatedEnterpriseSsoState,
  type ValidateEnterpriseSsoStateInput,
} from './enterprise-sso'
export {
  createEnterpriseCognitoInspectionCache,
} from './enterprise-cognito-inspection-cache'
export type {
  EnterpriseScimGroupJobProcessor,
} from './application/ports/scim-group-job-processor'
export type {
  EnterpriseScimGroupJobReference,
} from './domain/scim-group-job-reference'
