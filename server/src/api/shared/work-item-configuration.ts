import { createHash } from 'node:crypto'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldDefinition,
  type RequestFormField,
  type CustomFieldValue,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
  type WorkItemTypeChangeResolution,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { type WorkItemDependencies } from '../../app/composition/app-dependencies'
import {
  CognitoServiceError,
  FlociCognitoClient,
  getSystemAdminGroups,
  type AuthTokenSet,
  type GetUserResponse,
} from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { type MutationAuditContext } from '../../modules/audit/audit'
import {
  customFieldValueRecordsEqual,
  isTeamIssueNotFoundError,
  readAssignedProjectId,
  type CreateTeamIssueRequestBody,
  type TeamIssueDetailResponse,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import {
  WorkItemConfigurationError,
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationGraphRevisionIncrementTransactionItem,
  getWorkItemTypeCustomFieldDefinitions,
  normalizeCustomFieldValues,
  resolveWorkItemType,
  resolveWorkItemTypeWorkflow,
  resolveWorkflowStatus,
  type WorkItemConfigurationTransactionItems,
} from '../../modules/work-items/work-item-configuration'
import {
  authenticationDependencies,
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { projectDirectoryIdPrefix } from './constants'
import {
  type CognitoAccessTokenClaims,
  readCognitoAuthenticationMethods,
  readCognitoGroups,
} from './enterprise-access'
import { createWorkspaceMutationContext, type ProjectPrincipal } from './project-access'
import { getEnv } from './runtime-config'
import { decodeJwtPayload, readNumericClaim, readUserAttribute } from './token-claims'
import { isRecord } from './value-guards'
import { requireActiveWorkspaceAssignee } from './workspace-access'

/**
 * Builds the login response for a completed Cognito authentication.
 *
 * @param tokens - Cognito token set.
 * @param c - Hono request context.
 * @param requestBody - Login request body.
 * @param requestAuditContext - Audit context of the login request.
 * @param verifiedAuthenticationMethods - Authentication methods verified for the session.
 * @returns The HTTP response carrying the session tokens.
 */
export async function createAuthenticationResponse(
  tokens: AuthTokenSet,
  c: Context,
  requestBody: Readonly<Record<string, unknown>>,
  requestAuditContext?: MutationAuditContext,
  verifiedAuthenticationMethods: readonly string[] = [],
) {
  if (!tokens.AccessToken) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito did not return an access token.',
    )
  }

  if (
    requireAppDependencies().authentication.cognito instanceof FlociCognitoClient &&
    tokens.AccessToken.split('.').length !== 3
  ) {
    return {
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    }
  }

  const user = await authenticationDependencies.cognito.getUser(tokens.AccessToken)
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (userKey?.trim()) {
    const principal = toProjectPrincipal(user, tokens.AccessToken)
    const auditContext = requestAuditContext ?? createWorkspaceMutationContext(
      c,
      principal,
      requestBody,
    )
    await workspaceDependencies.workspaceAccess.reconcileAuthenticatedMember(principal.directoryId, {
      memberKey: principal.userKey,
      email: readUserAttribute(user, 'email') ?? principal.userKey,
      name: readUserAttribute(user, 'name'),
    }, auditContext)
    const claims = decodeJwtPayload<CognitoAccessTokenClaims>(tokens.AccessToken)
    const authenticatedAt = readNumericClaim(claims?.auth_time) ??
      readNumericClaim(claims?.iat) ??
      Math.floor(Date.now() / 1_000)
    const expiresAt = readNumericClaim(claims?.exp) ??
      Math.floor(Date.now() / 1_000) + (tokens.ExpiresIn ?? 3_600)
    const authenticationMethods = [
      ...new Set([
        ...readCognitoAuthenticationMethods(claims),
        ...verifiedAuthenticationMethods,
      ]),
    ]
    if (authenticationMethods.length > 0) {
      await workspaceDependencies.enterpriseSessionActivity.recordAuthenticationAssurance({
        workspaceId: principal.directoryId,
        sessionId: createHash('sha256').update(tokens.AccessToken).digest('base64url'),
        authenticationMethods,
        authenticatedAt,
        expiresAt,
      })
    }
  }

  return {
    accessToken: tokens.AccessToken,
    idToken: tokens.IdToken,
    refreshToken: tokens.RefreshToken,
    expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
    tokenType: tokens.TokenType ?? 'Bearer',
  }
}

