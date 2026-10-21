import { createHash } from 'node:crypto'
import {
  type EnterpriseIdentityProvider,
  type EnterpriseIdentitySnapshot,
  type EnterprisePermissionId,
  type EnterpriseRoleScope,
} from '@mukuroji/contracts'
import { getConnInfo } from 'hono/aws-lambda'
import type { Context } from 'hono'
import { type AppDependencies } from '../../app/composition/app-dependencies'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  CognitoServiceError,
  type EnterpriseCognitoSsoAppClientBinding,
} from '../../modules/authentication'
import {
  type ProjectAccessEntry,
  type ProjectDirectoryResponse,
  type ProjectRole,
} from '../../modules/directory'
import {
  WorkspaceAccessError,
  type WorkspaceRole,
} from '../../modules/workspace-access/workspace-access'
import {
  EnterpriseIdentityError,
  assertEnterpriseCognitoFederationBinding,
  assertEnterpriseIdentityProviderReady,
  type EnterpriseAuthorizationResource,
  type EnterpriseCognitoFederationBinding,
  type EnterprisePrincipalContext,
} from '../../modules/enterprise-identity'
import {
  createEnterpriseCognitoInspectionCache,
} from '../../modules/enterprise-identity/enterprise-cognito-inspection-cache'
import {
  isEnterpriseSsoAuthenticationMethod,
} from '../../modules/enterprise-identity/enterprise-sso'
import {
  EnterpriseSessionActivityError,
} from '../../modules/enterprise-identity/enterprise-session-activity'
import { type DocumentProjectRole } from '../../modules/documents'
import {
  authenticationDependencies,
  requireAppDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { ENTERPRISE_SERVICE_ACCOUNT_SNAPSHOT_RETRY_LIMIT } from './constants'
import { resolveRequestClientKey } from './http'
import { getAwsRegion, getEnv, trimTrailingSlash } from './runtime-config'
import { decodeJwtPayload } from './token-claims'

/**
 * Cognito access token の payload から読む claims です。
 */
export type CognitoAccessTokenClaims = {
  /**
   * Cognito user の immutable subject です。
   */
  sub?: unknown
  /**
   * Cognito access token の username です。
   */
  username?: unknown
  /**
   * Workspace partition を示す custom claim です。
   */
  'custom:directory_id'?: unknown
  /**
   * Cognito が認証を完了した epoch seconds です。
   */
  auth_time?: unknown
  /**
   * Access token を発行した epoch seconds です。
   */
  iat?: unknown
  /**
   * Access token が失効する epoch seconds です。
   */
  exp?: unknown
  /**
   * Authentication method reference 一覧です。
   */
  amr?: unknown
  /**
   * Cognito が返す authentication method reference 一覧です。
   */
  'cognito:amr'?: unknown
  /**
   * Cognito グループ名の配列です。
   */
  'cognito:groups'?: unknown
  /**
   * token を発行した Cognito user pool の issuer です。
   */
  iss?: unknown
  /**
   * token を発行した Cognito app client ID です。
   */
  client_id?: unknown
  /**
   * Cognito token の用途です。
   */
  token_use?: unknown
}

/**
 * Enterprise route 評価で特定 Team に付与された permission です。
 */
export type EnterpriseTeamAccess = {
  /** Permission の対象 Team ID です。 */
  teamId: string
  /** 対象 Team scope で有効な permission です。 */
  permissions: EnterprisePermissionId[]
}

/** Enterprise permission set retained for one Team-qualified Project scope. */
export type EnterpriseProjectScopeAccess = {
  /** Team that owns the Project scope. */
  teamId: string
  /** Project identifier within the owning Team. */
  projectId: string
  /** Permissions granted at this exact qualified scope. */
  permissions: EnterprisePermissionId[]
}

/**
 * Current request と独立した resource permission を再評価する Enterprise snapshot です。
 */
export type EnterpriseAuthorizationEvaluationSnapshot = {
  /** Directory、external ceiling、principal kind を解決済みの principal です。 */
  principal: EnterprisePrincipalContext
  /** 認証時に読み込んだ authoritative Enterprise state です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Provider binding と current membership に適合した role assignment です。 */
  assignments: EnterpriseIdentitySnapshot['roleAssignments']
  /** Provider binding と current membership に適合した group mapping です。 */
  groupMappings: EnterpriseIdentitySnapshot['groupMappings']
}

/** Cognito binding inspection を live read するか短期 cache から読むかを指定します。 */
type EnterpriseCognitoInspectionMode = 'cached' | 'fresh'

const enterpriseCognitoFederationBindingCaches = new WeakMap<
  Readonly<AppDependencies>,
  ReturnType<
    typeof createEnterpriseCognitoInspectionCache<
      EnterpriseCognitoFederationBinding
    >
  >
>()

const enterpriseCognitoSsoAppClientBindingCaches = new WeakMap<
  Readonly<AppDependencies>,
  ReturnType<
    typeof createEnterpriseCognitoInspectionCache<
      EnterpriseCognitoSsoAppClientBinding
    >
  >
>()

function getEnterpriseCognitoFederationBindingCache() {
  const dependencies = requireAppDependencies()
  let cache = enterpriseCognitoFederationBindingCaches.get(dependencies)
  if (!cache) {
    cache =
      createEnterpriseCognitoInspectionCache<EnterpriseCognitoFederationBinding>()
    enterpriseCognitoFederationBindingCaches.set(dependencies, cache)
  }
  return cache
}

function getEnterpriseCognitoSsoAppClientBindingCache() {
  const dependencies = requireAppDependencies()
  let cache = enterpriseCognitoSsoAppClientBindingCaches.get(dependencies)
  if (!cache) {
    cache =
      createEnterpriseCognitoInspectionCache<EnterpriseCognitoSsoAppClientBinding>()
    enterpriseCognitoSsoAppClientBindingCaches.set(dependencies, cache)
  }
  return cache
}

/**
 * Reports whether the deployment explicitly configured every SSO dependency.
 * @returns True only when the dedicated client, federation, and signing settings exist.
 * @throws EnterpriseIdentityError when configuration is only partially present.
 */
export function isEnterpriseSsoConfigured(): boolean {
  const configured = [
    'COGNITO_SSO_CLIENT_ID',
    'COGNITO_HOSTED_UI_DOMAIN',
    'COGNITO_SSO_REDIRECT_URI',
    'COGNITO_ENTERPRISE_IDP_NAME',
    'ENTERPRISE_SSO_STATE_SECRET',
  ].map((name) => Boolean(getEnv(name)?.trim()))
  if (!configured.some(Boolean)) return false
  if (!configured.every(Boolean)) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseSsoConfigurationIncomplete',
      'Enterprise SSO deployment configuration is incomplete.',
    )
  }
  return true
}

