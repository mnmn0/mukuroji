import type {
  EnterpriseGroupRoleMapping,
  EnterpriseIdentityProvider,
  EnterpriseRoleDefinition,
  EnterpriseSecuritySnapshot,
  EnterpriseSessionPolicy,
} from '../api'

/**
 * Group mapping と service account で選択できる Workspace/Team/Project scope です。
 */
export type EnterpriseSecurityScopeOption = {
  /** Scope の種類です。 */
  type: 'workspace' | 'team' | 'project'
  /** Scope の一意な ID です。 */
  id: string
  /** Selector に表示する scope 名です。 */
  name: string
}

/**
 * Directory group mapping editor が保持する scope と role の draft です。
 */
export type EnterpriseGroupRoleMappingDraft = {
  /** 選択中の role ID です。 */
  roleId: string
  /** `type:id` 形式の選択中 scope value です。 */
  scopeValue: string
}

/**
 * Creates an editable identity-provider draft from an API snapshot.
 *
 * @param identityProvider - Identity provider to clone.
 * @returns A draft that does not share its object reference with the snapshot.
 */
export function createIdentityProviderDraft(
  identityProvider: EnterpriseIdentityProvider,
): EnterpriseIdentityProvider {
  return { ...identityProvider }
}

/**
 * Creates an editable session-policy draft with cloned list fields.
 *
 * @param policy - Session policy to clone.
 * @returns A draft that shares no mutable lists with the snapshot.
 */
export function createSessionPolicyDraft(
  policy: EnterpriseSessionPolicy,
): EnterpriseSessionPolicy {
  return {
    ...policy,
    allowedGuestDomains: [...policy.allowedGuestDomains],
    ipAllowlist: [...policy.ipAllowlist],
  }
}

/**
 * Converts a scope option into a stable selector value.
 *
 * @param option - Scope option to serialize.
 * @returns A value in `type:id` form.
 */
export function createEnterpriseSecurityScopeValue(
  option: EnterpriseSecurityScopeOption,
): string {
  return `${option.type}:${option.id}`
}

/**
 * Builds initial permission-editor drafts from role definitions.
 *
 * @param roles - Roles used to initialize the editor.
 * @returns Permission IDs keyed by role ID.
 */
export function createRolePermissionDrafts(
  roles: EnterpriseRoleDefinition[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    roles.map((role) => [role.id, [...role.permissionIds]]),
  )
}

/**
 * Builds initial guest-assignment drafts from role definitions.
 *
 * @param roles - Roles used to initialize the editor.
 * @returns Guest-assignment flags keyed by role ID.
 */
export function createRoleGuestAssignableDrafts(
  roles: EnterpriseRoleDefinition[],
): Record<string, boolean> {
  return Object.fromEntries(
    roles.map((role) => [role.id, role.guestAssignable]),
  )
}

/**
 * Resolves roles the caller may assign to a mapping at a given scope.
 *
 * @param snapshot - Enterprise security snapshot.
 * @param scopeType - Scope type targeted by the mapping.
 * @returns Roles allowed by the server-owned assignment ceiling.
 */
export function resolveAssignableMappingRoles(
  snapshot: EnterpriseSecuritySnapshot,
  scopeType: EnterpriseSecurityScopeOption['type'],
): EnterpriseRoleDefinition[] {
  const assignableRoleIds = new Set(
    snapshot.assignableRoleIds.groupMappings[scopeType],
  )

  return snapshot.roles.filter((role) => assignableRoleIds.has(role.id))
}

/**
 * Builds initial scope and role drafts for existing mappings.
 *
 * @param mappings - Mappings used to initialize the editor.
 * @param scopeOptions - Scopes currently available to the caller.
 * @returns Mapping drafts keyed by mapping ID.
 */
export function createMappingDrafts(
  mappings: EnterpriseGroupRoleMapping[],
  scopeOptions: EnterpriseSecurityScopeOption[],
): Record<string, EnterpriseGroupRoleMappingDraft> {
  return Object.fromEntries(
    mappings.map((mapping) => [
      mapping.id,
      {
        roleId: mapping.roleId,
        scopeValue: resolveMappingScopeValue(mapping, scopeOptions),
      },
    ]),
  )
}

/**
 * Resolves the selector value for a mapping's current scope.
 *
 * @param mapping - Group mapping whose scope should be resolved.
 * @param scopeOptions - Scopes currently available to the caller.
 * @returns The matching scope value, or an empty string when unavailable.
 */
export function resolveMappingScopeValue(
  mapping: EnterpriseGroupRoleMapping,
  scopeOptions: EnterpriseSecurityScopeOption[],
): string {
  const exactScope = scopeOptions.find(
    (scope) =>
      scope.type === mapping.scopeType && scope.id === mapping.scopeId,
  )
  const workspaceScope =
    mapping.scopeType === 'workspace'
      ? scopeOptions.find((scope) => scope.type === 'workspace')
      : undefined

  return exactScope
    ? createEnterpriseSecurityScopeValue(exactScope)
    : workspaceScope
      ? createEnterpriseSecurityScopeValue(workspaceScope)
      : ''
}

/**
 * Normalizes multiline policy input for the API boundary.
 *
 * @param values - Individual lines to normalize.
 * @returns Trimmed lowercase values with blanks and duplicates removed.
 */
export function normalizeEnterpriseSecurityLineList(
  values: readonly string[],
): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  )
}