/**
 * Checks whether a request form field can map to a custom field.
 *
 * @param formField - Request form field.
 * @param customField - Custom field definition.
 * @returns `true` when the field types are compatible.
 */
export function isCompatibleRequestCustomField(
  formField: RequestFormField,
  customField: CustomFieldDefinition,
) {
  if (
    formField.type === 'short-text' ||
    formField.type === 'long-text' ||
    formField.type === 'email' ||
    formField.type === 'url'
  ) return customField.type === 'text'
  if (formField.type === 'number') {
    return customField.type === 'number' || customField.type === 'currency' || customField.type === 'duration'
  }
  if (formField.type === 'boolean') return customField.type === 'boolean'
  if (formField.type === 'date') return customField.type === 'date'
  if (formField.type === 'single-select') {
    const allowedOptions = new Set(customField.options?.map((option) => option.id) ?? [])
    return customField.type === 'select' &&
      (formField.options ?? []).every((option) => allowedOptions.has(option.id))
  }
  if (formField.type === 'multi-select') {
    const allowedOptions = new Set(customField.options?.map((option) => option.id) ?? [])
    return customField.type === 'multi-select' &&
      (formField.options ?? []).every((option) => allowedOptions.has(option.id))
  }
  return false
}

/** Removes Request mapping values that are outside the selected Work Item Type scope. */
export function filterRequestConversionCustomFieldValues(
  configuration: WorkItemConfiguration,
  typeId: unknown,
  values: unknown,
  projectId?: string,
): unknown {
  if (!isRecord(values)) return values
  const type = resolveWorkItemType(configuration, typeId)
  const allowedFieldIds = new Set(
    getWorkItemTypeCustomFieldDefinitions(configuration, type.id)
      .filter((definition) =>
        definition.type !== 'formula' &&
        (!definition.projectIds || definition.projectIds.length === 0 ||
          Boolean(projectId && definition.projectIds.includes(projectId)))
      )
      .map((definition) => definition.id),
  )
  return Object.fromEntries(Object.entries(values).filter(([fieldId]) =>
    allowedFieldIds.has(fieldId),
  ))
}

/** Parses the explicit acknowledgement sent with a Work Item Type change. */
export function readWorkItemTypeChangeResolution(
  value: unknown,
): WorkItemTypeChangeResolution | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !Array.isArray(value.discardCustomFieldIds)) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemTypeChangeResolution',
      'Work Item Type change resolution is invalid.',
    )
  }
  if (value.discardCustomFieldIds.length > 100) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemTypeChangeResolution',
      'Work Item Type change field acknowledgements are invalid.',
    )
  }
  const discardCustomFieldIds: string[] = []
  for (const fieldId of value.discardCustomFieldIds) {
    if (
      typeof fieldId !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(fieldId.trim())
    ) {
      throw new WorkItemConfigurationError(
        400,
        'InvalidWorkItemTypeChangeResolution',
        'Work Item Type change field acknowledgements are invalid.',
      )
    }
    discardCustomFieldIds.push(fieldId.trim())
  }
  if (
    value.workflowStatusId !== undefined &&
    (typeof value.workflowStatusId !== 'string' || !value.workflowStatusId.trim())
  ) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemTypeChangeResolution',
      'Replacement workflow status is invalid.',
    )
  }
  return {
    discardCustomFieldIds,
    ...(value.workflowStatusId === undefined
      ? {}
      : { workflowStatusId: value.workflowStatusId.trim() }),
  }
}