/**
 * Reads the Cognito SSO app client configuration.
 *
 * @returns The SSO app client configuration; throws a 503 error when it is incomplete.
 */
export function requireEnterpriseCognitoSsoAppClientConfiguration() {
  const mainClientId = getEnv('COGNITO_CLIENT_ID')?.trim()
  const clientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()
  const redirectUri = getEnv('COGNITO_SSO_REDIRECT_URI')?.trim()
  const identityProviderName = getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim()
  if (
    !mainClientId ||
    !clientId ||
    clientId === mainClientId ||
    !redirectUri ||
    !identityProviderName
  ) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientUnavailable',
      'A distinct Cognito enterprise SSO app client is not configured.',
    )
  }
  return { clientId, redirectUri, identityProviderName }
}

/**
 * Reads the configured Cognito enterprise identity provider name.
 *
 * @returns The configured provider name; throws a 503 enterprise identity error when it is missing.
 */
export function requireEnterpriseCognitoProviderName() {
  const identityProviderName = getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim()
  if (!identityProviderName) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoProviderUnavailable',
      'Cognito enterprise identity provider is not configured.',
    )
  }
  return identityProviderName
}

/**
 * Extracts the normalized domain part of an email address.
 *
 * @param email - Member email address.
 * @returns The lower-cased domain, or an empty string when the email has no domain.
 */
export function normalizeEnterpriseEmailDomain(email: string) {
  const atIndex = email.lastIndexOf('@')
  return atIndex > 0 ? email.slice(atIndex + 1).trim().toLowerCase() : ''
}

/**
 * Enforces the enterprise external-access policy for a member email and role.
 *
 * @param snapshot - Enterprise identity snapshot.
 * @param email - Member email address.
 * @param role - Workspace role.
 * @param recoveryAccount - Whether the account is a break-glass recovery account.
 */
