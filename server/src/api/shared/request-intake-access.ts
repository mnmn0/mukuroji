import { createHash } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  type RequestFormDraft,
  type RequestFormVersion,
  type RequestSubmission,
  type TriageActionInput,
  type TriageEntry,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  normalizeProjectMemberKey,
  ProjectDataError,
  projectRoleWeights,
  type ProjectRole,
} from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import {
  WorkspaceAccessError,
  type WorkspaceActiveMemberConditionOptions,
} from '../../modules/workspace-access/workspace-access'
import { FileProofingError } from '../../modules/files/file-proofing'
import { type NotificationItem } from '../../modules/notifications/notifications'
import { RequestIntakeError } from '../../modules/request-intake/request-intake'
import {
  TriageError,
  type TriageAuthorizationConditionChecks,
  type TriageTeamAccess,
} from '../../modules/triage'
import {
  WorkItemConfigurationError,
  createWorkItemConfigurationGuardConditionChecks,
  getWorkItemTypeCustomFieldDefinitions,
  type WorkItemConfigurationTransactionItems,
} from '../../modules/work-items/work-item-configuration'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { toWorkItemConfigurationErrorResponse } from './collaboration-access'
import { TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS } from './constants'
import { toAuthErrorResponse } from './http'
import {
  createEnterpriseControlAuthorizationConditionCheck,
  getEffectiveProjectAccessList,
  isEnterpriseTriageTeamScope,
  requireTeamPermission,
  resolveTriageEnterpriseProjectRole,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from './project-access'
import {
  getWorkItemConfigurationTableName,
  isCompatibleRequestCustomField,
} from './work-item-configuration'
import {
  projectAccessAllows,
  type TeamPermissionContext,
  toWorkspaceAccessErrorResponse,
  validateRequestRoutingTarget,
} from './workspace-access'

/**
 * Validates Request Form routing targets and custom-field mappings against active configuration.
 *
 * @param workspaceId - Workspace that owns the Request Form.
 * @param draft - Draft or immutable published snapshot being checked.
 * @param configurationOverrides - Candidate configurations keyed by affected Team.
 * @param targetTeamIds - Optional Team allowlist for partial configuration validation.
 * @returns Configuration revision guards for the validated live configurations.
 */
export async function validateRequestFormRoutingReferences(
  workspaceId: string,
  draft: RequestFormDraft,
  configurationOverrides: ReadonlyMap<string, WorkItemConfiguration> = new Map(),
  targetTeamIds?: ReadonlySet<string>,
) {
  const targets = [draft.routing.defaultTarget, ...draft.routing.rules.map((rule) => rule.target)]
    .filter((target) => targetTeamIds?.has(target.teamId) ?? true)
  if (targets.length === 0) return []
  const configurations = new Map<string, WorkItemConfiguration>()
  const resolvedConfigurations = new Map<string, ResolvedWorkItemConfiguration>()
  for (const target of targets) {
    let configuration = configurations.get(target.teamId)
    if (!configuration) {
      const validated = await validateRequestRoutingTarget(
        workspaceId,
        target,
        undefined,
        configurationOverrides.get(target.teamId),
      )
      configuration = validated.configuration
      configurations.set(target.teamId, configuration)
      if (validated.resolvedConfiguration) {
        resolvedConfigurations.set(target.teamId, validated.resolvedConfiguration)
      }
    } else {
      await validateRequestRoutingTarget(
        workspaceId,
        target,
        undefined,
        configuration,
      )
    }
  }
  for (const [formFieldId, customFieldId] of Object.entries(
    draft.routing.mapping.customFieldMappings ?? {},
  )) {
    const formField = draft.definition.sections.flatMap((section) => section.fields)
      .find((field) => field.id === formFieldId)
    for (const target of targets) {
      const configuration = configurations.get(target.teamId)
      if (!configuration) {
        throw new RequestIntakeError(
          503,
          'RequestRoutingUnavailable',
          `Configuration for Team "${target.teamId}" is unavailable.`,
        )
      }
      const customField = getWorkItemTypeCustomFieldDefinitions(
        configuration,
        target.workItemTypeId,
      ).find((definition) => definition.id === customFieldId)
      if (!customField) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Custom field "${customFieldId}" is not active for Team "${target.teamId}".`,
        )
      }
      if (
        customField.projectIds &&
        (!target.projectId || !customField.projectIds.includes(target.projectId))
      ) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Custom field "${customFieldId}" is not active for the routed Project.`,
        )
      }
      if (!formField || !isCompatibleRequestCustomField(formField, customField)) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Form field "${formFieldId}" is not compatible with custom field "${customFieldId}".`,
        )
      }
    }
  }

  const guardsByKey = new Map<string, WorkItemConfigurationTransactionItems[number]>()
  for (const [teamId, resolved] of resolvedConfigurations) {
    for (const guard of createWorkItemConfigurationGuardConditionChecks(
      getWorkItemConfigurationTableName(),
      workspaceId,
      teamId,
      resolved,
    )) {
      if (!guard.ConditionCheck) continue
      const key = JSON.stringify([guard.ConditionCheck.TableName, guard.ConditionCheck.Key])
      if (!guardsByKey.has(key)) guardsByKey.set(key, guard)
    }
  }
  return [...guardsByKey.values()]
}

/**
 * Converts request intake failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @param publicBoundary - Whether the error crosses the public request boundary.
 * @returns The HTTP error response.
 */
export function toRequestIntakeErrorResponse(
  c: Context,
  error: unknown,
  publicBoundary = false,
) {
  if (
    publicBoundary &&
    (
      error instanceof CognitoServiceError && error.status >= 500 ||
      error instanceof FileProofingError && error.status >= 500 ||
      error instanceof RequestIntakeError && error.status >= 500
    )
  ) {
    console.error(error)
    return c.json({ code: 'RequestIntakeUnavailable', message: 'Request intake is unavailable.' }, 503)
  }
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) {
    if (publicBoundary) {
      return c.json(
        { code: 'RequestAuthenticationRequired', message: 'Authentication is required for this request form.' },
        401,
      )
    }
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkItemConfigurationError
  ) return toWorkItemConfigurationErrorResponse(c, error)
  if (error instanceof FileProofingError) {
    const status = error.status === 400 || error.status === 403 || error.status === 404 ||
      error.status === 409 || error.status === 413 || error.status === 422 || error.status === 503
      ? error.status
      : 502
    return c.json({ code: error.code, message: error.message }, status)
  }
  if (!(error instanceof RequestIntakeError)) {
    console.error(error)
    return c.json({ code: 'RequestIntakeUnavailable', message: 'Request intake is unavailable.' }, 503)
  }
  if (error.status >= 500) console.error(error)
  if (
    publicBoundary &&
    (
      error.code === 'RequestFormUnavailable' ||
      error.code === 'RequestCapabilityUnavailable' ||
      error.code === 'RequestThreadUnavailable'
    )
  ) {
    return c.json({ code: 'RequestFormUnavailable', message: 'Request form is unavailable.' }, 404)
  }
  const status = error.status === 400 || error.status === 401 || error.status === 403 ||
    error.status === 404 || error.status === 409 || error.status === 413 ||
    error.status === 422 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/** Resolves the exact Team management capability used by the settings mutation route. */
export function resolveTriageConfigurationManagement(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
  visibleProjectIds: readonly string[] | undefined,
): boolean {
  if (visibleProjectIds !== undefined && !principal.isSystemAdmin) return false
  if (principal.isSystemAdmin || principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') {
    return true
  }
  if (principal.enterpriseRouteAuthorizedAtResource) {
    return principal.enterpriseGrantedRoutePermissions?.includes('teams.manage') === true
  }
  if (principal.enterprisePermissions !== undefined) return false
  return context?.team.projects.every((project) => {
    const access = context.projectAccesses?.find((candidate) => candidate.projectId === project.id)
    return access?.role === 'manager'
  }) === true
}

/** Merges stronger Project-scoped Enterprise access into a Team-scoped read snapshot.
 *
 * Team-level Enterprise read grants synthesize viewer access for every active Project. A
 * principal may simultaneously hold a stronger Project role, so Triage must preserve that
 * narrower write authority without widening it to the whole Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team context initially resolved for the route.
 * @returns The context with the strongest role retained for each Project in the Team.
 */
export async function mergeTriageProjectAccesses(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
): Promise<TeamPermissionContext> {
  if (principal.isSystemAdmin || context.projectAccesses === undefined) return context
  const teamProjectIds = new Set(context.team.projects.map((project) => project.id))
  const roleByProjectId = new Map(
    context.projectAccesses.map((access) => [access.projectId, access.role] as const),
  )
  for (const access of await getEffectiveProjectAccessList(principal)) {
    if (!teamProjectIds.has(access.projectId) || access.role === undefined) continue
    const currentRole = roleByProjectId.get(access.projectId)
    if (
      currentRole === undefined ||
      projectRoleWeights[access.role] > projectRoleWeights[currentRole]
    ) {
      roleByProjectId.set(access.projectId, access.role)
    }
  }
  for (const project of context.team.projects) {
    const enterpriseRole = resolveTriageEnterpriseProjectRole(
      principal,
      context.team.id,
      project.id,
    )
    if (enterpriseRole === undefined) continue
    const currentRole = roleByProjectId.get(project.id)
    if (
      currentRole === undefined ||
      projectRoleWeights[enterpriseRole] > projectRoleWeights[currentRole]
    ) {
      roleByProjectId.set(project.id, enterpriseRole)
    }
  }
  return {
    ...context,
    projectAccesses: [...roleByProjectId].map(([projectId, role]) => ({ projectId, role })),
  }
}

/**
 * Resolves the strongest live Team access without widening a read-only Project role.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team and Project access context when the route reads entries.
 * @param teamId - Team whose access is being projected.
 * @param minimumAccess - Access already enforced for the current route.
 * @returns Strongest access that may be advertised in Triage response capabilities.
 */
export function resolveEffectiveTriageTeamAccess(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
  teamId: string,
  minimumAccess: TriageTeamAccess,
): TriageTeamAccess {
  if (minimumAccess === 'manage' || principal.isSystemAdmin) return 'manage'
  let effectiveAccess = minimumAccess
  if (isEnterpriseTriageTeamScope(principal, teamId)) {
    const canWrite = principal.enterprisePermissions?.includes('teams.write') === true
    if (canWrite && principal.enterprisePermissions?.includes('teams.manage')) return 'manage'
    if (canWrite) effectiveAccess = 'write'
  }
  if (context?.projectAccesses?.some((entry) => entry.role === 'manager')) return 'manage'
  if (context?.projectAccesses?.some((entry) => entry.role === 'member')) return 'write'
  return effectiveAccess
}

/**
 * Resolves the Project subset for which entry mutations may truthfully be advertised.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team and Project access context.
 * @param teamId - Team whose access is being projected.
 * @param teamAccess - Strongest resolved Team access.
 * @returns Writable Project IDs, an empty read-only set, or undefined for Team-wide write.
 */
export function resolveWritableTriageProjectIds(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
  teamId: string,
  teamAccess: TriageTeamAccess,
): readonly string[] | undefined {
  if (teamAccess === 'read') return []
  if (
    principal.isSystemAdmin ||
    isEnterpriseTriageTeamScope(principal, teamId) &&
      principal.enterprisePermissions?.includes('teams.write') === true
  ) {
    return undefined
  }
  if (!context) return undefined
  return resolveRestrictedTriageProjectIds(principal, context, 'member')
}

/**
 * Narrows a Team queue to the Projects for which the current principal has live access.
 *
 * A principal that can access every active Project receives full Team visibility, which
 * also permits unassigned entries. A partially scoped principal receives only explicit
 * Project IDs so unassigned or cross-Project source metadata is never disclosed.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team directory and Project access snapshot.
 * @param minimumRole - Role required by the current Triage operation.
 * @returns Explicit visible Project IDs, or undefined for full Team visibility.
 */
export function resolveRestrictedTriageProjectIds(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  minimumRole: ProjectRole,
): readonly string[] | undefined {
  if (principal.isSystemAdmin || context.projectAccesses === undefined) return undefined
  const visibleProjectIds = context.projectAccesses
    .filter((access) => projectAccessAllows(access, minimumRole))
    .map((access) => access.projectId)
  const activeProjectIds = new Set(context.team.projects.map((project) => project.id))
  if (
    activeProjectIds.size === visibleProjectIds.length &&
    visibleProjectIds.every((projectId) => activeProjectIds.has(projectId))
  ) {
    return undefined
  }
  return visibleProjectIds
}

/** Builds commit-time conditions for the Workspace actor and Project access authorizing a Triage action. */
export async function createTriageProjectAuthorizationConditionChecks(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workspaceId: string,
  teamId: string,
  projectId: string | undefined,
  minimumRole: ProjectRole = 'member',
): Promise<TriageAuthorizationConditionChecks> {
  if (principal.isSystemAdmin) {
    return []
  }
  const actorMembershipChecks = await createTriageActiveActorConditionChecks(principal)
  const enterpriseProjectAccess = projectId !== undefined &&
    principal.enterpriseProjectAccesses?.some((access) =>
      access.projectId === projectId && projectAccessAllows(access, minimumRole)
    ) === true
  if (isEnterpriseTriageTeamScope(principal, teamId) || enterpriseProjectAccess) {
    const enterpriseControlCheck = createEnterpriseControlAuthorizationConditionCheck(principal)
    return enterpriseControlCheck
      ? [...actorMembershipChecks, enterpriseControlCheck]
      : actorMembershipChecks
  }
  if (!projectId) return actorMembershipChecks
  const access = context.projectAccesses?.find((candidate) => candidate.projectId === projectId)
  if (!access || !projectAccessAllows(access, minimumRole)) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" cannot access assigned project "${projectId}".`,
    )
  }
  const createAccessConditionCheck = workspaceDependencies.projectDirectory
    .createProjectAccessConditionCheck
  if (!createAccessConditionCheck) {
    throw new TriageError(
      503,
      'TriageProjectAccessFenceUnavailable',
      'Project authorization fencing is unavailable. Retry the request.',
    )
  }
  const conditionCheck = await createAccessConditionCheck(
    workspaceId,
    projectId,
    principal.userKey,
    minimumRole,
  )
  if (!conditionCheck) {
    throw new TriageError(
      409,
      'TriageProjectAccessChanged',
      'Project authorization changed while the action was being prepared.',
    )
  }
  return mergeTriageConditionChecks(actorMembershipChecks, [conditionCheck])
}

