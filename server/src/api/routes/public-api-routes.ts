import { createHash, randomUUID } from 'node:crypto'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  DEFAULT_WORK_ITEM_TYPE,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type ApiProblem,
  type CanonicalWorkItem,
  type PublicWorkItem,
  type CreateWorkItemInput,
  type PublicWorkItemTypeCatalog,
  type ResolvedWorkItemConfiguration,
  type ImportDryRunReport,
  type ImportJob,
  type ImportReport,
  type ImportRowError,
  type UpdatePublicWorkItemRequest,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { createMutationAuditContext, type MutationAuditContext } from '../../modules/audit/audit'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  createWorkItemAuthorizationChangedError,
  normalizeWorkItemSchedule,
  readAssignedProjectId,
  readTeamIssueAssigneeUserId,
  readWorkItemExpectedRevision,
  toTeamIssueResponseItem,
  type TeamIssueResponseItem,
  type WorkItemIdempotencyTransaction,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import {
  WorkspaceAccessError,
  type WorkspaceRole,
} from '../../modules/workspace-access/workspace-access'
import {
  CollaborationError,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
} from '../../modules/collaboration/collaboration'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import {
  WorkItemConfigurationError,
  getWorkItemTypeCustomFieldDefinitions,
  previewWorkItemTypeChange,
  resolveWorkItemTypeWorkflow,
} from '../../modules/work-items/work-item-configuration'
import {
  createPublicCustomFieldDefinition,
  projectPublicWorkItemTypeChangePreview,
} from '../../modules/developer-platform/public-work-item-type-projection'
import { PlanningError } from '../../modules/planning'
import type {
  AuthenticatedDeveloperCredential,
  IdempotencyMutationToken,
} from '../../modules/developer-platform/application/ports'
import {
  createAgentRunDeletionFences,
  createAgentRunMutationFenceExtension,
  prepareAgentRunCommentFence,
  type PublicWorkItemUpdateExtension,
} from '../shared/agent-run-access'
import {
  createDefaultSecretProtector,
} from '../../modules/developer-platform/adapter-out/shared/developer-platform-store'
import {
  ConnectorAuthorizationRuntime,
  createConnectorConflictRuntime,
  type ConnectorOAuthCallbackAuthorizer,
} from '../../modules/developer-platform/connector-authorization-runtime'
import {
  ConnectorRuntimeError,
  createOAuthConnectorRegistryFromEnvironment,
} from '../../modules/developer-platform/connector-oauth'
import {
  createConnectorRuntimeCache,
  loadConnectorRuntimeEnvironment,
} from '../../modules/developer-platform/connector-runtime-configuration'
import {
  createSecretsManagerConnectorRuntimeSecretLoader,
} from '../../modules/developer-platform/adapter-out/secrets-manager/connector-runtime-secret-loader'
import {
  createDynamoDbConnectorOAuthStateStoreFromEnvironment,
} from '../../modules/developer-platform/adapter-out/dynamodb/connector-oauth-state-store'
import { ConnectorOAuthStateManager } from '../../modules/developer-platform/connector-oauth-state'
import {
  createDynamoDbConnectorSyncPersistenceFromEnvironment,
} from '../../modules/developer-platform/adapter-out/dynamodb/connector-sync-persistence'
import {
  ConnectorSyncEngine,
  type ConnectorSyncHealthReporter,
  type ConnectorWorkItemGateway,
  type ConnectorWorkItemSnapshot,
} from '../../modules/developer-platform/connector-sync-runtime'
import {
  createPublicApiRouter,
  PublicApiServiceError,
  type ConnectorAuthorizationService,
  type DeveloperManagementPrincipal,
  type PublicApiDependencies,
  type PublicImportSourceInput,
  type PublicMutationContext,
  type PublicWorkItemService,
} from '../../modules/developer-platform/public-api'
import {
  previewWorkItemImport,
  WorkItemTransferError,
} from '../../modules/work-items/work-item-transfer'
import {
  evaluateWebhookEnterpriseTeamAccess,
} from '../../modules/developer-platform/webhook-authorization'
import {
  WorkItemImportError,
  createStoredWorkItemImportReport,
  createWorkItemImportJobId,
  requestWorkItemImportCancellation,
  stageWorkItemImport,
  type WorkItemImportExecution,
  type WorkItemImportWorkerDependencies,
} from '../../modules/work-items/work-item-import'
import { DocumentError } from '../../modules/documents'
import {
  developerPlatformDependencies,
  initializeLegacyTenantAdministration,
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import {
  createCollaborationCommentAuthorizationConditionChecks,
  createTeamIssueAutomaticWatcherCandidates,
} from '../shared/collaboration-access'
import {
  type DeveloperAuthorizationRequirement,
  resolveDeveloperCredentialPrincipal,
  resolveDeveloperManagementPrincipal,
} from '../shared/developer-platform-access'
import {
  createCommentSearchDocument,
  projectWorkItemSearchDocumentBestEffort,
} from '../shared/document-access'
import {
  hasWorkItemApprovalCompletionTransitionConflict,
  prepareConfiguredUpdateWorkItem,
} from '../shared/file-approval-access'
import {
  getEffectiveProjectAccessList,
  hasEnterpriseWorkspacePermission,
  type ProjectPrincipal,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  deleteWorkspaceSearchDocumentBestEffort,
  projectWorkspaceSearchDocumentBestEffort,
} from '../shared/search-access'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import {
  createWorkItemAuthorizationSnapshot,
  createWorkItemIdempotencyTransaction,
  loadAuthorizedTeamIssue,
  normalizeTeamIssueInput,
} from '../shared/work-item-access'
import { readAcceptanceCriteriaChange } from '../shared/work-item-acceptance-criteria'
import { prepareConfiguredCreateWorkItem } from '../shared/work-item-configuration'
import {
  createDependencyFencedWorkItemAuthorizationSnapshot,
  rejectInternalWorkItemCreateFields,
  rejectInternalWorkItemUpdateFields,
} from '../shared/work-item-schedule'
import {
  enforceActiveTenantForWorkspace,
  projectAccessAllows,
  requireActiveWorkspaceAssignee,
  type TeamPermissionContext,
} from '../shared/workspace-access'

/** Workspace 横断 export の Team/page continuation です。 */
type WorkItemExportContinuation = {
  /** Continuation schema version です。 */
  version: 1
  /** 次に読む Team ID です。 */
  teamId: string
  /** Accessible Team 順序を current RBAC directory snapshot に束縛する digest です。 */
  teamSetDigest: string
  /** Team 内の次 Work Item page cursor です。 */
  workItemCursor?: string
}

const queueWebhookDelivery = (...args: Parameters<
  NonNullable<PublicApiDependencies['queueWebhookDelivery']>
>) => requireAppDependencies().developerPlatform.queueWebhookDelivery(...args)

/** Work Item authorization snapshot を安定化する再読込回数です。 */
const WORK_ITEM_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT = 3

async function requireWebhookTeamPermission(
  principal: WorkspacePrincipal,
  teamId: string,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  const team = directory.teams.find((candidate) => candidate.id === teamId)

  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const [projectAccesses, enterpriseSnapshot] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectAccessList(
      principal.directoryId,
      principal.userKey,
    ),
    principal.enterpriseAuthorizationEvaluation?.snapshot ??
      workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
  ])
  const legacyReadAllowed = projectAccesses
    .filter((projectAccess) => teamProjectIds.has(projectAccess.projectId))
    .some((projectAccess) => projectAccessAllows(projectAccess, 'viewer'))
  const access = evaluateWebhookEnterpriseTeamAccess({
    snapshot: enterpriseSnapshot,
    memberKey: principal.userKey,
    memberEmail: principal.workspaceMember.email,
    workspaceRole: principal.workspaceRole,
    cognitoGroupIds: principal.groups,
    currentSystemAdministrator: principal.isSystemAdmin,
    activeWorkspaceMember: principal.workspaceMemberStatus === 'active',
    activeTeam: true,
    activeProject: true,
    legacyReadAllowed,
    teamId,
  })
  if (access.allowed) {
    return
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" cannot access team "${teamId}".`,
  )
}

/** Export を一つの Team/GSI Query に制限し、次 page の store continuation を返します。 */
async function readAccessibleWorkItemExportPage(
  principal: ProjectPrincipal,
  continuation: string | undefined,
  limit: number,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const contexts: TeamPermissionContext[] = directory.teams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }
    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer')
    )
    return teamProjectAccesses.length > 0
      ? [{ team, directory, projectAccesses: teamProjectAccesses } satisfies TeamPermissionContext]
      : []
  })
  if (contexts.length === 0) return { items: [], hasMore: false }

  const teamSetDigest = createHash('sha256')
    .update(contexts.map((context) => context.team.id).join('\0'))
    .digest('base64url')
  const decoded = decodeWorkItemExportContinuation(
    continuation,
    teamSetDigest,
  )
  const teamIndex = decoded
    ? contexts.findIndex((context) => context.team.id === decoded.teamId)
    : 0
  if (teamIndex < 0) {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Export cursor no longer matches the accessible Team set.',
    )
  }
  const context = contexts[teamIndex]!
  const accessibleProjectIds = principal.isSystemAdmin
    ? undefined
    : (context.projectAccesses ?? []).map((access) => access.projectId)
  const page = await workItemDependencies.teamIssues.getPublicWorkItemPage(
    principal.directoryId,
    context.team.id,
    {
      limit,
      ...(decoded?.workItemCursor ? { cursor: decoded.workItemCursor } : {}),
      ...(accessibleProjectIds ? { accessibleProjectIds } : {}),
    },
  )
  const nextTeam = page.nextCursor ? context : contexts[teamIndex + 1]
  const nextContinuation = nextTeam
    ? encodeWorkItemExportContinuation({
        version: 1,
        teamId: nextTeam.team.id,
        teamSetDigest,
        ...(page.nextCursor ? { workItemCursor: page.nextCursor } : {}),
      })
    : undefined
  return {
    // Contributors are internal planning data and are documented as excluded from exports.
    items: page.issues.map(omitWorkItemContributors),
    hasMore: nextContinuation !== undefined,
    ...(nextContinuation ? { nextContinuation } : {}),
  }
}

/**
 * Removes contributor assignments from a Work Item export row.
 *
 * @param workItem - Work Item read for the export page.
 * @returns The Work Item without its contributor assignments.
 */
function omitWorkItemContributors<T extends { readonly contributorAssignments?: unknown }>(
  workItem: T,
): Omit<T, 'contributorAssignments'> {
  const { contributorAssignments: _contributorAssignments, ...exported } = workItem
  void _contributorAssignments
  return exported
}