export function requireEnterpriseExternalAccessAllowed(
  snapshot: EnterpriseIdentitySnapshot,
  email: string,
  role: WorkspaceRole,
  recoveryAccount = false,
) {
  const policy = snapshot.policy?.externalAccess
  if (!policy) return
  const domain = normalizeEnterpriseEmailDomain(email)
  const verifiedDomains = snapshot.domains.filter((candidate) =>
    candidate.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((candidate) =>
    candidate.domain === domain
  )
  if (role === 'guest') {
    if (
      !policy.allowGuests ||
      policy.allowedGuestDomains.length > 0 &&
        !policy.allowedGuestDomains.includes(domain)
    ) {
      throw new WorkspaceAccessError(
        403,
        'EnterpriseGuestAccessDenied',
        'Workspace guest policy does not allow this account.',
      )
    }
    return
  }
  if (!managedDomain && !policy.allowExternalCollaborators && !recoveryAccount) {
    throw new WorkspaceAccessError(
      403,
      'EnterpriseExternalAccessDenied',
      'Workspace external collaborator policy does not allow this account.',
    )
  }
}

/**
 * Derives a stable enterprise authentication session ID from an access token.
 *
 * @param accessToken - Bearer access token from the request.
 * @returns The base64url SHA-256 digest of the token.
 */
export function createEnterpriseAuthenticationSessionId(accessToken: string) {
  return createHash('sha256').update(accessToken).digest('base64url')
}

/**
 * Reads the authentication methods verified for an enterprise session.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param authenticationSessionId - Enterprise authentication session ID.
 * @returns The verified authentication methods.
 */
export async function getVerifiedEnterpriseAuthenticationMethods(
  workspaceId: string,
  authenticationSessionId: string,
) {
  try {
    return await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
      workspaceId,
      authenticationSessionId,
    )
  } catch (error) {
    if (error instanceof EnterpriseSessionActivityError) {
      throw new WorkspaceAccessError(error.status, error.code, error.message, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Maps an enterprise session denial reason to its API error code.
 *
 * @param reason - Reason included in the error message.
 * @returns The API error code.
 */
export function resolveEnterpriseSessionErrorCode(
  reason: 'mfa-required' | 'session-expired' | 'reauthentication-required' | 'ip-denied' | undefined,
) {
  if (reason === 'mfa-required') return 'EnterpriseSessionMfaRequired'
  if (reason === 'session-expired') return 'EnterpriseSessionExpired'
  if (reason === 'reauthentication-required') {
    return 'EnterpriseSessionReauthenticationRequired'
  }
  if (reason === 'ip-denied') return 'EnterpriseSessionIpDenied'
  return 'EnterpriseSessionDenied'
}

/**
 * Reads an enterprise service account snapshot that stays unchanged across reads.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param accessToken - Bearer access token from the request.
 * @returns The stable service account snapshot.
 */
export async function readStableEnterpriseServiceAccountSnapshot(
  workspaceId: string,
  accessToken: string,
) {
  for (
    let attempt = 0;
    attempt <
      ENTERPRISE_SERVICE_ACCOUNT_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const before =
      await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const account =
      await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication
        .authenticateServiceAccountToken(
          workspaceId,
          accessToken,
        )
    const after =
      await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    if (
      before.controlRevision ===
        after.controlRevision
    ) {
      return { account, snapshot: after }
    }
  }
  throw new WorkspaceAccessError(
    409,
    'EnterpriseServiceAccountAuthorizationChanged',
    'Service account authorization changed. Retry the request.',
  )
}

/**
 * Current HTTP request の enterprise authorization 評価入力です。
 */
export type EnterpriseRequestAccessInput = {
  /** Resource が属する Workspace ID です。 */
  workspaceId: string
  /** Current HTTP request です。 */
  context?: Context
  /** Headless caller が server-side state から解決した authorization resource です。 */
  resource?: EnterpriseAuthorizationResource
  /** Headless collection 操作で Team/Project descendant scope を列挙するかどうかです。 */
  evaluateProjectScopes?: boolean
  /** Whether history/export collection must enumerate every descendant Project scope. */
  evaluateAllProjectScopes?: boolean
  /** Permissions used to enumerate descendant scopes instead of the route permission set. */
  scopePermissions?: readonly EnterprisePermissionId[]
  /** Route rule が要求する primary/alternative permission です。 */
  requiredPermissions?: readonly EnterprisePermissionId[]
  /** Directory、guest ceiling、principal kind を解決済みの principal です。 */
  principal: EnterprisePrincipalContext
  /** Current authoritative enterprise state です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Provider binding と current membership に適合した role assignment です。 */
  assignments: EnterpriseIdentitySnapshot['roleAssignments']
  /** Provider binding と current membership に適合した group mapping です。 */
  groupMappings: EnterpriseIdentitySnapshot['groupMappings']
}

/**
 * Current HTTP request の enterprise authorization 評価結果です。
 */
export type EnterpriseRequestAccess = {
  /** Primary または alternative permission で route を許可したかどうかです。 */
  allowed: boolean
  /** URL/body/canonical entity から解決した authorization resource です。 */
  resource: EnterpriseAuthorizationResource
  /** Current resource または絞り込み可能な Project 上で有効な permission です。 */
  permissions: EnterprisePermissionId[]
  /** Route を実際に許可した primary/alternative permission です。 */
  grantedRoutePermission?: EnterprisePermissionId
  /** Route 候補として少なくとも1つの scope で実際に許可された permission です。 */
  grantedRoutePermissions: EnterprisePermissionId[]
  /** URL/body/canonical entity の resource 自体で route を許可したかどうかです。 */
  authorizedAtResource: boolean
  /** Current route permission で読み書きできる Project と相当 role です。 */
  projectAccesses: ProjectAccessEntry[]
  /** Permission set retained for each Team-qualified Project scope. */
  projectScopeAccesses: EnterpriseProjectScopeAccess[]
  /** Current route permission で独立して読み書きできる Team ID です。 */
  authorizedTeamIds: string[]
  /** Current route で Team ごとに有効な enterprise permission です。 */
  teamAccesses: EnterpriseTeamAccess[]
}

/**
 * Enterprise assignment がない既存ユーザーについて domain handler の legacy ACL を使うか判定します。
 */
export function shouldDeferEnterpriseContentAuthorization(path: string) {
  return !path.startsWith('/api/enterprise/') &&
    path !== '/api/enterprise' &&
    !path.startsWith('/api/audit/') &&
    path !== '/api/audit' &&
    !path.startsWith('/api/workspace/') &&
    path !== '/api/workspace' &&
    !path.startsWith('/api/tenant/')
}

/**
 * Enterprise permission set を legacy handler が扱う Project role へ縮約します。
 */
export function resolveEnterpriseProjectRole(
  permissions: readonly EnterprisePermissionId[],
): ProjectRole {
  if (permissions.some((permission) => permission.endsWith('.manage'))) {
    return 'manager'
  }
  if (
    permissions.some((permission) =>
      permission.endsWith('.write') || permission === 'files.approve'
    )
  ) {
    return 'member'
  }
  return 'viewer'
}

/**
 * Adds the unique owner Team to legacy Project scopes before authorization evaluation.
 *
 * Ambiguous or unknown Project IDs remain unqualified and are rejected by the evaluator
 * once a qualified Project resource is available.
 *
 * @param entries - Assignment or group-mapping records carrying an Enterprise scope.
 * @param directory - Current Team-qualified Project directory.
 * @returns Entries with uniquely resolvable Project scopes qualified by owner Team.
 */
export function qualifyEnterpriseProjectScopes<T extends { scope: EnterpriseRoleScope }>(
  entries: readonly T[],
  directory: ProjectDirectoryResponse,
): T[] {
  const ownerTeamIdsByProjectId = new Map<string, Set<string>>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const ownerTeamIds = ownerTeamIdsByProjectId.get(project.id) ?? new Set<string>()
      ownerTeamIds.add(team.id)
      ownerTeamIdsByProjectId.set(project.id, ownerTeamIds)
    }
  }
  return entries.map((entry) => {
    if (
      entry.scope.kind !== 'project' ||
      entry.scope.parentTeamId !== undefined
    ) {
      return entry
    }
    const ownerTeamIds = ownerTeamIdsByProjectId.get(entry.scope.targetId ?? '')
    if (ownerTeamIds?.size !== 1) return entry
    const parentTeamId = ownerTeamIds.values().next().value
    if (!parentTeamId) return entry
    return {
      ...entry,
      scope: { ...entry.scope, parentTeamId },
    }
  })
}

/** Returns whether any Enterprise scope still needs Team qualification. */
export function hasUnqualifiedEnterpriseProjectScope(
  entries: readonly { scope: EnterpriseRoleScope }[],
) {
  return entries.some((entry) =>
    entry.scope.kind === 'project' && entry.scope.parentTeamId === undefined,
  )
}

function readAuthenticationMethods(claims: CognitoAccessTokenClaims | undefined) {
  const value = claims?.['cognito:amr'] ?? claims?.amr
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(/[\s,]+/u).filter(Boolean)
      : []
}

/**
 * Reads the non-SSO authentication methods recorded in Cognito access token claims.
 *
 * @param claims - Cognito access token claims.
 * @returns The authentication methods other than enterprise SSO.
 */
export function readCognitoAuthenticationMethods(
  claims: CognitoAccessTokenClaims | undefined,
) {
  return readAuthenticationMethods(claims).filter((method) =>
    !isEnterpriseSsoAuthenticationMethod(method)
  )
}

/**
 * Resolves the client IP used by enterprise IP policies.
 *
 * @param c - Hono request context.
 * @returns The resolved client IP key.
 */
export function resolveEnterpriseClientIp(c: Context) {
  let transportSource: string | undefined
  try {
    transportSource = getConnInfo(c).remote.address
  } catch {
    transportSource = undefined
  }
  return resolveRequestClientKey(
    transportSource,
    c.req.header('X-Forwarded-For'),
    new Set(
      (getEnv('MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

/**
 * Converts enterprise identity failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toEnterpriseIdentityErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof EnterpriseIdentityError)) {
    console.error(error)
    return c.json({
      code: 'EnterpriseIdentityUnavailable',
      message: 'Enterprise identity service is unavailable.',
    }, 503)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }, status)
}

/**
 * Verifies that the Cognito federation provider matches the stored enterprise identity provider.
 *
 * @param provider - Enterprise identity provider.
 * @param inspectionMode - Whether Cognito state may be served from the inspection cache.
 */
export async function assertEnterpriseCognitoFederationProvider(
  provider: EnterpriseIdentityProvider,
  inspectionMode: EnterpriseCognitoInspectionMode = 'fresh',
) {
  if (!authenticationDependencies.cognito.describeEnterpriseIdentityProvider) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoProviderInspectionUnavailable',
      'Cognito federation provider inspection is unavailable.',
    )
  }
  let binding: EnterpriseCognitoFederationBinding
  try {
    const cacheKey = `${getEnv('COGNITO_USER_POOL_ID')?.trim() ?? ''}\0${
      provider.cognitoProviderName
    }`
    const loadBinding = () => authenticationDependencies.cognito.describeEnterpriseIdentityProvider!(
      provider.cognitoProviderName,
    )
    const cache = getEnterpriseCognitoFederationBindingCache()
    binding = inspectionMode === 'cached'
      ? await cache.read(cacheKey, loadBinding)
      : await cache.refresh(cacheKey, loadBinding)
  } catch (error) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseCognitoProviderNotFound',
      'The configured Cognito federation provider could not be verified.',
      false,
      { cause: error },
    )
  }
  assertEnterpriseCognitoFederationBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
    binding,
  )
}

/**
 * Verifies that the Cognito SSO app client is configured for the enterprise identity provider.
 *
 * @param provider - Enterprise identity provider.
 * @param inspectionMode - Whether Cognito state may be served from the inspection cache.
 */
export async function assertEnterpriseCognitoSsoAppClient(
  provider: EnterpriseIdentityProvider,
  inspectionMode: EnterpriseCognitoInspectionMode = 'fresh',
) {
  const configuration = requireEnterpriseCognitoSsoAppClientConfiguration()
  if (!authenticationDependencies.cognito.describeEnterpriseSsoAppClient) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientInspectionUnavailable',
      'Cognito SSO app client inspection is unavailable.',
    )
  }
  let binding: EnterpriseCognitoSsoAppClientBinding
  try {
    const cacheKey = `${getEnv('COGNITO_USER_POOL_ID')?.trim() ?? ''}\0${
      configuration.clientId
    }`
    const loadBinding = () => authenticationDependencies.cognito.describeEnterpriseSsoAppClient!(
      configuration.clientId,
    )
    const cache = getEnterpriseCognitoSsoAppClientBindingCache()
    binding = inspectionMode === 'cached'
      ? await cache.read(cacheKey, loadBinding)
      : await cache.refresh(cacheKey, loadBinding)
  } catch (error) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientUnavailable',
      'The configured Cognito SSO app client could not be verified.',
      true,
      { cause: error },
    )
  }
  const requiredScopes = new Set(['openid', 'email', 'profile'])
  const actualScopes = new Set(binding.allowedOAuthScopes)
  if (
    binding.clientId !== configuration.clientId ||
    binding.hasClientSecret ||
    !binding.allowedOAuthFlowsUserPoolClient ||
    binding.supportedIdentityProviders.length !== 1 ||
    binding.supportedIdentityProviders[0] !== provider.cognitoProviderName ||
    provider.cognitoProviderName !== configuration.identityProviderName ||
    binding.allowedOAuthFlows.length !== 1 ||
    binding.allowedOAuthFlows[0] !== 'code' ||
    binding.explicitAuthFlows.length !== 1 ||
    binding.explicitAuthFlows[0] !== 'ALLOW_REFRESH_TOKEN_AUTH' ||
    actualScopes.size !== requiredScopes.size ||
    [...requiredScopes].some((scope) => !actualScopes.has(scope)) ||
    binding.callbackUrls.length !== 1 ||
    binding.callbackUrls[0] !== configuration.redirectUri
  ) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientBindingInvalid',
      'Cognito SSO app client does not match the required enterprise federation contract.',
    )
  }
}

