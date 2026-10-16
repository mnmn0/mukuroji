import { createHash } from 'node:crypto'
import {
  type AutomationAction,
  type AutomationExecutionStatus,
  type AutomationInboundWebhookDeliveryResponse,
  type AutomationTemplateApplication,
  type AutomationValue,
  type BulkOperation,
  type BulkOperationItemResult,
  type BulkOperationPreview,
  type BulkOperationRequest,
  type CreateWebhookTriageEntryInput,
  type UpdateAutomationRuleInput,
  type UpdateAutomationTemplateInput,
  type UpdateRecurringWorkInput,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError, readLocalizedNames } from '../../modules/directory'
import {
  createAuditEvent,
  createAuditEventId,
  createAuditEventTransactPut,
  createMutationAuditContext,
  createRequestFingerprint,
  calculateAuditExpiresAt,
  getConfiguredAuditTableName,
  getConfiguredAuditRetentionDays,
  type AuditEventV1,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  readAssignedProjectId,
  readTeamIssueAssigneeUserId,
  type TeamIssueResponseItem,
  type UpdateTeamIssueRequestBody,
  type UpdateTeamIssueResponse,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  type CollaborationAuthorizationConditionCheck,
} from '../../modules/collaboration/collaboration'
import { FileProofingError } from '../../modules/files/file-proofing'
import {
  WorkItemConfigurationError,
  validateWorkItemConfiguration,
} from '../../modules/work-items/work-item-configuration'
import {
  AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS,
  AutomationEngine,
  AutomationError,
  applyBulkOperation,
  deliverAutomationWebhook,
  createAutomationCommentId,
  isAutomationInboundWebhookJsonContentType,
  isAutomationValue,
  normalizeAutomationActionFailure,
  parseAutomationInboundWebhookJson,
  previewBulkOperation,
  readAutomationInboundWebhookBody,
  readAutomationInboundWebhookTimestamp,
  retryBulkOperation,
  toAutomationInboundWebhookEndpoint,
  undoBulkOperation,
  validateApplyAutomationTemplateInput,
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationRuleInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
  verifyAutomationInboundWebhookSignature,
  type AutomationActionExecutionContext,
  type AutomationActionExecutor,
  type AutomationEvent,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookProvisioning,
  type AutomationInboundWebhookSecretReference,
  type BulkOperationAdapter,
} from '../../modules/automation'
import {
  PlanningError,
  requirePlanningWorkItemHasNoScheduleDependencies,
} from '../../modules/planning'
import {
  createTriageInputFingerprint,
  isTriageTeamIdentifier,
  readWebhookTriageEnvelope,
  TriageError,
} from '../../modules/triage'
import {
  ambientAutomationActionExecutorDependencies,
  type AutomationActionExecutorDependencies,
  automationDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { toTriageErrorResponse } from '../shared/request-intake-access'
import {
  createAutomationWorkItemCreateBody,
  mapAutomationErrorStatus,
  readAutomationMetadataText,
  readAutomationText,
  validateWorkItemConfigurationUsage,
} from '../shared/automation-access'
import {
  createTeamIssueAutomaticWatcherCandidates,
  readCollaborationAuthorizationConditionChecks,
  toWorkItemConfigurationErrorResponse,
} from '../shared/collaboration-access'
import {
  createProjectSearchDocument,
  projectWorkItemSearchDocumentBestEffort,
} from '../shared/document-access'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import {
  prepareConfiguredUpdateWorkItem,
  requireApprovalReviewers,
  resolveFileApprovalCompletionTransition,
  toFileProofingErrorResponse,
} from '../shared/file-approval-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createPlanningFencedWorkItemAuthorizationSnapshot } from '../shared/planning-access'
import {
  createApiMutationContext,
  createWorkspaceMutationContext,
  requireAssignedProjectPermission,
  requireTeamConfigurationAdministration,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { getEnv } from '../shared/runtime-config'
import {
  projectWorkItemMutationSearchDocumentBestEffort,
  projectWorkspaceSearchDocumentBestEffort,
} from '../shared/search-access'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import { normalizeTeamIssueInput } from '../shared/work-item-access'
import {
  prepareConfiguredCreateWorkItem,
  validateWorkItemConfigurationReferences,
} from '../shared/work-item-configuration'
import { createDependencyFencedWorkItemAuthorizationSnapshot } from '../shared/work-item-schedule'
import {
  enforceActiveTenantForWorkspace,
  requireActiveWorkspaceAssignee,
} from '../shared/workspace-access'

async function readAutomationJson(c: Context) {
  const value = await readJson<unknown>(c.req)
  if (!isRecord(value)) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      'A JSON object request body is required.',
    )
  }
  return value
}

async function authenticateAutomationPrincipal(c: Context, manage = false) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new AutomationError('unauthenticated', 'AutomationAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (manage) requireWorkspaceAdministration(principal)
  return principal
}

function readRequiredInboundWebhookIdempotencyKey(c: Context) {
  const value = c.req.header('Idempotency-Key')?.trim()
  if (!value || value.length > 256) {
    throw new AutomationError(
      'invalid-input',
      'AutomationInboundWebhookIdempotencyKeyRequired',
      'A non-empty Idempotency-Key of at most 256 characters is required.',
    )
  }
  return value
}

function getAutomationInboundWebhookBaseUrl(c: Context) {
  return getEnv('AUTOMATION_INBOUND_WEBHOOK_BASE_URL')?.trim() || new URL(c.req.url).origin
}

async function requireAutomationInboundWebhookEndpoint(
  workspaceId: string,
  endpointId: string,
) {
  const endpoint = await automationDependencies.inboundWebhooks.getInboundWebhookEndpoint(workspaceId, endpointId)
  if (!endpoint) throw automationInboundWebhookNotFound()
  return endpoint
}

function toAutomationInboundWebhookSecretReference(
  endpoint: AutomationInboundWebhookEndpointRecord,
): AutomationInboundWebhookSecretReference {
  return {
    workspaceId: endpoint.workspaceId,
    endpointId: endpoint.id,
    secretId: endpoint.secretId,
    secretVersionId: endpoint.secretVersionId,
    secretGeneration: endpoint.secretGeneration,
  }
}

async function provisionAutomationInboundWebhookEndpoint(
  provisioning: AutomationInboundWebhookProvisioning,
) {
  const secretReference = toAutomationInboundWebhookSecretReference(provisioning.endpoint)
  try {
    const signingSecret = await automationDependencies.automationInboundWebhookSecrets.provision(secretReference)
    return {
      completed: await automationDependencies.inboundWebhooks.completeInboundWebhookProvisioning(provisioning),
      signingSecret,
    }
  } catch (error) {
    const current = await automationDependencies.inboundWebhooks.getInboundWebhookEndpoint(
      provisioning.endpoint.workspaceId,
      provisioning.endpoint.id,
    ).catch(() => undefined)
    if (current?.status === 'revoked') {
      await automationDependencies.automationInboundWebhookSecrets.delete(secretReference)
    }
    throw error
  }
}

function automationInboundWebhookNotFound() {
  return new AutomationError(
    'not-found',
    'AutomationInboundWebhookNotFound',
    'Inbound webhook endpoint was not found.',
  )
}

function automationInboundWebhookUnavailable() {
  return new AutomationError(
    'unavailable',
    'AutomationInboundWebhookUnavailable',
    'Inbound webhook service is unavailable.',
    true,
  )
}

function readAutomationPageLimit(value: string | undefined) {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AutomationError('invalid-input', 'InvalidAutomationQuery', 'Automation page limit is invalid.')
  }
  return limit
}

function readAutomationExecutionStatus(
  value: string | undefined,
): AutomationExecutionStatus | undefined {
  if (value === undefined) return undefined
  if (
    value === 'pending' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'dead-letter' ||
    value === 'skipped'
  ) return value
  throw new AutomationError('invalid-input', 'InvalidAutomationQuery', 'Automation execution status is invalid.')
}

function readWorkspaceBulkOperationRequest(
  value: Record<string, unknown>,
  workspaceId: string,
): BulkOperationRequest {
  return {
    ...value,
    workspaceId,
  } as BulkOperationRequest
}

async function requireBulkOperation(workspaceId: string, operationId: string) {
  const operation = await automationDependencies.bulkOperations.getBulkOperation(workspaceId, operationId)
  if (!operation) {
    throw new AutomationError('not-found', 'BulkOperationNotFound', 'Bulk operation was not found.')
  }
  return operation
}

/**
 * Restricts Bulk retry and undo operations to their initiating member.
 *
 * @param operation - Durable Bulk operation to authorize.
 * @param actorMemberKey - Current actor member key.
 */
export function requireBulkOperationOwner(operation: BulkOperation, actorMemberKey: string) {
  if (operation.actorMemberKey !== actorMemberKey) {
    throw new AutomationError('forbidden', 'BulkOperationForbidden', 'Bulk operation access is denied.')
  }
}

/**
 * Removes server-only undo snapshots from a Bulk operation response.
 *
 * @param operation - Durable Bulk operation to project.
 * @returns A response-safe copy of the operation.
 */
export function toBulkOperationResponse(operation: BulkOperation): BulkOperation {
  return {
    ...operation,
    items: operation.items.map((item) => {
      const redacted = { ...item }
      delete redacted.undoPayload
      return redacted
    }),
  }
}

function toBulkOperationPreviewResponse(preview: BulkOperationPreview): BulkOperationPreview {
  return {
    ...preview,
    items: preview.items.map((item) => {
      const redacted = { ...item }
      delete redacted.undoPayload
      return redacted
    }),
  }
}

async function putAutomationIngressEvent(
  c: Context,
  principal: WorkspacePrincipal,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new AutomationError('unavailable', 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
  }
  const context = createApiMutationContext(c, principal, metadata)
  const event = createAuditEvent({
    context,
    eventType: 'form.submitted',
    entity: { type: 'automation-form', id: entityId },
    summary: 'Automation form was submitted.',
    metadata,
    expiresAt: calculateAuditExpiresAt(
      context.occurredAt,
      getConfiguredAuditRetentionDays(),
    ),
  })
  const auditEvents = workspaceDependencies.auditEvents
  if (!auditEvents.putEvent) {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox does not provide an immutable writer.',
      true,
    )
  }
  try {
    await auditEvents.putEvent(event)
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AutomationError(
        'conflict',
        'IdempotencyConflict',
        'Idempotency key was already used with different automation ingress input.',
      )
    }
    throw error
  }
  return event
}

