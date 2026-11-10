import {
  type AutomationRule,
  type AutomationTemplate,
  type AutomationExecution,
  type AutomationValue,
  type RecurringWork,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import { ProjectDataError, type ProjectDirectoryResponse } from '../../modules/directory'
import {
  readTeamIssueAssigneeUserId,
  type CreateTeamIssueRequestBody,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  WorkItemConfigurationError,
  assertWorkItemChildTypeAllowed,
  type WorkItemConfigurationTransactionItems,
} from '../../modules/work-items/work-item-configuration'
import {
  AutomationError,
  type AutomationErrorCategory,
  type AutomationEvent,
} from '../../modules/automation'
import {
  automationDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { WORK_ITEMS_PARTITION_SCAN_LIMIT } from './constants'
import { validateRequestFormConfigurationUsage } from './request-intake-access'
import {
  assertWorkItemListWithinLimit,
  createWorkItemListProbeLimit,
  normalizeTeamIssueInput,
} from './work-item-access'
import {
  assertWorkItemConfigurationUsage,
  prepareConfiguredCreateWorkItem,
} from './work-item-configuration'
import { requireActiveWorkspaceAssignee } from './workspace-access'

/**
 * Builds the create-boundary body from merged Automation values.
 *
 * @param values - Template and action values to project into the create body.
 * @param idempotencyResourceId - Optional server-owned idempotency resource ID.
 * @returns Create-boundary body containing only supported Work Item fields.
 */
export function createAutomationWorkItemCreateBody(
  values: Readonly<Record<string, AutomationValue>>,
  idempotencyResourceId?: string,
): CreateTeamIssueRequestBody {
  return {
    ...(idempotencyResourceId === undefined ? {} : { idempotencyResourceId }),
    assignedProjectId: values.assignedProjectId,
    assigneeUserId: values.assigneeUserId,
    customFieldValues: values.customFieldValues,
    description: values.description,
    priority: values.priority,
    schedule: values.schedule,
    title: values.title,
    workItemTypeId: readAutomationText(values.workItemTypeId),
    workflowStatusId: values.workflowStatusId,
  }
}

/**
 * Reads a non-empty text value from automation event metadata.
 *
 * @param event - Automation event.
 * @param key - Metadata key.
 * @returns The trimmed text, or `undefined` when it is absent.
 */
export function readAutomationMetadataText(event: AutomationEvent, key: string) {
  return readAutomationText(event.metadata?.[key])
}

/**
 * Reads a non-empty automation text value.
 *
 * @param value - Automation value to read.
 * @returns The trimmed text, or `undefined` when it is empty.
 */
export function readAutomationText(value: AutomationValue | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Reads a positive safe integer from Automation event metadata.
 *
 * @param value - Metadata value to validate.
 * @returns Positive safe integer, or undefined for an invalid value.
 */
function readAutomationPositiveInteger(value: AutomationValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined
}

/**
 * Maps a transport-neutral Automation error category to the HTTP API status.
 *
 * @param category - Stable Automation failure category.
 * @returns HTTP status exposed by the Automation inbound adapter.
 */
export function mapAutomationErrorStatus(category: AutomationErrorCategory) {
  switch (category) {
    case 'invalid-input': return 400
    case 'unauthenticated': return 401
    case 'forbidden': return 403
    case 'not-found': return 404
    case 'conflict': return 409
    case 'payload-too-large': return 413
    case 'unsupported-media-type': return 415
    case 'unprocessable': return 422
    case 'locked': return 423
    case 'rate-limited': return 429
    case 'unavailable': return 503
  }
}

/**
 * Validates current Work Items and relations while the configuration scope write lock is held.
 *
 * Relation mutations that can be affected by configuration policy carry the same scope lock
 * condition. Returning one relation-graph condition per Team here would make a Workspace save
 * exceed DynamoDB's 100-item transaction limit without adding a concurrency guarantee.
 *
 * @param directoryId - Workspace whose configuration is being saved.
 * @param configuration - Candidate configuration being validated.
 * @param teamId - Team scope being saved, or undefined for a Workspace scope.
 */
export async function validateWorkItemConfigurationUsage(
  directoryId: string,
  configuration: WorkItemConfiguration,
  teamId?: string,
): Promise<WorkItemConfigurationTransactionItems> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(directoryId, 'ja')
  const targetTeamIds = teamId
    ? [teamId]
    : directory.teams.map((team) => team.id)
  const affectedTeamIds: string[] = []
  for (const targetTeamId of targetTeamIds) {
    if (!teamId) {
      const resolved = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        directoryId,
        targetTeamId,
      )
      if (!resolved.inheritedFrom && resolved.configuration.scopeType === 'team') {
        continue
      }
    }
    affectedTeamIds.push(targetTeamId)

    const relationGraph = await workItemDependencies.workItemConfigurations.listRelationGraph(
      directoryId,
      targetTeamId,
    )
    const readLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
    const response = await workItemDependencies.teamIssues.getTeamIssues(
      directoryId,
      targetTeamId,
      {
        consistentRead: true,
        includeArchived: true,
        ...(readLimit === undefined ? {} : { limit: readLimit }),
      },
    )
    assertWorkItemListWithinLimit(
      response.issues,
      WORK_ITEMS_PARTITION_SCAN_LIMIT,
      `Team "${targetTeamId}" configuration validation`,
    )
    for (const workItem of response.issues) {
      assertWorkItemConfigurationUsage(workItem, configuration)
    }
    const workItemsById = new Map(response.issues.map((workItem) => [workItem.id, workItem]))
    for (const relation of relationGraph.relations) {
      if (relation.type !== 'parent' && relation.type !== 'child') continue
      const source = workItemsById.get(relation.sourceWorkItemId)
      const target = workItemsById.get(relation.targetWorkItemId)
      if (!source || !target) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemConfigurationInUse',
          `Team "${targetTeamId}" contains a relation to a missing Work Item.`,
        )
      }
      if (relation.type === 'parent') {
        assertWorkItemChildTypeAllowed(
          configuration,
          target.workItemTypeId,
          source.workItemTypeId,
        )
      } else {
        assertWorkItemChildTypeAllowed(
          configuration,
          source.workItemTypeId,
          target.workItemTypeId,
        )
      }
    }
  }
  await validateRequestFormConfigurationUsage(
    directoryId,
    affectedTeamIds,
    configuration,
  )
  return await validateAutomationWorkItemConfigurationUsage(
    directoryId,
    affectedTeamIds,
    configuration,
    directory,
  )
}

