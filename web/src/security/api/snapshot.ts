import type { EnterpriseActiveBreakGlassActivation, EnterpriseBreakGlassAdministrator } from './breakGlass'
import type { EnterpriseDomainClaim } from './domains'
import { EnterpriseSecurityApiError } from './errors'
import type { EnterpriseGroupRoleMapping } from './groupRoleMappings'
import type { EnterpriseIdentityProvider } from './identityProvider'
import type { EnterpriseProvisioningLog, EnterpriseScimConfiguration } from './provisioning'
import type { EnterpriseAssignableRoleIds, EnterprisePermissionDefinition, EnterpriseRoleDefinition } from './roles'
import type { EnterpriseServiceAccount } from './serviceAccounts'
import type { EnterpriseSessionPolicy } from './sessionPolicy'

/**
 * Enterprise security 管理 API が返す操作権限です。
 */
export type EnterpriseSecurityCapabilities = {
  /** Enterprise security の状態を閲覧できるかどうかです。 */
  canView: boolean
  /** Identity provider と domain policy を閲覧できるかどうかです。 */
  canViewIdentity: boolean
  /** SCIM provisioning と reconciliation を閲覧できるかどうかです。 */
  canViewProvisioning: boolean
  /** Group mapping、role、guest policy を閲覧できるかどうかです。 */
  canViewAccess: boolean
  /** MFA、session、IP policy を閲覧できるかどうかです。 */
  canViewSessions: boolean
  /** Service account と break-glass administrator を閲覧できるかどうかです。 */
  canViewPrivileged: boolean
  /** Identity provider と domain policy を変更できるかどうかです。 */
  canManageIdentity: boolean
  /** SCIM provisioning と reconciliation を操作できるかどうかです。 */
  canManageProvisioning: boolean
  /** Group mapping、custom role、guest policy を変更できるかどうかです。 */
  canManageAccess: boolean
  /** Directory group mapping を変更できるかどうかです。 */
  canManageMappings: boolean
  /** Custom role と permission set を変更できるかどうかです。 */
  canManageRoles: boolean
  /** MFA、session、IP policy を変更できるかどうかです。 */
  canManageSessions: boolean
  /** Service account を変更できるかどうかです。 */
  canManagePrivilegedAccess: boolean
  /** Break-glass administrator を変更できるかどうかです。 */
  canManageBreakGlass: boolean
}

/**
 * SSO enforcement の非機密 prerequisite 状態です。
 */
export type EnterpriseSsoPrerequisites = {
  /** 接続テスト済み identity provider が存在するかどうかです。 */
  providerReady: boolean
  /** 所有権確認済み domain が存在するかどうかです。 */
  domainReady: boolean
  /** MFA 確認済み break-glass login 経路が存在するかどうかです。 */
  breakGlassReady: boolean
}

/**
 * Enterprise identity と security policy の管理 snapshot です。
 */
export type EnterpriseSecuritySnapshot = {
  /** ログイン中 principal の管理 capability です。 */
  capabilities: EnterpriseSecurityCapabilities
  /** 用途・scope ごとに割り当て可能な role ID です。 */
  assignableRoleIds: EnterpriseAssignableRoleIds
  /** Current principal が custom role へ付与できる permission ID です。 */
  assignablePermissionIds: string[]
  /** SAML/OIDC identity provider 設定です。 */
  identityProvider: EnterpriseIdentityProvider
  /** SSO enforcement の非機密 prerequisite 状態です。 */
  ssoPrerequisites: EnterpriseSsoPrerequisites
  /** Workspace が claim している domain 一覧です。 */
  domains: EnterpriseDomainClaim[]
  /** SCIM connection 設定です。 */
  scim: EnterpriseScimConfiguration
  /** Provisioning operation の新しい順履歴です。 */
  provisioningLogs: EnterpriseProvisioningLog[]
  /** Directory group role mapping 一覧です。 */
  mappings: EnterpriseGroupRoleMapping[]
  /** Built-in/custom role 一覧です。 */
  roles: EnterpriseRoleDefinition[]
  /** Role editor で選べる permission catalog です。 */
  permissions: EnterprisePermissionDefinition[]
  /** MFA、session、IP、guest policy です。 */
  sessionPolicy: EnterpriseSessionPolicy
  /** Interactive user と分離した service account 一覧です。 */
  serviceAccounts: EnterpriseServiceAccount[]
  /** Break-glass administrator 一覧です。 */
  breakGlassAdministrators: EnterpriseBreakGlassAdministrator[]
  /** Server が確認した current member の有効な recovery elevation です。 */
  activeBreakGlassActivation?: EnterpriseActiveBreakGlassActivation
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Enterprise identity と security policy の管理 snapshot を取得します。
 */
export function getEnterpriseSecuritySnapshot(
  accessToken: string,
  signal?: AbortSignal,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security',
    accessToken,
    { signal },
  ).then(parseEnterpriseSecuritySnapshot)
}

async function sendEnterpriseSecurityRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${enterpriseSecurityApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new EnterpriseSecurityApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function parseEnterpriseSecuritySnapshot(data: unknown) {
  if (
    !isRecord(data) ||
    !isEnterpriseSecurityCapabilities(data.capabilities) ||
    !isEnterpriseAssignableRoleIds(data.assignableRoleIds) ||
    !Array.isArray(data.assignablePermissionIds) ||
    !data.assignablePermissionIds.every(
      (permissionId) => typeof permissionId === 'string',
    ) ||
    !isRecord(data.identityProvider) ||
    (data.capabilities.canViewIdentity
      ? typeof data.identityProvider.id !== 'string'
      : data.identityProvider.id !== undefined &&
        typeof data.identityProvider.id !== 'string') ||
    !isEnterpriseSsoPrerequisites(data.ssoPrerequisites) ||
    !Array.isArray(data.domains) ||
    !data.domains.every(
      (domain) =>
        isRecord(domain) &&
        typeof domain.verificationRecordName === 'string' &&
        Boolean(domain.verificationRecordName),
    ) ||
    !isEnterpriseScimConfiguration(data.scim) ||
    !Array.isArray(data.mappings) ||
    !data.mappings.every(
      (mapping) =>
        isRecord(mapping) &&
        typeof mapping.identityProviderId === 'string',
    ) ||
    !Array.isArray(data.roles) ||
    !data.roles.every(
      (role) =>
        isRecord(role) && typeof role.guestAssignable === 'boolean',
    ) ||
    !Array.isArray(data.permissions) ||
    !isRecord(data.sessionPolicy) ||
    typeof data.sessionPolicy.idleTimeoutMinutes !== 'number' ||
    typeof data.sessionPolicy.reauthenticationMinutes !== 'number' ||
    typeof data.sessionPolicy.sensitiveActionReauthenticationMinutes !==
      'number' ||
    typeof data.sessionPolicy.externalCollaboratorsAllowed !== 'boolean' ||
    typeof data.sessionPolicy.guestSessionLifetimeMinutes !== 'number' ||
    !Array.isArray(data.serviceAccounts) ||
    !data.serviceAccounts.every(isEnterpriseServiceAccount) ||
    !Array.isArray(data.breakGlassAdministrators) ||
    (data.activeBreakGlassActivation !== undefined &&
      data.activeBreakGlassActivation !== null &&
      (!isRecord(data.activeBreakGlassActivation) ||
        typeof data.activeBreakGlassActivation.expiresAt !== 'string' ||
        !Number.isFinite(
          Date.parse(data.activeBreakGlassActivation.expiresAt),
        )))
  ) {
    throw createMalformedResponseError()
  }

  return {
    assignablePermissionIds: data.assignablePermissionIds,
    assignableRoleIds: data.assignableRoleIds,
    activeBreakGlassActivation:
      isRecord(data.activeBreakGlassActivation) &&
      typeof data.activeBreakGlassActivation.expiresAt === 'string'
        ? { expiresAt: data.activeBreakGlassActivation.expiresAt }
        : undefined,
    breakGlassAdministrators:
      data.breakGlassAdministrators as EnterpriseBreakGlassAdministrator[],
    capabilities: data.capabilities as EnterpriseSecurityCapabilities,
    domains: data.domains as EnterpriseDomainClaim[],
    identityProvider: {
      ...data.identityProvider,
      id:
        typeof data.identityProvider.id === 'string'
          ? data.identityProvider.id
          : '',
    } as EnterpriseIdentityProvider,
    mappings: data.mappings as EnterpriseGroupRoleMapping[],
    permissions: data.permissions as EnterprisePermissionDefinition[],
    provisioningLogs: Array.isArray(data.provisioningLogs)
      ? (data.provisioningLogs as EnterpriseProvisioningLog[])
      : [],
    roles: data.roles as EnterpriseRoleDefinition[],
    scim: data.scim as EnterpriseScimConfiguration,
    serviceAccounts: data.serviceAccounts as EnterpriseServiceAccount[],
    sessionPolicy: data.sessionPolicy as EnterpriseSessionPolicy,
    ssoPrerequisites: data.ssoPrerequisites,
  } satisfies EnterpriseSecuritySnapshot
}

function createMalformedResponseError() {
  return new EnterpriseSecurityApiError(
    502,
    'Enterprise security API returned an invalid response.',
    'EnterpriseSecurityInvalidResponse',
  )
}

function readErrorCode(data: unknown) {
  return isRecord(data) && typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return isRecord(data) && typeof data.message === 'string'
    ? data.message
    : 'Enterprise security request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnterpriseSecurityCapabilities(
  value: unknown,
): value is EnterpriseSecurityCapabilities {
  if (!isRecord(value)) {
    return false
  }

  return [
    'canView',
    'canViewIdentity',
    'canViewProvisioning',
    'canViewAccess',
    'canViewSessions',
    'canViewPrivileged',
    'canManageIdentity',
    'canManageProvisioning',
    'canManageAccess',
    'canManageMappings',
    'canManageRoles',
    'canManageSessions',
    'canManagePrivilegedAccess',
    'canManageBreakGlass',
  ].every((capability) => typeof value[capability] === 'boolean')
}

function isEnterpriseScimConfiguration(
  value: unknown,
): value is EnterpriseScimConfiguration {
  return (
    isRecord(value) &&
    typeof value.identityProviderId === 'string' &&
    (
      value.status === 'disabled' ||
      value.status === 'ready' ||
      value.status === 'syncing' ||
      value.status === 'error'
    ) &&
    typeof value.endpointUrl === 'string' &&
    Number.isSafeInteger(value.tokenGeneration) &&
    Number(value.tokenGeneration) >= 0 &&
    (
      value.tokenLastFour === undefined ||
      typeof value.tokenLastFour === 'string' &&
        /^[A-Za-z0-9_-]{4}$/.test(value.tokenLastFour)
    ) &&
    (
      value.lastSyncAt === undefined ||
      typeof value.lastSyncAt === 'string' &&
        Number.isFinite(Date.parse(value.lastSyncAt))
    ) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0
  )
}

function isEnterpriseSsoPrerequisites(
  value: unknown,
): value is EnterpriseSsoPrerequisites {
  return (
    isRecord(value) &&
    typeof value.providerReady === 'boolean' &&
    typeof value.domainReady === 'boolean' &&
    typeof value.breakGlassReady === 'boolean'
  )
}

function isEnterpriseServiceAccount(
  value: unknown,
): value is EnterpriseServiceAccount {
  if (!isRecord(value)) {
    return false
  }

  const scopeType = value.scopeType
  return (
    (scopeType === 'workspace' ||
      scopeType === 'team' ||
      scopeType === 'project') &&
    (scopeType === 'workspace'
      ? value.scopeId === undefined
      : typeof value.scopeId === 'string' && Boolean(value.scopeId)) &&
    Number.isSafeInteger(value.credentialLifetimeDays) &&
    Number(value.credentialLifetimeDays) >= 1 &&
    Number(value.credentialLifetimeDays) <= 365 &&
    (value.credentialExpiresAt === undefined ||
      (typeof value.credentialExpiresAt === 'string' &&
        Number.isFinite(Date.parse(value.credentialExpiresAt)))) &&
    isStringArray(value.allowedSourceCidrs)
  )
}

function isEnterpriseAssignableRoleIds(
  value: unknown,
): value is EnterpriseAssignableRoleIds {
  if (!isRecord(value) || !isRecord(value.groupMappings)) {
    return false
  }

  const groupMappings = value.groupMappings

  return (
    ['workspace', 'team', 'project'].every((scope) =>
      isStringArray(groupMappings[scope]),
    ) &&
    isStringArray(value.serviceAccounts)
  )
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && Boolean(item))
  )
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw createMalformedResponseError()
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
