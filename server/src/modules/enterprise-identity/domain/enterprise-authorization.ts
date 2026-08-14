import { isIP } from 'node:net'
import {
  type EnterpriseCustomRole,
  type EnterpriseBuiltInRoleId,
  type EnterpriseDirectoryGroupMapping,
  type EnterpriseIdentitySnapshot,
  type EnterprisePermissionId,
  type EnterpriseRoleAssignment,
  type EnterpriseRoleId,
  type EnterpriseRoutePermissionRule,
  type EnterpriseSecurityPolicy,
  ENTERPRISE_BUILT_IN_ROLE_IDS,
  ENTERPRISE_PERMISSION_IDS,
} from '@mukuroji/contracts'

/** Enterprise authorization に渡す principal context です。 */
export type EnterprisePrincipalContext = {
  /** Principal の種別です。 */
  kind: 'member' | 'service-account' | 'break-glass'
  /** Workspace 内の immutable principal ID です。 */
  principalId: string
  /** Cognito が現在の token に含めた directory group ID 一覧です。 */
  directoryGroupIds: string[]
  /** Provider-qualified な active SCIM group membership 一覧です。 */
  directoryGroupMemberships?: EnterpriseDirectoryGroupMembership[]
  /** Built-in Workspace role です。 */
  workspaceRole?: 'owner' | 'admin' | 'member' | 'guest'
  /** Built-in Workspace role permission を custom/mapped role と合成するかどうかです。 */
  includeWorkspaceRolePermissions?: boolean
  /** System administrator の live membership が確認済みかどうかです。 */
  systemAdministrator?: boolean
  /** Service account 等に直接付与された permission です。 */
  directPermissions?: EnterprisePermissionId[]
  /** Guest/external principal に適用する permission ceiling です。 */
  permissionCeiling?: EnterprisePermissionId[]
}

/** Provider-qualified な SCIM directory group membership です。 */
export type EnterpriseDirectoryGroupMembership = {
  /** Group を供給した identity provider ID です。 */
  identityProviderId: string
  /** Mukuroji が発行した immutable SCIM group ID です。 */
  groupId: string
  /** Upstream directory が発行した immutable group ID です。 */
  externalId: string
}

/** HTTP/realtime evaluator が共有する authoritative directory principal 解決結果です。 */
export type EnterpriseDirectoryPrincipalResolution = {
  /** Principal が provider readiness に関係なく SCIM directory 管理下かどうかです。 */
  directoryManaged: boolean
  /** 現在の Cognito token から取得した group ID 一覧です。 */
  directoryGroupIds: string[]
  /** Provider-qualified な active SCIM group membership 一覧です。 */
  directoryGroupMemberships: EnterpriseDirectoryGroupMembership[]
  /** 同じ provider の membership と一致する mapping 一覧です。 */
  compatibleGroupMappings: EnterpriseDirectoryGroupMapping[]
  /** Provider binding を満たす assignment 一覧です。 */
  compatibleRoleAssignments: EnterpriseRoleAssignment[]
  /** Principal に紐づく inactive SCIM user が存在するかどうかです。 */
  deprovisioned: boolean
}

/** Enterprise authorization が評価する resource context です。 */
export type EnterpriseAuthorizationResource = {
  /** Resource が属する Workspace ID です。 */
  workspaceId: string
  /** Resource scope の種別です。 */
  kind: 'workspace' | 'team' | 'project'
  /** Team または Project ID です。 */
  targetId?: string
  /** Project resource が属する Team ID です。 */
  parentTeamId?: string
}

/** Enterprise access evaluator の入力です。 */
export type EvaluateEnterpriseAccessInput = {
  /** Route が要求する permission です。 */
  permission: EnterprisePermissionId
  /** 認証済み principal です。 */
  principal: EnterprisePrincipalContext
  /** Direct/materialized role assignment 一覧です。 */
  assignments: EnterpriseRoleAssignment[]
  /** Workspace custom role 一覧です。 */
  customRoles: EnterpriseCustomRole[]
  /** Directory group mapping 一覧です。 */
  groupMappings: EnterpriseDirectoryGroupMapping[]
  /** 評価対象 resource です。 */
  resource: EnterpriseAuthorizationResource
  /**
   * Team ID uniquely resolved from the current Project Directory for a legacy Project scope.
   * Only callers that need backward-compatible evaluation of an unqualified scope provide it.
   */
  projectScopeOwnerTeamId?: string
}