function encodeWorkItemExportContinuation(value: WorkItemExportContinuation) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeWorkItemExportContinuation(
  value: string | undefined,
  teamSetDigest: string,
) {
  if (!value) return undefined
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<WorkItemExportContinuation>
    if (
      decoded.version !== 1 ||
      decoded.teamSetDigest !== teamSetDigest ||
      typeof decoded.teamId !== 'string' ||
      !decoded.teamId ||
      (decoded.workItemCursor !== undefined &&
        (typeof decoded.workItemCursor !== 'string' || !decoded.workItemCursor))
    ) {
      throw new TypeError('Invalid export continuation.')
    }
    return decoded as WorkItemExportContinuation
  } catch {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Export cursor is invalid.',
    )
  }
}

function createForwardingClient<TClient extends object>(resolve: () => TClient): TClient {
  return new Proxy({} as TClient, {
    get(_target, property) {
      const client = resolve()
      const value = Reflect.get(client, property)
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

async function authenticateDeveloperManagement(
  authorization: string,
  context: Context,
): Promise<DeveloperManagementPrincipal> {
  const accessToken = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim()
  if (!accessToken) {
    throw new PublicApiServiceError(
      401,
      'authentication_required',
      'A Cognito Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  const canAdminister = principal.isSystemAdmin ||
    (
      principal.enterprisePermissions !== undefined
        ? hasEnterpriseWorkspacePermission(principal, 'workspace.manage')
        : principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
    )
  return {
    workspaceId: principal.directoryId,
    userId: principal.userKey,
    capabilities: {
      canManageCredentials: canAdminister,
      canManageWebhooks: canAdminister,
      canManageIntegrations: canAdminister,
      canImport: canAdminister,
      canExport: canAdminister,
    },
  }
}

async function resolveStableWorkItemAuthorization<T>(
  workspaceId: string,
  resolvePrincipal: () => Promise<WorkspacePrincipal>,
  authorize: (principal: WorkspacePrincipal) => Promise<T>,
) {
  for (
    let attempt = 0;
    attempt < WORK_ITEM_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const planningRevision = await workItemDependencies.planning.getAuthorizationRevision(workspaceId)
    let authorization:
      | { ok: true; principal: WorkspacePrincipal; value: T }
      | { ok: false; error: unknown }
    try {
      const principal = await resolvePrincipal()
      authorization = {
        ok: true,
        principal,
        value: await authorize(principal),
      }
    } catch (error) {
      authorization = { ok: false, error }
    }
    if (await workItemDependencies.planning.getAuthorizationRevision(workspaceId) !== planningRevision) {
      continue
    }
    if (!authorization.ok) throw authorization.error
    return {
      principal: authorization.principal,
      value: authorization.value,
      authorizationSnapshot: createWorkItemAuthorizationSnapshot(
        authorization.principal,
        planningRevision,
      ),
    }
  }
  throw createWorkItemAuthorizationChangedError()
}

function createPublicMutationAuditContext(
  principal: WorkspacePrincipal,
  context: PublicMutationContext,
  request: {
    method: string
    path: string
    body: unknown
    query?: Record<string, string>
  },
): MutationAuditContext {
  return createMutationAuditContext({
    workspaceId: principal.directoryId,
    actor: {
      id: principal.actorId,
      kind: 'user',
      displayName: principal.userKey,
    },
    idempotencyKey: context.idempotencyKey,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request,
    source: {
      kind: 'api',
      requestId: context.requestId,
      method: request.method,
      route: request.path,
    },
  })
}

/** Top-level fields admitted by the closed public Work Item response schema. */
const PUBLIC_WORK_ITEM_RESPONSE_FIELDS = [
  'schemaVersion',
  'revision',
  'id',
  'teamId',
  'title',
  'description',
  'assignedProjectId',
  'assigneeUserId',
  'assigneeEmail',
  'assigneeName',
  'dueDate',
  'schedule',
  'priority',
  'creatorMemberKey',
  'workflowStatusId',
  'workItemTypeId',
  'statusCategory',
  'workflowSchemaVersion',
  'customFieldValues',
  'relationIds',
  'createdAt',
  'updatedAt',
  'source',
] satisfies readonly (keyof PublicWorkItem)[]

/**
 * Projects one canonical Work Item onto the closed public response schema.
 *
 * @param workItem - Internal canonical Work Item containing optional server-only fields.
 * @returns Detached public response without causal, archive, intake, or approval state.
 */
export function projectPublicWorkItem(workItem: CanonicalWorkItem): PublicWorkItem {
  return {
    schemaVersion: workItem.schemaVersion,
    revision: workItem.revision,
    id: workItem.id,
    teamId: workItem.teamId,
    title: workItem.title,
    ...(workItem.description === undefined ? {} : { description: workItem.description }),
    ...(workItem.assignedProjectId === undefined
      ? {}
      : { assignedProjectId: workItem.assignedProjectId }),
    assigneeUserId: workItem.assigneeUserId,
    ...(workItem.assigneeEmail === undefined
      ? {}
      : { assigneeEmail: workItem.assigneeEmail }),
    ...(workItem.assigneeName === undefined ? {} : { assigneeName: workItem.assigneeName }),
    dueDate: workItem.dueDate,
    schedule: projectPublicWorkItemSchedule(workItem.schedule),
    priority: workItem.priority,
    creatorMemberKey: workItem.creatorMemberKey,
    workflowStatusId: workItem.workflowStatusId,
    workItemTypeId: workItem.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
    statusCategory: workItem.statusCategory,
    workflowSchemaVersion: workItem.workflowSchemaVersion,
    customFieldValues: structuredClone(workItem.customFieldValues),
    relationIds: [...workItem.relationIds],
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
    source: workItem.source,
  }
}

/**
 * Projects a canonical schedule without forwarding future internal schedule properties.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns Detached schedule limited to the public schedule union.
 */
function projectPublicWorkItemSchedule(
  schedule: CanonicalWorkItem['schedule'],
): CanonicalWorkItem['schedule'] {
  const calendarPolicy = {
    timeZone: schedule.calendarPolicy.timeZone,
    workingWeekdays: [...schedule.calendarPolicy.workingWeekdays],
    holidays: [...schedule.calendarPolicy.holidays],
  }
  const plannedEffort = schedule.plannedEffortMinutes === undefined
    ? {}
    : { plannedEffortMinutes: schedule.plannedEffortMinutes }
  switch (schedule.mode) {
    case 'unscheduled':
      return { mode: schedule.mode, calendarPolicy, ...plannedEffort }
    case 'due-date':
      return {
        mode: schedule.mode,
        calendarPolicy,
        dueDate: schedule.dueDate,
        ...plannedEffort,
      }
    case 'date-range':
      return {
        mode: schedule.mode,
        calendarPolicy,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        durationDays: schedule.durationDays,
        ...plannedEffort,
      }
    case 'milestone':
      return {
        mode: schedule.mode,
        calendarPolicy,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        durationDays: schedule.durationDays,
        ...plannedEffort,
      }
  }
}

/**
 * Sanitizes an adapter-produced Work Item receipt before it is stored for replay.
 *
 * @param value - Unknown adapter response body.
 * @returns Detached object containing only public Work Item response fields.
 */
function projectPublicWorkItemReceiptBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PublicApiServiceError(
      503,
      'temporarily_unavailable',
      'The Work Item mutation produced an invalid replay receipt.',
      true,
    )
  }
  const projected: Record<string, unknown> = {}
  for (const field of PUBLIC_WORK_ITEM_RESPONSE_FIELDS) {
    if (field === 'schedule') continue
    if (value[field] !== undefined) projected[field] = structuredClone(value[field])
  }
  if (value.schedule !== undefined) {
    try {
      projected.schedule = projectPublicWorkItemSchedule(
        normalizeWorkItemSchedule(value.schedule),
      )
    } catch {
      throw new PublicApiServiceError(
        503,
        'temporarily_unavailable',
        'The Work Item mutation produced an invalid replay receipt.',
        true,
      )
    }
  }
  return projected
}

/**
 * Creates an atomic public Work Item receipt transaction with response allowlisting.
 *
 * @param workspaceId - Workspace that owns the idempotency reservation.
 * @param token - Public API idempotency reservation token.
 * @param createReceipt - Optional wrapper that embeds the allowlisted Work Item in a larger response with its own status.
 * @returns Transaction contribution that cannot persist internal Work Item fields.
 */
function createPublicWorkItemIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken | undefined,
  createReceipt?: (workItem: Record<string, unknown>) => { status: 200 | 201; body: unknown },
): WorkItemIdempotencyTransaction | undefined {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, token)
  if (transaction === undefined) return undefined
  return {
    async prepare(response) {
      if (response.status !== 200) return transaction.prepare(response)
      const workItem = projectPublicWorkItemReceiptBody(response.body)
      return transaction.prepare(createReceipt ? createReceipt(workItem) : { status: 200, body: workItem })
    },
  }
}

/**
 * Canonical Work Item を一度だけ materialize する identity です。
 */
export type IdempotentWorkItemCreate = {
  /** Request identity と payload から決まる deterministic Work Item ID です。 */
  issueId: string
  /** Team、row payload、idempotency identity の SHA-256 digest です。 */
  requestDigest: string
}

async function createCanonicalPublicWorkItem(
  principal: WorkspacePrincipal,
  teamId: string,
  input: CreateWorkItemInput,
  context: PublicMutationContext,
  requestPath: string,
  idempotentCreate?: IdempotentWorkItemCreate,
  authorizationSnapshot?: WorkItemAuthorizationSnapshot,
) {
  rejectInternalWorkItemCreateFields(input)
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, teamId, 'member')
  const body = normalizeTeamIssueInput(input, permission.team)
  requireAssignedProjectPermission(
    principal,
    permission,
    readAssignedProjectId(body.assignedProjectId),
    'member',
  )
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    teamId,
  )
  const configuredBody = await prepareConfiguredCreateWorkItem(
    principal.directoryId,
    teamId,
    body,
    resolvedConfiguration,
  )
  const assigneeUserId = readTeamIssueAssigneeUserId(configuredBody)
  await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
  const response = await workItemDependencies.teamIssues.createTeamIssue(
    principal.directoryId,
    teamId,
    {
      ...configuredBody,
      assigneeUserId,
      ...(idempotentCreate
        ? {
            idempotentIssueId: idempotentCreate.issueId,
            idempotentRequestDigest: idempotentCreate.requestDigest,
          }
        : {}),
      authorizationSnapshot,
    },
    principal.userKey,
    createPublicMutationAuditContext(principal, context, {
      method: 'POST',
      path: requestPath,
      body: { teamId, ...input },
    }),
  )
  await projectWorkItemSearchDocumentBestEffort(
    principal.directoryId,
    response.issue,
    'Public Work Item creation',
    [],
  )
  return response.issue
}