async function executeAutomationTemplateApplication(
  c: Context,
  principal: WorkspacePrincipal,
  initialApplication: AutomationTemplateApplication,
) {
  if (initialApplication.status === 'succeeded') return initialApplication
  assertTemplateApplicationNotFailed(initialApplication)
  const now = new Date()
  const application = await automationDependencies.ruleTemplates.claimTemplateApplication(
    initialApplication,
    now,
    new Date(now.getTime() + AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS).toISOString(),
  )
  if (!application) {
    const current = await automationDependencies.ruleTemplates.getTemplateApplication(
      initialApplication.workspaceId,
      initialApplication.id,
    )
    if (current?.status === 'succeeded') return current
    if (current) assertTemplateApplicationNotFailed(current)
    throw new AutomationError(
      'conflict',
      'AutomationTemplateApplicationInProgress',
      'Template application is already in progress. Retry with the same Idempotency-Key.',
      true,
    )
  }

  try {
    const template = await automationDependencies.ruleTemplates.getTemplateVersion(
      application.workspaceId,
      application.templateId,
      application.templateVersion,
    )
    if (!template || template.kind !== application.kind) {
      throw new AutomationError(
        'unavailable',
        'AutomationTemplateVersionUnavailable',
        'Pinned template version is unavailable.',
        true,
      )
    }
    if (application.kind === 'project') {
      const target = application.target
      if (template.kind !== 'project' || target.kind !== 'project') {
        throw new AutomationError('unavailable', 'AutomationTemplateApplicationInvalid', 'Project template application is invalid.')
      }
      const names = readLocalizedNames(template.payload)
      const result = {
        kind: 'project' as const,
        teamId: target.teamId,
        projectId: application.id,
        name: names.nameJa,
      }
      const response = await workspaceDependencies.projectDirectory.createProject(
        principal.directoryId,
        target.teamId,
        {
          ...template.payload,
          idempotencyResourceId: application.id,
        },
        {
          userKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
        },
        createApiMutationContext(
          c,
          principal,
          {
            applicationId: application.id,
            target,
            templateId: application.templateId,
            templateVersion: application.templateVersion,
          },
          application.id,
        ),
        [automationDependencies.ruleTemplates.createTemplateApplicationCompletionMutation(application, result)],
      )
      await projectWorkspaceSearchDocumentBestEffort(
        () => {
          return createProjectSearchDocument(
            principal.directoryId,
            target.teamId,
            response.project,
            principal.userKey,
            names.nameEn === response.project.name ? undefined : names.nameEn,
          )
        },
        'automation template Project creation',
      )
      return await requireCompletedTemplateApplication(application)
    }

    if (template.kind !== 'workflow' || application.target.kind !== 'workflow') {
      throw new AutomationError('unavailable', 'AutomationTemplateApplicationInvalid', 'Workflow template application is invalid.')
    }
    const target = application.target
    const resolved = target.scopeType === 'workspace'
      ? await workItemDependencies.workItemConfigurations.getWorkspaceConfiguration(application.workspaceId)
      : await workItemDependencies.workItemConfigurations.getTeamConfiguration(
          application.workspaceId,
          target.scopeId,
        )
    const storedTargetRevision = target.scopeType === 'team' && resolved.inheritedFrom
      ? 0
      : resolved.configuration.revision
    if (storedTargetRevision !== target.expectedRevision) {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemConfigurationRevisionConflict',
        'Work Item configuration changed. Reload and try again.',
      )
    }
    const configuration = validateWorkItemConfiguration({
      ...resolved.configuration,
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      revision: target.expectedRevision,
      workflow: template.payload,
      ...(resolved.configuration.workItemTypes === undefined
        ? {}
        : {
            workItemTypes: remapWorkItemTypeWorkflowReferences(
              resolved.configuration.workItemTypes,
              resolved.configuration.workflow.id,
              template.payload.id,
            ),
          }),
      ...(target.expectedRevision === 0 ? { updatedAt: undefined } : {}),
    }, {
      scopeType: target.scopeType,
      scopeId: target.scopeId,
    })
    const result = {
      kind: 'workflow',
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      revision: target.expectedRevision + 1,
    } as const
    const completionTransactItems = [
      automationDependencies.ruleTemplates.createTemplateApplicationCompletionMutation(application, result),
    ]
    const configurationAuditContext = createWorkspaceMutationContext(
      c,
      principal,
      {
        applicationId: application.id,
        target,
        templateId: application.templateId,
        templateVersion: application.templateVersion,
      },
      application.id,
    )
    if (target.scopeType === 'workspace') {
      await workItemDependencies.workItemConfigurations.saveWorkspaceConfiguration(
        application.workspaceId,
        configuration,
        async () => {
          await validateWorkItemConfigurationReferences(application.workspaceId, configuration)
          return validateWorkItemConfigurationUsage(application.workspaceId, configuration)
        },
        completionTransactItems,
        configurationAuditContext,
      )
    } else {
      await workItemDependencies.workItemConfigurations.saveTeamConfiguration(
        application.workspaceId,
        target.scopeId,
        configuration,
        async () => {
          await validateWorkItemConfigurationReferences(
            application.workspaceId,
            configuration,
            target.scopeId,
          )
          return validateWorkItemConfigurationUsage(
            application.workspaceId,
            configuration,
            target.scopeId,
          )
        },
        completionTransactItems,
        configurationAuditContext,
      )
    }
    return await requireCompletedTemplateApplication(application)
  } catch (error) {
    const current = await automationDependencies.ruleTemplates.getTemplateApplication(application.workspaceId, application.id)
      .catch(() => undefined)
    if (current?.status === 'succeeded') return current
    if (
      current?.status === 'running' &&
      current.revision === application.revision &&
      current.runnerLeaseExpiresAt === application.runnerLeaseExpiresAt
    ) {
      await saveTemplateApplicationFailureState(current, error).catch(() => undefined)
    }
    throw error
  }
}

/** Remaps explicit Work Item Types from a replaced primary Workflow to its template Workflow. */
function remapWorkItemTypeWorkflowReferences(
  workItemTypes: WorkItemConfiguration['workItemTypes'],
  replacedWorkflowId: string,
  replacementWorkflowId: string,
): WorkItemConfiguration['workItemTypes'] {
  if (workItemTypes === undefined || replacedWorkflowId === replacementWorkflowId) {
    return workItemTypes
  }
  return workItemTypes.map((type) => type.defaultWorkflowId === replacedWorkflowId
    ? { ...type, defaultWorkflowId: replacementWorkflowId }
    : type)
}

function assertTemplateApplicationNotFailed(application: AutomationTemplateApplication) {
  if (application.status !== 'failed') return
  throw new AutomationError(
    'conflict',
    application.errorCode ?? 'AutomationTemplateApplicationFailed',
    application.errorMessage ?? 'Template application previously failed.',
  )
}

async function requireCompletedTemplateApplication(application: AutomationTemplateApplication) {
  const completed = await automationDependencies.ruleTemplates.getTemplateApplication(application.workspaceId, application.id)
  if (completed?.status === 'succeeded') return completed
  throw new AutomationError(
    'unavailable',
    'AutomationTemplateApplicationCompletionUnavailable',
    'Template application completion is not yet available.',
    true,
  )
}

async function saveTemplateApplicationFailureState(
  application: AutomationTemplateApplication,
  error: unknown,
) {
  const {
    runnerLeaseExpiresAt: _runnerLeaseExpiresAt,
    result: _result,
    errorCode: _errorCode,
    errorMessage: _errorMessage,
    ...base
  } = application
  const updatedAt = new Date().toISOString()
  if (!isTerminalTemplateApplicationError(error)) {
    await automationDependencies.ruleTemplates.saveTemplateApplication({
      ...base,
      status: 'pending',
      revision: application.revision + 1,
      updatedAt,
    }, application.revision)
    return
  }
  const failed: AutomationTemplateApplication = {
    ...base,
    status: 'failed',
    revision: application.revision + 1,
    errorCode: error.code,
    errorMessage: error.message,
    updatedAt,
  }
  await automationDependencies.ruleTemplates.saveTemplateApplication(failed, application.revision)
}

function isTerminalTemplateApplicationError(
  error: unknown,
): error is AutomationError | WorkItemConfigurationError | ProjectDataError {
  if (error instanceof AutomationError) return error.category !== 'unavailable' && !error.retryable
  return (error instanceof WorkItemConfigurationError || error instanceof ProjectDataError) &&
    error.status < 500
}

/**
 * Converts Planning failures into the stable Automation action error contract.
 *
 * @param error - Planning failure raised while preparing one bulk mutation.
 * @param requireScheduleConfirmation - Whether dependency-in-use must become the schedule confirmation contract.
 * @returns Equivalent Automation error with conflict and retryability preserved.
 */
function toBulkAutomationPlanningError(
  error: PlanningError,
  requireScheduleConfirmation = false,
): AutomationError {
  const requiresConfirmation = requireScheduleConfirmation &&
    error.code === 'PlanningWorkItemDependencyInUse'
  return new AutomationError(
    error.status === 409 ? 'conflict' : 'unavailable',
    requiresConfirmation ? 'WorkItemScheduleConfirmationRequired' : error.code,
    requiresConfirmation
      ? 'Preview and explicitly confirm schedule changes for Work Items with dependencies.'
      : error.message,
    error.status >= 500,
  )
}