/** Enterprise authorization の決定と effective permission set です。 */
export type EnterpriseEffectiveAccess = {
  /** 要求 permission が許可されたかどうかです。 */
  allowed: boolean
  /** Resource 上で有効な permission 一覧です。 */
  permissions: EnterprisePermissionId[]
  /** Deny の safe reason code です。 */
  reason?: 'permission-missing' | 'guest-ceiling' | 'scope-mismatch'
}

/** Token/session security validation の入力です。 */
export type EnterpriseSessionContext = {
  /** Access token の authentication time (epoch seconds) です。 */
  authenticatedAt: number
  /** 検証時刻 (epoch seconds) です。 */
  now: number
  /** Authentication method reference 一覧です。 */
  authenticationMethods: string[]
  /** 信頼済み transport/proxy から解決した client IP です。 */
  clientIp?: string
  /** Sensitive/privileged route かどうかです。 */
  privileged: boolean
  /** Guest/external principal かどうかです。 */
  external: boolean
  /** Active break-glass activation を使うかどうかです。 */
  breakGlass: boolean
}

/** Token/session security validation の結果です。 */
export type EnterpriseSessionValidation = {
  /** Session が現在の policy を満たすかどうかです。 */
  valid: boolean
  /** Reject の safe reason code です。 */
  reason?: 'mfa-required' | 'session-expired' | 'reauthentication-required' | 'ip-denied'
}

const builtInRolePermissions: Record<
  EnterpriseBuiltInRoleId,
  EnterprisePermissionId[]
> = {
  'workspace:owner': [...ENTERPRISE_PERMISSION_IDS],
  'workspace:admin': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    permission !== 'audit.export' && permission !== 'service-accounts.use'
  ),
  'workspace:member': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    !permission.endsWith('.manage') &&
    permission !== 'audit.read' &&
    permission !== 'audit.export' &&
    permission !== 'identity.read' &&
    permission !== 'security.read' &&
    permission !== 'service-accounts.use'
  ),
  'workspace:guest': ENTERPRISE_PERMISSION_IDS.filter((permission) =>
    permission.endsWith('.read') &&
    permission !== 'audit.read' &&
    permission !== 'identity.read' &&
    permission !== 'security.read'
  ),
  'team:manager': ['teams.read', 'teams.write', 'teams.manage', 'projects.read', 'projects.write',
    'projects.manage', 'work-items.read', 'work-items.write', 'documents.read', 'documents.write',
    'documents.manage', 'files.read', 'files.write', 'files.approve', 'planning.read',
    'planning.write', 'planning.manage'],
  'team:member': ['teams.read', 'teams.write', 'projects.read', 'projects.write', 'work-items.read',
    'work-items.write', 'documents.read', 'documents.write', 'files.read', 'files.write',
    'planning.read'],
  'project:manager': ['projects.read', 'projects.write', 'projects.manage', 'work-items.read',
    'work-items.write', 'documents.read', 'documents.write', 'documents.manage', 'files.read',
    'files.write', 'files.approve', 'planning.read', 'planning.write',
    'planning.manage'],
  'project:member': ['projects.read', 'projects.write', 'work-items.read', 'work-items.write',
    'documents.read', 'documents.write', 'files.read', 'files.write', 'planning.read'],
  'project:viewer': ['projects.read', 'work-items.read', 'documents.read', 'files.read',
    'planning.read'],
}

/**
 * Resolves the canonical permission set for a built-in or custom role.
 *
 * @remarks
 * Unknown role IDs resolve to no permissions. Callers must still validate role existence and
 * scope compatibility at the input boundary.
 *
 * @param customRoles - Custom roles configured for the workspace.
 * @param roleId - Role ID to resolve.
 * @returns The canonical permission set.
 */
export function resolveEnterpriseRolePermissions(
  customRoles: readonly EnterpriseCustomRole[],
  roleId: EnterpriseRoleId,
): EnterprisePermissionId[] {
  const builtIn = isEnterpriseBuiltInRoleId(roleId)
    ? builtInRolePermissions[roleId]
    : undefined
  if (builtIn) return [...builtIn]
  return [...(customRoles.find((role) => role.roleId === roleId)?.permissions ?? [])]
}

/**
 * Determines whether a role can be assigned at a resource scope.
 *
 * @param roleId - Role ID to validate.
 * @param scopeKind - Target scope kind.
 * @returns Whether the role and scope are compatible.
 */
