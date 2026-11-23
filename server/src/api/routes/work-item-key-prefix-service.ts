import type {
  TeamWorkItemKeyPrefixSettings,
  UpdateTeamWorkItemKeyPrefixRequest,
} from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import { createWorkItemKeyPrefixCandidates, type TeamWorkItemKeyPrefixState } from '../../modules/work-items'
import { workItemDependencies } from '../shared/app-dependencies'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canWorkspaceBusinessWrite,
  hasEnterprisePermissionAtResource,
  requireTeamPermission,
  type WorkspacePrincipal,
} from '../shared/project-access'

/**
 * Reads a Team's Work Item key prefix setting and whether the caller may change it.
 *
 * The caller must already be authorized to view the Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team ID.
 * @returns The settings response.
 */
export async function readTeamWorkItemKeyPrefixSettings(
  principal: WorkspacePrincipal,
  teamId: string,
): Promise<TeamWorkItemKeyPrefixSettings> {
  const [state, canManage] = await Promise.all([
    workItemDependencies.teamIssues.getTeamWorkItemKeyPrefix(principal.directoryId, teamId),
    canManageTeam(principal, teamId),
  ])
  return toResponse(teamId, state, canManage)
}

/**
 * Changes the key prefix of a Team's new Work Items in one transaction that also fences the
 * caller's authorization and writes the audit event.
 *
 * The caller must already be authorized as a Team manager with Workspace write access.
 *
 * @param principal - Authenticated Team manager.
 * @param teamId - Team ID.
 * @param request - Validated change request.
 * @param mutationContext - Audit context of the request.
 * @returns The settings response after the change.
 * @throws ProjectDataError (409) when the prefix is taken, changed first, or access changed.
 */
export async function changeTeamWorkItemKeyPrefix(
  principal: WorkspacePrincipal,
  teamId: string,
  request: UpdateTeamWorkItemKeyPrefixRequest,
  mutationContext: MutationAuditContext,
): Promise<TeamWorkItemKeyPrefixSettings> {
  // The registry saves only when the stored prefix equals `expectedKeyPrefix`, so that value is
  // the prefix the change actually replaced.
  const auditPut = createKeyPrefixAuditPut(
    mutationContext,
    principal,
    teamId,
    request.expectedKeyPrefix ?? undefined,
    request.keyPrefix,
  )
  const saved = await workItemDependencies.teamIssues.changeTeamWorkItemKeyPrefix({
    directoryId: principal.directoryId,
    teamId,
    keyPrefix: request.keyPrefix,
    expectedKeyPrefix: request.expectedKeyPrefix,
    now: new Date().toISOString(),
    transactItems: [
      // Fences the caller's membership version and Enterprise control revision, so a manager
      // whose access changed after the check cannot save.
      ...createPlanningCallerAuthorizationConditionChecks(
        principal,
        [],
        principal.principalKind !== 'service-account',
      ),
      ...(auditPut ? [auditPut] : []),
    ],
  })
  return toResponse(teamId, saved, true)
}

/**
 * Reports whether the principal may change the Team's prefix. A permission denial returns false;
 * other failures, such as a failed directory read, are thrown.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team ID.
 * @returns Whether the principal manages the Team and may write Workspace business data.
 */
async function canManageTeam(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  // Under Enterprise control the PUT route requires `teams.manage` at the Team, not the Team role.
  if (principal.enterprisePermissions !== undefined) {
    return hasEnterprisePermissionAtResource(principal, 'teams.manage', {
      workspaceId: principal.directoryId,
      kind: 'team',
      targetId: teamId,
    })
  }
  try {
    await requireTeamPermission({ ...principal, enterpriseRouteAuthorizedAtResource: false }, teamId, 'manager')
    return true
  } catch (error) {
    // Only a denial means "cannot manage"; a failed directory read must still fail the request.
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Builds the response body from a Team's prefix state.
 *
 * @param teamId - Team ID.
 * @param state - Stored prefix state.
 * @param canManage - Whether the caller may change the prefix.
 * @returns The settings response.
 */
function toResponse(
  teamId: string,
  state: TeamWorkItemKeyPrefixState,
  canManage: boolean,
): TeamWorkItemKeyPrefixSettings {
  return {
    teamId,
    ...(state.keyPrefix
      ? { keyPrefix: state.keyPrefix }
      : { suggestedKeyPrefix: createWorkItemKeyPrefixCandidates(teamId, 1)[0] }),
    previousPrefixes: state.previousPrefixes,
    lastNumber: state.lastNumber,
    canManage,
  }
}

/**
 * Builds the audit put written in the prefix change transaction.
 *
 * @param mutationContext - Audit context of the request.
 * @param principal - Team manager.
 * @param teamId - Team ID.
 * @param before - Prefix before the change, if any.
 * @param after - New prefix.
 * @returns The transactional audit put, or undefined when auditing is not configured.
 */
function createKeyPrefixAuditPut(
  mutationContext: MutationAuditContext,
  principal: WorkspacePrincipal,
  teamId: string,
  before: string | undefined,
  after: string,
) {
  return createMutationAuditEventPut(
    getConfiguredAuditTableName(),
    mutationContext,
    {
      directoryId: principal.directoryId,
      eventType: 'work-item-key-prefix.updated',
      entityType: 'work-item-key-prefix',
      entityId: `team/${teamId}/work-item-key-prefix`,
      action: 'updated',
      summary: 'Team Work Item key prefix was changed.',
      changes: [{ field: 'keyPrefix', before: before ?? '', after }],
      metadata: { adapter: 'work-item-key-prefix', teamId },
    },
  )
}