/** Builds the commit-time active-membership fence for a Triage mutation. */
export async function createTriageActiveActorConditionChecks(
  principal: WorkspacePrincipal,
  options?: WorkspaceActiveMemberConditionOptions,
): Promise<TriageAuthorizationConditionChecks> {
  const createMemberCheck = workspaceDependencies.workspaceAccess
    .createActiveMemberConditionCheck
  if (!createMemberCheck) {
    throw new TriageError(
      503,
      'TriageActorAuthorizationFenceUnavailable',
      'Workspace membership fencing is unavailable. Retry the Triage action.',
    )
  }
  const conditionCheck = await createMemberCheck.call(
    workspaceDependencies.workspaceAccess,
    principal.directoryId,
    normalizeProjectMemberKey(principal.userKey),
    options ?? TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
  )
  if (!conditionCheck) {
    throw new TriageError(
      409,
      'TriageActorMembershipChanged',
      'Workspace membership changed while the Triage action was being prepared.',
    )
  }
  return [conditionCheck]
}

/** Removes duplicate DynamoDB condition checks when current and destination Projects coincide. */
export function mergeTriageConditionChecks(
  ...groups: readonly (NonNullable<TransactWriteCommandInput['TransactItems']>)[]
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const seen = new Set<string>()
  return groups.flatMap((group) => group.filter((item) => {
    const condition = item.ConditionCheck
    if (!condition?.TableName || !condition.Key) return true
    const key = JSON.stringify([condition.TableName, condition.Key])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }))
}