function createApiBulkOperationAdapter(
  principal: WorkspacePrincipal,
  c: Context,
): BulkOperationAdapter {
  const createBulkMutationContext = (
    metadata: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    const context = createApiMutationContext(c, principal, metadata, idempotencyKey)
    return {
      ...context,
      requestFingerprint: createRequestFingerprint({
        method: 'POST',
        path: '/internal/automation/bulk-item-mutation',
        body: metadata,
      }),
    }
  }

  const hasBulkMutationAuditProof = async (
    context: MutationAuditContext,
    teamId: string,
    workItemId: string,
    beforeRevision: number,
    afterRevision: number,
  ) => {
    const entityId = createTeamIssueAuditEntityId(teamId, workItemId)
    const eventId = createAuditEventId(
      context,
      'work-item.updated',
      { type: 'work-item', id: entityId },
    )
    const event = await workspaceDependencies.auditEvents.getEvent(principal.directoryId, eventId)
    return isExpectedBulkMutationAuditProof(
      event,
      context,
      principal,
      entityId,
      teamId,
      workItemId,
      beforeRevision,
      afterRevision,
    )
  }

  const loadCurrentItem = async (request: BulkOperationRequest, itemIndex: number) => {
    const item = request.items[itemIndex]
    if (!item) {
      throw new AutomationError('invalid-input', 'BulkOperationTargetMissing', 'Bulk operation target is missing.')
    }
    const context = await requireTeamPermission(principal, item.teamId, 'member')
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      item.teamId,
      item.workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    requireAssignedProjectPermission(
      principal,
      context,
      detail.issue.assignedProjectId,
      'member',
    )
    return { context, detail, item }
  }

  const loadItem = async (request: BulkOperationRequest, itemIndex: number) => {
    const loaded = await loadCurrentItem(request, itemIndex)
    if (loaded.detail.issue.revision !== loaded.item.expectedRevision) {
      throw new AutomationError(
        'conflict',
        'WorkItemRevisionConflict',
        'Work Item changed after it was selected.',
      )
    }
    return loaded
  }

  const prepareAction = async (
    request: BulkOperationRequest,
    itemIndex: number,
  ) => {
    const loaded = await loadItem(request, itemIndex)
    const { action } = request
    let body: UpdateTeamIssueRequestBody

    if (action.type === 'move') {
      body = normalizeTeamIssueInput(
        {
          assignedProjectId: action.targetProjectId,
          expectedRevision: loaded.item.expectedRevision,
        },
        loaded.context.team,
      )
      requireAssignedProjectPermission(
        principal,
        loaded.context,
        action.targetProjectId,
        'member',
      )
    } else if (action.type === 'archive') {
      let authorizationSnapshot: WorkItemAuthorizationSnapshot | undefined
      if (action.archived) {
        try {
          authorizationSnapshot = await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            loaded.item.teamId,
            loaded.item.workItemId,
          )
        } catch (error) {
          if (error instanceof PlanningError) {
            throw toBulkAutomationPlanningError(error)
          }
          throw error
        }
      }
      body = {
        archivedAt: action.archived ? new Date().toISOString() : null,
        archivedBy: action.archived ? principal.userKey : null,
        expectedRevision: loaded.item.expectedRevision,
        ...(authorizationSnapshot ? { authorizationSnapshot } : {}),
      }
    } else {
      body = normalizeTeamIssueInput(
        {
          ...action.patch,
          expectedRevision: loaded.item.expectedRevision,
        },
        loaded.context.team,
      )
      requireAssignedProjectPermission(
        principal,
        loaded.context,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
    }

    const configuredBody = action.type === 'archive'
      ? body
      : await prepareConfiguredUpdateWorkItem(
          principal.directoryId,
          loaded.item.teamId,
          loaded.detail.issue,
          body,
          await workItemDependencies.workItemConfigurations.getTeamConfiguration(
            principal.directoryId,
            loaded.item.teamId,
          ),
        )
    if ('assigneeUserId' in configuredBody) {
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(configuredBody),
      )
    }
    const changesAssignedProject =
      action.type !== 'archive' &&
      'assignedProjectId' in configuredBody &&
      readAssignedProjectId(configuredBody.assignedProjectId) !==
        loaded.detail.issue.assignedProjectId
    if (
      action.type !== 'archive' &&
      'schedule' in configuredBody &&
      configuredBody.schedule !== undefined &&
      stableDigestStringify(configuredBody.schedule) !==
        stableDigestStringify(loaded.detail.issue.schedule)
    ) {
      try {
        const authorizationSnapshot =
          await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            loaded.item.teamId,
            loaded.item.workItemId,
          )
        return {
          ...loaded,
          body: { ...configuredBody, authorizationSnapshot },
        }
      } catch (error) {
        if (error instanceof PlanningError) {
          throw toBulkAutomationPlanningError(error, true)
        }
        throw error
      }
    }
    if (changesAssignedProject) {
      try {
        const authorizationSnapshot =
          await createPlanningFencedWorkItemAuthorizationSnapshot(principal)
        return {
          ...loaded,
          body: { ...configuredBody, authorizationSnapshot },
        }
      } catch (error) {
        if (error instanceof PlanningError) {
          throw toBulkAutomationPlanningError(error)
        }
        throw error
      }
    }
    return { ...loaded, body: configuredBody }
  }

  const canAttemptResponseLossRecovery = (error: unknown) => {
    const failure = normalizeAutomationActionFailure(error)
    return failure.retryable || failure.code === 'WorkItemRevisionConflict' ||
      failure.code === 'ConditionalCheckFailedException'
  }

  const recoverAppliedItem = async (
    request: BulkOperationRequest,
    itemIndex: number,
    checkpoint: BulkOperationItemResult,
  ) => {
    if (!checkpoint.undoPayload) return undefined
    const loaded = await loadCurrentItem(request, itemIndex)
    const resultingRevision = loaded.item.expectedRevision + 1
    if (
      loaded.detail.issue.revision !== resultingRevision ||
      !isBulkActionApplied(loaded.detail.issue, request.action)
    ) return undefined
    const metadata = { bulkAction: request.action, item: loaded.item }
    const context = createBulkMutationContext(
      metadata,
      createBulkItemMutationIdempotencyKey(
        request,
        itemIndex,
        'apply',
        principal.userKey,
      ),
    )
    if (!await hasBulkMutationAuditProof(
      context,
      loaded.item.teamId,
      loaded.item.workItemId,
      loaded.item.expectedRevision,
      resultingRevision,
    )) return undefined
    return {
      resultingRevision,
      undoPayload: structuredClone(checkpoint.undoPayload),
    }
  }

  const recoverUndoneItem = async (
    operation: BulkOperation,
    itemIndex: number,
    request: BulkOperationRequest,
    item: BulkOperationItemResult,
  ) => {
    if (!item.undoPayload || item.resultingRevision === undefined) return undefined
    const loaded = await loadCurrentItem(request, 0)
    const resultingRevision = item.resultingRevision + 1
    if (
      loaded.detail.issue.revision !== resultingRevision ||
      !isAutomationPatchApplied(loaded.detail.issue, item.undoPayload)
    ) return undefined
    const metadata = {
      bulkOperationId: operation.id,
      itemIndex,
      undo: true,
    }
    const context = createBulkMutationContext(
      metadata,
      createBulkUndoMutationIdempotencyKey(operation, itemIndex),
    )
    if (!await hasBulkMutationAuditProof(
      context,
      item.teamId,
      item.workItemId,
      item.resultingRevision,
      resultingRevision,
    )) return undefined
    return { resultingRevision }
  }

  return {
    async preview(request, itemIndex) {
      const prepared = await prepareAction(request, itemIndex)
      return {
        allowed: true,
        undoPayload: createBulkUndoPayload(request.action, prepared.detail.issue),
      }
    },
    async apply(request, itemIndex, checkpoint) {
      let prepared: Awaited<ReturnType<typeof prepareAction>>
      try {
        prepared = await prepareAction(request, itemIndex)
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverAppliedItem(request, itemIndex, checkpoint)
          : undefined
        if (recovered) return recovered
        throw error
      }
      let response: UpdateTeamIssueResponse
      try {
        response = await workItemDependencies.teamIssues.updateTeamIssue(
          principal.directoryId,
          prepared.item.teamId,
          prepared.item.workItemId,
          prepared.body,
          principal.userKey,
          createBulkMutationContext(
            { bulkAction: request.action, item: prepared.item },
            createBulkItemMutationIdempotencyKey(
              request,
              itemIndex,
              'apply',
              principal.userKey,
            ),
          ),
        )
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverAppliedItem(request, itemIndex, checkpoint)
          : undefined
        if (recovered) return recovered
        throw error
      }
      await projectWorkItemMutationSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'bulk Work Item update',
      )
      return {
        resultingRevision: response.issue.revision,
        undoPayload: structuredClone(checkpoint.undoPayload),
      }
    },
    async undo(operation, itemIndex) {
      const item = operation.items[itemIndex]
      if (!item?.undoPayload || item.resultingRevision === undefined) {
        throw new AutomationError('conflict', 'BulkUndoUnavailable', 'Bulk operation item cannot be undone.')
      }
      const request: BulkOperationRequest = {
        workspaceId: operation.workspaceId,
        action: operation.action,
        items: [{
          teamId: item.teamId,
          workItemId: item.workItemId,
          expectedRevision: item.resultingRevision,
        }],
      }
      let loaded: Awaited<ReturnType<typeof loadItem>>
      try {
        loaded = await loadItem(request, 0)
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverUndoneItem(operation, itemIndex, request, item)
          : undefined
        if (recovered) return recovered
        throw error
      }
      const body = {
        ...item.undoPayload,
        expectedRevision: item.resultingRevision,
      } as UpdateTeamIssueRequestBody
      const normalizedBody = operation.action.type === 'archive'
        ? body
        : normalizeTeamIssueInput(body, loaded.context.team)
      if ('assignedProjectId' in normalizedBody) {
        requireAssignedProjectPermission(
          principal,
          loaded.context,
          readAssignedProjectId(normalizedBody.assignedProjectId),
          'member',
        )
      }
      const configuredBody = operation.action.type === 'archive'
        ? normalizedBody
        : await prepareConfiguredUpdateWorkItem(
            principal.directoryId,
            item.teamId,
            loaded.detail.issue,
            normalizedBody,
            await workItemDependencies.workItemConfigurations.getTeamConfiguration(
              principal.directoryId,
              item.teamId,
            ),
          )
      if ('assigneeUserId' in configuredBody) {
        await requireActiveWorkspaceAssignee(
          principal.directoryId,
          readTeamIssueAssigneeUserId(configuredBody),
        )
      }
      const changesSchedule = 'schedule' in configuredBody &&
        configuredBody.schedule !== undefined &&
        stableDigestStringify(configuredBody.schedule) !==
          stableDigestStringify(loaded.detail.issue.schedule)
      const changesAssignedProject = 'assignedProjectId' in configuredBody &&
        readAssignedProjectId(configuredBody.assignedProjectId) !==
          loaded.detail.issue.assignedProjectId
      const restoresArchive = typeof configuredBody.archivedAt === 'string'
      let mutationBody = configuredBody
      if (changesSchedule || restoresArchive || changesAssignedProject) {
        try {
          mutationBody = {
            ...configuredBody,
            authorizationSnapshot:
              changesSchedule || restoresArchive
                ? await createDependencyFencedWorkItemAuthorizationSnapshot(
                    principal,
                    item.teamId,
                    item.workItemId,
                  )
                : await createPlanningFencedWorkItemAuthorizationSnapshot(principal),
          }
        } catch (error) {
          if (error instanceof PlanningError) {
            throw new AutomationError(
              error.status === 409 ? 'conflict' : 'unavailable',
              changesSchedule && error.code === 'PlanningWorkItemDependencyInUse'
                ? 'WorkItemScheduleConfirmationRequired'
                : error.code,
              changesSchedule && error.code === 'PlanningWorkItemDependencyInUse'
                ? 'Preview and explicitly confirm schedule changes for Work Items with dependencies.'
                : error.message,
              error.status >= 500,
            )
          }
          throw error
        }
      }
      let response: UpdateTeamIssueResponse
      try {
        response = await workItemDependencies.teamIssues.updateTeamIssue(
          principal.directoryId,
          item.teamId,
          item.workItemId,
          mutationBody,
          principal.userKey,
          createBulkMutationContext(
            {
              bulkOperationId: operation.id,
              itemIndex,
              undo: true,
            },
            createBulkUndoMutationIdempotencyKey(operation, itemIndex),
          ),
        )
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverUndoneItem(operation, itemIndex, request, item)
          : undefined
        if (recovered) return recovered
        throw error
      }
      await projectWorkItemMutationSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'bulk Work Item undo',
      )
      return { resultingRevision: response.issue.revision }
    },
  }
}