export function isEnterpriseRoleCompatibleWithScope(
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
): boolean {
  return roleId.startsWith('custom:') || roleId.startsWith(`${scopeKind}:`)
}

/**
 * Determines whether a principal can assign a role without exceeding its own permissions.
 *
 * @param customRoles - Custom roles configured for the workspace.
 * @param callerPermissions - Effective permissions of the calling principal.
 * @param roleId - Role ID to assign.
 * @param scopeKind - Target scope kind.
 * @returns Whether the assignment is safe.
 */
export function canAssignEnterpriseRole(
  customRoles: readonly EnterpriseCustomRole[],
  callerPermissions: readonly EnterprisePermissionId[],
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
): boolean {
  const roleExists = roleId.startsWith('custom:')
    ? customRoles.some((role) => role.roleId === roleId)
    : isEnterpriseBuiltInRoleId(roleId)
  if (!roleExists || !isEnterpriseRoleCompatibleWithScope(roleId, scopeKind)) return false
  return resolveEnterpriseRolePermissions(customRoles, roleId).every((permission) =>
    callerPermissions.includes(permission)
  )
}

/**
 * Resolves the first permission matching a request method and path.
 *
 * @remarks Routes without a matching rule return `undefined` and are denied by default.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param rules - Route permission rules.
 * @returns The first matching permission, or undefined.
 */
export function resolveRoutePermission(
  method: string,
  path: string,
  rules: readonly EnterpriseRoutePermissionRule[],
) {
  return resolveRoutePermissions(method, path, rules)?.[0]
}

/**
 * Resolves the any-of permissions from the first rule matching a request method and path.
 *
 * @remarks Routes without a matching rule return `undefined` and are denied by default.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param rules - Route permission rules.
 * @returns Permissions from the matching rule, or undefined.
 */
export function resolveRoutePermissions(
  method: string,
  path: string,
  rules: readonly EnterpriseRoutePermissionRule[],
) {
  const normalizedMethod = method.trim().toUpperCase()
  const normalizedPath = normalizePath(path)
  const rule = rules.find((candidate) =>
    (candidate.method === '*' || candidate.method === normalizedMethod) &&
    routePatternMatches(candidate.pathPattern, normalizedPath)
  )
  return rule
    ? [rule.permission, ...(rule.alternativePermissions ?? [])]
    : undefined
}

/**
 * Resolves SCIM users, SCIM groups, and Cognito groups into an authorization context.
 *
 * @remarks
 * SCIM group IDs are not flattened into the Cognito group namespace. A mapping is eligible only
 * when the user, group, and mapping share the same `identityProviderId`.
 *
 * @param snapshot - Authoritative Enterprise Identity snapshot.
 * @param principalId - Principal ID to resolve.
 * @param cognitoGroupIds - Cognito group IDs in the current token.
 * @returns Provider-aware directory principal resolution.
 */