/**
 * Builds the authorized, creation-oriented Work Item Type catalog for one Team.
 *
 * @param teamId - Team whose configuration was resolved.
 * @param resolvedConfiguration - Effective Team or inherited Work Item configuration.
 * @param accessibleProjectIds - Project IDs visible to the requesting principal, or undefined for unrestricted access.
 * @returns Active Work Item Types with their workflow statuses and public field definitions.
 */
function createPublicWorkItemTypeCatalog(
  teamId: string,
  resolvedConfiguration: ResolvedWorkItemConfiguration,
  accessibleProjectIds: ReadonlySet<string> | undefined,
): PublicWorkItemTypeCatalog {
  const configuration = resolvedConfiguration.configuration
  const types = [...(configuration.workItemTypes ?? [])]
  if (!types.some((type) => type.id === DEFAULT_WORK_ITEM_TYPE_ID)) {
    types.push(DEFAULT_WORK_ITEM_TYPE)
  }

  return {
    teamId,
    configurationRevision: configuration.revision,
    workItemTypes: types
      .filter((type) => type.status === 'active')
      .sort((first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name))
      .map((type) => {
        const workflow = resolveWorkItemTypeWorkflow(configuration, type.id)
        const typeRequiredFieldIds = new Set(type.requiredCustomFieldIds)
        const customFields = getWorkItemTypeCustomFieldDefinitions(configuration, type.id)
          .flatMap((definition) => {
            const publicDefinition = createPublicCustomFieldDefinition(
              definition,
              typeRequiredFieldIds.has(definition.id),
              accessibleProjectIds,
            )
            return publicDefinition ? [publicDefinition] : []
          })
        return {
          id: type.id,
          name: type.name,
          ...(type.description === undefined ? {} : { description: type.description }),
          defaultWorkflowId: workflow.id,
          workflow: {
            id: workflow.id,
            name: workflow.name,
            initialStatusId: workflow.initialStatusId,
            statuses: workflow.statuses,
          },
          customFields,
        }
      }),
  }
}

/** Options for a public Work Item update shared by PATCH and Agent Run start. */
export type CanonicalPublicWorkItemUpdateOptions = {
  /** Request recorded in the audit context of the update. */
  auditRequest: {
    /** HTTP method. */
    method: string
    /** Request path. */
    path: string
    /** Query parameters. */
    query?: Record<string, string>
    /** Request body. */
    body: unknown
  }
  /** Agent Run writes committed atomically with the update. */
  extension?: PublicWorkItemUpdateExtension
  /** Whether the caller is an agent fenced by its Agent Run, which may only mark acceptance criteria met or unmet. */
  agentFenced?: boolean
}

/**
 * Updates a canonical Work Item for a developer credential with current RBAC,
 * configuration validation, revision CAS, and an atomic idempotency receipt.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Updated Work Item.
 * @param input - Validated public patch.
 * @param mutationContext - Request and idempotency identifiers.
 * @param idempotency - Idempotency reservation token.
 * @param options - Audit request and optional Agent Run extension.
 * @returns The updated canonical Work Item and the authorized principal.
 */
export async function updateCanonicalPublicWorkItem(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  workItemId: string,
  input: UpdatePublicWorkItemRequest,
  mutationContext: PublicMutationContext,
  idempotency: IdempotencyMutationToken | undefined,
  options: CanonicalPublicWorkItemUpdateOptions,
): Promise<{
  /** Updated canonical Work Item. */
  issue: TeamIssueResponseItem
  /** Principal authorized for the update. */
  principal: WorkspacePrincipal
}> {
  rejectInternalWorkItemUpdateFields(input)
  const authorization = await resolveStableWorkItemAuthorization(
    credential.workspaceId,
    async () => await resolveDeveloperCredentialPrincipal(credential, {
      permission: 'work-items.write',
      teamId,
      evaluateProjectScopes: true,
    }),
    async (principal) => {
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(input, permission.team)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        detail.issue.assignedProjectId,
        'member',
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
      const dependencyAuthorizationSnapshot =
        'schedule' in body &&
          body.schedule !== undefined &&
          stableDigestStringify(body.schedule) !==
            stableDigestStringify(detail.issue.schedule)
          ? await createDependencyFencedWorkItemAuthorizationSnapshot(
              principal,
              teamId,
              workItemId,
            )
          : undefined
      return { body, detail, dependencyAuthorizationSnapshot }
    },
  )
  const { principal, authorizationSnapshot } = authorization
  const { body, detail, dependencyAuthorizationSnapshot } = authorization.value
  if (
    dependencyAuthorizationSnapshot &&
    dependencyAuthorizationSnapshot.planningRevision !==
      authorizationSnapshot.planningRevision
  ) {
    throw createWorkItemAuthorizationChangedError()
  }
  const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    teamId,
  )
  const configuredBody = await prepareConfiguredUpdateWorkItem(
    principal.directoryId,
    teamId,
    detail.issue,
    body,
    resolvedConfiguration,
  )
  if ('assigneeUserId' in configuredBody) {
    await requireActiveWorkspaceAssignee(
      principal.directoryId,
      readTeamIssueAssigneeUserId(configuredBody),
    )
  }
  if ('acceptanceCriteria' in configuredBody && detail.issue.revision !== expectedRevision) {
    // Criterion IDs refer to the observed list, so a stale request is a revision conflict.
    throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'Work Item revision does not match the expected revision.')
  }
  const acceptanceCriteria = readAcceptanceCriteriaChange(
    configuredBody, detail.issue.acceptanceCriteria ?? [], options.agentFenced === true,
  )
  const auditContext = createPublicMutationAuditContext(
    principal,
    mutationContext,
    options.auditRequest,
  )
  const now = new Date()
  const prepared = await options.extension?.prepare({
    principal,
    issue: detail.issue,
    resolvedConfiguration,
    auditContext,
    now,
  })
  const idempotencyTransaction = createPublicWorkItemIdempotencyTransaction(
    principal.directoryId,
    idempotency,
    prepared?.createReceipt,
  )
  let response: Awaited<ReturnType<typeof workItemDependencies.teamIssues.updateTeamIssue>>
  try {
    response = await workItemDependencies.teamIssues.updateTeamIssue(
      principal.directoryId,
      teamId,
      workItemId,
      {
        ...configuredBody,
        ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
        expectedRevision,
        authorizationSnapshot,
        ...(prepared && prepared.transactItems.length > 0
          ? { agentRunTransactItems: prepared.transactItems }
          : {}),
      },
      principal.userKey,
      auditContext,
      idempotencyTransaction,
    )
  } catch (error) {
    throw prepared ? await prepared.classifyFailure(error) : error
  }
  await prepared?.afterCommit?.()
  await projectWorkItemSearchDocumentBestEffort(
    principal.directoryId,
    response.issue,
    'Public Work Item update',
  )
  return { issue: response.issue, principal }
}

/**
 * Adapts request-bound canonical Work Item operations and authorization to the Public API port.
 *
 * @returns A Public API Work Item service backed by canonical application operations.
 */