function isExpectedBulkMutationAuditProof(
  event: AuditEventV1 | undefined,
  context: MutationAuditContext,
  principal: WorkspacePrincipal,
  entityId: string,
  teamId: string,
  workItemId: string,
  beforeRevision: number,
  afterRevision: number,
) {
  return event?.directoryId === principal.directoryId &&
    event.workspaceId === principal.directoryId &&
    event.eventType === 'work-item.updated' &&
    event.action === 'updated' &&
    event.idempotencyKeyHash === context.idempotencyKeyHash &&
    event.requestFingerprint === context.requestFingerprint &&
    event.actor.id === principal.actorId &&
    event.actor.kind === 'user' &&
    event.actorUserId === principal.actorId &&
    event.entity.type === 'work-item' &&
    event.entity.id === entityId &&
    event.entityType === 'work-item' &&
    event.entityId === entityId &&
    event.target.type === 'work-item' &&
    event.target.id === entityId &&
    event.targetType === 'work-item' &&
    event.targetId === entityId &&
    event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.actorMemberKey === principal.userKey &&
    event.metadata.teamId === teamId &&
    event.metadata.issueId === workItemId &&
    event.metadata.beforeRevision === beforeRevision &&
    event.metadata.afterRevision === afterRevision
}

/**
 * Creates a deterministic mutation key for one Bulk apply item.
 *
 * @param request - Canonical Bulk operation request.
 * @param itemIndex - Zero-based item index.
 * @param phase - Mutation phase bound to the key.
 * @param actorMemberKey - Member executing the mutation.
 * @returns A stable idempotency key.
 */
export function createBulkItemMutationIdempotencyKey(
  request: BulkOperationRequest,
  itemIndex: number,
  phase: 'apply',
  actorMemberKey: string,
) {
  const item = request.items[itemIndex]
  return `bulk_${createHash('sha256').update(JSON.stringify({
    action: request.action,
    item,
    phase,
    actorMemberKey,
    workspaceId: request.workspaceId,
  })).digest('hex')}`
}

function createBulkUndoMutationIdempotencyKey(
  operation: BulkOperation,
  itemIndex: number,
) {
  return `bulk_${createHash('sha256').update(JSON.stringify({
    itemIndex,
    operationId: operation.id,
    phase: 'undo',
    workspaceId: operation.workspaceId,
  })).digest('hex')}`
}

function createBulkUndoPayload(
  action: BulkOperationRequest['action'],
  issue: TeamIssueResponseItem,
): Record<string, AutomationValue> {
  if (action.type === 'move') {
    return { assignedProjectId: issue.assignedProjectId ?? null }
  }
  if (action.type === 'archive') {
    return {
      archivedAt: issue.archivedAt ?? null,
      archivedBy: issue.archivedBy ?? null,
    }
  }
  const snapshot: Record<string, AutomationValue> = {}
  const issueValues = issue as unknown as Record<string, AutomationValue | undefined>
  for (const field of Object.keys(action.patch)) {
    if (bulkEditableWorkItemFields.has(field)) {
      snapshot[field] = issueValues[field] ?? null
    }
  }
  return snapshot
}

function isBulkActionApplied(
  issue: TeamIssueResponseItem,
  action: BulkOperationRequest['action'],
) {
  if (action.type === 'edit') return isAutomationPatchApplied(issue, action.patch)
  if (action.type === 'move') {
    return automationValuesEqual(issue.assignedProjectId ?? null, action.targetProjectId)
  }
  return action.archived
    ? Boolean(issue.archivedAt) && issue.archivedBy !== undefined
    : issue.archivedAt === undefined && issue.archivedBy === undefined
}

const bulkEditableWorkItemFields = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'priority',
  'schedule',
  'title',
  'workflowStatusId',
])

const automationEditableWorkItemFields = new Set([
  ...bulkEditableWorkItemFields,
  'typeChangeResolution',
  'workItemTypeId',
])

/**
 * Creates the action executor used by the durable Automation engine.
 *
 * @param dependencies - Explicit Automation action ports; API routes use request-bound defaults.
 * @returns An executor for one Automation action at a time.
 */
export function createAutomationActionExecutor(
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
): AutomationActionExecutor {
  return {
    async execute(action, context) {
      switch (action.type) {
        case 'assign':
          await executeAutomationWorkItemUpdate(
            { assigneeUserId: action.assigneeMemberKey },
            context,
            dependencies,
          )
          return
        case 'move':
          await executeAutomationWorkItemUpdate(
            { assignedProjectId: action.targetProjectId },
            context,
            dependencies,
          )
          return
        case 'update':
          await executeAutomationWorkItemUpdate(action.patch, context, dependencies)
          return
        case 'create':
          await executeAutomationWorkItemCreate(action, context, dependencies)
          return
        case 'comment':
          await executeAutomationComment(action.body, context, dependencies)
          return
        case 'notify':
          await emitAutomationOutboxEvent(
            'automation.notification.requested',
            action.title,
            action.recipientMemberKeys,
            context,
            { body: action.body ?? '' },
            dependencies,
          )
          return
        case 'approval':
          await executeAutomationApproval(action, context, dependencies)
          return
        case 'webhook':
          await deliverAutomationWebhook(action, context)
      }
    },
  }
}

/**
 * Applies a validated Automation patch to one canonical Work Item.
 *
 * @param patch - Automation field values to apply.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the update workflow.
 * @returns A promise that resolves after persistence and projection.
 */
async function executeAutomationWorkItemUpdate(
  patch: Record<string, AutomationValue>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await dependencies.teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, includeEvents: false },
  )
  const unsafeFields = Object.keys(patch).filter((field) => !automationEditableWorkItemFields.has(field))
  if (unsafeFields.length > 0) {
    throw new AutomationError(
      'invalid-input',
      'AutomationUpdateFieldUnsupported',
      `Automation cannot update fields: ${unsafeFields.join(', ')}.`,
    )
  }
  const body = {
    ...patch,
    expectedRevision: detail.issue.revision,
  } as UpdateTeamIssueRequestBody
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  const configuredBody = await prepareConfiguredUpdateWorkItem(
    context.execution.workspaceId,
    target.teamId,
    detail.issue,
    normalizeTeamIssueInput(body, team),
    await dependencies.workItemConfigurations.getTeamConfiguration(
      context.execution.workspaceId,
      target.teamId,
    ),
    { relationDependencies: dependencies },
  )
  if ('assigneeUserId' in configuredBody) {
    await requireActiveWorkspaceAssignee(
      context.execution.workspaceId,
      readTeamIssueAssigneeUserId(configuredBody),
      dependencies,
    )
  }
  const changesSchedule =
    'schedule' in configuredBody &&
    configuredBody.schedule !== undefined &&
    stableDigestStringify(configuredBody.schedule) !==
      stableDigestStringify(detail.issue.schedule)
  const changesAssignedProject =
    'assignedProjectId' in configuredBody &&
    readAssignedProjectId(configuredBody.assignedProjectId) !== detail.issue.assignedProjectId
  const planningRevisionFence = changesSchedule
    ? await createAutomationSchedulePlanningRevisionFence(
        context.execution.workspaceId,
        target.teamId,
        target.workItemId,
        dependencies,
      )
    : changesAssignedProject
      ? await createAutomationPlanningRevisionFence(
          context.execution.workspaceId,
          dependencies,
        )
      : undefined
  const mutationContext = createAutomationMutationContext(context, patch)
  let updatedIssue: TeamIssueResponseItem
  try {
    const response = await dependencies.teamIssues.updateTeamIssue(
      context.execution.workspaceId,
      target.teamId,
      target.workItemId,
      {
        ...configuredBody,
        ...(planningRevisionFence ? { planningRevisionFence } : {}),
      },
      `automation:${context.execution.ruleId}`,
      mutationContext,
    )
    updatedIssue = response.issue
  } catch (error) {
    const current = await dependencies.teamIssues.getTeamIssueDetail(
      context.execution.workspaceId,
      target.teamId,
      target.workItemId,
      { consistentIssueRead: true, includeEvents: false },
    ).catch(() => undefined)
    const resultingRevision = detail.issue.revision + 1
    if (
      !current ||
      current.issue.revision !== resultingRevision ||
      !isAutomationPatchApplied(current.issue, patch) ||
      !await hasAutomationMutationAuditProof(
        mutationContext,
        target.teamId,
        target.workItemId,
        detail.issue.revision,
        resultingRevision,
        dependencies,
      )
    ) throw error
    updatedIssue = current.issue
  }
  await projectWorkItemSearchDocumentBestEffort(
    context.execution.workspaceId,
    updatedIssue,
    'automation Work Item update',
    undefined,
    dependencies,
  )
}

/**
 * Verifies that one Automation schedule update is isolated and captures its Planning fence.
 *
 * @param workspaceId - Workspace containing the target Work Item.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @param dependencies - Ports used by the Automation execution.
 * @returns Exact Planning revision that must still hold in the update transaction.
 */