/**
 * Resolves and validates a Work Item create body against the active configuration.
 *
 * @param directoryId - Workspace that owns the Work Item.
 * @param teamId - Team whose configuration is authoritative.
 * @param input - Normalized create body.
 * @param resolved - Current Team or inherited Work Item configuration.
 * @param options - Context-specific status resolution options.
 * @returns A create body with canonical type, workflow, fields, and concurrency guards.
 */
export async function prepareConfiguredCreateWorkItem(
  directoryId: string,
  teamId: string,
  input: CreateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
  options: { fallbackToTypeInitialStatus?: boolean } = {},
): Promise<CreateTeamIssueRequestBody> {
  const { quickCapture, ...inputWithoutQuickCapture } = input
  if (quickCapture !== undefined && typeof quickCapture !== 'boolean') {
    throw new WorkItemConfigurationError(
      400,
      'InvalidQuickCapture',
      'Quick capture must be a boolean.',
    )
  }
  const workItemType = resolveWorkItemType(
    resolved.configuration,
    input.workItemTypeId,
  )
  const requestedWorkflowStatusId = typeof input.workflowStatusId === 'string'
    ? input.workflowStatusId.trim()
    : undefined
  const typeWorkflow = resolveWorkItemTypeWorkflow(resolved.configuration, workItemType.id)
  const workflowStatusId = options.fallbackToTypeInitialStatus &&
    requestedWorkflowStatusId !== undefined &&
    !typeWorkflow.statuses.some(
      (status) => status.id === requestedWorkflowStatusId,
    )
    ? undefined
    : input.workflowStatusId
  const workflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    workflowStatusId,
    workItemType.id,
  )
  const isQuickCapture = quickCapture === true

  if (isQuickCapture && workflowStatus.statusCategory !== 'backlog') {
    throw new WorkItemConfigurationError(
      400,
      'InvalidQuickCaptureStatus',
      'Quick capture is only available in a backlog workflow status.',
    )
  }

  const projectId = readAssignedProjectId(input.assignedProjectId) ?? undefined
  const customFieldValues = normalizeCustomFieldValues(
    resolved.configuration,
    input.customFieldValues,
    {
      allowRequiredMissing: isQuickCapture,
      mode: 'create',
      projectId,
      workItemTypeId: workItemType.id,
    },
  )
  await requireActiveCustomFieldPeople(
    directoryId,
    resolved.configuration,
    customFieldValues,
    projectId,
    workItemType.id,
  )
  return {
    ...inputWithoutQuickCapture,
    workItemTypeId: workItemType.id,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: workflowStatus.workflowStatusId,
    statusCategory: workflowStatus.statusCategory,
    customFieldValues,
    configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
      getWorkItemConfigurationTableName(),
      directoryId,
      teamId,
      resolved,
    ),
  }
}

/** Reads a Work Item's parent/child relations and fences their graph revision during a type change. */
export async function createWorkItemTypeRelationConfigurationTransactionItems(
  directoryId: string,
  teamId: string,
  current: TeamIssueResponseItem,
  targetTypeId: string,
  configuration: WorkItemConfiguration,
  relationDependencies: Pick<WorkItemDependencies, 'teamIssues' | 'workItemConfigurations'> =
    workItemDependencies,
): Promise<WorkItemConfigurationTransactionItems> {
  const relationPage = await relationDependencies.workItemConfigurations.listRelationGraph(
    directoryId,
    teamId,
  )
  const typeChangedRelations = relationPage.relations.filter((relation) =>
    (relation.sourceWorkItemId === current.id || relation.targetWorkItemId === current.id) &&
      (relation.type === 'parent' || relation.type === 'child'),
  )
  await Promise.all(typeChangedRelations.map(async (relation) => {
    const currentIsSource = relation.sourceWorkItemId === current.id
    const relatedWorkItemId = currentIsSource
      ? relation.targetWorkItemId
      : relation.sourceWorkItemId
    let targetDetail: TeamIssueDetailResponse
    try {
      targetDetail = await relationDependencies.teamIssues.getTeamIssueDetail(
        directoryId,
        teamId,
        relatedWorkItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemRelationInconsistent',
          'A Work Item relation points to a missing endpoint.',
        )
      }
      throw error
    }
    if (relation.type === 'parent') {
      assertWorkItemChildTypeAllowed(
        configuration,
        currentIsSource ? targetDetail.issue.workItemTypeId : targetTypeId,
        currentIsSource ? targetTypeId : targetDetail.issue.workItemTypeId,
      )
      return
    }
    assertWorkItemChildTypeAllowed(
      configuration,
      currentIsSource ? targetTypeId : targetDetail.issue.workItemTypeId,
      currentIsSource ? targetDetail.issue.workItemTypeId : targetTypeId,
    )
  }))
  return typeChangedRelations.length === 0
    ? []
    : [createWorkItemRelationGraphRevisionIncrementTransactionItem(
        getWorkItemConfigurationTableName(),
        directoryId,
        teamId,
        relationPage.graphRevision,
      )]
}

