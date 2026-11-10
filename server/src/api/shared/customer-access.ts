import { type EnterprisePermissionId } from '@mukuroji/contracts'
import type { Context } from 'hono'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { type CustomerAuthorizationScope } from '../../modules/customers'
import { TriageError, type TriageTeamAccess } from '../../modules/triage'
import { readBearerAccessToken } from './http'
import {
  hasEnterpriseCustomerPermission,
  isEnterpriseTriageTeamScope,
  requireTeamConfigurationAdministration,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  resolveEnterpriseAuditActorKind,
  type WorkspacePrincipal,
} from './project-access'
import { authenticateWorkspacePrincipal } from './request-authorization'
import {
  mergeTriageProjectAccesses,
  requireFullTriageConfigurationScope,
  resolveEffectiveTriageTeamAccess,
  resolveRestrictedTriageProjectIds,
  resolveTriageConfigurationManagement,
  resolveWritableTriageProjectIds,
} from './request-intake-access'
import { type TeamPermissionContext } from './workspace-access'

/** Checks whether the authenticated principal may receive Customer impact data. */
export function hasCustomerReadAccess(
  principal: WorkspacePrincipal,
  scope?: CustomerAuthorizationScope,
): boolean {
  if (principal.workspaceRole === 'guest') return false
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) return principal.enterprisePermissions === undefined
  const customerReadPermissions: readonly EnterprisePermissionId[] = [
    'requests.read',
    'requests.manage',
    'workspace.manage',
  ]
  return customerReadPermissions.some((permission) =>
    hasEnterpriseCustomerPermission(principal, permission, scope)
  )
}

/**
 * Authenticates a Team Triage request and enforces its live Team authorization.
 *
 * Triage can contain requester identity and private routing rationale, so Workspace
 * guests are denied even when they can view a related Project.
 *
 * @param context - Current Hono request context.
 * @param teamId - Team queue identifier from the route.
 * @param access - Minimum Triage access requested by the adapter.
 * @returns The authenticated Workspace and member identifiers.
 */
export async function requireTriageTeamAccess(
  context: Context,
  teamId: string,
  access: TriageTeamAccess,
) {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot access the Team Triage queue.',
    )
  }
  let teamContext: TeamPermissionContext | undefined
  if (access === 'manage') {
    requireWorkspaceBusinessWrite(principal)
    if (
      principal.enterpriseRouteAuthorizedAtResource &&
      principal.enterprisePermissions !== undefined &&
      principal.enterpriseGrantedRoutePermissions?.includes('teams.manage') !== true
    ) {
      throw new WorkspaceAccessError(
        403,
        'WorkspacePermissionDenied',
        'Team management permission is required for Triage settings.',
      )
    }
    await requireTeamConfigurationAdministration(principal, teamId)
    teamContext = await requireFullTriageConfigurationScope(principal, teamId)
  } else {
    if (access === 'write') requireWorkspaceBusinessWrite(principal)
    teamContext = await requireTeamPermission(
      principal,
      teamId,
      access === 'write' ? 'member' : 'viewer',
    )
    if (isEnterpriseTriageTeamScope(principal, teamId)) {
      teamContext = await mergeTriageProjectAccesses(principal, teamContext)
    }
  }
  const visibleProjectIds = teamContext
    ? resolveRestrictedTriageProjectIds(
        principal,
        teamContext,
        access === 'write' ? 'member' : 'viewer',
      )
    : undefined
  const teamAccess = resolveEffectiveTriageTeamAccess(principal, teamContext, teamId, access)
  const writableProjectIds = resolveWritableTriageProjectIds(
    principal,
    teamContext,
    teamId,
    teamAccess,
  )
  const canManageConfiguration = resolveTriageConfigurationManagement(
    principal,
    teamContext,
    visibleProjectIds,
  )
  return {
    workspaceId: principal.directoryId,
    userId: principal.userKey,
    auditActor: {
      id: principal.actorId,
      kind: resolveEnterpriseAuditActorKind(principal),
      displayName: principal.userKey,
    },
    ...(principal.enterpriseBreakGlassActivationId
      ? { auditCorrelationId: principal.enterpriseBreakGlassActivationId }
      : {}),
    teamAccess,
    ...(visibleProjectIds !== undefined ? { visibleProjectIds } : {}),
    ...(writableProjectIds !== undefined ? { writableProjectIds } : {}),
    canManageConfiguration,
    canReadCustomerAssociations: hasCustomerReadAccess(principal, { teamId }),
  }
}

/** Checks whether the principal has the authority required to expose Customer internals or mutate them. */
export function hasCustomerManagementAccess(
  principal: WorkspacePrincipal,
  scope?: CustomerAuthorizationScope,
): boolean {
  if (principal.isSystemAdmin && (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin')) return true
  if (principal.enterprisePermissions !== undefined) {
    const customerManagementPermissions: readonly EnterprisePermissionId[] = [
      'requests.manage',
      'workspace.manage',
    ]
    return customerManagementPermissions.some((permission) =>
      hasEnterpriseCustomerPermission(principal, permission, scope)
    )
  } else if (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') {
    return true
  }
  return false
}