/**
 * Verifies that the runtime Cognito providers match the enterprise identity snapshot.
 *
 * @param snapshot - Enterprise identity snapshot.
 * @param principalId - Principal ID.
 * @param email - Member email address.
 */
export async function assertEnterpriseRuntimeCognitoProviders(
  snapshot: EnterpriseIdentitySnapshot,
  principalId: string,
  email: string,
) {
  const normalizedPrincipalId = principalId.trim().toLowerCase()
  const providerIds = new Set(
    snapshot.scimUsers
      .filter((user) =>
        user.active &&
        user.appliedVersion >= user.version &&
        user.linkedMemberKey?.trim().toLowerCase() === normalizedPrincipalId
      )
      .map((user) => user.identityProviderId),
  )
  const emailDomain = normalizeEnterpriseEmailDomain(email)
  for (const domain of snapshot.domains) {
    if (
      domain.status !== 'verified' ||
      !domain.enforceSso ||
      domain.domain !== emailDomain
    ) continue
    if (!domain.identityProviderId) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentityStateInvalid',
        'An enforced enterprise domain is missing its identity provider binding.',
      )
    }
    providerIds.add(domain.identityProviderId)
  }
  for (const providerId of providerIds) {
    const provider = snapshot.identityProviders.find((candidate) =>
      candidate.providerId === providerId
    )
    assertEnterpriseIdentityProviderReady(provider)
    await assertEnterpriseCognitoFederationProvider(provider, 'cached')
    await assertEnterpriseCognitoSsoAppClient(provider, 'cached')
  }
}