/** Builds commit-time Team, Project, and owner fences for a Form-backed action. */
export async function createTriageActionReferenceConditionChecks(
  workspaceId: string,
  teamId: string,
  entry: TriageEntry,
  action: Exclude<TriageActionInput, { action: 'accept' | 'duplicate' }>,
): Promise<NonNullable<TransactWriteCommandInput['TransactItems']>> {
  const createDirectoryChecks = workspaceDependencies.projectDirectory
    .createActiveReferenceConditionChecks
  const createMemberCheck = workspaceDependencies.workspaceAccess
    .createActiveMemberConditionCheck
  if (!createDirectoryChecks || !createMemberCheck) {
    throw new TriageError(
      503,
      'TriageAssignmentReferenceValidationUnavailable',
      'Assignment reference validation is unavailable. Retry the request.',
    )
  }
  const projectId = action.action === 'assign'
    ? action.projectId === null
      ? undefined
      : action.projectId ?? entry.projectId
    : entry.projectId
  let directoryChecks
  try {
    directoryChecks = await createDirectoryChecks.call(
      workspaceDependencies.projectDirectory,
      workspaceId,
      teamId,
      projectId,
    )
  } catch (error) {
    if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
      throw new TriageError(409, 'TriageAssignmentTeamUnavailable', 'The target Team is not active.', { cause: error })
    }
    if (error instanceof ProjectDataError && error.code === 'ProjectNotFound') {
      throw new TriageError(409, 'TriageAssignmentProjectUnavailable', 'The target Project is not active.', { cause: error })
    }
    throw error
  }
  if (action.action !== 'assign' || action.ownerUserId === null || action.ownerUserId === undefined) {
    return directoryChecks
  }
  const memberCheck = await createMemberCheck.call(
    workspaceDependencies.workspaceAccess,
    workspaceId,
    normalizeProjectMemberKey(action.ownerUserId),
    TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
  )
  if (!memberCheck) {
    throw new TriageError(
      409,
      'TriageAssignmentOwnerUnavailable',
      'The assigned owner is not an active Workspace member.',
    )
  }
  return [...directoryChecks, memberCheck]
}

