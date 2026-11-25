import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldDefinition,
  type RequestFormField,
  type CustomFieldValue,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
  type WorkItemTypeChangeResolution,
  type WorkflowRuleActor,
  type WorkflowRuleWorkItemState,
} from '@mukuroji/contracts'
import { type WorkItemDependencies } from '../../app/composition/app-dependencies'
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
  assertWorkflowRules,
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
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { getEnv } from './runtime-config'
import { isRecord } from './value-guards'
import { createPlanningCallerAuthorizationConditionChecks } from './planning-access'
import { principalManagesTeamWorkItem, type ProjectPrincipal, type WorkspacePrincipal } from './project-access'
import { readNewWorkItemAcceptanceCriteria } from './work-item-acceptance-criteria'
import { requireActiveWorkspaceAssignee, type TeamPermissionContext } from './workspace-access'

/**
 * Who is changing a Work Item status, before it is judged against one Work Item.
 *
 * - `person`: a signed-in person acting directly in the Web.
 * - `automation`: an Automation rule, a Project template, or another app-owned job.
 * - `credential`: a developer credential, which Public API clients, MCP, and agents use.
 */
export type WorkflowRulePrincipal =
  | {
    /** A person acting directly. */
    kind: 'person'
    /** Member key compared with the Work Item assignee. */
    userKey: string
    /** Tells whether the person manages a Project of the Team, or the Team when `undefined`. */
    managesProject: (projectId: string | undefined) => boolean
    /**
     * Checks that fail the write when the person's member row or enterprise roles change after the
     * rules were judged.
     */
    roleConditionChecks: NonNullable<CreateTeamIssueRequestBody['authorizationConditionChecks']>
  }
  | {
    /** An app-owned job, never a person. */
    kind: 'automation'
  }
  | {
    /** A developer credential, never a person acting directly. */
    kind: 'credential'
  }

/** Rule principal of an Automation rule or another app-owned job. */
export const AUTOMATION_WORKFLOW_RULE_PRINCIPAL: WorkflowRulePrincipal = { kind: 'automation' }

/** Rule principal of a developer credential used by Public API clients, MCP, and agents. */
export const CREDENTIAL_WORKFLOW_RULE_PRINCIPAL: WorkflowRulePrincipal = { kind: 'credential' }

/**
 * Creates the rule principal of a principal signed in to a Team route.
 *
 * An enterprise service account authenticates on the same routes as a person but is not one, so it
 * is judged like a developer credential. Without a Team permission context, only a system admin
 * counts as a manager.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal, if the principal has one.
 * @returns A rule principal that reads the person's manager roles from the context.
 */
export function createPersonWorkflowRulePrincipal(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
): WorkflowRulePrincipal {
  if (principal.principalKind === 'service-account') return CREDENTIAL_WORKFLOW_RULE_PRINCIPAL
  return {
    kind: 'person',
    userKey: principal.userKey,
    managesProject: (projectId) => context
      ? principalManagesTeamWorkItem(principal, context, projectId)
      : principal.isSystemAdmin,
    roleConditionChecks: createPlanningCallerAuthorizationConditionChecks(principal),
  }
}

/**
 * Judges a rule principal against one Work Item.
 *
 * A person counts as a manager only when they manage every Project the change touches, so moving a
 * Work Item into another Project cannot borrow a role from either side.
 *
 * @param rulePrincipal - Who is changing the status.
 * @param workItem - Work Item before the change.
 * @param workItem.assigneeUserId - Current assignee.
 * @param workItem.assignedProjectId - Current Project, if any.
 * @param nextProjectId - Project after the change, if any.
 * @returns The actor the workflow rules evaluate.
 */
export function resolveWorkflowRuleActor(
  rulePrincipal: WorkflowRulePrincipal,
  workItem: { assigneeUserId?: string; assignedProjectId?: string },
  nextProjectId: string | undefined,
): WorkflowRuleActor {
  if (rulePrincipal.kind !== 'person') {
    return { interactive: false, projectManager: false, assignee: false }
  }
  const projectIds = new Set([workItem.assignedProjectId, nextProjectId])
  return {
    interactive: true,
    projectManager: [...projectIds].every((projectId) => rulePrincipal.managesProject(projectId)),
    assignee: workItem.assigneeUserId !== undefined &&
      workItem.assigneeUserId.trim().toLowerCase() === rulePrincipal.userKey.trim().toLowerCase(),
  }
}

/**
 * Builds the Work Item state that status required fields are checked against.
 *
 * @param schedule - Canonical schedule after the change.
 * @param acceptanceCriteriaCount - Number of acceptance criteria after the change.
 * @param customFieldValues - Custom field values after the change.
 * @returns The state with empty strings and lists treated as unfilled.
 */