export function createCanonicalPublicWorkItemService(): PublicWorkItemService {
  return {
    /** Reads bounded canonical discussion pages and rechecks access after the read. */
    async listComments(credential, teamId, workItemId, continuation, limit, assignedProjectId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read', teamId, evaluateProjectScopes: true,
      })
      const before = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      if (assignedProjectId !== undefined && before.detail.issue.assignedProjectId !== assignedProjectId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is outside the requested Project.')
      }
      const page = await workItemDependencies.collaboration.getThread({
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, workItemId),
        viewerMemberKey: principal.userKey,
        includeReplies: true,
        newestFirst: true,
        includeScopeState: false,
        limit,
        cursor: continuation,
      })
      const current = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read', teamId, evaluateProjectScopes: true,
      })
      const after = await loadAuthorizedTeamIssue(current, teamId, workItemId, 'viewer')
      if (assignedProjectId !== undefined && after.detail.issue.assignedProjectId !== assignedProjectId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is outside the requested Project.')
      }
      if (before.detail.issue.assignedProjectId !== after.detail.issue.assignedProjectId) {
        throw new PublicApiServiceError(409, 'conflict', 'Work Item assignment changed. Reload the discussion.')
      }
      return {
        items: page.comments.filter((comment) => !comment.deletedAt).map((comment) => ({
          id: comment.id,
          actorUserId: comment.authorMemberKey,
          body: comment.bodyMarkdown,
          createdAt: comment.createdAt,
        })),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextContinuation: page.nextCursor } : {}),
      }
    },

    /** Revalidates comment write permissions for receipt replay. */
    async authorizeComment(credential, teamId, workItemId, assignedProjectId, assigneeUserId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write', teamId, evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      if (assignedProjectId !== undefined && detail.issue.assignedProjectId !== assignedProjectId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is outside the requested Project.')
      }
      if (assigneeUserId !== undefined && detail.issue.assigneeUserId !== assigneeUserId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is assigned to another member.')
      }
    },

    /** Persists a progress note through the existing fenced collaboration transaction. */
    async addComment(credential, teamId, workItemId, body, mutationContext, assignedProjectId, assigneeUserId, agentRunFence) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write', teamId, evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      if (assignedProjectId !== undefined && detail.issue.assignedProjectId !== assignedProjectId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is outside the requested Project.')
      }
      if (assigneeUserId !== undefined && detail.issue.assigneeUserId !== assigneeUserId) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item is assigned to another member.')
      }
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, workItemId)
      const authorizationConditionChecks = await createCollaborationCommentAuthorizationConditionChecks(
        principal, context, teamId, detail.issue.assignedProjectId,
      )
      const preparedFence = agentRunFence
        ? await prepareAgentRunCommentFence(principal, teamId, workItemId, agentRunFence, detail.issue.assigneeUserId, new Date())
        : undefined
      const comment = await workItemDependencies.collaboration.createComment({
        workspaceId: principal.directoryId,
        teamId,
        issueId: workItemId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        assigneeMemberKey: detail.issue.assigneeUserId,
        actorMemberKey: principal.userKey,
        bodyMarkdown: body,
        mentionMemberKeys: [],
        automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
        deepLink: createTeamIssueDeepLink(teamId, workItemId),
        authorizationConditionChecks: [
          ...authorizationConditionChecks,
          ...(preparedFence?.conditionChecks ?? []),
        ],
        auditContext: createPublicMutationAuditContext(principal, mutationContext, {
          method: 'POST',
          path: `/api/v1/work-items/${encodeURIComponent(workItemId)}/comments`,
          query: { teamId, ...(assignedProjectId ? { assignedProjectId } : {}), ...(assigneeUserId ? { assigneeUserId } : {}) },
          body: { body },
        }),
      }).catch(async (error: unknown) => {
        throw preparedFence ? await preparedFence.classifyFailure(error) : error
      })
      await preparedFence?.afterCommit()
      await projectWorkspaceSearchDocumentBestEffort(() => createCommentSearchDocument(
        principal.directoryId, teamId, detail.issue, comment,
      ), 'Public Work Item comment creation')
      return {
        id: comment.id,
        actorUserId: comment.authorMemberKey,
        body: comment.bodyMarkdown,
        createdAt: comment.createdAt,
      }
    },
    async list(credential, filters, continuation, limit) {
      const teamId = typeof filters.teamId === 'string' ? filters.teamId : ''
      if (!teamId) {
        throw new PublicApiServiceError(400, 'invalid_request', 'teamId is required.')
      }
      const assignedProjectId = typeof filters.assignedProjectId === 'string'
        ? filters.assignedProjectId
        : undefined
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        ...(assignedProjectId ? { projectId: assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const accessibleProjectIds = principal.isSystemAdmin
        ? undefined
        : (permission.projectAccesses ?? [])
            .filter((access) => projectAccessAllows(access, 'viewer'))
            .map((access) => access.projectId)
      if (
        assignedProjectId &&
        accessibleProjectIds &&
        !accessibleProjectIds.includes(assignedProjectId)
      ) {
        return { items: [], hasMore: false }
      }
      const page = await workItemDependencies.teamIssues.getPublicWorkItemPage(
        principal.directoryId,
        teamId,
        {
          limit,
          ...(continuation ? { cursor: continuation } : {}),
          ...(assignedProjectId ? { assignedProjectId } : {}),
          ...(typeof filters.assigneeUserId === 'string'
            ? { assigneeUserId: filters.assigneeUserId }
            : {}),
          ...(typeof filters.workflowStatusId === 'string'
            ? { workflowStatusId: filters.workflowStatusId }
            : {}),
          ...(typeof filters.workItemTypeId === 'string'
            ? { workItemTypeId: filters.workItemTypeId }
            : {}),
          ...(typeof filters.updatedAfter === 'string'
            ? { updatedAfter: filters.updatedAfter }
            : {}),
          ...(accessibleProjectIds ? { accessibleProjectIds } : {}),
        },
      )
      return {
        items: page.issues.map(projectPublicWorkItem),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextContinuation: page.nextCursor } : {}),
      }
    },

    async get(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      return projectPublicWorkItem((await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        'viewer',
      )).detail.issue)
    },

    async getAcceptanceCriteria(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      const { issue } = (await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')).detail
      return {
        schemaVersion: 1,
        teamId: issue.teamId,
        workItemId: issue.id,
        revision: issue.revision,
        items: (issue.acceptanceCriteria ?? []).map((criterion) => ({ ...criterion })),
      }
    },

    async listWorkItemTypes(credential, teamId, assignedProjectId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      requireAssignedProjectPermission(principal, permission, assignedProjectId, 'viewer')
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const accessibleProjectIds = assignedProjectId !== undefined ? new Set([assignedProjectId]) : principal.isSystemAdmin
        ? undefined
        : new Set(
            (permission.projectAccesses ?? [])
              .filter((access) => projectAccessAllows(access, 'viewer'))
              .map((access) => access.projectId),
          )
      return createPublicWorkItemTypeCatalog(
        teamId,
        resolvedConfiguration,
        accessibleProjectIds,
      )
    },

    /**
     * Revalidates public access and calculates a non-mutating Work Item Type preview.
     *
     * @param credential - Authenticated developer credential.
     * @param teamId - Team that owns the Work Item.
     * @param workItemId - Work Item whose type would change.
     * @param input - Target type, optional Project proposal, and expected revision.
     * @returns Server-calculated field and workflow impact.
     */
    async previewTypeChange(credential, teamId, workItemId, input) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      if (detail.issue.revision !== input.expectedRevision) {
        throw new ProjectDataError(
          409,
          'WorkItemRevisionConflict',
          'Work Item changed. Reload and try again.',
        )
      }
      requireAssignedProjectPermission(
        principal,
        permission,
        detail.issue.assignedProjectId,
        'member',
      )
      const proposedAssignedProjectId = 'assignedProjectId' in input
        ? readAssignedProjectId(input.assignedProjectId)
        : detail.issue.assignedProjectId
      if ('assignedProjectId' in input) {
        requireAssignedProjectPermission(
          principal,
          permission,
          proposedAssignedProjectId,
          'member',
        )
      }
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const preview = previewWorkItemTypeChange(
        resolvedConfiguration.configuration,
        detail.issue.workItemTypeId,
        detail.issue.workflowStatusId,
        detail.issue.customFieldValues,
        input.targetWorkItemTypeId,
        proposedAssignedProjectId ?? undefined,
        input.expectedRevision,
      )
      const approvalCompletionTransitionConflict = await hasWorkItemApprovalCompletionTransitionConflict(
        principal.directoryId,
        teamId,
        workItemId,
        preview.targetWorkItemTypeId,
        preview.invalidWorkflowStatusId === undefined
          ? preview.currentWorkflowStatusId
          : preview.targetInitialWorkflowStatusId,
        resolvedConfiguration.configuration,
      )
      const accessibleProjectIds = principal.isSystemAdmin
        ? undefined
        : new Set(
            (permission.projectAccesses ?? [])
              .filter((access) => projectAccessAllows(access, 'viewer'))
              .map((access) => access.projectId),
          )
      return projectPublicWorkItemTypeChangePreview({
        ...preview,
        approvalCompletionTransitionConflict,
        requiresResolution: preview.requiresResolution || approvalCompletionTransitionConflict,
      }, accessibleProjectIds)
    },

    async authorizeCreate(credential, input) {
      const { teamId, ...workItemInput } = input
      rejectInternalWorkItemCreateFields(workItemInput)
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        ...(typeof workItemInput.assignedProjectId === 'string'
          ? { projectId: workItemInput.assignedProjectId }
          : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(workItemInput, permission.team)
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
    },

    async create(credential, input, context) {
      const { teamId, ...workItemInput } = input
      rejectInternalWorkItemCreateFields(workItemInput)
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveDeveloperCredentialPrincipal(credential, {
          permission: 'work-items.write',
          teamId,
          ...(typeof workItemInput.assignedProjectId === 'string'
            ? { projectId: workItemInput.assignedProjectId }
            : {}),
          evaluateProjectScopes: true,
        }),
        async (principal) => {
          requireWorkspaceBusinessWrite(principal)
          const permission = await requireTeamPermission(principal, teamId, 'member')
          const body = normalizeTeamIssueInput(workItemInput, permission.team)
          requireAssignedProjectPermission(
            principal,
            permission,
            readAssignedProjectId(body.assignedProjectId),
            'member',
          )
        },
      )
      return projectPublicWorkItem(await createCanonicalPublicWorkItem(
        authorization.principal,
        teamId,
        workItemInput,
        context,
        '/api/v1/work-items',
        createPublicApiWorkItemCreateIdentity(
          credential.workspaceId,
          credential.credentialId,
          context,
          teamId,
          workItemInput,
        ),
        authorization.authorizationSnapshot,
      ))
    },

    async authorizeUpdate(credential, teamId, workItemId, input) {
      rejectInternalWorkItemUpdateFields(input)
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(input, permission.team)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        detail.issue.assignedProjectId,
        'member',
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
    },

    async update(
      credential,
      teamId,
      workItemId,
      input,
      mutationContext,
      idempotency,
      agentRunFence,
    ) {
      const { issue } = await updateCanonicalPublicWorkItem(
        credential,
        teamId,
        workItemId,
        input,
        mutationContext,
        idempotency,
        {
          auditRequest: {
            method: 'PATCH',
            path: `/api/v1/work-items/${encodeURIComponent(workItemId)}`,
            query: { teamId },
            body: input,
          },
          ...(agentRunFence
            ? { extension: createAgentRunMutationFenceExtension(teamId, workItemId, agentRunFence), agentFenced: true }
            : {}),
        },
      )
      return projectPublicWorkItem(issue)
    },

    async authorizeDelete(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      await requireTeamPermission(principal, teamId, 'member')
      const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
      if (
        enterpriseEvaluation &&
        !evaluateEnterpriseAccess({
          permission: 'work-items.write',
          principal: enterpriseEvaluation.principal,
          assignments: enterpriseEvaluation.assignments,
          customRoles: enterpriseEvaluation.snapshot.customRoles,
          groupMappings: enterpriseEvaluation.groupMappings,
          resource: {
            workspaceId: principal.directoryId,
            kind: 'team',
            targetId: teamId,
          },
        }).allowed
      ) {
        throw new ProjectDataError(
          403,
          'ProjectAccessDenied',
          `User "${principal.userKey}" cannot prove current Team write access for deleted Work Item "${workItemId}".`,
        )
      }
    },

    async delete(
      credential,
      teamId,
      workItemId,
      expectedRevision,
      mutationContext,
      idempotency,
    ) {
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveDeveloperCredentialPrincipal(credential, {
          permission: 'work-items.write',
          teamId,
          evaluateProjectScopes: true,
        }),
        async (principal) => {
          requireWorkspaceBusinessWrite(principal)
          await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
          return await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            teamId,
            workItemId,
          )
        },
      )
      const { principal, authorizationSnapshot } = authorization
      if (
        authorization.value.planningRevision !==
          authorizationSnapshot.planningRevision
      ) {
        throw createWorkItemAuthorizationChangedError()
      }
      const externalLinks = await developerPlatformDependencies.externalLinks.listExternalWorkItemLinks({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
      })
      if (externalLinks.length > 0) {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'Unlink all external resources before deleting this Work Item.',
        )
      }
      if (!workItemDependencies.teamIssues.deleteTeamIssue) {
        throw new PublicApiServiceError(
          503,
          'temporarily_unavailable',
          'Canonical Work Item deletion is not configured.',
          true,
        )
      }
      const [externalLinkFence, documentBacklinkFence] = await Promise.all([
        developerPlatformDependencies.transactions.prepareWorkItemDeletionFenceTransactWrite?.({
          workspaceId: principal.directoryId,
          teamId,
          workItemId,
        }),
        workItemDependencies.documents.prepareWorkItemDeletionFenceTransactWrite({
          workspaceId: principal.directoryId,
          workItemId: `team/${teamId}/issue/${workItemId}`,
        }),
      ])
      const deletionAuditContext = createPublicMutationAuditContext(principal, mutationContext, {
        method: 'DELETE',
        path: `/api/v1/work-items/${encodeURIComponent(workItemId)}`,
        query: { teamId },
        body: { expectedRevision },
      })
      const agentRunFences = await createAgentRunDeletionFences(
        principal,
        teamId,
        workItemId,
        deletionAuditContext,
        new Date(),
      )
      const response = await workItemDependencies.teamIssues.deleteTeamIssue(
        principal.directoryId,
        teamId,
        workItemId,
        expectedRevision,
        principal.userKey,
        deletionAuditContext,
        createPublicWorkItemIdempotencyTransaction(
          principal.directoryId,
          idempotency,
        ),
        [
          ...(externalLinkFence
            ? [{
                kind: 'external-links' as const,
                transactWriteItem: externalLinkFence.transactWriteItem,
              }]
            : []),
          {
            kind: 'document-backlinks',
            transactWriteItem: documentBacklinkFence.transactWriteItem,
          },
          ...agentRunFences,
        ],
        undefined,
        authorizationSnapshot,
      )
      await deleteWorkspaceSearchDocumentBestEffort(
        principal.directoryId,
        'work-item',
        createTeamIssueAuditEntityId(teamId, workItemId),
        'Public Work Item deletion',
      )
      return projectPublicWorkItem(response.issue)
    },

    async authorizeExternalLink(credential, teamId, workItemId, write) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: write ? 'work-items.write' : 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      if (write) requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        write ? 'member' : 'viewer',
      )
    },

    async authorizeWebhookTeams(managementPrincipal, teamIds) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'workspace.manage',
      })
      requireWorkspaceBusinessWrite(principal)
      for (const teamId of teamIds) {
        await requireWebhookTeamPermission(principal, teamId)
      }
    },

    async dryRunImport(managementPrincipal, input) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: input.teamId,
        ...(input.assignedProjectId ? { projectId: input.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      await requirePublicImportPermission(principal, input)
      return (await validatePublicImport(principal, input)).report
    },

    async commitImport(managementPrincipal, dryRunJobId, input, mutationContext) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: input.teamId,
        ...(input.assignedProjectId ? { projectId: input.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      if (dryRunJobId) {
        const dryRunJob = (await developerPlatformDependencies.imports.listImportJobs(principal.directoryId))
          .find((job) => job.id === dryRunJobId)
        if (
          !dryRunJob ||
          dryRunJob.createdByUserId !== principal.userKey ||
          !dryRunJob.dryRun
        ) {
          throw new PublicApiServiceError(404, 'not_found', 'Import dry-run job was not found.')
        }
        if (dryRunJob.status !== 'completed' || (dryRunJob.report?.invalidRows ?? 1) > 0) {
          throw new PublicApiServiceError(
            409,
            'conflict',
            'Import dry-run must complete without invalid rows before commit.',
          )
        }
        if (!matchesImportJobInput(dryRunJob, input)) {
          throw new PublicApiServiceError(
            409,
            'conflict',
            'Import metadata differs from the dry-run. Run validation again.',
          )
        }
      }
      await requirePublicImportPermission(principal, input)
      const jobId = createWorkItemImportJobId(
        principal.directoryId,
        principal.userKey,
        mutationContext.idempotencyKey,
      )
      const job = await developerPlatformDependencies.imports.createImportJob({
        workspaceId: principal.directoryId,
        createdByUserId: principal.userKey,
        jobId,
        input: {
          format: input.format,
          teamId: input.teamId,
          ...(input.assignedProjectId
            ? { assignedProjectId: input.assignedProjectId }
            : {}),
          mapping: input.mapping,
          dryRun: false,
        },
      })
      if (job.status === 'completed') return job
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'The deterministic import job is already in a terminal state.',
        )
      }
      try {
        await stageWorkItemImport({
          jobId: job.id,
          workspaceId: principal.directoryId,
          createdByUserId: principal.userKey,
          teamId: input.teamId,
          ...(input.assignedProjectId
            ? { assignedProjectId: input.assignedProjectId }
            : {}),
          format: input.format,
          sourceContent: input.source.content,
          mapping: input.mapping,
          requestFingerprint: createHash('sha256')
            .update(`management-import-v1\n${mutationContext.idempotencyKey}`)
            .digest('hex'),
        }, {
          executions: developerPlatformDependencies.workItemImportExecutions,
          sources: developerPlatformDependencies.workItemImportSources,
          queue: developerPlatformDependencies.workItemImportQueue,
          now: () => new Date(),
        })
        return job
      } catch (error) {
        if (!(error instanceof WorkItemImportError && error.retryable)) {
          await failImportJobBestEffort(principal.directoryId, job.id, error)
        }
        throw error
      }
    },

    async authorizeImportJob(managementPrincipal, job, write) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: write ? 'work-items.write' : 'work-items.read',
        teamId: job.teamId,
        ...(job.assignedProjectId ? { projectId: job.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      if (job.createdByUserId !== principal.userKey) {
        throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
      }
      const permission = await requireTeamPermission(
        principal,
        job.teamId,
        write ? 'member' : 'viewer',
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        job.assignedProjectId,
        write ? 'member' : 'viewer',
      )
    },

    async cancelImport(managementPrincipal, job) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: job.teamId,
        ...(job.assignedProjectId ? { projectId: job.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      if (job.createdByUserId !== principal.userKey) {
        throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
      }
      const permission = await requireTeamPermission(principal, job.teamId, 'member')
      requireAssignedProjectPermission(
        principal,
        permission,
        job.assignedProjectId,
        'member',
      )
      if (job.status === 'cancelled') return job
      if (job.status === 'completed' || job.status === 'failed') {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'Only a queued or running import can be cancelled.',
        )
      }
      await requestWorkItemImportCancellation(
        principal.directoryId,
        job.id,
        {
          executions: developerPlatformDependencies.workItemImportExecutions,
          sources: developerPlatformDependencies.workItemImportSources,
          jobs: createWorkItemImportJobLifecycle(),
          now: () => new Date(),
        },
      )
      return requireImportJob(principal.directoryId, job.id)
    },

    async export(managementPrincipal, _format, continuation, limit) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.read',
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      return readAccessibleWorkItemExportPage(
        principal,
        continuation,
        limit,
      )
    },
  }
}