export function resolveEnterpriseDirectoryPrincipal(
  snapshot: EnterpriseIdentitySnapshot,
  principalId: string,
  cognitoGroupIds: readonly string[],
): EnterpriseDirectoryPrincipalResolution {
  const normalizedPrincipalId = principalId.trim().toLowerCase()
  const eligibleProviderIds = new Set(
    snapshot.identityProviders
      .filter((provider) =>
        provider.status === 'active' &&
        provider.lastTestedAt !== undefined &&
        Number.isFinite(Date.parse(provider.lastTestedAt))
      )
      .map((provider) => provider.providerId),
  )
  const linkedScimUsers = snapshot.scimUsers.filter((candidate) =>
    candidate.linkedMemberKey?.trim().toLowerCase() === normalizedPrincipalId
  )
  const activeScimUsers = linkedScimUsers.filter((candidate) =>
    eligibleProviderIds.has(candidate.identityProviderId) &&
    candidate.active && candidate.appliedVersion >= candidate.version
  )
  const directoryGroupMemberships = snapshot.scimGroups
    .filter((group) =>
      eligibleProviderIds.has(group.identityProviderId) &&
      group.active &&
      group.appliedVersion >= group.version &&
      activeScimUsers.some((user) =>
        user.identityProviderId === group.identityProviderId &&
        group.memberUserIds.includes(user.userId)
      )
    )
    .map((group) => ({
      identityProviderId: group.identityProviderId,
      groupId: group.groupId,
      externalId: group.externalId,
    }))
  const compatibleGroupMappings = snapshot.groupMappings.filter((mapping) =>
    eligibleProviderIds.has(mapping.identityProviderId) &&
    mapping.enabled &&
    directoryGroupMemberships.some((membership) =>
      membership.identityProviderId === mapping.identityProviderId &&
      (
        membership.groupId === mapping.directoryGroupId ||
        membership.externalId === mapping.directoryGroupId
      )
    )
  )
  const compatibleMappingIds = new Set(
    compatibleGroupMappings.map((mapping) => mapping.mappingId),
  )

  return {
    directoryManaged: linkedScimUsers.length > 0,
    directoryGroupIds: [...new Set(
      cognitoGroupIds.map((groupId) => groupId.trim()).filter(Boolean),
    )],
    directoryGroupMemberships,
    compatibleGroupMappings,
    compatibleRoleAssignments: snapshot.roleAssignments.filter((assignment) =>
      assignment.principalKind !== 'directory-group' ||
      assignment.source !== 'directory-mapping' ||
      assignment.mappingId !== undefined && compatibleMappingIds.has(assignment.mappingId)
    ),
    deprovisioned: linkedScimUsers.length > 0 &&
      linkedScimUsers.every((candidate) =>
        !candidate.active &&
        candidate.appliedVersion >= candidate.version
      ),
  }
}

/**
 * Evaluates access across built-in roles, custom roles, assignments, mappings, and guest ceilings.
 *
 * @param input - Authorization evaluation input.
 * @returns Effective permissions and the allow or deny decision.
 */
export function evaluateEnterpriseAccess(
  input: EvaluateEnterpriseAccessInput,
): EnterpriseEffectiveAccess {
  if (input.principal.systemAdministrator || input.principal.kind === 'break-glass') {
    return { allowed: true, permissions: [...ENTERPRISE_PERMISSION_IDS] }
  }

  const roleIds = new Set<EnterpriseRoleId>()
  if (
    input.principal.workspaceRole &&
    input.principal.includeWorkspaceRolePermissions !== false
  ) {
    roleIds.add(`workspace:${input.principal.workspaceRole}`)
  }
  let matchingScopedGrant = input.resource.kind === 'workspace'
  for (const assignment of input.assignments) {
    const mapping = assignment.source === 'directory-mapping' && assignment.mappingId
      ? input.groupMappings.find((candidate) =>
          candidate.enabled && candidate.mappingId === assignment.mappingId
        )
      : undefined
    const principalMatches =
      assignment.principalKind === input.principal.kind &&
        assignment.principalId === input.principal.principalId ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source !== 'directory-mapping'
            ? input.principal.directoryGroupIds.includes(assignment.principalId)
            : mapping !== undefined &&
              mapping.directoryGroupId === assignment.principalId &&
              directoryMembershipMatches(
                input.principal.directoryGroupMemberships,
                mapping,
              )
        )
    if (
      principalMatches &&
      scopeMatches(assignment.scope, input.resource, input.projectScopeOwnerTeamId)
    ) {
      roleIds.add(assignment.roleId)
      matchingScopedGrant = true
    }
  }
  for (const mapping of input.groupMappings) {
    if (
      mapping.enabled &&
      directoryMembershipMatches(
        input.principal.directoryGroupMemberships,
        mapping,
      ) &&
      scopeMatches(mapping.scope, input.resource, input.projectScopeOwnerTeamId)
    ) {
      roleIds.add(mapping.roleId)
      matchingScopedGrant = true
    }
  }

  const permissions = new Set(input.principal.directPermissions ?? [])
  for (const roleId of roleIds) {
    const customRole = input.customRoles.find((role) => role.roleId === roleId)
    if (
      customRole &&
      input.principal.workspaceRole === 'guest' &&
      !customRole.guestAssignable
    ) {
      continue
    }
    for (const permission of resolveEnterpriseRolePermissions(
      input.customRoles,
      roleId,
    )) {
      permissions.add(permission)
    }
  }

  const ceiling = input.principal.permissionCeiling
  if (ceiling) {
    for (const permission of permissions) {
      if (!ceiling.includes(permission)) permissions.delete(permission)
    }
    if (!ceiling.includes(input.permission)) {
      return {
        allowed: false,
        permissions: [...permissions],
        reason: 'guest-ceiling',
      }
    }
  }
  const allowed = permissions.has(input.permission)
  if (allowed) return { allowed: true, permissions: [...permissions] }
  const reason: EnterpriseEffectiveAccess['reason'] = matchingScopedGrant
    ? 'permission-missing'
    : 'scope-mismatch'
  return { allowed: false, permissions: [...permissions], reason }
}