/**
 * Resolves the document role granted by enterprise permissions.
 *
 * @param permissions - Enterprise permissions of the principal.
 * @returns The document role, or `undefined` when no document permission is granted.
 */
export function resolveEnterpriseDocumentRole(
  permissions: readonly EnterprisePermissionId[],
): DocumentProjectRole | undefined {
  if (permissions.includes('documents.manage')) return 'manager'
  if (permissions.includes('documents.write')) return 'member'
  if (permissions.includes('documents.read')) return 'viewer'
  return undefined
}

/**
 * Current route と独立して評価した Enterprise Document scope です。
 */
export type EnterpriseDocumentScopeAccess = {
  /** Project ごとに Document ACL の上限として使う role です。 */
  projectRoles: Record<string, DocumentProjectRole>
  /** Enterprise で許可されていない scope を deny する境界です。 */
  restrictToAuthorizedScopes: true
  /** Workspace scope の Document ACL 上限です。 */
  workspaceScopeRole?: DocumentProjectRole
}

/** Compares two resource descriptors without widening their scoped target. */
export function isSameEnterpriseAuthorizationResource(
  left: EnterpriseAuthorizationResource | undefined,
  right: EnterpriseAuthorizationResource,
): boolean {
  if (!left || left.workspaceId !== right.workspaceId || left.kind !== right.kind) return false
  if (right.kind === 'workspace') return true
  return left.targetId === right.targetId && (
    right.kind === 'team' || left.parentTeamId === right.parentTeamId
  )
}