/** Production connector runtime の API/worker 共有 components です。 */
type ConnectorRuntimeBundle = {
  /** OAuth lifecycle と conflict recovery の API boundary です。 */
  authorization: ConnectorAuthorizationRuntime
  /** Provider と canonical Work Item の双方向 sync engine です。 */
  syncEngine: ConnectorSyncEngine
}

/** Canonical Work Item service を connector worker の current-RBAC/CAS boundary へ適合します。 */
function createCanonicalConnectorWorkItemGateway(): ConnectorWorkItemGateway {
  return {
    async authorize(workspaceId, actorUserId, teamId, workItemId, write) {
      try {
        const principal = await resolveConnectorActorPrincipal(
          workspaceId,
          actorUserId,
          {
            permission: write ? 'work-items.write' : 'work-items.read',
            teamId,
            evaluateProjectScopes: true,
          },
        )
        if (write) requireWorkspaceBusinessWrite(principal)
        await loadAuthorizedTeamIssue(
          principal,
          teamId,
          workItemId,
          write ? 'member' : 'viewer',
        )
      } catch (error) {
        if (
          (
            error instanceof PublicApiServiceError ||
            error instanceof ProjectDataError ||
            error instanceof WorkspaceAccessError
          ) &&
          (error.status === 403 || error.status === 404)
        ) {
          throw new ConnectorRuntimeError(
            'ConnectorWorkItemAccessDenied',
            'The connector actor cannot access this Work Item.',
          )
        }
        throw error
      }
    },

    async get(workspaceId, teamId, workItemId) {
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      return toConnectorWorkItemSnapshot(detail.issue)
    },

    async applyExternal(input) {
      const preauthorizedPrincipal = await resolveConnectorActorPrincipal(
        input.workspaceId,
        input.actorUserId,
        {
          permission: 'work-items.write',
          teamId: input.teamId,
          evaluateProjectScopes: true,
        },
      )
      requireWorkspaceBusinessWrite(preauthorizedPrincipal)
      await requireTeamPermission(preauthorizedPrincipal, input.teamId, 'member')
      const requestFingerprint = createHash('sha256')
        .update(stableDigestStringify({
          version: 1,
          workspaceId: input.workspaceId,
          teamId: input.teamId,
          workItemId: input.workItemId,
          actorUserId: input.actorUserId,
          expectedRevision: input.expectedRevision,
          patch: input.patch,
        }))
        .digest('hex')
      const credentialId = `connector-sync:${createHash('sha256')
        .update(`${input.workspaceId}\0${input.actorUserId}`)
        .digest('hex')
        .slice(0, 48)}`
      const reservationRequest = {
        workspaceId: input.workspaceId,
        credentialId,
        idempotencyKey: input.operationId,
        requestFingerprint,
      }
      const reservation = await developerPlatformDependencies.idempotency.reserveIdempotency(
        reservationRequest,
      )
      if (reservation.status === 'replay') {
        const replayPrincipal = await resolveConnectorActorPrincipal(
          input.workspaceId,
          input.actorUserId,
          {
            permission: 'work-items.write',
            teamId: input.teamId,
            evaluateProjectScopes: true,
          },
        )
        requireWorkspaceBusinessWrite(replayPrincipal)
        await loadAuthorizedTeamIssue(
          replayPrincipal,
          input.teamId,
          input.workItemId,
          'member',
        )
        return {
          kind: 'applied',
          workItem: readConnectorWorkItemReplay(
            reservation.response,
            input.teamId,
            input.workItemId,
          ),
        }
      }
      if (reservation.status === 'in-progress') {
        throw new ConnectorRuntimeError(
          'ConnectorWorkItemMutationInProgress',
          'The same connector Work Item mutation is still in progress.',
          { retryable: true },
        )
      }
      const completionRequest = {
        ...reservationRequest,
        reservationId: reservation.reservationId,
      }
      try {
        const authorization = await resolveStableWorkItemAuthorization(
          input.workspaceId,
          async () => await resolveConnectorActorPrincipal(
            input.workspaceId,
            input.actorUserId,
            {
              permission: 'work-items.write',
              teamId: input.teamId,
              evaluateProjectScopes: true,
            },
          ),
          async (principal) => {
            requireWorkspaceBusinessWrite(principal)
            const permission = await requireTeamPermission(
              principal,
              input.teamId,
              'member',
            )
            const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
              input.workspaceId,
              input.teamId,
              input.workItemId,
              { consistentIssueRead: true, includeEvents: false },
            )
            requireAssignedProjectPermission(
              principal,
              permission,
              detail.issue.assignedProjectId,
              'member',
            )
            return { detail, permission }
          },
        )
        const { principal, authorizationSnapshot } = authorization
        const { detail, permission } = authorization.value
        if (detail.issue.revision !== input.expectedRevision) {
          await developerPlatformDependencies.idempotency.releaseIdempotency(completionRequest)
          return {
            kind: 'conflict',
            workItem: toConnectorWorkItemSnapshot(detail.issue),
          }
        }
        const body = normalizeTeamIssueInput({
          expectedRevision: input.expectedRevision,
          ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
          ...(input.patch.description !== undefined
            ? { description: input.patch.description }
            : {}),
          ...(input.patch.status !== undefined
            ? { workflowStatusId: input.patch.status }
            : {}),
        }, permission.team)
        const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
          input.workspaceId,
          input.teamId,
        )
        const configuredBody = await prepareConfiguredUpdateWorkItem(
          input.workspaceId,
          input.teamId,
          detail.issue,
          body,
          configuration,
        )
        const idempotencyTransaction: WorkItemIdempotencyTransaction | undefined =
          developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite
            ? {
                async prepare(response) {
                  return developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite?.({
                    ...completionRequest,
                    response,
                  })
                },
              }
            : undefined
        const response = await workItemDependencies.teamIssues.updateTeamIssue(
          input.workspaceId,
          input.teamId,
          input.workItemId,
          { ...configuredBody, authorizationSnapshot },
          principal.userKey,
          createMutationAuditContext({
            workspaceId: input.workspaceId,
            actor: {
              id: principal.actorId,
              kind: 'user',
              displayName: principal.userKey,
            },
            idempotencyKey: input.operationId,
            request: {
              method: 'SYNC',
              path: `/connector-sync/work-items/${input.workItemId}`,
              body: input.patch,
            },
            source: {
              kind: 'system',
              requestId: `connector-sync-${createHash('sha256')
                .update(input.operationId)
                .digest('hex')
                .slice(0, 24)}`,
            },
          }),
          idempotencyTransaction,
        )
        await developerPlatformDependencies.idempotency.completeIdempotency({
          ...completionRequest,
          response: { status: 200, body: response.issue },
        })
        await projectWorkItemSearchDocumentBestEffort(
          input.workspaceId,
          response.issue,
          'Connector Work Item synchronization',
        )
        return {
          kind: 'applied',
          workItem: toConnectorWorkItemSnapshot(response.issue),
        }
      } catch (error) {
        await developerPlatformDependencies.idempotency
          .releaseIdempotency(completionRequest)
          .catch(() => undefined)
        if (error instanceof ProjectDataError && error.code === 'WorkItemRevisionConflict') {
          const latest = await workItemDependencies.teamIssues.getTeamIssueDetail(
            input.workspaceId,
            input.teamId,
            input.workItemId,
            { consistentIssueRead: true, includeEvents: false },
          )
          return {
            kind: 'conflict',
            workItem: toConnectorWorkItemSnapshot(latest.issue),
          }
        }
        if (error instanceof ProjectDataError && error.code === 'WorkItemAuthorizationChanged') {
          throw new ConnectorRuntimeError(
            'ConnectorWorkItemAuthorizationChanged',
            'Work Item authorization changed during connector synchronization.',
            { retryable: true },
          )
        }
        throw error
      }
    },
  }
}