/** Returns whether a role ID belongs to the closed built-in role set. */
function isEnterpriseBuiltInRoleId(
  roleId: EnterpriseRoleId,
): roleId is EnterpriseBuiltInRoleId {
  return ENTERPRISE_BUILT_IN_ROLE_IDS.some((candidate) => candidate === roleId)
}

/**
 * Validates MFA, absolute lifetime, sensitive reauthentication, and IP allowlists.
 *
 * @param policy - Workspace security policy.
 * @param context - Current session context.
 * @returns A fail-closed session decision.
 */
export function validateEnterpriseSession(
  policy: EnterpriseSecurityPolicy | undefined,
  context: EnterpriseSessionContext,
): EnterpriseSessionValidation {
  const methods = new Set(context.authenticationMethods.map((method) => method.toLowerCase()))
  if (!policy) {
    return context.breakGlass &&
        ![...methods].some((method) =>
          method.includes('mfa') || method.includes('otp') || method.includes('webauthn')
        )
      ? { valid: false, reason: 'mfa-required' }
      : { valid: true }
  }
  const requiresMfa = policy.mfaRequirement === 'required' ||
    context.external && policy.externalAccess.requireMfa ||
    context.breakGlass
  if (
    requiresMfa &&
    ![...methods].some((method) =>
      method.includes('mfa') || method.includes('otp') || method.includes('webauthn')
    )
  ) {
    return { valid: false, reason: 'mfa-required' }
  }
  const absoluteLifetime = context.external
    ? Math.min(
        policy.sessionLifetimeMinutes,
        policy.externalAccess.maximumSessionLifetimeMinutes,
      )
    : policy.sessionLifetimeMinutes
  const ageSeconds = context.now - context.authenticatedAt
  if (ageSeconds < 0 || ageSeconds > absoluteLifetime * 60) {
    return { valid: false, reason: 'session-expired' }
  }
  const reauthenticationMinutes = context.privileged
    ? policy.sensitiveActionReauthenticationMinutes
    : policy.reauthenticationIntervalMinutes
  if (ageSeconds > reauthenticationMinutes * 60) {
    return { valid: false, reason: 'reauthentication-required' }
  }
  const appliesIpAllowlist = !context.breakGlass &&
    (
      policy.ipAllowlistMode === 'all-users' ||
      policy.ipAllowlistMode === 'privileged-users' && context.privileged
    )
  if (
    appliesIpAllowlist &&
    (
      !context.clientIp ||
      !policy.ipAllowlist.some((cidr) => ipMatchesCidr(context.clientIp!, cidr))
    )
  ) {
    return { valid: false, reason: 'ip-denied' }
  }
  return { valid: true }
}

/**
 * Determines whether an IPv4 or IPv6 address belongs to a CIDR range.
 *
 * @param address - IP address to validate.
 * @param cidr - Allowlist CIDR.
 * @returns Whether the address belongs to the range.
 */
export function ipMatchesCidr(address: string, cidr: string) {
  const [network, prefixText, ...extra] = cidr.trim().split('/')
  if (!network || !prefixText || extra.length > 0) return false
  const normalizedAddress = normalizeIpv4MappedAddress(address.trim())
  const normalizedNetwork = normalizeIpv4MappedAddress(network)
  const addressVersion = isIP(normalizedAddress)
  if (addressVersion === 0 || addressVersion !== isIP(normalizedNetwork)) return false
  const bitLength = addressVersion === 4 ? 32 : 128
  const rawPrefix = Number(prefixText)
  const prefix = normalizedNetwork === network ? rawPrefix : rawPrefix - 96
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitLength) return false
  const addressValue = addressVersion === 4
    ? parseIpv4(normalizedAddress)
    : parseIpv6(normalizedAddress)
  const networkValue = addressVersion === 4
    ? parseIpv4(normalizedNetwork)
    : parseIpv6(normalizedNetwork)
  if (addressValue === undefined || networkValue === undefined) return false
  if (prefix === 0) return true
  const shift = BigInt(bitLength - prefix)
  return addressValue >> shift === networkValue >> shift
}