/**
 * Requires people referenced by custom field values to be active members.
 *
 * @param directoryId - Workspace directory ID.
 * @param configuration - Work Item configuration.
 * @param values - Custom field values.
 * @param projectId - Project that scopes the operation.
 * @param workItemTypeId - Work Item type ID.
 */
export async function requireActiveCustomFieldPeople(
  directoryId: string,
  configuration: WorkItemConfiguration,
  values: Readonly<Record<string, CustomFieldValue>>,
  projectId?: string,
  workItemTypeId?: string,
) {
  const definitions = getWorkItemTypeCustomFieldDefinitions(
    configuration,
    workItemTypeId,
    { allowArchived: true },
  )
  const personIds = definitions.flatMap((definition) => {
    const value = values[definition.id]
    return definition.type === 'person' &&
      (!definition.projectIds || definition.projectIds.length === 0 || Boolean(
        projectId && definition.projectIds.includes(projectId),
      )) &&
      typeof value === 'string'
      ? [value]
      : []
  })
  await Promise.all([...new Set(personIds)].map((personId) =>
    requireActiveWorkspaceAssignee(directoryId, personId),
  ))
}

/**
 * Validates that a Work Item configuration only references existing Teams, Projects, and members.
 *
 * @param directoryId - Workspace directory ID.
 * @param configuration - Work Item configuration.
 * @param teamId - Team that owns the resource.
 */
export async function validateWorkItemConfigurationReferences(
  directoryId: string,
  configuration: WorkItemConfiguration,
  teamId?: string,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(directoryId, 'ja')
  const scopedTeams = teamId
    ? directory.teams.filter((team) => team.id === teamId)
    : directory.teams
  if (teamId && scopedTeams.length === 0) {
    throw new WorkItemConfigurationError(
      404,
      'TeamNotFound',
      `Team "${teamId}" was not found.`,
    )
  }
  const activeProjectIds = new Set(
    scopedTeams.flatMap((team) => team.projects.map((project) => project.id)),
  )
  for (const definition of configuration.customFields) {
    for (const projectId of definition.projectIds ?? []) {
      if (!activeProjectIds.has(projectId)) {
        throw new WorkItemConfigurationError(
          400,
          'InvalidWorkItemConfiguration',
          `Custom field "${definition.id}" references inactive or out-of-scope project "${projectId}".`,
        )
      }
    }
    if (definition.type === 'person' && typeof definition.defaultValue === 'string') {
      await requireActiveWorkspaceAssignee(directoryId, definition.defaultValue)
    }
  }
}

/**
 * Asserts that a Work Item still matches its Work Item configuration.
 *
 * @param workItem - Work Item response item.
 * @param configuration - Work Item configuration.
 */