/** Connector actor の current Workspace membership を解決します。 */
function resolveConnectorActorPrincipal(
  workspaceId: string,
  actorUserId: string,
  requirement: DeveloperAuthorizationRequirement,
) {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId,
    credentialId: `connector-actor:${createHash('sha256')
      .update(actorUserId)
      .digest('hex')
      .slice(0, 48)}`,
    subjectUserId: actorUserId,
    scopes: [],
  }, requirement)
}

/** Canonical response を provider-neutral connector snapshot へ変換します。 */
function toConnectorWorkItemSnapshot(
  issue: TeamIssueResponseItem,
): ConnectorWorkItemSnapshot {
  return {
    id: issue.id,
    teamId: issue.teamId,
    revision: issue.revision,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    status: issue.workflowStatusId,
  }
}

/** Encrypted idempotency receipt から tenant/resource-bound snapshot を復元します。 */
function readConnectorWorkItemReplay(
  value: unknown,
  teamId: string,
  workItemId: string,
) {
  if (!isRecord(value) || value.status !== 200 || value.body === undefined) {
    throw new ConnectorRuntimeError(
      'ConnectorWorkItemReceiptInvalid',
      'Connector Work Item idempotency receipt is invalid.',
    )
  }
  const issue = toTeamIssueResponseItem(value.body)
  if (issue.teamId !== teamId || issue.id !== workItemId) {
    throw new ConnectorRuntimeError(
      'ConnectorWorkItemReceiptInvalid',
      'Connector Work Item idempotency receipt belongs to another resource.',
    )
  }
  return toConnectorWorkItemSnapshot(issue)
}

/** Current membership と integration 管理権限を OAuth callback 時に再評価します。 */
function createConnectorOAuthCallbackAuthorizer(): ConnectorOAuthCallbackAuthorizer {
  return {
    async authorize(workspaceId, userId) {
      const principal = await resolveConnectorActorPrincipal(
        workspaceId,
        userId,
        { permission: 'workspace.manage' },
      )
      requireWorkspaceBusinessWrite(principal)
      if (
        principal.enterprisePermissions === undefined &&
        principal.workspaceRole !== 'owner' &&
        principal.workspaceRole !== 'admin'
      ) {
        throw new PublicApiServiceError(
          403,
          'forbidden',
          'Current Workspace administrator access is required to connect providers.',
        )
      }
    },
  }
}

/** Environment に provider がある場合だけ production connector runtime を構築します。 */
function createConfiguredConnectorRuntime(
  environment: NodeJS.ProcessEnv,
): ConnectorRuntimeBundle | undefined {
  const encodedConfiguration = environment.MUKUROJI_CONNECTOR_PROVIDERS_JSON?.trim()
  if (!hasConfiguredConnectorProviders(encodedConfiguration)) return undefined
  const registry = createOAuthConnectorRegistryFromEnvironment({
    environment,
  })
  const signingSecret = environment.CONNECTOR_OAUTH_STATE_SIGNING_SECRET?.trim()
  if (!signingSecret) {
    throw new TypeError(
      'CONNECTOR_OAUTH_STATE_SIGNING_SECRET is required when connectors are configured.',
    )
  }
  const originSigningSecret = environment.CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET?.trim()
  if (!originSigningSecret) {
    throw new TypeError(
      'CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET is required when connectors are configured.',
    )
  }
  const state = new ConnectorOAuthStateManager({
    store: createDynamoDbConnectorOAuthStateStoreFromEnvironment(environment),
    protector: createDefaultSecretProtector(),
    signingSecret,
    previousSigningSecrets: readConnectorOAuthStatePreviousSigningSecrets(
      environment.CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON,
    ),
  })
  const persistence = createDynamoDbConnectorSyncPersistenceFromEnvironment(environment)
  let authorization: ConnectorAuthorizationRuntime | undefined
  const health = createForwardingClient<ConnectorSyncHealthReporter>(() => {
    if (!authorization) {
      throw new ConnectorRuntimeError(
        'ConnectorRuntimeUnavailable',
        'Connector authorization runtime is not initialized.',
        { retryable: true },
      )
    }
    return authorization
  })
  const syncEngine = new ConnectorSyncEngine({
    platform: createForwardingClient(() => ({
      readConnectorLifecycleSnapshot: (request) =>
        developerPlatformDependencies.connectors
          .readConnectorLifecycleSnapshot(request),
      readConnectorCredential: (request) =>
        developerPlatformDependencies.connectors.readConnectorCredential(request),
      updateConnectorStatus: (request) =>
        developerPlatformDependencies.connectors.updateConnectorStatus(request),
      recoverConnector: (request) =>
        developerPlatformDependencies.connectors.recoverConnector(request),
      claimConnectorCredentialRefresh: (request) =>
        developerPlatformDependencies.connectors
          .claimConnectorCredentialRefresh(request),
      releaseConnectorCredentialRefresh: (request) =>
        developerPlatformDependencies.connectors
          .releaseConnectorCredentialRefresh(request),
      listExternalWorkItemLinks: (request) =>
        developerPlatformDependencies.externalLinks
          .listExternalWorkItemLinks(request),
    })),
    registry,
    workItems: createCanonicalConnectorWorkItemGateway(),
    persistence,
    health,
    originSigningSecret,
    previousOriginSigningSecrets: readConnectorSyncOriginPreviousSigningSecrets(
      environment.CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON,
    ),
  })
  authorization = new ConnectorAuthorizationRuntime({
    platform: createForwardingClient(() => developerPlatformDependencies.connectors),
    registry,
    state,
    callbackAuthorizer: createConnectorOAuthCallbackAuthorizer(),
    conflicts: createConnectorConflictRuntime(syncEngine),
    reauthorizationReturnUrl:
      environment.CONNECTOR_REAUTHORIZATION_RETURN_URL?.trim() ??
        '/settings?developerSection=connectors',
  })
  return { authorization, syncEngine }
}

/** OAuth state key rotation の grace period に使う旧 secret JSON array を検証します。 */
function readConnectorOAuthStatePreviousSigningSecrets(
  value: string | undefined,
) {
  if (!value?.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed) ||
      parsed.length > 3 ||
      parsed.some((secret) => typeof secret !== 'string' || !secret.trim())
    ) {
      throw new TypeError()
    }
    return parsed.map((secret) => secret.trim())
  } catch {
    throw new TypeError(
      'CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON must be a JSON array of up to three non-empty strings.',
    )
  }
}

/**
 * Parses previous Connector origin signing secrets used during key rotation.
 *
 * @param value - Optional JSON array from configuration.
 * @returns Up to three validated previous secrets.
 */
export function readConnectorSyncOriginPreviousSigningSecrets(
  value: string | undefined,
) {
  if (!value?.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length > 3) throw new TypeError()
    const secrets = parsed.map((secret) => {
      if (typeof secret !== 'string') throw new TypeError()
      return secret.trim()
    })
    if (secrets.some((secret) => Buffer.byteLength(secret, 'utf8') < 32)) {
      throw new TypeError()
    }
    return secrets
  } catch {
    throw new TypeError(
      'CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON must be a JSON array of up to three strings containing at least 32 bytes.',
    )
  }
}

/** Empty configuration で connector routes を fail-closed に保ちます。 */
function hasConfiguredConnectorProviders(value: string | undefined) {
  if (!value) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return !Array.isArray(parsed) || parsed.length > 0
  } catch {
    return true
  }
}

/**
 * Warm Lambda invocation 間で成功値を短時間共有し、一時障害後は bounded backoff で再取得します。
 */
const connectorRuntimeBundleCache = createConnectorRuntimeCache({
  async load() {
    return createConfiguredConnectorRuntime(
      await loadConnectorRuntimeEnvironment(
        process.env,
        createSecretsManagerConnectorRuntimeSecretLoader(),
      ),
    )
  },
})