/** A validated Work Item Automation template used by configuration usage checks. */
type WorkItemAutomationTemplate = Extract<AutomationTemplate, { kind: 'work-item' }>

/**
 * Lists pending, running, retryable failed, and dead-letter Automation executions with cursor-loop protection.
 *
 * @param workspaceId - Workspace whose executions are inspected.
 * @returns All execution snapshots that may resume pinned Automation work.
 */
async function listNonTerminalAutomationExecutions(
  workspaceId: string,
): Promise<AutomationExecution[]> {
  const statuses: readonly AutomationExecution['status'][] = [
    'pending',
    'running',
    'failed',
    'dead-letter',
  ]
  const executionsById = new Map<string, AutomationExecution>()
  await Promise.all(statuses.map(async (status) => {
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    do {
      const page = await automationDependencies.executions.listExecutions({
        workspaceId,
        status,
        consistentRead: true,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const execution of page.executions) {
        if (execution.status !== status) continue
        if (execution.workspaceId !== workspaceId) {
          throw new AutomationError(
            'unavailable',
            'AutomationExecutionScopeInvalid',
            'Automation execution scope metadata is inconsistent.',
            true,
          )
        }
        if (execution.status === 'failed' && !execution.retryable) continue
        executionsById.set(execution.id, execution)
      }
      cursor = page.nextCursor
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new AutomationError(
            'unavailable',
            'AutomationPaginationCursorLoop',
            'Automation execution pagination cursor did not advance.',
            true,
          )
        }
        seenCursors.add(cursor)
      }
    } while (cursor !== undefined)
  }))
  return [...executionsById.values()]
}

/**
 * Validates enabled Automation definitions that can create Work Items for an affected Team.
 *
 * @param directoryId - Workspace whose configuration is being saved.
 * @param affectedTeamIds - Teams that will use the candidate configuration after the save.
 * @param configuration - Candidate configuration to test against Automation references.
 * @param directory - Consistent Team and Project directory snapshot used by create validation.
 * @returns Commit-time Automation definition revision fences after all references remain usable.
 */