export function assertWorkItemConfigurationUsage(
  workItem: TeamIssueResponseItem,
  configuration: WorkItemConfiguration,
) {
  try {
    const workItemType = resolveWorkItemType(
      configuration,
      workItem.workItemTypeId,
      { allowArchived: true },
    )
    const status = resolveWorkflowStatus(
      configuration,
      workItem.workflowStatusId,
      workItemType.id,
    )
    if (status.statusCategory !== workItem.statusCategory) {
      throw new Error('the stored status category would become stale')
    }

    const storedValues = workItem.customFieldValues
    const typeDefinitions = getWorkItemTypeCustomFieldDefinitions(
      configuration,
      workItemType.id,
      { allowArchived: true },
    )
    const definitionIds = new Set(typeDefinitions.map((definition) => definition.id))
    const removedValueId = Object.keys(storedValues).find((fieldId) => !definitionIds.has(fieldId))
    if (removedValueId) {
      throw new Error(`stored field "${removedValueId}" would lose its definition`)
    }
    const normalizedValues = normalizeCustomFieldValues(
      configuration,
      undefined,
      {
        existingValues: storedValues,
        allowRequiredMissing: workItem.statusCategory === 'backlog',
        mode: 'update',
        projectId: workItem.assignedProjectId,
        workItemTypeId: workItemType.id,
      },
    )
    for (const definition of typeDefinitions) {
      if (
        definition.type === 'formula' &&
        (!definition.projectIds ||
          definition.projectIds.length === 0 ||
          Boolean(
            workItem.assignedProjectId &&
            definition.projectIds.includes(workItem.assignedProjectId),
          )) &&
        normalizedValues[definition.id] !== storedValues[definition.id]
      ) {
        throw new Error(`formula field "${definition.id}" requires recalculation`)
      }
    }
    if (!customFieldValueRecordsEqual(storedValues, normalizedValues)) {
      throw new Error('stored custom field values require normalization or scope cleanup')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'stored values are incompatible'
    throw new WorkItemConfigurationError(
      409,
      'WorkItemConfigurationInUse',
      `Work Item "${workItem.id}" uses a definition that conflicts with this configuration: ${reason}.`,
    )
  }
}

/**
 * Reads the Work Item configuration table name.
 *
 * @returns The configured table name or the local default.
 */
export function getWorkItemConfigurationTableName() {
  return getEnv('WORK_ITEM_CONFIGURATION_TABLE_NAME') ??
    'mukuroji-work-item-configuration-local'
}

/**
 * Converts a Cognito user into a project principal.
 *
 * @param user - Cognito user.
 * @param accessToken - Bearer access token from the request.
 * @returns The project principal.
 */
export function toProjectPrincipal(user: GetUserResponse, accessToken: string): ProjectPrincipal {
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (!userKey?.trim()) {
    throw new ProjectDataError(
      403,
      'ProjectPrincipalMissing',
      'Cognito user does not have a stable project access identifier.',
    )
  }

  const normalizedUserKey = userKey.trim().toLowerCase()
  const actorId = readUserAttribute(user, 'sub')?.trim() || user.Username?.trim() || normalizedUserKey
  const directoryId = readProjectDirectoryId(user) ?? `${projectDirectoryIdPrefix}${normalizedUserKey}`
  const groups = readCognitoGroups(accessToken)

  return {
    directoryId,
    userKey: normalizedUserKey,
    actorId,
    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
    groups,
  }
}

function getConfiguredWorkspaceDirectoryId() {
  return getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')?.trim() || undefined
}

function readProjectDirectoryId(user: GetUserResponse) {
  const directoryId = readUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const workspaceId = readUserAttribute(user, 'custom:workspace_id')?.trim() || undefined
  const configuredWorkspaceDirectoryId = getConfiguredWorkspaceDirectoryId()

  if (directoryId && workspaceId && directoryId !== workspaceId) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      'Cognito directory attributes do not identify the same workspace.',
    )
  }

  const claimedDirectoryId = directoryId ?? workspaceId

  if (
    configuredWorkspaceDirectoryId &&
    claimedDirectoryId !== configuredWorkspaceDirectoryId
  ) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      `Cognito workspace "${claimedDirectoryId ?? 'missing'}" does not match configured workspace "${configuredWorkspaceDirectoryId}".`,
    )
  }

  return claimedDirectoryId
}