/** Secrets Manager-backed connector runtime を TTL と bounded retry 付きで構築します。 */
async function getConfiguredConnectorRuntimeBundle() {
  return connectorRuntimeBundleCache.get()
}

/** 設定済み OAuth runtime を返し、未設定なら secret-free error で fail-closed にします。 */
async function requireConfiguredConnectorAuthorization() {
  const runtime = await getConfiguredConnectorRuntimeBundle()
  if (!runtime) {
    throw new ConnectorRuntimeError(
      'ConnectorRuntimeUnavailable',
      'Connector provider authorization is not configured.',
      { retryable: true },
    )
  }
  return runtime.authorization
}

/**
 * Lazily loads the configured synchronization engine for Connector workers.
 *
 * @returns The configured Connector synchronization engine.
 */
export async function requireConfiguredConnectorSyncEngine() {
  const runtime = await getConfiguredConnectorRuntimeBundle()
  if (!runtime) {
    throw new ConnectorRuntimeError(
      'ConnectorRuntimeUnavailable',
      'Connector synchronization is not configured.',
      { retryable: true },
    )
  }
  return runtime.syncEngine
}

/** Public router が module-load secret read なしで利用する OAuth runtime proxy です。 */
const lazyConnectorAuthorization: ConnectorAuthorizationService = {
  async begin(principal, input, operationId) {
    return (await requireConfiguredConnectorAuthorization())
      .begin(principal, input, operationId)
  },
  async completeCallback(input) {
    return (await requireConfiguredConnectorAuthorization()).completeCallback(input)
  },
  async abortCallback(input) {
    return (await requireConfiguredConnectorAuthorization()).abortCallback(input)
  },
  async reauthorize(principal, installationId, operationId) {
    return (await requireConfiguredConnectorAuthorization())
      .reauthorize(principal, installationId, operationId)
  },
  async disconnect(principal, installationId) {
    return (await requireConfiguredConnectorAuthorization())
      .disconnect(principal, installationId)
  },
  async listConflicts(principal, input) {
    return (await requireConfiguredConnectorAuthorization())
      .listConflicts(principal, input)
  },
  async resolveConflict(principal, conflictId, input) {
    return (await requireConfiguredConnectorAuthorization())
      .resolveConflict(principal, conflictId, input)
  },
}

async function requirePublicImportPermission(
  principal: WorkspacePrincipal,
  input: PublicImportSourceInput,
) {
  const permission = await requireTeamPermission(principal, input.teamId, 'member')
  requireAssignedProjectPermission(
    principal,
    permission,
    input.assignedProjectId,
    'member',
  )
  return permission
}

async function validatePublicImport(
  principal: WorkspacePrincipal,
  input: PublicImportSourceInput,
) {
  const permission = await requirePublicImportPermission(principal, input)
  const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    input.teamId,
  )
  const preview = previewWorkItemImport(
    input.format,
    input.source.content,
    input.mapping,
  )
  const errorsByRow = new Map<number, ImportRowError[]>(
    preview.rows.map((row) => [row.row, [...row.errors]]),
  )
  const mappedByRow = new Map<number, Record<string, unknown>>()
  const validInputs: Array<{ row: number; input: CreateWorkItemInput }> = []
  const assigneeValidations = new Map<
    string,
    ReturnType<typeof requireActiveWorkspaceAssignee>
  >()
  for (const row of preview.rows) {
    if (!row.input) continue
    const candidate: CreateWorkItemInput = {
      ...row.input,
      ...(row.input.assignedProjectId === undefined && input.assignedProjectId
        ? { assignedProjectId: input.assignedProjectId }
        : {}),
    }
    mappedByRow.set(row.row, { ...candidate })
    try {
      const normalized = normalizeTeamIssueInput(candidate, permission.team)
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(normalized.assignedProjectId),
        'member',
      )
      const configured = await prepareConfiguredCreateWorkItem(
        principal.directoryId,
        input.teamId,
        normalized,
        configuration,
      )
      const assigneeUserId = readTeamIssueAssigneeUserId(configured)
      let assigneeValidation = assigneeValidations.get(assigneeUserId)
      if (!assigneeValidation) {
        assigneeValidation = requireActiveWorkspaceAssignee(
          principal.directoryId,
          assigneeUserId,
        )
        assigneeValidations.set(assigneeUserId, assigneeValidation)
      }
      await assigneeValidation
      validInputs.push({ row: row.row, input: candidate })
    } catch (error) {
      const rowError = toImportRowError(error, row.row)
      if (!rowError) throw error
      errorsByRow.get(row.row)?.push(rowError)
    }
  }
  const errors = [...errorsByRow.values()].flat()
  const invalidRowIds = new Set(errors.map((error) => error.row))
  const report: ImportDryRunReport = {
    valid: invalidRowIds.size === 0,
    totalRows: preview.totalRows,
    validRows: preview.totalRows - invalidRowIds.size,
    invalidRows: invalidRowIds.size,
    errors,
    sample: preview.rows.slice(0, 20).map((row) => {
      const rowErrors = errorsByRow.get(row.row) ?? []
      return {
        row: row.row,
        input: {},
        mapped: mappedByRow.get(row.row) ?? {},
        valid: rowErrors.length === 0,
        errors: rowErrors,
      }
    }),
  }
  return {
    report,
    validInputs: validInputs.filter((row) => !invalidRowIds.has(row.row)),
  }
}

async function requireImportJob(workspaceId: string, jobId: string) {
  const job = (await developerPlatformDependencies.imports.listImportJobs(workspaceId))
    .find((candidate) => candidate.id === jobId)
  if (!job) {
    throw new WorkItemImportError('ImportJobNotFound', 'Import job was not found.')
  }
  return job
}

function createWorkItemImportJobLifecycle() {
  return {
    async markRunning(execution: WorkItemImportExecution) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'running' || job.status === 'completed') return
      if (job.status !== 'queued') {
        throw new WorkItemImportError(
          'ImportJobTerminal',
          'Import job cannot be started from its current state.',
        )
      }
      await developerPlatformDependencies.imports.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'running',
      })
    },

    async markCompleted(
      execution: WorkItemImportExecution,
      report: ImportReport,
    ) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'completed') return
      if (job.status !== 'running') {
        throw new WorkItemImportError(
          'ImportJobTerminal',
          'Import job cannot be completed from its current state.',
        )
      }
      await developerPlatformDependencies.imports.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'completed',
        report: createStoredWorkItemImportReport(report),
      })
    },

    async markFailed(
      execution: WorkItemImportExecution,
      problem: ApiProblem,
      report?: ImportReport,
    ) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'failed' || job.status === 'completed' || job.status === 'cancelled') {
        return
      }
      await developerPlatformDependencies.imports.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'failed',
        ...(report ? { report: createStoredWorkItemImportReport(report) } : {}),
        error: problem,
      })
    },

    async markCancelled(execution: WorkItemImportExecution) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
        return
      }
      await developerPlatformDependencies.imports.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'cancelled',
      })
    },
  }
}

async function resolveWorkItemImportPrincipal(execution: WorkItemImportExecution) {
  return resolveDeveloperManagementPrincipal({
    workspaceId: execution.workspaceId,
    userId: execution.createdByUserId,
    capabilities: {
      canManageCredentials: false,
      canManageWebhooks: false,
      canManageIntegrations: false,
      canImport: true,
      canExport: false,
    },
  }, {
    permission: 'work-items.write',
    teamId: execution.teamId,
    ...(execution.assignedProjectId
      ? { projectId: execution.assignedProjectId }
      : {}),
    evaluateProjectScopes: true,
  })
}

/**
 * Determines whether a Workspace role may manage Work Item imports.
 *
 * @param role - Current Workspace role.
 * @returns Whether import management is allowed.
 */
export function canManageWorkItemImports(role: WorkspaceRole) {
  return role === 'owner' || role === 'admin'
}

async function requireWorkItemImportExecutionAuthorization(
  principal: WorkspacePrincipal,
  execution: WorkItemImportExecution,
) {
  const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
  const canManageImport = enterpriseEvaluation
    ? evaluateEnterpriseAccess({
        permission: 'workspace.manage',
        principal: enterpriseEvaluation.principal,
        assignments: enterpriseEvaluation.assignments,
        customRoles: enterpriseEvaluation.snapshot.customRoles,
        groupMappings: enterpriseEvaluation.groupMappings,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'workspace',
        },
      }).allowed
    : canManageWorkItemImports(principal.workspaceRole)
  if (!canManageImport) {
    throw new WorkItemImportError(
      'ImportManagementAccessRevoked',
      'Import management access is no longer available.',
    )
  }
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, execution.teamId, 'member')
  requireAssignedProjectPermission(
    principal,
    permission,
    execution.assignedProjectId,
    'member',
  )
}

async function authorizeWorkItemImportExecution(execution: WorkItemImportExecution) {
  try {
    const principal = await resolveWorkItemImportPrincipal(execution)
    await requireWorkItemImportExecutionAuthorization(principal, execution)
  } catch (error) {
    throw toWorkItemImportWorkerError(error)
  }
}

/**
 * Maps a Work Item import failure to retryable or terminal worker semantics.
 *
 * @param error - Unknown failure raised by a downstream port.
 * @returns The original retryable failure or a stable Work Item import error.
 */
export function toWorkItemImportWorkerError(error: unknown): unknown {
  if (error instanceof WorkItemImportError) return error
  const mapped = mapPublicApiAdapterError(error)
  if (!mapped || mapped.retryable || mapped.status >= 500) return error
  const errorCode = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string'
    ? error.code
    : undefined
  if (
    mapped.status === 409 &&
    (errorCode === 'WorkItemConfigurationRevisionConflict' ||
      errorCode === 'WorkItemAuthorizationChanged' ||
      errorCode === 'ConditionalCheckFailedException')
  ) {
    return new WorkItemImportError(
      'ImportConcurrentMutation',
      'Import encountered a concurrent state change and will retry.',
      true,
    )
  }
  if (mapped.status === 401 || mapped.status === 403 || mapped.status === 404) {
    return new WorkItemImportError(
      'ImportAuthorizationRejected',
      'Import is no longer authorized by current Workspace, Team, or Project access.',
    )
  }
  return new WorkItemImportError(
    'ImportValidationRejected',
    'Import source no longer passes current validation.',
  )
}

/**
 * Creates application dependencies for the durable Work Item import worker.
 *
 * @returns Worker ports bound to the active dependency context.
 */
