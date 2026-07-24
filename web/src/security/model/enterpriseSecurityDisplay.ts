import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type {
  EnterpriseRoleDefinition,
  EnterpriseRoleImpact,
  EnterpriseSecuritySnapshot,
  EnterpriseServiceAccount,
} from '../api'
import type { EnterpriseSecurityScopeOption } from './enterpriseSecurityForms'

const securityRoleNameKeys: Readonly<Record<string, MessageKey>> = {
  'project:manager': 'security.role.name.projectManager',
  'project:member': 'security.role.name.projectMember',
  'project:viewer': 'security.role.name.projectViewer',
  'team:manager': 'security.role.name.teamManager',
  'team:member': 'security.role.name.teamMember',
  'workspace:admin': 'security.role.name.workspaceAdmin',
  'workspace:guest': 'security.role.name.workspaceGuest',
  'workspace:member': 'security.role.name.workspaceMember',
  'workspace:owner': 'security.role.name.workspaceOwner',
  'workspace-member': 'security.role.name.workspaceMember',
  'workspace-owner': 'security.role.name.workspaceOwner',
}

const securityPermissionResourceKeys: Readonly<Record<string, MessageKey>> = {
  audit: 'security.permission.resource.audit',
  automation: 'security.permission.resource.automation',
  content: 'security.permission.resource.content',
  files: 'security.permission.resource.files',
  identity: 'security.permission.resource.identity',
  members: 'security.permission.resource.members',
  planning: 'security.permission.resource.planning',
  projects: 'security.permission.resource.projects',
  requests: 'security.permission.resource.requests',
  security: 'security.permission.resource.security',
  'service-accounts': 'security.permission.resource.serviceAccounts',
  teams: 'security.permission.resource.teams',
  'work-items': 'security.permission.resource.workItems',
  workspace: 'security.permission.resource.workspace',
}

const securityPermissionActionKeys: Readonly<Record<string, MessageKey>> = {
  approve: 'security.permission.action.approve',
  configure: 'security.permission.action.configure',
  export: 'security.permission.action.export',
  manage: 'security.permission.action.manage',
  read: 'security.permission.action.read',
  use: 'security.permission.action.use',
  write: 'security.permission.action.write',
}

/**
 * Formats a built-in role ID as a localized display label.
 *
 * @param role - Role to display.
 * @param t - Localized message resolver.
 * @returns A translated built-in label or the API-provided custom name.
 */
export function formatEnterpriseSecurityRoleName(
  role: EnterpriseRoleDefinition,
  t: (key: MessageKey) => string,
): string {
  const messageKey = securityRoleNameKeys[role.id]
  return messageKey ? t(messageKey) : role.name
}

/**
 * Formats a service-account scope for administrators.
 *
 * @param account - Service account to display.
 * @param scopeOptions - Available scopes used to resolve a friendly name.
 * @param t - Localized message resolver.
 * @returns A label containing the scope type and name.
 */
export function formatEnterpriseServiceAccountScope(
  account: EnterpriseServiceAccount,
  scopeOptions: EnterpriseSecurityScopeOption[],
  t: (key: MessageKey) => string,
): string {
  const scope = scopeOptions.find(
    (candidate) =>
      candidate.type === account.scopeType &&
      (account.scopeType === 'workspace' || candidate.id === account.scopeId),
  )

  return scope
    ? `${t(`security.scope.${scope.type}`)} · ${scope.name}`
    : account.scopeId
      ? `${t(`security.scope.${account.scopeType}`)} · ${account.scopeId}`
      : t(`security.scope.${account.scopeType}`)
}

/**
 * Summarizes scope, lifetime, and CIDR boundaries before account creation.
 *
 * @param scope - Scope currently selected by the administrator.
 * @param credentialLifetimeDays - Credential lifetime in days.
 * @param sourceCidrCount - Number of configured source CIDRs.
 * @param t - Localized message resolver.
 * @returns A summary of the credential boundaries to be created.
 */
export function formatEnterpriseServiceAccountImpactSummary(
  scope: EnterpriseSecurityScopeOption | undefined,
  credentialLifetimeDays: number,
  sourceCidrCount: number,
  t: (key: MessageKey) => string,
): string {
  const scopeLabel = scope
    ? `${t(`security.scope.${scope.type}`)} · ${scope.name}`
    : t('security.privileged.selectScope')
  const sourceBoundary =
    sourceCidrCount > 0
      ? t('security.privileged.sourceCidrsRestricted').replace(
          '{count}',
          String(sourceCidrCount),
        )
      : t('security.privileged.sourceCidrsUnrestricted')

  return t('security.privileged.impactSummaryDescription')
    .replace('{scope}', scopeLabel)
    .replace('{days}', String(credentialLifetimeDays))
    .replace('{source}', sourceBoundary)
}

/**
 * Formats a permission ID as a localized resource and action label.
 *
 * @param permission - Permission to display.
 * @param t - Localized message resolver.
 * @returns A translated permission label or the API-provided name.
 */
export function formatEnterpriseSecurityPermissionName(
  permission: EnterpriseSecuritySnapshot['permissions'][number],
  t: (key: MessageKey) => string,
): string {
  const [resourceId, actionId] = permission.id.split('.')
  const resourceKey = resourceId
    ? securityPermissionResourceKeys[resourceId]
    : undefined
  const actionKey = actionId
    ? securityPermissionActionKeys[actionId]
    : undefined

  if (!resourceKey || !actionKey) {
    return permission.name
  }

  return t('security.permission.localizedName')
    .replace('{resource}', t(resourceKey))
    .replace('{action}', t(actionKey))
}

/**
 * Formats localized explanatory copy for a permission.
 *
 * @param permission - Permission to describe.
 * @param t - Localized message resolver.
 * @returns A translated description or the API-provided fallback.
 */
export function formatEnterpriseSecurityPermissionDescription(
  permission: EnterpriseSecuritySnapshot['permissions'][number],
  t: (key: MessageKey) => string,
): string {
  const localizedName = formatEnterpriseSecurityPermissionName(permission, t)
  return localizedName === permission.name
    ? permission.description
    : t('security.permission.localizedDescription').replace(
        '{permission}',
        localizedName,
      )
}

/**
 * Formats an ISO date for the selected administration locale.
 *
 * @param value - ISO date string to format.
 * @param locale - Locale used for presentation.
 * @returns The formatted date, or the original value when invalid.
 */
export function formatEnterpriseSecurityDate(
  value: string,
  locale: Locale = 'ja',
): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

/**
 * Converts an opaque ID into a deterministic DOM test-ID segment.
 *
 * @param value - Opaque identifier to normalize.
 * @returns A lowercase slug containing only alphanumerics and hyphens.
 */
export function createEnterpriseSecurityTestId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/**
 * Formats assignment impact when a role mutation is blocked.
 *
 * @param impact - Server-provided role impact.
 * @param t - Localized message resolver.
 * @returns Warning copy with assignment, mapping, and service-account counts.
 */
export function formatEnterpriseRoleImpactBlockedMessage(
  impact: EnterpriseRoleImpact,
  t: (key: MessageKey) => string,
): string {
  return t('security.access.roleImpactBlocked')
    .replace('{assignments}', String(impact.assignmentCount))
    .replace('{mappings}', String(impact.mappingCount))
    .replace('{serviceAccounts}', String(impact.serviceAccountCount))
}