async function createAutomationSchedulePlanningRevisionFence(
  workspaceId: string,
  teamId: string,
  workItemId: string,
  dependencies: AutomationActionExecutorDependencies,
) {
  const state = await dependencies.planning.getAuthorizationState(workspaceId)
  if (!Array.isArray(state.workItemDependencies)) {
    throw new AutomationError(
      'unavailable',
      'PlanningWorkItemDependencyStateUnavailable',
      'Work Item dependency state is unavailable for mutation validation.',
      true,
    )
  }
  try {
    requirePlanningWorkItemHasNoScheduleDependencies(
      state.workItemDependencies,
      teamId,
      workItemId,
    )
  } catch (error) {
    if (
      error instanceof PlanningError &&
      error.code === 'PlanningWorkItemDependencyInUse'
    ) {
      throw new AutomationError(
        'conflict',
        'WorkItemScheduleConfirmationRequired',
        'Preview and explicitly confirm schedule changes for Work Items with dependencies.',
      )
    }
    throw error
  }
  return { expectedRevision: state.revision }
}

/**
 * Captures the Planning revision that serializes an Automation Project move with archive.
 *
 * @param workspaceId - Workspace containing the target Work Item.
 * @param dependencies - Ports used by the Automation execution.
 * @returns Exact Planning revision that must still hold in the update transaction.
 */
async function createAutomationPlanningRevisionFence(
  workspaceId: string,
  dependencies: AutomationActionExecutorDependencies,
) {
  const state = await dependencies.planning.getAuthorizationState(workspaceId)
  return { expectedRevision: state.revision }
}

/**
 * Verifies that a recovered Automation update has its deterministic audit proof.
 *
 * @param context - Mutation audit context used by the original write.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Target Work Item identifier.
 * @param beforeRevision - Revision observed before the write.
 * @param afterRevision - Expected revision after the write.
 * @param dependencies - Ports used to read audit state.
 * @returns Whether the matching immutable audit event exists.
 */
async function hasAutomationMutationAuditProof(
  context: MutationAuditContext,
  teamId: string,
  workItemId: string,
  beforeRevision: number,
  afterRevision: number,
  dependencies: AutomationActionExecutorDependencies,
) {
  const entityId = createTeamIssueAuditEntityId(teamId, workItemId)
  const eventId = createAuditEventId(
    context,
    'work-item.updated',
    { type: 'work-item', id: entityId },
  )
  const event = await dependencies.auditEvents.getEvent(context.workspaceId, eventId)
  return event?.directoryId === context.workspaceId &&
    event.workspaceId === context.workspaceId &&
    event.eventType === 'work-item.updated' &&
    event.action === 'updated' &&
    event.idempotencyKeyHash === context.idempotencyKeyHash &&
    event.requestFingerprint === context.requestFingerprint &&
    event.actor.id === context.actor.id &&
    event.actor.kind === 'service' &&
    event.actorUserId === context.actor.id &&
    event.entity.type === 'work-item' &&
    event.entity.id === entityId &&
    event.entityType === 'work-item' &&
    event.entityId === entityId &&
    event.target.type === 'work-item' &&
    event.target.id === entityId &&
    event.targetType === 'work-item' &&
    event.targetId === entityId &&
    event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.actorMemberKey === context.actor.id &&
    event.metadata.teamId === teamId &&
    event.metadata.issueId === workItemId &&
    event.metadata.beforeRevision === beforeRevision &&
    event.metadata.afterRevision === afterRevision
}

/**
 * Creates one canonical Work Item from an Automation action.
 *
 * @param action - Work Item creation action.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the creation workflow.
 * @returns A promise that resolves after persistence and projection.
 */
async function executeAutomationWorkItemCreate(
  action: Extract<AutomationAction, { type: 'create' }>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const templateVersion = action.templateVersion
  const template = action.templateId && templateVersion !== undefined && Number.isSafeInteger(templateVersion)
    ? await dependencies.automation.getTemplateVersion(
        context.execution.workspaceId,
        action.templateId,
        templateVersion,
      )
    : undefined
  if (action.templateId && (!template || !template.enabled || template.kind !== 'work-item')) {
    throw new AutomationError(
      'conflict',
      'AutomationTemplateUnavailable',
      'The selected Work Item template is unavailable.',
    )
  }
  const values: Record<string, AutomationValue> = {
    ...(template?.kind === 'work-item' ? template.payload : {}),
    ...action.values,
  }
  const teamId = readAutomationText(values.teamId) ?? readAutomationMetadataText(context.event, 'teamId')
  if (!teamId) {
    throw new AutomationError('invalid-input', 'AutomationTargetMissing', 'Create action requires a Team ID.')
  }
  const body = createAutomationWorkItemCreateBody(
    values,
    `${context.execution.id}_create_${context.actionIndex}`,
  )
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    teamId,
    dependencies,
  )
  const configuredBody = await prepareConfiguredCreateWorkItem(
    context.execution.workspaceId,
    teamId,
    normalizeTeamIssueInput(body, team),
    await dependencies.workItemConfigurations.getTeamConfiguration(
      context.execution.workspaceId,
      teamId,
    ),
  )
  const assignee = readTeamIssueAssigneeUserId(configuredBody)
  await requireActiveWorkspaceAssignee(
    context.execution.workspaceId,
    assignee,
    dependencies,
  )
  const response = await dependencies.teamIssues.createTeamIssue(
    context.execution.workspaceId,
    teamId,
    configuredBody,
    `automation:${context.execution.ruleId}`,
    createAutomationMutationContext(context, values),
  )
  await projectWorkItemSearchDocumentBestEffort(
    context.execution.workspaceId,
    response.issue,
    'automation Work Item creation',
    [],
    dependencies,
  )
}

/**
 * Loads the active Team targeted by an Automation definition.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Target Team identifier.
 * @param dependencies - Ports used to read directory state.
 * @returns The active Team directory entry.
 */
async function requireAutomationTeam(
  workspaceId: string,
  teamId: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const directory = await dependencies.projectDirectory.getProjectDirectory(
    workspaceId,
    'en',
    true,
  )
  const team = directory.teams.find((candidate) => candidate.id === teamId)
  if (!team) {
    throw new AutomationError(
      'conflict',
      'AutomationTeamUnavailable',
      'The selected Work Item Team is unavailable.',
    )
  }
  return team
}

/**
 * Creates a durable Work Item approval from an Automation action.
 *
 * @param action - Approval action definition.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the approval workflow.
 * @returns A promise that resolves after the approval is persisted.
 */
async function executeAutomationApproval(
  action: Extract<AutomationAction, { type: 'approval' }>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await dependencies.teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, includeEvents: false },
  )
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  if (
    detail.issue.assignedProjectId &&
    !team.projects.some((project) => project.id === detail.issue.assignedProjectId)
  ) {
    throw new AutomationError(
      'conflict',
      'AutomationApprovalTargetUnavailable',
      'The approval Work Item project is not active in its owner Team.',
    )
  }
  const reviewerMemberKeys = action.reviewerMemberKeys.map((memberKey) => memberKey.trim().toLowerCase())
  await requireApprovalReviewers(
    context.execution.workspaceId,
    target.teamId,
    detail.issue.assignedProjectId,
    reviewerMemberKeys,
    dependencies,
  )
  if (action.completionStatusId) {
    await resolveFileApprovalCompletionTransition(
      context.execution.workspaceId,
      target.teamId,
      detail.issue,
      action.completionStatusId,
      dependencies,
    )
  }
  const executionStartedAtEpoch = Date.parse(context.execution.startedAt)
  if (!Number.isFinite(executionStartedAtEpoch)) {
    throw new AutomationError(
      'unavailable',
      'AutomationExecutionStateInvalid',
      'Automation execution start time is invalid.',
    )
  }
  const input = {
    reviewerMemberKeys,
    dueAt: new Date(executionStartedAtEpoch + action.dueInHours * 3_600_000).toISOString(),
    ...(action.completionStatusId ? { completionTransition: action.completionStatusId } : {}),
  }
  await dependencies.fileProofing.createWorkItemApproval(
    {
      workspaceId: context.execution.workspaceId,
      teamId: target.teamId,
      kind: 'work-item',
      issueId: target.workItemId,
      ...(detail.issue.assignedProjectId
        ? { projectId: detail.issue.assignedProjectId }
        : {}),
    },
    {
      memberKey: `automation:${context.execution.ruleId}`,
      kind: 'service',
      guest: false,
      canWrite: true,
      canManage: true,
    },
    input,
    createAutomationMutationContext(context, {
      subjectType: 'work-item',
      teamId: target.teamId,
      workItemId: target.workItemId,
      ...input,
    }),
  )
}

/**
 * Appends one idempotent Automation comment to a Work Item.
 *
 * @param body - Validated comment body.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the comment workflow.
 * @returns A promise that resolves after the comment is persisted.
 */
async function executeAutomationComment(
  body: string,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const entityKey = createWorkItemCollaborationEntityKey(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
  )
  const auditContext = createAutomationMutationContext(context, { body })
  const commentId = createAutomationCommentId(context.execution.id, context.actionIndex)
  const replay = await dependencies.collaboration.getCommentMutationReplay({
    entityKey,
    auditContext,
    commentId,
  })
  if (replay) {
    const expectedActorMemberKey = `automation:${context.execution.ruleId}`.toLowerCase()
    if (
      replay.authorMemberKey !== expectedActorMemberKey ||
      replay.bodyMarkdown !== body
    ) {
      throw new AutomationError(
        'conflict',
        'AutomationCommentIdempotencyConflict',
        'The Automation comment action was reused with different input.',
      )
    }
    return
  }

  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  const detail = await dependencies.teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, includeEvents: false },
  )
  if (
    detail.issue.assignedProjectId &&
    !team.projects.some((project) => project.id === detail.issue.assignedProjectId)
  ) {
    throw new AutomationError(
      'conflict',
      'AutomationCommentTargetUnavailable',
      'The comment Work Item project is not active in its owner Team.',
    )
  }
  const createActiveReferenceConditionChecks = dependencies.projectDirectory
    .createActiveReferenceConditionChecks
  if (!createActiveReferenceConditionChecks) {
    throw new AutomationError(
      'unavailable',
      'AutomationCommentAuthorizationUnavailable',
      'Comment authorization fencing is unavailable.',
      true,
    )
  }
  let authorizationConditionChecks: CollaborationAuthorizationConditionCheck[]
  try {
    authorizationConditionChecks = readCollaborationAuthorizationConditionChecks(
      await createActiveReferenceConditionChecks.call(
        dependencies.projectDirectory,
        context.execution.workspaceId,
        target.teamId,
        detail.issue.assignedProjectId,
      ),
    )
  } catch (error) {
    if (error instanceof ProjectDataError) {
      throw new AutomationError(
        'conflict',
        'AutomationCommentTargetUnavailable',
        'The comment Work Item Team or Project is no longer active.',
      )
    }
    throw error
  }
  const projectEntityKey = detail.issue.assignedProjectId
    ? createProjectCollaborationEntityKey(
        context.execution.workspaceId,
        detail.issue.assignedProjectId,
      )
    : undefined
  await dependencies.collaboration.createComment({
    workspaceId: context.execution.workspaceId,
    teamId: target.teamId,
    issueId: target.workItemId,
    workItemTitle: detail.issue.title,
    entityKey,
    projectId: detail.issue.assignedProjectId,
    projectEntityKey,
    assigneeMemberKey: detail.issue.assigneeUserId,
    actorMemberKey: `automation:${context.execution.ruleId}`,
    bodyMarkdown: body,
    commentId,
    automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
    deepLink: createTeamIssueDeepLink(target.teamId, target.workItemId),
    authorizationConditionChecks,
    auditContext,
  })
}