/**
 * Converts Cognito user directory failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toCognitoDirectoryErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Cognito user data is unavailable.' }, 502)
  }

  if (error.code === 'UserNotFoundException') {
    return c.json({ message: 'Cognito user was not found.' }, 404)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'CognitoAccessTokenInvalid') {
    return c.json({ message: 'Authentication failed.' }, 401)
  }

  if (error.code === 'CognitoConfigurationMissing') {
    console.error(error)
    return c.json({ message: 'Cognito is not configured.' }, 503)
  }

  if (error.code === 'TooManyRequestsException') {
    return c.json({ message: 'Cognito user data is rate limited.' }, 429)
  }

  if (error.code === 'InvalidParameterException') {
    return c.json({ message: error.message }, 400)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    console.error(error)
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  console.error(error)
  return c.json({ message: 'Cognito user data is unavailable.' }, 502)
}

/**
 * Validates an access token against the configured Cognito user pool and clients.
 *
 * @param accessToken - Bearer access token from the request.
 */
export function validateConfiguredCognitoAccessToken(accessToken: string) {
  const userPoolId = getEnv('COGNITO_USER_POOL_ID')?.trim()
  const clientId = getEnv('COGNITO_CLIENT_ID')?.trim()
  const ssoClientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()

  if ((!userPoolId || !clientId) && !canAutoDiscoverLocalCognitoConfiguration()) {
    throw new CognitoServiceError(
      503,
      'CognitoConfigurationMissing',
      'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required.',
    )
  }

  if (!userPoolId && !clientId) {
    return
  }

  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const expectedIssuer = userPoolId ? getConfiguredCognitoIssuer(userPoolId) : undefined
  const tokenIssuer = typeof claims?.iss === 'string'
    ? normalizeCognitoIssuer(claims.iss)
    : undefined
  const acceptedClientIds = new Set([clientId, ssoClientId].filter(
    (candidate): candidate is string => Boolean(candidate),
  ))

  if (
    !claims ||
    claims.token_use !== 'access' ||
    (expectedIssuer && tokenIssuer !== expectedIssuer) ||
    (acceptedClientIds.size > 0 &&
      (typeof claims.client_id !== 'string' || !acceptedClientIds.has(claims.client_id)))
  ) {
    throw new CognitoServiceError(
      401,
      'CognitoAccessTokenInvalid',
      'Access token does not match the configured Cognito user pool and app client.',
    )
  }
}

function getConfiguredCognitoIssuer(userPoolId: string) {
  const configuredIssuer = normalizeCognitoIssuer(getEnv('COGNITO_ISSUER') ?? '')

  return configuredIssuer || createCognitoIssuer(userPoolId)
}

function normalizeCognitoIssuer(value: string) {
  return trimTrailingSlash(value.trim())
}

function createCognitoIssuer(userPoolId: string) {
  const poolRegion = userPoolId.split('_')[0] || getAwsRegion()
  const domainSuffix = poolRegion.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'

  return `https://cognito-idp.${poolRegion}.${domainSuffix}/${userPoolId}`
}

function canAutoDiscoverLocalCognitoConfiguration() {
  return Boolean(getCognitoEndpoint()) || (
    typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
  )
}

/**
 * Reads the Cognito groups from an access token.
 *
 * @param accessToken - Bearer access token from the request.
 * @returns The group names, or an empty list when none are present.
 */
export function readCognitoGroups(accessToken: string) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const groups = claims?.['cognito:groups']

  if (!Array.isArray(groups)) {
    return []
  }

  return groups.filter((group): group is string => typeof group === 'string' && Boolean(group))
}

function getCognitoEndpoint() {
  return loadServerConfig().cognitoEndpoint
}