async function validateAutomationWorkItemConfigurationUsage(
  directoryId: string,
  affectedTeamIds: readonly string[],
  configuration: WorkItemConfiguration,
  directory: ProjectDirectoryResponse,
): Promise<WorkItemConfigurationTransactionItems> {
  if (affectedTeamIds.length === 0) return []
  const affectedTeamIdSet = new Set(affectedTeamIds)
  let automationDefinitionRevision: number
  try {
    automationDefinitionRevision = await automationDependencies.ruleTemplates.getAutomationDefinitionRevision(
      directoryId,
    )
  } catch (error) {
    throw createAutomationConfigurationUsageError(
      'Automation definition concurrency state could not be inspected',
      error,
    )
  }
  let recurringWorks: RecurringWork[]
  let rules: AutomationRule[]
  try {
    [recurringWorks, rules] = await Promise.all([
      automationDependencies.recurringSchedules.listRecurringWorks(directoryId),
      automationDependencies.ruleTemplates.listRules(directoryId),
    ])
  } catch (error) {
    throw createAutomationConfigurationUsageError(
      'Automation definitions could not be inspected',
      error,
    )
  }

  let executions: AutomationExecution[]
  try {
    executions = await listNonTerminalAutomationExecutions(directoryId)
  } catch (error) {
    throw createAutomationConfigurationUsageError(
      'Automation executions could not be inspected',
      error,
    )
  }

  const templateCache = new Map<string, Promise<WorkItemAutomationTemplate>>()
  /**
   * Loads and validates one immutable Work Item template version.
   *
   * @param templateId - Template identifier to load.
   * @param templateVersion - Immutable version pinned by the Automation definition.
   * @returns A promise for the enabled Work Item template.
   */
  const readWorkItemTemplate = (
    templateId: string,
    templateVersion: number | undefined,
  ): Promise<WorkItemAutomationTemplate> => {
    const cacheKey = `${templateId}\u0000${String(templateVersion)}`
    const cached = templateCache.get(cacheKey)
    if (cached) return cached
    const pending = (async () => {
      if (templateVersion === undefined || !Number.isSafeInteger(templateVersion)) {
        throw new AutomationError(
          'unavailable',
          'AutomationTemplateUnavailable',
          `Pinned Work Item template "${templateId}" is unavailable.`,
          true,
        )
      }
      const template = await automationDependencies.ruleTemplates.getTemplateVersion(
        directoryId,
        templateId,
        templateVersion,
      )
      if (!template || !template.enabled || template.kind !== 'work-item') {
        throw new AutomationError(
          'conflict',
          'AutomationTemplateUnavailable',
          `Pinned Work Item template "${templateId}" is unavailable.`,
        )
      }
      return template
    })()
    templateCache.set(cacheKey, pending)
    return pending
  }

  /**
   * Validates the complete merged create payload against one candidate Team configuration.
   *
   * @param targetTeamId - Team that will own the generated Work Item.
   * @param values - Merged template and action values for the generated Work Item.
   * @returns A promise that resolves after the create payload is accepted.
   */
  const validateCreatePayload = async (
    targetTeamId: string,
    values: Readonly<Record<string, AutomationValue>>,
  ) => {
    if (!affectedTeamIdSet.has(targetTeamId)) return
    const team = directory.teams.find((candidate) => candidate.id === targetTeamId)
    if (!team) {
      throw new WorkItemConfigurationError(
        409,
        'AutomationTeamUnavailable',
        `Automation target Team "${targetTeamId}" is unavailable.`,
      )
    }
    const configuredBody = await prepareConfiguredCreateWorkItem(
      directoryId,
      targetTeamId,
      normalizeTeamIssueInput(
        createAutomationWorkItemCreateBody(values),
        team,
      ),
      { configuration },
    )
    await requireActiveWorkspaceAssignee(
      directoryId,
      readTeamIssueAssigneeUserId(configuredBody),
    )
  }

  /**
   * Validates every Work Item create action in one immutable rule version.
   *
   * @param rule - Immutable Automation rule version to inspect.
   * @param fallbackTeamId - Event-derived target Team for actions without a Team value.
   * @returns A promise that resolves after all create actions are accepted.
   */
  const validateRuleCreateActions = async (
    rule: AutomationRule,
    fallbackTeamId?: string,
  ) => {
    for (const action of rule.actions) {
      if (action.type !== 'create') continue
      const template = action.templateId === undefined
        ? undefined
        : await readWorkItemTemplate(action.templateId, action.templateVersion)
      const values: Record<string, AutomationValue> = {
        ...template?.payload,
        ...action.values,
      }
      const targetTeamId = readAutomationText(values.teamId) ?? fallbackTeamId
      const targetTeamIds = targetTeamId === undefined
        ? affectedTeamIds
        : [targetTeamId]
      for (const candidateTeamId of targetTeamIds) {
        await validateCreatePayload(candidateTeamId, values)
      }
    }
  }

  for (const recurring of recurringWorks) {
    if (!recurring.enabled || !affectedTeamIdSet.has(recurring.teamId)) continue
    try {
      const template = await readWorkItemTemplate(
        recurring.templateId,
        recurring.templateVersion,
      )
      await validateCreatePayload(recurring.teamId, {
        ...template.payload,
        teamId: recurring.teamId,
      })
    } catch (error) {
      throw createAutomationConfigurationUsageError(
        `Enabled Recurring Work "${recurring.id}"`,
        error,
      )
    }
  }

  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      await validateRuleCreateActions(rule)
    } catch (error) {
      throw createAutomationConfigurationUsageError(
        `Enabled Automation Rule "${rule.id}" create actions`,
        error,
      )
    }
  }

  for (const execution of executions) {
    try {
      const event = await automationDependencies.executions.getExecutionEvent(
        directoryId,
        execution.id,
      )
      if (!event || event.workspaceId !== directoryId || event.eventId !== execution.triggerEventId) {
        throw new AutomationError(
          'unavailable',
          'AutomationTriggerEventUnavailable',
          `Automation execution "${execution.id}" trigger event is unavailable.`,
          true,
        )
      }
      if (execution.ruleId.startsWith('recurring:')) {
        const recurringWorkId = execution.ruleId.slice('recurring:'.length)
        const recurringWorkIdFromEvent = readAutomationMetadataText(event, 'recurringWorkId')
        const targetTeamId = readAutomationMetadataText(event, 'teamId')
        const templateId = readAutomationMetadataText(event, 'templateId')
        const templateVersion = readAutomationPositiveInteger(event.metadata?.templateVersion)
        if (
          !recurringWorkId ||
          recurringWorkIdFromEvent !== recurringWorkId ||
          !targetTeamId ||
          !templateId ||
          templateVersion === undefined
        ) {
          throw new AutomationError(
            'unavailable',
            'RecurringExecutionInvalid',
            `Automation execution "${execution.id}" recurring reference is invalid.`,
          )
        }
        const template = await readWorkItemTemplate(templateId, templateVersion)
        await validateCreatePayload(targetTeamId, {
          ...template.payload,
          teamId: targetTeamId,
        })
      } else {
        const rule = await automationDependencies.ruleTemplates.getRuleVersion(
          directoryId,
          execution.ruleId,
          execution.ruleVersion,
        )
        if (!rule) {
          throw new AutomationError(
            'unavailable',
            'AutomationRuleVersionUnavailable',
            `Automation execution "${execution.id}" rule version is unavailable.`,
            true,
          )
        }
        await validateRuleCreateActions(
          rule,
          readAutomationMetadataText(event, 'teamId'),
        )
      }
    } catch (error) {
      throw createAutomationConfigurationUsageError(
        `Automation execution "${execution.id}"`,
        error,
      )
    }
  }

  return [automationDependencies.ruleTemplates.createAutomationDefinitionRevisionConditionCheck(
    directoryId,
    automationDefinitionRevision,
  )]
}

/**
 * Converts an Automation usage failure into the Work Item configuration error contract.
 *
 * @param reference - Human-readable Automation definition reference.
 * @param error - Failure raised while reading or validating the reference.
 * @returns A stable Work Item configuration usage error.
 */
function createAutomationConfigurationUsageError(
  reference: string,
  error: unknown,
): WorkItemConfigurationError {
  const isKnownError = error instanceof AutomationError ||
    error instanceof ProjectDataError ||
    error instanceof WorkspaceAccessError ||
    error instanceof WorkItemConfigurationError
  const reason = isKnownError
    ? error.message
    : 'Automation references could not be inspected'
  const status = isKnownError
    ? error instanceof AutomationError
      ? mapAutomationErrorStatus(error.category)
      : error.status
    : 503
  const unavailable = status >= 500
  return new WorkItemConfigurationError(
    unavailable ? 503 : 409,
    unavailable
      ? 'WorkItemConfigurationDependencyUnavailable'
      : 'WorkItemConfigurationInUse',
    `${reference} is incompatible with this configuration: ${reason}.`,
  )
}