/**
 * Derives the canonical Work Item ID used by every accept-create retry path.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Destination Team identifier.
 * @param entryId - Source Triage Entry identifier.
 * @returns A Work Item adapter-compatible deterministic identifier.
 */
export function createDeterministicTriageWorkItemId(
  workspaceId: string,
  teamId: string,
  entryId: string,
) {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${teamId}\0${entryId}`)
    .digest('hex')
  return `triage-${digest.slice(0, 48)}`
}

/** Converts Triage failures and existing application errors into the public API envelope. */
export function toTriageErrorResponse(context: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(context, error)
  if (error instanceof WorkItemConfigurationError) {
    return toWorkItemConfigurationErrorResponse(context, error)
  }
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(context, error)
  }
  if (error instanceof RequestIntakeError) {
    const status = error.status === 400 || error.status === 404 || error.status === 409 ||
        error.status === 413 || error.status === 422 || error.status === 429 ||
        error.status === 503
      ? error.status
      : 502
    return context.json({ code: error.code, message: error.message }, status)
  }
  if (!(error instanceof TriageError)) {
    console.error(error)
    return context.json(
      { code: 'TriageUnavailable', message: 'Team Triage is unavailable.' },
      503,
    )
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 || error.status === 401 || error.status === 403 ||
      error.status === 404 || error.status === 409 || error.status === 413 ||
      error.status === 422 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return context.json({ code: error.code, message: error.message }, status)
}

/** Requires a settings replacement caller to manage every active Project in the Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team whose complete configuration would be replaced.
 * @returns A Project-scoped Team context when legacy access was used, otherwise undefined.
 */
export async function requireFullTriageConfigurationScope(
  principal: WorkspacePrincipal,
  teamId: string,
): Promise<TeamPermissionContext | undefined> {
  if (
    principal.isSystemAdmin ||
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin' ||
    isEnterpriseTriageTeamScope(principal, teamId) &&
      principal.enterpriseGrantedRoutePermissions?.includes('teams.manage') === true
  ) {
    return undefined
  }

  const context = await requireTeamPermission(principal, teamId, 'manager')
  const managedProjectIds = new Set(
    context.projectAccesses
      ?.filter((access) => projectAccessAllows(access, 'manager'))
      .map((access) => access.projectId) ?? [],
  )
  if (context.team.projects.every((project) => managedProjectIds.has(project.id))) {
    return context
  }
  throw new WorkspaceAccessError(
    403,
    'WorkspacePermissionDenied',
    'Full Team management permission is required to replace Triage settings.',
  )
}

/** Returns whether a Triage notification is meaningful only to the current owner. */
export function requiresCurrentTriageOwner(notification: NotificationItem) {
  return notification.reasons.length > 0 && notification.reasons.every((reason) =>
    reason === 'assignee' || reason === 'assignment' || reason === 'due' ||
    reason === 'overdue' || reason === 'sla' || reason === 'triage-sla' ||
    reason === 'escalation' || reason === 'triage-assignment'
  )
}

/**
 * Validates immutable Request routing snapshots still required by published Forms or queued submissions.
 *
 * @param directoryId - Workspace whose configuration is being saved.
 * @param affectedTeamIds - Teams that will use the candidate configuration after the save.
 * @param configuration - Candidate configuration to test against those Teams.
 * @returns A promise that resolves after all affected Request routing references remain usable.
 */
export async function validateRequestFormConfigurationUsage(
  directoryId: string,
  affectedTeamIds: readonly string[],
  configuration: WorkItemConfiguration,
): Promise<void> {
  if (affectedTeamIds.length === 0) return
  const affectedTeamIdSet = new Set(affectedTeamIds)
  const configurationOverrides = new Map<string, WorkItemConfiguration>()
  for (const affectedTeamId of affectedTeamIds) {
    configurationOverrides.set(affectedTeamId, configuration)
  }
  let versions: RequestFormVersion[]
  try {
    versions = await workItemDependencies.requestIntake.listCurrentPublishedFormVersions(
      directoryId,
    )
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : 'published Request Forms could not be inspected'
    const unavailable = (
      error instanceof RequestIntakeError ||
      error instanceof ProjectDataError ||
      error instanceof WorkspaceAccessError ||
      error instanceof WorkItemConfigurationError
    ) && error.status >= 500
    throw new WorkItemConfigurationError(
      unavailable ? 503 : 409,
      unavailable
        ? 'WorkItemConfigurationDependencyUnavailable'
        : 'WorkItemConfigurationInUse',
      `Published Request Form configuration could not be inspected: ${reason}`,
    )
  }
  for (const version of versions) {
    const targets = [
      version.snapshot.routing.defaultTarget,
      ...version.snapshot.routing.rules.map((rule) => rule.target),
    ]
    if (!targets.some((target) => affectedTeamIdSet.has(target.teamId))) continue
    try {
      await validateRequestFormRoutingReferences(
        directoryId,
        version.snapshot,
        configurationOverrides,
        affectedTeamIdSet,
      )
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : 'published routing references are invalid'
      const unavailable = (
        error instanceof RequestIntakeError ||
        error instanceof ProjectDataError ||
        error instanceof WorkspaceAccessError ||
        error instanceof WorkItemConfigurationError
      ) && error.status >= 500
      throw new WorkItemConfigurationError(
        unavailable ? 503 : 409,
        unavailable
          ? 'WorkItemConfigurationDependencyUnavailable'
          : 'WorkItemConfigurationInUse',
        `Published Request Form "${version.formId}" version ${version.version} is incompatible with this configuration: ${reason}`,
      )
    }
  }

  let submissions: RequestSubmission[]
  try {
    submissions = await listNonTerminalRequestSubmissions(directoryId)
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : 'queued Request submissions could not be inspected'
    const unavailable = (
      error instanceof RequestIntakeError ||
      error instanceof ProjectDataError ||
      error instanceof WorkspaceAccessError ||
      error instanceof WorkItemConfigurationError
    ) && error.status >= 500
    throw new WorkItemConfigurationError(
      unavailable ? 503 : 409,
      unavailable
        ? 'WorkItemConfigurationDependencyUnavailable'
        : 'WorkItemConfigurationInUse',
      `Queued Request submissions could not be inspected: ${reason}`,
    )
  }
  for (const submission of submissions) {
    if (!affectedTeamIdSet.has(submission.routingTarget.teamId)) continue
    try {
      await validateRequestRoutingTarget(
        directoryId,
        submission.routingTarget,
        undefined,
        configurationOverrides.get(submission.routingTarget.teamId),
      )
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : 'queued routing references are invalid'
      const unavailable = (
        error instanceof RequestIntakeError ||
        error instanceof ProjectDataError ||
        error instanceof WorkspaceAccessError ||
        error instanceof WorkItemConfigurationError
      ) && error.status >= 500
      throw new WorkItemConfigurationError(
        unavailable ? 503 : 409,
        unavailable
          ? 'WorkItemConfigurationDependencyUnavailable'
          : 'WorkItemConfigurationInUse',
        `Queued Request submission "${submission.id}" is incompatible with this configuration: ${reason}`,
      )
    }
  }
}

const nonTerminalRequestSubmissionStatuses = [
  'received',
  'triaging',
  'needs-more-info',
] as const

/**
 * Lists every non-terminal Request submission using the bounded queue pagination contract.
 *
 * @param directoryId - Workspace whose queued submissions are inspected.
 * @returns Non-terminal submissions retained by the Request Intake queue.
 */
async function listNonTerminalRequestSubmissions(
  directoryId: string,
): Promise<RequestSubmission[]> {
  const submissions: RequestSubmission[] = []
  for (const status of nonTerminalRequestSubmissionStatuses) {
    let cursor: string | undefined
    const evaluatedCursors = new Set<string>()
    do {
      const page = await workItemDependencies.requestIntake.listSubmissions(directoryId, {
        status,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      })
      submissions.push(...page.submissions)
      if (page.nextCursor === undefined) break
      if (evaluatedCursors.has(page.nextCursor)) {
        throw new RequestIntakeError(
          503,
          'RequestRoutingUnavailable',
          'Request submission pagination did not advance.',
        )
      }
      evaluatedCursors.add(page.nextCursor)
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
  return submissions
}
