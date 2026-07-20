import type {
  EnterpriseSecurityCapabilities,
  EnterpriseSecuritySnapshot,
} from './api'

/**
 * Sensitive UI state を破棄する capability boundary key を作成します。
 *
 * @param capabilities 最新 snapshot の enterprise security capability です。
 * @returns Capability downgrade/restore の各遷移で Content を remountする key です。
 */
export function createEnterpriseSecurityCapabilityBoundary(
  capabilities?: EnterpriseSecurityCapabilities,
) {
  if (!capabilities) {
    return 'snapshot-unavailable'
  }

  return Object.entries(capabilities)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, allowed]) => `${capability}:${allowed}`)
    .join('|')
}

/**
 * Sensitive UI state を capability と snapshot freshness の境界で破棄する key を作成します。
 *
 * @param capabilities 最新 snapshot の enterprise security capability です。
 * @param isStale 表示 snapshot が stale かどうかです。
 * @returns Capability または freshness の遷移で Content を remount する key です。
 */
export function createEnterpriseSecurityStateBoundary(
  capabilities: EnterpriseSecurityCapabilities | undefined,
  isStale: boolean,
) {
  return `${createEnterpriseSecurityCapabilityBoundary(capabilities)}:${
    isStale ? 'stale' : 'fresh'
  }`
}

/**
 * Role/mapping/付与上限の更新時に access editor の一時入力を破棄する境界 key を作ります。
 */
export function createSecurityAccessBoundaryKey(
  snapshot: EnterpriseSecuritySnapshot,
  scopeOptions: ReadonlyArray<{ type: string; id: string }>,
) {
  return `access:${snapshot.roles
    .map((role) => `${role.id}:${role.version}`)
    .join(',')}:${snapshot.mappings
    .map((mapping) => `${mapping.id}:${mapping.version}`)
    .join(',')}:${scopeOptions
    .map((scope) => `${scope.type}:${scope.id}`)
    .join(',')}:${[...snapshot.assignablePermissionIds]
    .sort()
    .join(',')}`
}

/**
 * Server が返した active recovery expiry を表示可能な Unix time に変換します。
 */
export function parseActiveEnterpriseRecoveryExpiry(
  expiresAt: string | undefined,
  currentTime = Date.now(),
) {
  if (!expiresAt) {
    return undefined
  }

  const expiresAtMilliseconds = Date.parse(expiresAt)
  if (
    !Number.isFinite(expiresAtMilliseconds) ||
    expiresAtMilliseconds <= currentTime
  ) {
    return undefined
  }

  return expiresAtMilliseconds
}

/**
 * Service account scope ごとに server が許可した role grant ceiling を返します。
 */
export function resolveServiceAccountAssignableRoleIds(
  snapshot: EnterpriseSecuritySnapshot,
  scopeType: 'workspace' | 'team' | 'project',
) {
  return scopeType === 'workspace'
    ? snapshot.assignableRoleIds.serviceAccounts
    : snapshot.assignableRoleIds.groupMappings[scopeType]
}