export function createWorkflowRuleWorkItemState(
  schedule: unknown,
  acceptanceCriteriaCount: number,
  customFieldValues: Readonly<Record<string, CustomFieldValue>>,
): WorkflowRuleWorkItemState {
  return {
    hasDueDate: readScheduleDueDate(schedule) !== '',
    acceptanceCriteriaCount,
    filledCustomFieldIds: new Set(Object.entries(customFieldValues)
      .filter(([, value]) =>
        !(typeof value === 'string' && value.trim() === '') && !(Array.isArray(value) && value.length === 0))
      .map(([fieldId]) => fieldId)),
  }
}

/**
 * Reads the deadline projection of a normalized schedule without trusting its type.
 *
 * @param schedule - Normalized schedule value.
 * @returns The due date or end date, or an empty string when there is none.
 */
function readScheduleDueDate(schedule: unknown): string {
  if (!isRecord(schedule)) return ''
  const date = schedule.mode === 'due-date'
    ? schedule.dueDate
    : schedule.mode === 'date-range' || schedule.mode === 'milestone'
      ? schedule.endDate
      : undefined
  return typeof date === 'string' ? date : ''
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
 * @param rulePrincipal - Who creates the Work Item, for a workflow status other than the initial one.
 * @param options - Context-specific status resolution options.
 * @returns A create body with canonical type, workflow, fields, and concurrency guards.
 * @throws WorkflowRuleError when the Work Item is created in a status its creator may not enter, or
 *   without a field that status requires.
 */
export async function prepareConfiguredCreateWorkItem(
  directoryId: string,
  teamId: string,
  input: CreateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
  rulePrincipal: WorkflowRulePrincipal,
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
  // Creating in the initial status is not a status change; any other status is entered like one.
  if (workflowStatus.workflowStatusId !== typeWorkflow.initialStatusId) {
    assertWorkflowRules(resolved.configuration, {
      workItemTypeId: workItemType.id,
      projectId,
      fromStatusId: undefined,
      toStatusId: workflowStatus.workflowStatusId,
      // A new Work Item has no assignee before the change, so a creator naming themselves does not
      // satisfy `assignee`; only the target Project is managed.
      actor: resolveWorkflowRuleActor(rulePrincipal, { assignedProjectId: projectId }, projectId),
      state: () => createWorkflowRuleWorkItemState(
        input.schedule,
        // The create body's criteria are normalized the same way the create route stores them.
        readNewWorkItemAcceptanceCriteria(input.acceptanceCriteria)?.length ?? 0,
        customFieldValues,
      ),
    })
  }
  // A person may enter a restricted status only by their roles, so the create fails when those
  // roles change before it commits.
  const roleConditionChecks =
    workflowStatus.workflowStatusId !== typeWorkflow.initialStatusId && rulePrincipal.kind === 'person'
      ? rulePrincipal.roleConditionChecks
      : []
  return {
    ...inputWithoutQuickCapture,
    ...(roleConditionChecks.length > 0
      ? {
          authorizationConditionChecks: [
            ...roleConditionChecks,
            ...(inputWithoutQuickCapture.authorizationConditionChecks ?? []),
          ],
        }
      : {}),
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

/** Reads a Work Item's own parent/child relations and fences their graph revision during a type change. */
export async function createWorkItemTypeRelationConfigurationTransactionItems(
  directoryId: string,
  teamId: string,
  current: TeamIssueResponseItem,
  targetTypeId: string,
  configuration: WorkItemConfiguration,
  relationDependencies: Pick<WorkItemDependencies, 'teamIssues' | 'workItemConfigurations'> =
    workItemDependencies,
): Promise<WorkItemConfigurationTransactionItems> {
  // Reciprocal rows make the changed Work Item the source of both its parent and child links.
  const relationPage = await relationDependencies.workItemConfigurations.listRelations(
    directoryId,
    teamId,
    current.id,
    { types: ['child', 'parent'] },
  )
  const typeChangedRelations = relationPage.relations.filter((relation) =>
    relation.sourceWorkItemId === current.id &&
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
    // Job roles are retired by archiving; a role still assigned to a contributor must stay defined.
    const jobRoleIds = new Set((configuration.jobRoles ?? []).map((role) => role.id))
    const orphanedAssignment = workItem.contributorAssignments?.find((assignment) =>
      assignment.jobRoleId !== undefined && !jobRoleIds.has(assignment.jobRoleId))
    if (orphanedAssignment) {
      throw new Error(`job role "${orphanedAssignment.jobRoleId}" is still assigned to a contributor`)
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