/**
 * Appends an Automation notification or approval event to the audit outbox.
 *
 * @param eventType - Stable audit event type.
 * @param summary - Safe event summary.
 * @param recipientMemberKeys - Notification recipient member keys.
 * @param context - Durable Automation execution context.
 * @param metadata - Redacted action metadata.
 * @param dependencies - Ports used to append the event.
 * @returns A promise that resolves after the event is appended.
 */
async function emitAutomationOutboxEvent(
  eventType: string,
  summary: string,
  recipientMemberKeys: string[],
  context: AutomationActionExecutionContext,
  metadata: Record<string, AutomationValue>,
  dependencies: AutomationActionExecutorDependencies,
) {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new AutomationError('unavailable', 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
  }
  const target = readOptionalAutomationWorkItemTarget(context.event)
  const event = createAuditEvent({
    context: createAutomationMutationContext(context, metadata),
    eventType,
    entity: {
      type: target ? 'work-item' : 'automation-execution',
      id: target ? `${target.teamId}#${target.workItemId}` : context.execution.id,
    },
    summary,
    expiresAt: calculateAuditExpiresAt(
      new Date().toISOString(),
      getConfiguredAuditRetentionDays(),
    ),
    metadata: {
      ...metadata,
      ...(target ? { teamId: target.teamId, issueId: target.workItemId } : {}),
      automationRuleLineage: createAutomationRuleLineage(context),
      notificationTitle: summary,
      notificationCandidates: recipientMemberKeys.map((memberKey) => ({
        memberKey,
        reason: eventType === 'approval.requested' ? 'approval' : 'automation',
      })),
    },
  })
  const auditEvents = dependencies.auditEvents
  if (!auditEvents.putEvent) {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox does not provide an immutable writer.',
      true,
    )
  }
  try {
    await auditEvents.putEvent(event)
  } catch {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox write failed.',
      true,
    )
  }
}

function createAutomationMutationContext(
  context: AutomationActionExecutionContext,
  body: unknown,
) {
  return createMutationAuditContext({
    workspaceId: context.execution.workspaceId,
    actor: {
      id: `automation:${context.execution.ruleId}`,
      kind: 'service',
      displayName: 'mukuroji automation',
    },
    idempotencyKey: context.idempotencyKey,
    correlationId: context.execution.id,
    request: {
      method: 'AUTOMATION',
      path: `/automation/executions/${context.execution.id}/actions/${context.actionIndex}`,
      body,
    },
    source: {
      kind: 'system',
      requestId: context.execution.id,
      route: `automation-lineage:${createAutomationRuleLineage(context).join(',')}`,
    },
  })
}

function createAutomationRuleLineage(context: AutomationActionExecutionContext) {
  return [...(context.event.automationRuleLineage ?? []), context.execution.ruleId]
}

function readAutomationWorkItemTarget(event: AutomationEvent) {
  const target = readOptionalAutomationWorkItemTarget(event)
  if (!target) {
    throw new AutomationError('invalid-input', 'AutomationTargetMissing', 'Action requires a Work Item target.')
  }
  return target
}

function readOptionalAutomationWorkItemTarget(event: AutomationEvent) {
  const teamId = readAutomationMetadataText(event, 'teamId') ?? readAutomationText(event.workItem?.teamId)
  const workItemId = readAutomationMetadataText(event, 'issueId') ??
    readAutomationMetadataText(event, 'workItemId') ??
    readAutomationText(event.workItem?.id)
  return teamId && workItemId ? { teamId, workItemId } : undefined
}

function isAutomationPatchApplied(
  issue: TeamIssueResponseItem,
  patch: Record<string, AutomationValue>,
) {
  const current: unknown = issue
  if (!isRecord(current)) return false
  return Object.entries(patch)
    .filter(([field]) => field !== 'typeChangeResolution')
    .every(([field, expected]) => automationValuesEqual(current[field] ?? null, expected))
}

function automationValuesEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length &&
      first.every((value, index) => automationValuesEqual(value, second[index]))
  }
  if (isRecord(first) && isRecord(second)) {
    const firstKeys = Object.keys(first).sort()
    const secondKeys = Object.keys(second).sort()
    return firstKeys.length === secondKeys.length &&
      firstKeys.every((key, index) =>
        key === secondKeys[index] && automationValuesEqual(first[key], second[key])
      )
  }
  return false
}

/**
 * Requires the Team a Triage-purpose endpoint routes to to be active in the Workspace.
 *
 * @param workspaceId - Workspace that owns the endpoint.
 * @param teamId - Routing Team.
 * @returns Condition checks that keep the Team active until the endpoint reservation commits.
 */
async function createTriageRoutingTeamFences(workspaceId: string, teamId: string) {
  // Triage rejects Team IDs outside its identifier grammar, so such a Team could never
  // receive a delivered entry; refuse the endpoint instead of accepting dead deliveries.
  if (!isTriageTeamIdentifier(teamId)) {
    throw new AutomationError(
      'invalid-input',
      'AutomationInboundWebhookTriageTeamUnsupported',
      'Triage cannot route entries to this Team ID.',
    )
  }
  const projectDirectory = workspaceDependencies.projectDirectory
  if (!projectDirectory.createActiveReferenceConditionChecks) {
    throw new AutomationError(
      'unavailable',
      'AutomationInboundWebhookTriageTeamUnavailable',
      'Triage routing Team fencing is unavailable.',
      true,
    )
  }
  try {
    return await projectDirectory.createActiveReferenceConditionChecks(workspaceId, teamId)
  } catch (error) {
    if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
      throw new AutomationError(
        'invalid-input',
        'AutomationInboundWebhookTriageTeamNotFound',
        'The Triage routing Team does not exist.',
      )
    }
    throw error
  }
}

/** Verified delivery facts shared by every inbound webhook purpose. */
type VerifiedInboundWebhookDelivery = {
  /** Sender idempotency key. */
  idempotencyKey: string
  /** SHA-256 of the raw body. */
  bodyFingerprint: string
  /** Fingerprint of the verified signature. */
  signatureFingerprint: string
  /** Verified signature timestamp. */
  signatureTimestamp: string
}

/**
 * Turns a verified Triage-purpose delivery into a Triage entry.
 *
 * The delivery is recorded with the same replay and signature receipts as Automation
 * deliveries, but under a `triage.webhook-received` audit event that carries no payload
 * and is never matched by Automation rules. The entry is idempotent by endpoint and
 * event ID, so a redelivery after a lost response returns the same entry.
 *
 * @param c - Hono request context.
 * @param endpoint - Verified active endpoint.
 * @param payload - Parsed JSON body.
 * @param delivery - Verified delivery facts.
 * @returns 202 with the delivery event ID and the Triage entry ID.
 */
async function deliverTriageWebhook(
  c: Context,
  endpoint: AutomationInboundWebhookEndpointRecord,
  payload: unknown,
  delivery: VerifiedInboundWebhookDelivery,
) {
  try {
    const teamId = endpoint.triageRouting?.teamId
    if (!teamId) throw automationInboundWebhookUnavailable()
    const envelope = readWebhookTriageEnvelope(payload)
    const auditTableName = getConfiguredAuditTableName()
    if (!auditTableName) throw automationInboundWebhookUnavailable()
    const path = `/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`
    const auditContext = createMutationAuditContext({
      workspaceId: endpoint.workspaceId,
      actor: { id: `inbound-webhook:${endpoint.id}`, kind: 'service', displayName: endpoint.name },
      idempotencyKey: createHash('sha256').update(`${endpoint.id}\0${delivery.idempotencyKey}`).digest('hex'),
      request: { method: 'POST', path, body: { endpointId: endpoint.id, bodyFingerprint: delivery.bodyFingerprint } },
      source: {
        kind: 'api',
        requestId: c.req.header('X-Request-Id'),
        method: 'POST',
        route: path,
        ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
        userAgent: c.req.header('User-Agent'),
      },
    })
    const event = createAuditEvent({
      context: auditContext,
      eventType: 'triage.webhook-received',
      entity: { type: 'automation-webhook', id: endpoint.id },
      summary: 'A Triage webhook was received.',
      metadata: { webhookId: endpoint.id, teamId },
      expiresAt: calculateAuditExpiresAt(auditContext.occurredAt, getConfiguredAuditRetentionDays()),
    })
    const recorded = await automationDependencies.inboundWebhooks.recordInboundWebhookDelivery(endpoint, {
      ...delivery,
      eventId: event.eventId,
      auditMutation: createAuditEventTransactPut(auditTableName, event),
    })
    return await admitTriageWebhookEntry(c, endpoint, teamId, envelope, delivery.idempotencyKey, recorded)
  } catch (error) {
    if (error instanceof TriageError) return toTriageErrorResponse(c, error)
    throw error
  }
}