export function createWorkItemImportWorkerDependencies(): WorkItemImportWorkerDependencies {
  return {
    executions: developerPlatformDependencies.workItemImportExecutions,
    sources: developerPlatformDependencies.workItemImportSources,
    jobs: createWorkItemImportJobLifecycle(),
    authorize: authorizeWorkItemImportExecution,
    async assertTenantEnabled(execution) {
      try {
        await workspaceDependencies.tenantLifecycleEnforcement.assertActive(execution.workspaceId)
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          error.code === 'TenantAdministrationNotInitialized'
        ) {
          await initializeLegacyTenantAdministration(execution.workspaceId)
          try {
            await workspaceDependencies.tenantLifecycleEnforcement.assertActive(execution.workspaceId)
            return
          } catch (retryError) {
            if (
              retryError instanceof TenantAdministrationError &&
              retryError.code === 'TenantAdministrationNotInitialized'
            ) {
              throw new WorkItemImportError(
                'ImportTenantUnavailable',
                'Tenant administration is still initializing; the import can be retried.',
                true,
              )
            }
            if (
              retryError instanceof TenantAdministrationError &&
              (
                retryError.code === 'TenantClosing' ||
                retryError.code === 'TenantClosed'
              )
            ) {
              throw new WorkItemImportError(
                'ImportTenantUnavailable',
                'The tenant can no longer execute Developer Platform imports.',
              )
            }
            throw retryError
          }
        }
        if (
          error instanceof TenantAdministrationError &&
          (
            error.code === 'TenantClosing' ||
            error.code === 'TenantClosed'
          )
        ) {
          throw new WorkItemImportError(
            'ImportTenantUnavailable',
            'The tenant can no longer execute Developer Platform imports.',
          )
        }
        if (error instanceof TenantAdministrationError) {
          throw error
        }
        throw error
      }
    },
    async validate(execution, sourceContent) {
      try {
        const principal = await resolveWorkItemImportPrincipal(execution)
        const validation = await validatePublicImport(principal, {
          format: execution.format,
          source: {
            fileName: execution.format === 'csv' ? 'import.csv' : 'import.json',
            mediaType: execution.format === 'csv' ? 'text/csv' : 'application/json',
            content: sourceContent,
          },
          teamId: execution.teamId,
          ...(execution.assignedProjectId
            ? { assignedProjectId: execution.assignedProjectId }
            : {}),
          mapping: execution.mapping,
        })
        return { report: validation.report, rows: validation.validInputs }
      } catch (error) {
        throw toWorkItemImportWorkerError(error)
      }
    },
    async createWorkItem(request) {
      try {
        const authorization = await resolveStableWorkItemAuthorization(
          request.execution.workspaceId,
          async () => await resolveWorkItemImportPrincipal(request.execution),
          async (principal) => {
            await requireWorkItemImportExecutionAuthorization(
              principal,
              request.execution,
            )
          },
        )
        await createCanonicalPublicWorkItem(
          authorization.principal,
          request.execution.teamId,
          request.input,
          {
            requestId: `import-worker-${createHash('sha256')
              .update(request.execution.jobId)
              .digest('hex')
              .slice(0, 20)}`,
            idempotencyKey: request.idempotencyKey,
            correlationId: request.execution.jobId,
          },
          '/api/developer/imports',
          {
            issueId: request.workItemId,
            requestDigest: request.requestDigest,
          },
          authorization.authorizationSnapshot,
        )
      } catch (error) {
        throw toWorkItemImportWorkerError(error)
      }
    },
    now: () => new Date(),
    createLeaseOwner: randomUUID,
  }
}

function toImportRowError(error: unknown, row: number): ImportRowError | undefined {
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkspaceAccessError ||
    error instanceof WorkItemConfigurationError ||
    error instanceof DocumentError ||
    error instanceof CognitoServiceError
  ) {
    if (error.status >= 500) return undefined
    return { row, code: error.code, message: error.message }
  }
  return undefined
}

function matchesImportJobInput(
  job: ImportJob,
  input: PublicImportSourceInput,
) {
  return job.format === input.format &&
    job.teamId === input.teamId &&
    job.assignedProjectId === input.assignedProjectId &&
    JSON.stringify(job.mapping) === JSON.stringify(input.mapping)
}

/**
 * Creates an actor-scoped import row identity and payload digest.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param actorUserId - Importing actor identifier.
 * @param context - Public mutation idempotency context.
 * @param teamId - Target Team identifier.
 * @param input - Canonical Work Item creation input.
 * @returns Deterministic Work Item identity and request digest.
 */
export function createImportRowCreateIdentity(
  workspaceId: string,
  actorUserId: string,
  context: PublicMutationContext,
  teamId: string,
  input: CreateWorkItemInput,
): IdempotentWorkItemCreate {
  const identityDigest = createHash('sha256')
    .update(`${workspaceId}\n${actorUserId}\n${context.idempotencyKey}\n${teamId}`)
    .digest('hex')
  const requestDigest = createHash('sha256')
    .update(
      `${workspaceId}\n${actorUserId}\n${context.idempotencyKey}\n` +
        `${teamId}\n${stableDigestStringify(input)}`,
    )
    .digest('hex')
  return {
    issueId: `import-${identityDigest.slice(0, 48)}`,
    requestDigest,
  }
}

function createPublicApiWorkItemCreateIdentity(
  workspaceId: string,
  credentialId: string,
  context: PublicMutationContext,
  teamId: string,
  input: CreateWorkItemInput,
): IdempotentWorkItemCreate {
  const requestIdentity =
    `${workspaceId}\n${credentialId}\n${context.idempotencyKey}\n${teamId}`
  const identityDigest = createHash('sha256')
    .update(`public-work-item-v1\n${requestIdentity}`)
    .digest('hex')
  const requestDigest = createHash('sha256')
    .update(
      `public-work-item-v1\n${requestIdentity}\n${stableDigestStringify(input)}`,
    )
    .digest('hex')
  return {
    issueId: `api-${identityDigest.slice(0, 48)}`,
    requestDigest,
  }
}

async function failImportJobBestEffort(
  workspaceId: string,
  jobId: string,
  error: unknown,
) {
  try {
    await developerPlatformDependencies.imports.updateImportJob({
      workspaceId,
      jobId,
      status: 'failed',
      error: toImportApiProblem(error),
    })
  } catch (updateError) {
    const failure = mapPublicApiAdapterError(updateError)
    console.error('Failed to persist import job failure.', {
      code: failure?.code ?? 'internal_error',
      status: failure?.status ?? 500,
    })
  }
}

function toImportApiProblem(error: unknown): ApiProblem {
  const mapped = mapPublicApiAdapterError(error)
  const normalized = mapped ?? new PublicApiServiceError(
    500,
    'internal_error',
    'Import failed unexpectedly.',
    true,
  )
  return {
    type: `https://docs.mukuroji.app/problems/${normalized.code}`,
    title: normalized.code,
    status: normalized.status,
    code: normalized.code,
    detail: normalized.message,
    requestId: 'import-job',
    retryable: normalized.retryable,
  }
}

function mapPublicApiAdapterError(error: unknown) {
  if (error instanceof PublicApiServiceError) return error
  if (error instanceof ConnectorRuntimeError) {
    const status = error.providerStatus === 429
      ? 429
      : error.retryable
        ? 503
        : error.authorizationRequired
          ? 409
          : error.code.includes('NotFound')
            ? 404
            : error.code.includes('Conflict') ||
                error.code.includes('Changed') ||
                error.code.includes('Mismatch') ||
                error.code.includes('Consumed')
              ? 409
              : 400
    const code = status === 429
      ? 'rate_limited'
      : status === 503
        ? 'temporarily_unavailable'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : 'validation_failed'
    return new PublicApiServiceError(status, code, error.message, error.retryable)
  }
  if (error instanceof WorkItemImportError) {
    return new PublicApiServiceError(
      error.retryable ? 503 : 409,
      error.retryable ? 'temporarily_unavailable' : 'conflict',
      error.retryable
        ? 'Import could not be queued because a durable dependency is temporarily unavailable.'
        : error.message,
      error.retryable,
    )
  }
  if (error instanceof WorkItemTransferError) {
    return new PublicApiServiceError(
      error.status,
      error.status >= 500 ? 'temporarily_unavailable' : 'validation_failed',
      error.message,
      error.status >= 500,
    )
  }
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkspaceAccessError ||
    error instanceof WorkItemConfigurationError ||
    error instanceof PlanningError ||
    error instanceof CollaborationError ||
    error instanceof DocumentError ||
    error instanceof CognitoServiceError
  ) {
    const code = error.status === 401
      ? 'invalid_credentials'
      : error.status === 403
        ? 'forbidden'
        : error.status === 404
          ? 'not_found'
          : error.status === 409
            ? 'conflict'
            : error.status >= 500
              ? 'temporarily_unavailable'
              : 'validation_failed'
    return new PublicApiServiceError(error.status, code, error.message, error.status >= 500)
  }
  return undefined
}

function getPublicApiCursorSecret() {
  return loadServerConfig().publicApiCursorSecret
}

/**
 * Registers the public API HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerPublicApiRoutes(routeApp: Hono): void {
  if (!loadServerConfig().runtimeRole) {
    const publicApiDependencies: PublicApiDependencies = {
      apiKeys: createForwardingClient(() => developerPlatformDependencies.apiKeys),
      oauthCredentials: createForwardingClient(
        () => developerPlatformDependencies.oauthCredentials,
      ),
      webhookSubscriptions: createForwardingClient(
        () => developerPlatformDependencies.webhookSubscriptions,
      ),
      webhookDeliveries: createForwardingClient(
        () => developerPlatformDependencies.webhookDeliveries,
      ),
      connectors: createForwardingClient(() => developerPlatformDependencies.connectors),
      externalLinks: createForwardingClient(
        () => developerPlatformDependencies.externalLinks,
      ),
      imports: createForwardingClient(() => developerPlatformDependencies.imports),
      idempotency: createForwardingClient(
        () => developerPlatformDependencies.idempotency,
      ),
      rateLimits: createForwardingClient(() => developerPlatformDependencies.rateLimits),
      enforceActiveWorkspace: async (workspaceId) => {
        await enforceActiveTenantForWorkspace(workspaceId)
      },
      authenticateManagement: authenticateDeveloperManagement,
      workItems: createForwardingClient(() => developerPlatformDependencies.publicWorkItems),
      agentRuns: createForwardingClient(() => developerPlatformDependencies.publicAgentRuns),
      openApiDocument: PUBLIC_API_OPENAPI_DOCUMENT,
      get cursorSecret() {
        return getPublicApiCursorSecret()
      },
      queueWebhookDelivery,
      connectorAuthorization: lazyConnectorAuthorization,
      mapError: mapPublicApiAdapterError,
    }
    routeApp.route('/api', createPublicApiRouter(publicApiDependencies))
  }
}