/** Returns whether a provider-qualified membership satisfies a mapping. */
function directoryMembershipMatches(
  memberships: readonly EnterpriseDirectoryGroupMembership[] | undefined,
  mapping: EnterpriseDirectoryGroupMapping,
) {
  return memberships?.some((membership) =>
    membership.identityProviderId === mapping.identityProviderId &&
    (
      membership.groupId === mapping.directoryGroupId ||
      membership.externalId === mapping.directoryGroupId
    )
  ) === true
}

/** Normalizes a route path before matching. */
function normalizePath(path: string) {
  const normalized = `/${path.trim().replace(/^\/+|\/+$/gu, '')}`
  return normalized === '/' ? normalized : normalized.replace(/\/+$/gu, '')
}

/** Returns whether a normalized request path matches a route pattern. */
function routePatternMatches(pattern: string, path: string) {
  const normalizedPattern = normalizePath(pattern)
  const wildcard = normalizedPattern.endsWith('*')
  const base = wildcard ? normalizedPattern.slice(0, -1) : normalizedPattern
  const expression = base
    .split('/')
    .map((segment) => segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment))
    .join('/')
  return new RegExp(`^${expression}${wildcard ? '.*' : ''}$`, 'u').test(path)
}

/** Escapes one literal regular-expression segment. */
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Returns whether an assignment scope covers a resource. */
function scopeMatches(
  scope: EnterpriseRoleAssignment['scope'],
  resource: EnterpriseAuthorizationResource,
  projectScopeOwnerTeamId?: string,
) {
  if (scope.workspaceId !== resource.workspaceId) return false
  if (scope.kind === 'workspace') return true
  if (scope.kind === 'team') {
    return resource.kind === 'team' && scope.targetId === resource.targetId ||
      resource.kind === 'project' && scope.targetId === resource.parentTeamId
  }
  return resource.kind === 'project' &&
    scope.targetId === resource.targetId &&
    (scope.parentTeamId ?? projectScopeOwnerTeamId) !== undefined &&
    (scope.parentTeamId ?? projectScopeOwnerTeamId) === resource.parentTeamId
}

/** Normalizes an IPv4-mapped IPv6 address to its embedded canonical IPv4 address. */
function normalizeIpv4MappedAddress(value: string) {
  if (isIP(value) !== 6) return value
  let parsedValue = parseIpv6(value)
  if (parsedValue === undefined) {
    const separatorIndex = value.lastIndexOf(':')
    if (separatorIndex < 0) return value
    const embeddedValue = parseIpv4(value.slice(separatorIndex + 1))
    if (embeddedValue === undefined) return value
    const highGroup = (embeddedValue >> 16n).toString(16)
    const lowGroup = (embeddedValue & 0xffffn).toString(16)
    parsedValue = parseIpv6(
      `${value.slice(0, separatorIndex)}:${highGroup}:${lowGroup}`,
    )
  }
  if (parsedValue === undefined || parsedValue >> 32n !== 0xffffn) return value
  const embeddedValue = parsedValue & 0xffffffffn
  return [24n, 16n, 8n, 0n]
    .map((shift) => ((embeddedValue >> shift) & 0xffn).toString())
    .join('.')
}

/** Parses a canonical IPv4 address into a bigint. */
function parseIpv4(value: string) {
  const octets = value.split('.')
  if (octets.length !== 4) return undefined
  let parsed = 0n
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(octet)) return undefined
    const number = Number(octet)
    if (number > 255) return undefined
    parsed = parsed << 8n | BigInt(number)
  }
  return parsed
}

/** Parses an unembedded canonical IPv6 address into a bigint. */
function parseIpv6(value: string) {
  const normalized = value.toLowerCase()
  if (normalized.includes('.')) return undefined
  const doubleColonParts = normalized.split('::')
  if (doubleColonParts.length > 2) return undefined
  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : []
  const right = doubleColonParts[1] ? doubleColonParts[1].split(':') : []
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    doubleColonParts.length === 1 && left.length !== 8 ||
    doubleColonParts.length === 2 && left.length + right.length >= 8
  ) return undefined
  const groups = doubleColonParts.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left
  if (groups.length !== 8) return undefined
  return groups.reduce((result, group) => result << 16n | BigInt(`0x${group}`), 0n)
}