/**
 * Creates, or replays, the Triage entry of a delivery whose receipt has committed.
 *
 * @param c - Hono request context.
 * @param endpoint - Endpoint that accepted the delivery.
 * @param teamId - Routing Team of the endpoint.
 * @param envelope - Validated webhook envelope.
 * @param idempotencyKey - Sender idempotency key.
 * @param recorded - Committed receipt's event ID and first accepted time.
 * @returns 202 with the delivery event ID and the Triage entry ID, or a Triage error response.
 */
async function admitTriageWebhookEntry(
  c: Context,
  endpoint: AutomationInboundWebhookEndpointRecord,
  teamId: string,
  envelope: CreateWebhookTriageEntryInput,
  idempotencyKey: string,
  recorded: { eventId: string; acceptedAt?: string },
) {
  let receipt
  try {
    receipt = await workItemDependencies.triage.createWebhookEntry(
      endpoint.workspaceId,
      teamId,
      { id: endpoint.id, name: endpoint.name },
      envelope,
      {
        // Delivery keys may be up to 256 characters; the Triage receipt stores a fixed-length digest.
        key: createHash('sha256').update(`${endpoint.id}\0${idempotencyKey}`).digest('hex'),
        fingerprint: createTriageInputFingerprint(envelope),
      },
      // A retry after a failed admission keeps the time the delivery was first accepted.
      // The admission validator checks the routing Team with a commit-time condition.
      recorded.acceptedAt ? { receivedAt: recorded.acceptedAt } : {},
    )
  } catch (error) {
    // Admission failures, including infrastructure errors, use the Triage error envelope.
    return toTriageErrorResponse(c, error)
  }
  const response: AutomationInboundWebhookDeliveryResponse = { eventId: recorded.eventId, triageEntryId: receipt.entry.id }
  return c.json(response, 202)
}

/**
 * Finishes a Triage delivery whose receipt already committed, whatever the endpoint's state.
 *
 * A committed receipt is the server's acceptance of that delivery, so a retry completes its
 * Triage entry even after the endpoint's secret is rotated, or the endpoint is paused or
 * revoked and its secret deleted. The retry must carry the same idempotency key and the exact
 * raw body the receipt accepted; the body was authenticated when the receipt committed, and a
 * SHA-256 match binds the retry to it. Any other request, including every new delivery, gets
 * no recovery and goes through current-secret verification.
 *
 * @param c - Hono request context.
 * @param opaqueEndpointId - Public endpoint identifier from the request path.
 * @returns The admission response when an accepted delivery matches; otherwise the raw body,
 *   when this check had to read it, for normal verification.
 */
async function completeAcceptedTriageWebhookDelivery(
  c: Context,
  opaqueEndpointId: string,
): Promise<{ completed?: Response; rawBody?: Uint8Array }> {
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
  if (!idempotencyKey || idempotencyKey.length > 256) return {}
  const accepted = await automationDependencies.inboundWebhooks.resolveAcceptedTriageWebhookDelivery(
    opaqueEndpointId,
    idempotencyKey,
  )
  const teamId = accepted?.endpoint.triageRouting?.teamId
  if (!accepted || !teamId) return {}
  const rawBody = await readAutomationInboundWebhookBody(c.req.raw)
  if (createHash('sha256').update(rawBody).digest('hex') !== accepted.bodyFingerprint) return { rawBody }
  try {
    const envelope = readWebhookTriageEnvelope(parseAutomationInboundWebhookJson(rawBody))
    await enforceActiveTenantForWorkspace(accepted.endpoint.workspaceId)
    return {
      completed: await admitTriageWebhookEntry(c, accepted.endpoint, teamId, envelope, idempotencyKey, accepted),
    }
  } catch (error) {
    if (error instanceof TriageError) return { completed: toTriageErrorResponse(c, error) }
    throw error
  }
}

function toAutomationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError || error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof WorkItemConfigurationError) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
  if (error instanceof FileProofingError) {
    return toFileProofingErrorResponse(c, error)
  }
  if (!(error instanceof AutomationError)) {
    console.error(error)
    return c.json({ message: 'Automation data is unavailable.' }, 502)
  }
  const status = mapAutomationErrorStatus(error.category)
  if (status >= 500) console.error(error)
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Registers the automation HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAutomationRoutes(routeApp: Hono): void {
  /** Workspace の versioned automation rules を返します。 */
  routeApp.get('/api/automation/rules', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      return c.json({ rules: await automationDependencies.ruleTemplates.listRules(principal.directoryId) })
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が automation rule を作成します。 */
  routeApp.post('/api/automation/rules', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = validateCreateAutomationRuleInput(await readAutomationJson(c))
      return c.json(await automationDependencies.ruleTemplates.createRule(
        principal.directoryId,
        input,
        c.req.header('Idempotency-Key')?.trim() || undefined,
      ), 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が automation rule の新 version を保存します。 */
  routeApp.patch('/api/automation/rules/:ruleId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = await readAutomationJson(c) as UpdateAutomationRuleInput
      return c.json(await automationDependencies.ruleTemplates.updateRule(
        principal.directoryId,
        c.req.param('ruleId'),
        input,
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者へ secret を除いた inbound webhook endpoints を返します。 */
  routeApp.get('/api/automation/inbound-webhooks', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      return c.json({
        endpoints: await automationDependencies.inboundWebhooks.listInboundWebhookEndpoints(principal.directoryId),
      })
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が server-issued inbound webhook endpoint を作成します。 */
  routeApp.post('/api/automation/inbound-webhooks', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
      const input = validateCreateAutomationInboundWebhookEndpointInput(await readAutomationJson(c))
      const triageRouting = input.triageRouting
      // A replay returns the endpoint created by the original request, even if the Team changed since.
      const provisioning = await automationDependencies.inboundWebhooks.reserveCreateInboundWebhookEndpoint(
        principal.directoryId,
        principal.actorId,
        input,
        idempotencyKey,
        getAutomationInboundWebhookBaseUrl(c),
        triageRouting
          ? () => createTriageRoutingTeamFences(principal.directoryId, triageRouting.teamId)
          : undefined,
      )
      const { completed, signingSecret } = await provisionAutomationInboundWebhookEndpoint(
        provisioning,
      )
      return c.json({
        endpoint: toAutomationInboundWebhookEndpoint(completed),
        signingSecret,
      }, 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者へ secret を除いた inbound webhook endpoint を返します。 */
  routeApp.get('/api/automation/inbound-webhooks/:endpointId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      return c.json(await requireAutomationInboundWebhookEndpoint(
        principal.directoryId,
        c.req.param('endpointId'),
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が inbound webhook endpoint の表示名を更新します。 */
  routeApp.patch('/api/automation/inbound-webhooks/:endpointId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      return c.json(await automationDependencies.inboundWebhooks.updateInboundWebhookEndpoint(
        principal.directoryId,
        c.req.param('endpointId'),
        validateUpdateAutomationInboundWebhookEndpointInput(await readAutomationJson(c)),
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が inbound webhook endpoint を pause します。 */
  routeApp.post('/api/automation/inbound-webhooks/:endpointId/pause', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      return c.json(await automationDependencies.inboundWebhooks.setInboundWebhookEndpointStatus(
        principal.directoryId,
        c.req.param('endpointId'),
        validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
        'paused',
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が inbound webhook endpoint を resume します。 */
  routeApp.post('/api/automation/inbound-webhooks/:endpointId/resume', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      return c.json(await automationDependencies.inboundWebhooks.setInboundWebhookEndpointStatus(
        principal.directoryId,
        c.req.param('endpointId'),
        validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
        'active',
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が signing secret generation を rotate します。 */
  routeApp.post('/api/automation/inbound-webhooks/:endpointId/rotate', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
      const provisioning = await automationDependencies.inboundWebhooks.reserveRotateInboundWebhookEndpoint(
        principal.directoryId,
        principal.actorId,
        c.req.param('endpointId'),
        validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
        idempotencyKey,
      )
      const { completed, signingSecret } = await provisionAutomationInboundWebhookEndpoint(
        provisioning,
      )
      return c.json({
        endpoint: toAutomationInboundWebhookEndpoint(completed),
        signingSecret,
      })
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が inbound webhook endpoint と全 secret generations を revoke します。 */
  routeApp.delete('/api/automation/inbound-webhooks/:endpointId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const revoked = await automationDependencies.inboundWebhooks.revokeInboundWebhookEndpoint(
        principal.directoryId,
        c.req.param('endpointId'),
        validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
      )
      await automationDependencies.automationInboundWebhookSecrets.delete(
        toAutomationInboundWebhookSecretReference(revoked),
      )
      return c.json(toAutomationInboundWebhookEndpoint(revoked))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** External sender の raw JSON delivery を HMAC 検証して durable outbox event に変換します。 */
  routeApp.post('/api/automation/inbound-webhooks/:opaqueEndpointId', async (c) => {
    try {
      const opaqueEndpointId = c.req.param('opaqueEndpointId')
      const endpoint = await automationDependencies.inboundWebhooks.resolveInboundWebhookEndpoint(
        opaqueEndpointId,
      )
      // A delivery whose receipt already committed finishes before current-secret verification,
      // so a later rotation, pause, or revocation cannot strand it. Every other request,
      // including any new delivery, is verified or rejected below.
      const recovery = await completeAcceptedTriageWebhookDelivery(c, opaqueEndpointId)
      if (recovery.completed) return recovery.completed
      if (!endpoint || endpoint.status === 'provisioning' || endpoint.status === 'revoked') {
        throw automationInboundWebhookNotFound()
      }
      if (endpoint.status === 'paused') {
        throw new AutomationError(
          'locked',
          'AutomationInboundWebhookPaused',
          'Inbound webhook endpoint is paused.',
        )
      }
      if (!isAutomationInboundWebhookJsonContentType(c.req.header('Content-Type'))) {
        throw new AutomationError(
          'unsupported-media-type',
          'AutomationInboundWebhookContentTypeUnsupported',
          'Content-Type must be application/json with optional UTF-8 charset.',
        )
      }

      const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
      const rawBody = recovery.rawBody ?? await readAutomationInboundWebhookBody(c.req.raw)
      const signatureTimestamp = readAutomationInboundWebhookTimestamp(
        c.req.header('X-Mukuroji-Timestamp'),
      )
      const secretReference = toAutomationInboundWebhookSecretReference(endpoint)
      const signingSecret = await automationDependencies.automationInboundWebhookSecrets.get(secretReference)
      const signatureFingerprint = verifyAutomationInboundWebhookSignature(
        signingSecret,
        signatureTimestamp,
        rawBody,
        c.req.header('X-Mukuroji-Signature'),
      )
      const payload = parseAutomationInboundWebhookJson(rawBody)
      if (!isAutomationValue(payload)) {
        throw new AutomationError(
          'invalid-input',
          'AutomationInboundWebhookJsonInvalid',
          'Request body contains an unsupported JSON value.',
        )
      }
      const bodyFingerprint = createHash('sha256').update(rawBody).digest('hex')
      await enforceActiveTenantForWorkspace(endpoint.workspaceId)
      if (endpoint.purpose === 'triage') {
        return await deliverTriageWebhook(c, endpoint, payload, { idempotencyKey, bodyFingerprint, signatureFingerprint, signatureTimestamp })
      }

      const auditTableName = getConfiguredAuditTableName()
      if (!auditTableName) throw automationInboundWebhookUnavailable()
      const path = `/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`
      const auditContext = createMutationAuditContext({
        workspaceId: endpoint.workspaceId,
        actor: {
          id: `inbound-webhook:${endpoint.id}`,
          kind: 'service',
          displayName: endpoint.name,
        },
        idempotencyKey: createHash('sha256')
          .update(`${endpoint.id}\0${idempotencyKey}`)
          .digest('hex'),
        request: {
          method: 'POST',
          path,
          body: { endpointId: endpoint.id, bodyFingerprint },
        },
        source: {
          kind: 'api',
          requestId: c.req.header('X-Request-Id'),
          method: 'POST',
          route: path,
          ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
          userAgent: c.req.header('User-Agent'),
        },
      })
      const event = createAuditEvent({
        context: auditContext,
        eventType: 'webhook.received',
        entity: { type: 'automation-webhook', id: endpoint.id },
        summary: 'Automation webhook was received.',
        metadata: { webhookId: endpoint.id, payload },
        expiresAt: calculateAuditExpiresAt(
          auditContext.occurredAt,
          getConfiguredAuditRetentionDays(),
        ),
      })
      const delivery = await automationDependencies.inboundWebhooks.recordInboundWebhookDelivery(endpoint, {
        idempotencyKey,
        bodyFingerprint,
        signatureFingerprint,
        signatureTimestamp,
        eventId: event.eventId,
        auditMutation: createAuditEventTransactPut(auditTableName, event),
      })
      return c.json({ eventId: delivery.eventId }, 202)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace の versioned automation templates を返します。 */
  routeApp.get('/api/automation/templates', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      return c.json({ templates: await automationDependencies.ruleTemplates.listTemplates(principal.directoryId) })
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が automation template を作成します。 */
  routeApp.post('/api/automation/templates', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = validateCreateAutomationTemplateInput(await readAutomationJson(c))
      return c.json(await automationDependencies.ruleTemplates.createTemplate(
        principal.directoryId,
        input,
        c.req.header('Idempotency-Key')?.trim() || undefined,
      ), 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が automation template の新 version を保存します。 */
  routeApp.patch('/api/automation/templates/:templateId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = await readAutomationJson(c) as UpdateAutomationTemplateInput
      return c.json(await automationDependencies.ruleTemplates.updateTemplate(
        principal.directoryId,
        c.req.param('templateId'),
        input,
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が template の current version を複製します。 */
  routeApp.post('/api/automation/templates/:templateId/duplicate', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const source = await automationDependencies.ruleTemplates.getTemplate(
        principal.directoryId,
        c.req.param('templateId'),
      )
      if (!source) {
        throw new AutomationError('not-found', 'AutomationTemplateNotFound', 'Automation template was not found.')
      }
      return c.json(await automationDependencies.ruleTemplates.createTemplate(
        principal.directoryId,
        validateCreateAutomationTemplateInput({
          kind: source.kind,
          name: `${source.name} copy`,
          enabled: source.enabled,
          payload: structuredClone(source.payload),
        }),
        c.req.header('Idempotency-Key')?.trim() || undefined,
      ), 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が Project/Workflow template を immutable version pin 付きで適用します。 */
  routeApp.post('/api/automation/templates/:templateId/applications', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
      if (!idempotencyKey) {
        throw new AutomationError(
          'invalid-input',
          'AutomationIdempotencyKeyRequired',
          'Idempotency-Key is required for template application.',
        )
      }
      const input = validateApplyAutomationTemplateInput(await readAutomationJson(c))
      if (
        input.target.kind === 'workflow' &&
        input.target.scopeType === 'workspace' &&
        input.target.scopeId !== principal.directoryId
      ) {
        throw new AutomationError(
          'invalid-input',
          'InvalidAutomationInput',
          'Workspace workflow target must match the authenticated Workspace.',
        )
      }
      if (input.target.kind === 'workflow' && input.target.scopeType === 'team') {
        await requireTeamConfigurationAdministration(principal, input.target.scopeId)
      }
      const application = await automationDependencies.ruleTemplates.reserveTemplateApplication(
        principal.directoryId,
        principal.actorId,
        c.req.param('templateId'),
        input.target,
        idempotencyKey,
      )
      return c.json(await executeAutomationTemplateApplication(c, principal, application))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が durable template application receipt を取得します。 */
  routeApp.get('/api/automation/template-applications/:applicationId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const application = await automationDependencies.ruleTemplates.getTemplateApplication(
        principal.directoryId,
        c.req.param('applicationId'),
      )
      if (!application) {
        throw new AutomationError(
          'not-found',
          'AutomationTemplateApplicationNotFound',
          'Template application was not found.',
        )
      }
      return c.json(application)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace の recurring Work 定義を返します。 */
  routeApp.get('/api/recurring-work', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      return c.json({ recurringWorks: await automationDependencies.recurringSchedules.listRecurringWorks(principal.directoryId) })
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が recurring Work 定義を作成します。 */
  routeApp.post('/api/recurring-work', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = validateCreateRecurringWorkInput(await readAutomationJson(c))
      await requireAutomationTeam(principal.directoryId, input.teamId)
      return c.json(await automationDependencies.recurringSchedules.createRecurringWork(
        principal.directoryId,
        input,
        c.req.header('Idempotency-Key')?.trim() || undefined,
      ), 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が recurring Work 定義の新 version を保存します。 */
  routeApp.patch('/api/recurring-work/:recurringWorkId', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const input = await readAutomationJson(c) as UpdateRecurringWorkInput
      const current = await automationDependencies.recurringSchedules.getRecurringWork(
        principal.directoryId,
        c.req.param('recurringWorkId'),
      )
      if (!current) {
        throw new AutomationError('not-found', 'RecurringWorkNotFound', 'Recurring Work definition was not found.')
      }
      await requireAutomationTeam(principal.directoryId, input.teamId ?? current.teamId)
      return c.json(await automationDependencies.recurringSchedules.updateRecurringWork(
        principal.directoryId,
        c.req.param('recurringWorkId'),
        input,
      ))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Automation execution history と partial action state を返します。 */
  routeApp.get('/api/automation/executions', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      return c.json(await automationDependencies.executions.listExecutions({
        workspaceId: principal.directoryId,
        ruleId: c.req.query('ruleId'),
        status: readAutomationExecutionStatus(c.req.query('status')),
        cursor: c.req.query('cursor'),
        limit: readAutomationPageLimit(c.req.query('limit')),
      }))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Workspace 管理者が retryable execution を同じ trigger event で再開します。 */
  routeApp.post('/api/automation/executions/:executionId/retry', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c, true)
      const executionId = c.req.param('executionId')
      const event = await automationDependencies.executions.getExecutionEvent(principal.directoryId, executionId)
      if (!event) {
        throw new AutomationError('not-found', 'AutomationExecutionNotFound', 'Automation execution was not found.')
      }
      const engine = new AutomationEngine(
        automationDependencies.executions,
        createAutomationActionExecutor(),
      )
      return c.json(await engine.retryExecution(principal.directoryId, executionId, event))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Authenticated form submission を durable automation outbox event に変換します。 */
  routeApp.post('/api/automation/forms/:formId/submissions', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      requireWorkspaceBusinessWrite(principal)
      const payload = await readAutomationJson(c)
      const event = await putAutomationIngressEvent(
        c,
        principal,
        c.req.param('formId'),
        { formId: c.req.param('formId'), payload },
      )
      return c.json({ eventId: event.eventId }, 202)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Bulk Work Item mutation を item 単位で検証し、dry-run 結果を返します。 */
  routeApp.post('/api/bulk-operations/preview', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      requireWorkspaceBusinessWrite(principal)
      const request = readWorkspaceBulkOperationRequest(
        await readAutomationJson(c),
        principal.directoryId,
      )
      const preview = await previewBulkOperation(
        request,
        createApiBulkOperationAdapter(principal, c),
      )
      return c.json(toBulkOperationPreviewResponse(preview))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Preview token が一致する Bulk Work Item mutation を確定します。 */
  routeApp.post('/api/bulk-operations', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      requireWorkspaceBusinessWrite(principal)
      const request = readWorkspaceBulkOperationRequest(
        await readAutomationJson(c),
        principal.directoryId,
      )
      const adapter = createApiBulkOperationAdapter(principal, c)
      const preview = await previewBulkOperation(request, adapter)
      const operation = await applyBulkOperation(
        request,
        preview,
        adapter,
        principal.userKey,
        automationDependencies.bulkOperations,
      )
      return c.json(toBulkOperationResponse(operation), 201)
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Bulk operation の retryable failures だけを安全に再実行します。 */
  routeApp.post('/api/bulk-operations/:operationId/retry', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      requireWorkspaceBusinessWrite(principal)
      const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
      requireBulkOperationOwner(operation, principal.userKey)
      const retried = await retryBulkOperation(
        operation,
        createApiBulkOperationAdapter(principal, c),
        automationDependencies.bulkOperations,
      )
      return c.json(toBulkOperationResponse(retried))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })

  /** Bulk operation の成功 item を current revision guard 付きで undo します。 */
  routeApp.post('/api/bulk-operations/:operationId/undo', async (c) => {
    try {
      const principal = await authenticateAutomationPrincipal(c)
      requireWorkspaceBusinessWrite(principal)
      const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
      requireBulkOperationOwner(operation, principal.userKey)
      const undone = await undoBulkOperation(
        operation,
        createApiBulkOperationAdapter(principal, c),
        automationDependencies.bulkOperations,
      )
      return c.json(toBulkOperationResponse(undone))
    } catch (error) {
      return toAutomationErrorResponse(c, error)
    }
  })
}
