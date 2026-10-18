import { createHash, randomUUID } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
  readSearchWorkItemTypeKey,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type AiAssistanceCitation,
  type AiAssistanceDraft,
  type AiAssistanceSource,
  type DocumentComment,
  type DocumentDetail,
  type RequestLocalizedText,
  type CustomFieldValue,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
  type WorkItemDependencyEndpoint,
  type EnterprisePermissionId,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  normalizeProjectMemberKey,
  ProjectDataError,
  type ProjectDirectoryTeamResponse,
  type ProjectRole,
} from '../../modules/directory'
import { createWorkItemDependencyKey, isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { createDocumentWorkspaceSearchBody } from '../../modules/workspace-search/workspace-search'
import { RequestIntakeError } from '../../modules/request-intake/request-intake'
import {
  isTriageEntryVisible,
  projectTriageEntryForPrincipal,
  TriageError,
} from '../../modules/triage'
import {
  AI_ASSISTANCE_MAX_GENERATION_AUTHORIZATION_CONDITIONS,
  AiAssistanceError,
  aliasAiAssistanceTextIdentifiers,
  classifyAiAssistanceSensitivePromptField,
  createAiAssistancePrivateTextAliases,
  createAiAssistanceProviderAlias,
  createAiAssistanceRouter,
  redactAiAssistancePromptFieldValue,
  redactAiAssistanceText,
  type AiAssistanceActor,
  type AiAssistanceAllowedValues,
  type AiAssistanceAuthorizationCondition,
  type AiAssistanceCustomFieldDefinition,
  type AiAssistanceAuthorizationState,
  type AiAssistanceTriageRoutingTuple,
  type AiAssistanceTriageSourceRouting,
  type AiAssistancePolicyAuthorizationFence,
  type AiAssistancePolicyAuthorization,
  type AiAssistancePlanningDependency,
  type AiAssistanceService,
  type AiAssistanceTextAlias,
  type CheckAiAssistanceAuthorizationInput,
  type ResolveAiAssistanceContextInput,
  type ResolvedAiAssistanceContext,
} from '../../modules/ai-assistance'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
} from '../../modules/enterprise-identity'
import {
  resolveWorkItemType,
  resolveWorkItemTypeWorkflow,
} from '../../modules/work-items/work-item-configuration'
import { createWorkItemConfigurationScopeKey } from '../../modules/work-items'
import { PLANNING_STORAGE_SCHEMA_VERSION, PlanningError } from '../../modules/planning'
import { DocumentError, type DocumentAccessContext } from '../../modules/documents'
import { canManageAiAssistanceWorkspace } from '../shared/ai-assistance-access'
import {
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { requireTriageTeamAccess } from '../shared/customer-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  filterPlanningSnapshotForPrincipal,
  planningUpdateTargetsEqual,
  readPlanningPublishState,
  readPlanningWorkItemState,
  requirePlanningUpdateTargetPermission,
  toPlanningErrorResponse,
} from '../shared/planning-access'
import {
  hasEnterpriseWorkspacePermission,
  requireWorkspaceBusinessRead,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  toRequestIntakeErrorResponse,
  toTriageErrorResponse,
} from '../shared/request-intake-access'
import { getEnv } from '../shared/runtime-config'
import {
  createWorkspaceSearchContext,
  isWorkspaceSearchAuthorizationCurrent,
  type WorkspaceSearchContext,
} from '../shared/search-access'
import { isRecord } from '../shared/value-guards'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { getWorkItemConfigurationTableName } from '../shared/work-item-configuration'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

const aiAssistanceService: AiAssistanceService = {
  getPolicy: (actor) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.getPolicy(actor),
  updatePolicy: (actor, request, authorization: AiAssistancePolicyAuthorization) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.updatePolicy(
      actor,
      request,
      authorization,
    ),
  getPreference: (actor) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.getPreference(actor),
  updatePreference: (actor, request, authorization) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.updatePreference(
      actor,
      request,
      authorization,
    ),
  generate: (actor, request, authorization, idempotencyKey, requestStartedAtMs) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.generate(
      actor,
      request,
      authorization,
      idempotencyKey,
      requestStartedAtMs,
    ),
  generateWithMetadata: (
    actor,
    request,
    authorization,
    idempotencyKey,
    requestStartedAtMs,
  ) => {
    return requireAppDependencies().aiAssistance.aiAssistanceService.generateWithMetadata(
      actor,
      request,
      authorization,
      idempotencyKey,
      requestStartedAtMs,
    )
  },
  getGeneration: (actor, generationId, authorization) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.getGeneration(
      actor,
      generationId,
      authorization,
    ),
  decideGeneration: (actor, generationId, request, authorization) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.decideGeneration(
      actor,
      generationId,
      request,
      authorization,
    ),
  createFeedback: (actor, generationId, request, authorization, idempotencyKey) =>
    requireAppDependencies().aiAssistance.aiAssistanceService.createFeedback(
      actor,
      generationId,
      request,
      authorization,
      idempotencyKey,
    ),
}

/**
 * Requires the canonical Request Intake read boundary for an AI source.
 *
 * Enterprise callers need a Workspace-scoped `requests.read` or `requests.manage` permission;
 * legacy callers retain the existing owner/admin boundary. The generation route itself only
 * requires `workspace.read`, so its route-authorization boolean cannot be reused here.
 *
 * @param context - Current Request Intake source request.
 * @returns Freshly authenticated principal with permission to read Request Intake data.
 */
async function requireAiRequestSubmissionAdministration(
  context: Context,
): Promise<WorkspacePrincipal> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new RequestIntakeError(
      401,
      'RequestAuthenticationRequired',
      'Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (
    principal.enterprisePermissions !== undefined &&
    hasEnterpriseWorkspaceRequestPermission(principal)
  ) {
    return principal
  }
  if (principal.enterprisePermissions !== undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Request Intake read permission is required for this AI source.',
    )
  }
  if (canManageAiAssistanceWorkspace(principal)) return principal
  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Workspace owner or admin access is required.',
  )
}

/** Checks Request Intake permissions at the current Enterprise Workspace resource. */
function hasEnterpriseWorkspaceRequestPermission(principal: WorkspacePrincipal): boolean {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) return false
  const resource: EnterpriseAuthorizationResource = {
    workspaceId: principal.directoryId,
    kind: 'workspace',
  }
  const requestPermissions: readonly EnterprisePermissionId[] = [
    'requests.read',
    'requests.manage',
  ]
  return requestPermissions.some((permission) =>
    evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  )
}

/**
 * Determines whether the current Enterprise principal may enumerate Workspace members.
 *
 * AI generation is intentionally authorized by the weaker `workspace.read` route
 * permission, so member candidates must not inherit that route permission. Legacy
 * Workspace authorization retains its existing member-directory behavior.
 *
 * @param principal - Current authenticated Workspace principal.
 * @returns Whether active member identifiers may be exposed as model candidates.
 */
function canReadAiAssistanceMemberDirectory(principal: WorkspacePrincipal): boolean {
  if (principal.isSystemAdmin || principal.enterprisePermissions === undefined) return true
  return hasEnterpriseWorkspacePermission(principal, 'members.read') ||
    hasEnterpriseWorkspacePermission(principal, 'members.manage')
}

/** Maximum serialized characters retained for one source prompt fragment. */
const AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT = 3_500

/** Maximum serialized characters retained for visible directory metadata. */
const AI_ASSISTANCE_DIRECTORY_PROMPT_CHARACTER_LIMIT = 12_000

/** Maximum final prompt-context characters retained below the application hard limit. */
const AI_ASSISTANCE_PROMPT_CONTEXT_CHARACTER_LIMIT = 90_000

/** Maximum number of visible identifiers supplied for one structured output category. */
const AI_ASSISTANCE_ALLOWED_VALUE_LIMIT = 100

/** Maximum complete active-member set accepted for provider-side privacy aliases. */
const AI_ASSISTANCE_PRIVATE_MEMBER_IDENTIFIER_LIMIT = 1_000

/** Maximum entries accepted in one authorization-fence collection before failing closed. */
const AI_ASSISTANCE_AUTHORIZATION_FENCE_COLLECTION_LIMIT = 2_000

/** Maximum number of comments or activity rows copied from one authorized source. */
const AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT = 12

/** Maximum number of permission-filtered dependency candidates shown beside a Work Item. */
const AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT = 20

/** Maximum number of AI prompt sources resolved concurrently in one request. */
const AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY = 4

/** Conservative non-source condition reserve for Workspace, Planning, Document, and Enterprise rows. */
const AI_ASSISTANCE_NON_SOURCE_AUTHORIZATION_CONDITION_RESERVE = 4

/** One permission-safe source fragment and the non-content fences that authorize it. */
type ResolvedAiPromptSource = {
  /** Bounded prompt fragment built from an authorized application projection. */
  prompt: unknown
  /** Server-constructed citation returned with the generated draft. */
  citation: AiAssistanceCitation
  /** Identifiers and revisions hashed into the authorization token. */
  fence: unknown
  /** Visible relation identifiers that model output may reference. */
  relationIds: readonly string[]
  /** Visible Work Item endpoints that planning output may reference. */
  workItemEndpoints: readonly WorkItemDependencyEndpoint[]
  /** Persisted Planning edges used to reject duplicate or cyclic additions. */
  existingPlanningDependencies?: readonly AiAssistancePlanningDependency[]
  /** Current or directly reachable workflow statuses for a Work Item source. */
  workflowStatusIds: readonly string[]
  /** Current Team and Project routing for a triage source, when applicable. */
  triageSourceRouting?: AiAssistanceTriageSourceRouting
  /** Source-of-truth row that must remain unchanged through a later AI commit. */
  authorizationCondition: AiAssistanceAuthorizationCondition
  /** Additional source rows, such as the bounded Document comment window, fenced at commit time. */
  authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
  /** Work Item configuration Teams whose resolved revisions authorize this source. */
  configurationTeamIds?: readonly string[]
}

/** Current Project membership row used to bind a triage route to its source-of-truth revision. */
type AiAssistanceProjectMembership = {
  /** Canonical active member identifier. */
  memberId: string
  /** Current Project role for the member. */
  role: ProjectRole
  /** Last update timestamp of the membership row. */
  updatedAt: string
}

/** Shared live authorization and configuration state used by one resolver pass. */
type AiAssistanceResolverState = {
  /** Current search/document authorization snapshot. */
  searchContext: WorkspaceSearchContext
  /** Current task-specific identifier allowlists. */
  allowedValues: AiAssistanceAllowedValues
  /** Bounded task-minimal directory and filter metadata for the prompt. */
  directoryPrompt: unknown | undefined
  /** Active member identifiers held only for provider-local alias replacement. */
  privateMemberIdentifiers: ResolvedAiAssistanceContext['privateMemberIdentifiers']
  /** Exact member ID and display-name replacements applied before prompt bounding. */
  privacyAliases: readonly AiAssistanceTextAlias[]
  /** Active non-guest member identifiers eligible for triage routing. */
  eligibleMemberIds: readonly string[]
  /** Field identifiers excluded globally when any visible Team defines them as sensitive. */
  sensitiveCustomFieldIds: ReadonlySet<string>
  /** Complete current custom-field identifiers keyed by visible Team. */
  customFieldIdsByTeamId: ReadonlyMap<string, ReadonlySet<string>>
  /** Non-content authorization and configuration fences. */
  fence: Record<string, unknown>
  /** Complete routing tuples retained for the authorization token, including bounded additions. */
  triageRoutingFence: readonly AiAssistanceTriageRoutingTuple[]
  /** Current Project membership rows keyed by Team-qualified routing key. */
  projectMembershipsByRoutingKey: ReadonlyMap<
    string,
    readonly AiAssistanceProjectMembership[]
  >
  /** Current active Workspace member rows keyed by canonical member identifier. */
  workspaceMemberAuthorizationConditionsByMemberId: ReadonlyMap<
    string,
    AiAssistanceAuthorizationCondition
  >
  /** Resolved Work Item configuration rows keyed by Team identifier. */
  configurationAuthorizationConditionsByTeamId: ReadonlyMap<
    string,
    readonly AiAssistanceAuthorizationCondition[]
  >
  /** Workflow definitions keyed by Team and Work Item Type. */
  workItemTypeWorkflowsByTeamId: ReadonlyMap<
    string,
    ReadonlyMap<string, WorkItemConfiguration['workflow']>
  >
}

/** Returns every stored or built-in Work Item Type identifier for a configuration. */
function getAiWorkItemTypeIds(configuration: WorkItemConfiguration): readonly string[] {
  return [
    DEFAULT_WORK_ITEM_TYPE_ID,
    ...(configuration.workItemTypes?.map((type) => type.id) ?? []),
  ].filter((typeId, index, typeIds) => typeIds.indexOf(typeId) === index)
}

/** Resolves every Work Item Type to its selected workflow for AI planning and search. */
function resolveAiWorkItemTypeWorkflows(
  configuration: WorkItemConfiguration,
): ReadonlyMap<string, WorkItemConfiguration['workflow']> {
  return new Map(
    getAiWorkItemTypeIds(configuration).map(
      (typeId): [string, WorkItemConfiguration['workflow']] => [
        typeId,
        resolveWorkItemTypeWorkflow(configuration, typeId, { allowArchived: true }),
      ],
    ),
  )
}

/**
 * Loads visible Team configurations in deterministic bounded batches.
 *
 * @param workspaceId - Workspace whose Team configurations are being resolved.
 * @param visibleTeams - Teams already filtered by the current search authorization scope.
 * @returns Team configuration snapshots in the same order as the input Teams.
 */
async function resolveAiAssistanceTeamConfigurations(
  workspaceId: string,
  visibleTeams: readonly ProjectDirectoryTeamResponse[],
): Promise<Array<{ team: ProjectDirectoryTeamResponse; resolved: ResolvedWorkItemConfiguration }>> {
  const configurations: Array<{
    team: ProjectDirectoryTeamResponse
    resolved: ResolvedWorkItemConfiguration
  }> = []
  for (
    let offset = 0;
    offset < visibleTeams.length;
    offset += AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY
  ) {
    const batch = visibleTeams.slice(
      offset,
      offset + AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY,
    )
    configurations.push(...await Promise.all(batch.map(async (team) => ({
      team,
      resolved: await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        workspaceId,
        team.id,
      ),
    }))))
  }
  return configurations
}

/**
 * Resolves current Project membership for AI triage routing in bounded batches.
 *
 * @param directoryId - Workspace directory that owns the Projects.
 * @param projects - Team-qualified destination Projects visible to the request.
 * @param eligibleMemberIds - Active, non-guest Workspace members already visible to the model.
 * @returns Team/project routing keys mapped to membership revisions and eligible member IDs.
 */
async function resolveAiAssistanceProjectMemberIds(
  directoryId: string,
  projects: readonly Readonly<{ teamId: string; projectId: string }>[],
  eligibleMemberIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, readonly AiAssistanceProjectMembership[]>> {
  const membersByProjectRoutingKey = new Map<
    string,
    readonly AiAssistanceProjectMembership[]
  >()
  const eligibleMemberIdsByNormalizedId = new Map<string, string>()
  for (const memberId of eligibleMemberIds) {
    eligibleMemberIdsByNormalizedId.set(memberId.trim().toLowerCase(), memberId)
  }
  for (
    let offset = 0;
    offset < projects.length;
    offset += AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY
  ) {
    const batch = projects.slice(
      offset,
      offset + AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY,
    )
    const responses = await Promise.all(batch.map((project) =>
      workspaceDependencies.projectDirectory.getProjectMembers(
        directoryId,
        project.projectId,
        project.teamId,
      )
    ))
    for (const [index, response] of responses.entries()) {
      const project = batch[index]
      if (project === undefined) {
        throw new Error('AI assistance Project membership response ordering changed.')
      }
      const members = response.members.flatMap((member) => {
        const canonicalMemberId = eligibleMemberIdsByNormalizedId.get(
          member.id.trim().toLowerCase(),
        )
        return canonicalMemberId === undefined
          ? []
          : [{
              memberId: canonicalMemberId,
              role: member.role,
              updatedAt: member.updatedAt,
            }]
      }).sort((left, right) => left.memberId.localeCompare(right.memberId))
      membersByProjectRoutingKey.set(
        createAiAssistanceProjectRoutingKey(project.teamId, project.projectId),
        members,
      )
    }
  }
  return membersByProjectRoutingKey
}

/**
 * Retains a triage source's Team and Project route when the provider allowlist is bounded.
 *
 * Directory results are globally capped for prompt size. A source route must be promoted
 * before that cap is applied; otherwise a content-only model response would inherit a
 * source Project that is absent from the validated routing tuple set.
 *
 * @param principal - Workspace principal whose Project memberships are being resolved.
 * @param state - Resolver state containing the bounded route and active-member metadata.
 * @param sourceRouting - Source Team and optional Project inferred from the authorized source.
 * @returns Resolver state with the source route first in provider-facing allowlists.
 */
async function prioritizeAiAssistanceSourceRouting(
  principal: WorkspacePrincipal,
  state: AiAssistanceResolverState,
  sourceRouting: AiAssistanceTriageSourceRouting | undefined,
): Promise<AiAssistanceResolverState> {
  if (sourceRouting === undefined) return state
  const currentTuples = state.allowedValues.triageRoutingTuples ?? []
  const sourceTeamTuple = currentTuples.find((tuple) =>
    tuple.teamId === sourceRouting.teamId && tuple.projectId === undefined)
  const teamTuple = sourceTeamTuple ?? {
    teamId: sourceRouting.teamId,
    assigneeUserIds: state.eligibleMemberIds,
  }
  const sourceProjectTuple = sourceRouting.projectId === undefined
    ? undefined
    : currentTuples.find((tuple) =>
        tuple.teamId === sourceRouting.teamId &&
        tuple.projectId === sourceRouting.projectId)
  let projectMembershipsByRoutingKey = state.projectMembershipsByRoutingKey
  let projectTuple = sourceProjectTuple
  if (sourceRouting.projectId !== undefined && projectTuple === undefined) {
    const routingKey = createAiAssistanceProjectRoutingKey(
      sourceRouting.teamId,
      sourceRouting.projectId,
    )
    const resolvedMemberships = await resolveAiAssistanceProjectMemberIds(
      principal.directoryId,
      [{ teamId: sourceRouting.teamId, projectId: sourceRouting.projectId }],
      new Set(state.eligibleMemberIds),
    )
    const memberships = resolvedMemberships.get(routingKey)
    if (memberships === undefined) throw aiAssistanceAuthorizationChangedError()
    projectTuple = {
      teamId: sourceRouting.teamId,
      projectId: sourceRouting.projectId,
      assigneeUserIds: memberships.map((member) => member.memberId),
    }
    const updatedProjectMembershipsByRoutingKey = new Map(
      state.projectMembershipsByRoutingKey,
    )
    updatedProjectMembershipsByRoutingKey.set(routingKey, memberships)
    projectMembershipsByRoutingKey = updatedProjectMembershipsByRoutingKey
  }
  const promotedTuples = [
    ...(projectTuple === undefined ? [] : [projectTuple]),
    teamTuple,
    ...currentTuples.filter((tuple) =>
      !(tuple.teamId === sourceRouting.teamId && tuple.projectId === undefined) &&
      !(tuple.teamId === sourceRouting.teamId && tuple.projectId === sourceRouting.projectId)),
  ].slice(0, AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
  const modelTeamIds = prioritizedUniqueAiAllowedValues(
    promotedTuples.map((tuple) => tuple.teamId),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
    [sourceRouting.teamId],
  )
  const modelProjectIds = prioritizedUniqueAiAllowedValues(
    promotedTuples.flatMap((tuple) => tuple.projectId === undefined ? [] : [tuple.projectId]),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
    sourceRouting.projectId === undefined ? [] : [sourceRouting.projectId],
  )
  const routeByKey = new Map<string, AiAssistanceTriageRoutingTuple>()
  for (const tuple of promotedTuples) {
    routeByKey.set(
      createAiAssistanceProjectRoutingKey(tuple.teamId, tuple.projectId ?? ''),
      tuple,
    )
  }
  const triageRoutingFence = [...state.triageRoutingFence]
  for (const tuple of [teamTuple, ...(projectTuple === undefined ? [] : [projectTuple])]) {
    const key = createAiAssistanceProjectRoutingKey(tuple.teamId, tuple.projectId ?? '')
    if (!triageRoutingFence.some((candidate) =>
      createAiAssistanceProjectRoutingKey(candidate.teamId, candidate.projectId ?? '') === key)) {
      triageRoutingFence.push(tuple)
    }
  }
  const sortedFence = triageRoutingFence
    .map((tuple) => ({
      teamId: tuple.teamId,
      ...(tuple.projectId === undefined ? {} : { projectId: tuple.projectId }),
      assigneeUserIds: [...tuple.assigneeUserIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.teamId.localeCompare(right.teamId) ||
      (left.projectId ?? '').localeCompare(right.projectId ?? ''))
  return {
    ...state,
    allowedValues: {
      ...state.allowedValues,
      teamIds: modelTeamIds,
      projectIds: modelProjectIds,
      triageRoutingTuples: [...routeByKey.values()],
    },
    projectMembershipsByRoutingKey,
    triageRoutingFence,
    fence: {
      ...state.fence,
      teamIds: modelTeamIds,
      projectIds: modelProjectIds,
      triageRoutingTuples: sortedFence,
    },
  }
}

/** Creates a collision-free key for a Team-qualified Project routing tuple. */
function createAiAssistanceProjectRoutingKey(teamId: string, projectId: string): string {
  return `${teamId}\u0000${projectId}`
}

/**
 * Projects a fresh Workspace principal into the AI application actor.
 *
 * @param principal - Current server-authenticated Workspace principal.
 * @param _context - Current request context; caller-provided correlation headers are ignored.
 * @returns Application actor with no caller-asserted identity fields.
 */
function createAiAssistanceActor(
  principal: WorkspacePrincipal,
  _context: Context,
): AiAssistanceActor {
  return {
    workspaceId: principal.directoryId,
    memberId: principal.userKey,
    actorId: principal.actorId,
    auditActorKind: principal.principalKind === 'service-account'
      ? 'service'
      : principal.principalKind === 'break-glass'
        ? 'break-glass'
        : 'user',
    traceId: randomUUID(),
    canManagePolicy: canManageAiAssistanceWorkspace(principal),
  }
}

/**
 * Projects fresh Workspace authorization state into the policy transaction fence.
 *
 * @param principal - Principal freshly authenticated at the policy write boundary.
 * @param actor - Application actor bound to that principal.
 * @returns Membership and Enterprise revisions checked by the DynamoDB policy transaction.
 */
function createAiAssistancePolicyAuthorizationFence(
  principal: WorkspacePrincipal,
  actor: AiAssistanceActor,
): AiAssistancePolicyAuthorizationFence | undefined {
  if (
    principal.directoryId !== actor.workspaceId ||
    principal.userKey !== actor.memberId ||
    principal.actorId !== actor.actorId ||
    !actor.canManagePolicy
  ) return undefined
  return {
    workspaceMemberVersion: principal.workspaceMember.version,
    workspaceRole: principal.workspaceRole,
    principalKind: principal.principalKind ?? 'member',
    ...(principal.enterpriseIdentityControlRevision === undefined
      ? {}
      : { enterpriseControlRevision: principal.enterpriseIdentityControlRevision }),
  }
}

/**
 * Resolves all source text through current application authorization boundaries.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param input - Validated actor and generation request.
 * @param context - Current request context for canonical source authorization helpers.
 * @returns Bounded redaction-ready prompt context, citations, and authorization hash.
 */
async function resolveAiAssistanceContext(
  principal: WorkspacePrincipal,
  input: ResolveAiAssistanceContextInput,
  context: Context,
): Promise<ResolvedAiAssistanceContext> {
  requireAiAssistanceActorMatchesPrincipal(principal, input.actor)
  requireWorkspaceBusinessRead(principal)
  const sources = getAiAssistanceRequestSources(input.request)
  const documentSourceCount = sources.filter((source) => source.type === 'document').length
  const configurationSourceCount = sources.filter((source) => source.type !== 'document').length
  const selectedOutputConditionReserve = input.request.task === 'triage' ? 3 : 0
  const documentCommentLimit = documentSourceCount === 0
    ? AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT
    : Math.max(
        0,
        Math.min(
          AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT,
          Math.floor(
            (AI_ASSISTANCE_MAX_GENERATION_AUTHORIZATION_CONDITIONS -
              sources.length -
              documentSourceCount -
              AI_ASSISTANCE_NON_SOURCE_AUTHORIZATION_CONDITION_RESERVE -
              configurationSourceCount * 2 -
              selectedOutputConditionReserve) /
              documentSourceCount,
          ),
        ),
      )
  const state = await createAiAssistanceResolverState(
    principal,
    sources.some((source) => source.type === 'document'),
    input.request.task,
    input.request.locale,
    input.request.task === 'triage' && input.request.source.type === 'triage-entry'
      ? input.request.source.teamId
      : undefined,
  )
  const resolvedSources: ResolvedAiPromptSource[] = []
  for (
    let offset = 0;
    offset < sources.length;
    offset += AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY
  ) {
    const batch = sources.slice(
      offset,
      offset + AI_ASSISTANCE_SOURCE_RESOLUTION_CONCURRENCY,
    )
    resolvedSources.push(...await Promise.all(batch.map((source, index) =>
      resolveAiAssistanceSource(
        principal,
        source,
        state,
        context,
        `source-${offset + index + 1}`,
        documentCommentLimit,
      )
    )))
  }
  const triageSourceRouting = resolvedSources.find((source) =>
    source.triageSourceRouting !== undefined)?.triageSourceRouting
  const resolverState = await prioritizeAiAssistanceSourceRouting(
    principal,
    state,
    input.request.task === 'triage' ? triageSourceRouting : undefined,
  )
  const relationIds = uniqueAiAllowedValues([
    ...resolverState.allowedValues.relationIds,
    ...resolvedSources.flatMap((source) => source.relationIds),
  ], AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
  const workItemEndpoints = uniqueAiWorkItemEndpoints([
    ...resolverState.allowedValues.workItemEndpoints,
    ...resolvedSources.flatMap((source) => source.workItemEndpoints),
  ])
  const existingPlanningDependencies = uniqueAiAssistancePlanningDependencies(
    resolvedSources.flatMap((source) => source.existingPlanningDependencies ?? []),
  )
  const candidateAllowedValues: AiAssistanceAllowedValues = {
    ...resolverState.allowedValues,
    relationIds,
    statuses: input.request.task === 'planning'
      ? uniqueAiAllowedValues(
          resolvedSources.flatMap((source) => source.workflowStatusIds),
          AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
        )
      : resolverState.allowedValues.statuses,
    workItemEndpoints,
    existingPlanningDependencies,
    triageRoutingTuples: resolverState.allowedValues.triageRoutingTuples,
  }
  const promptContext = serializeBoundedAiPromptContext({
    task: input.request.task,
    ...(resolverState.directoryPrompt === undefined
      ? {}
      : { directory: resolverState.directoryPrompt }),
    sources: resolvedSources.map((source) => source.prompt),
    ...(input.request.task === 'search'
      ? { naturalLanguageQuery: input.request.query }
      : {}),
  }, resolverState.privacyAliases)
  const allowedValues: AiAssistanceAllowedValues = {
    assigneeUserIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.assigneeUserIds,
      resolverState.privacyAliases,
    ),
    creatorUserIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.creatorUserIds,
      resolverState.privacyAliases,
    ),
    teamIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.teamIds,
    ),
    projectIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.projectIds,
    ),
    workItemTypeIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.workItemTypeIds,
    ),
    customFieldDefinitions: filterAiCustomFieldDefinitionsVisibleInPrompt(
      promptContext,
      candidateAllowedValues.customFieldDefinitions ?? [],
    ),
    customFieldIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.customFieldIds,
    ),
    relationIds: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.relationIds,
    ),
    statuses: filterAiAllowedValuesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.statuses,
    ),
    workItemEndpoints: filterAiWorkItemEndpointsVisibleInPrompt(
      promptContext,
      candidateAllowedValues.workItemEndpoints,
    ),
    existingPlanningDependencies: candidateAllowedValues.existingPlanningDependencies,
    triageRoutingTuples: filterAiTriageRoutingTuplesVisibleInPrompt(
      promptContext,
      candidateAllowedValues.triageRoutingTuples ?? [],
      resolverState.privacyAliases,
    ),
  }
  if (!await isWorkspaceSearchAuthorizationCurrent(
    principal.directoryId,
    resolverState.searchContext.planningRevision,
    resolverState.searchContext.documentAuthorizationRevision,
    resolverState.searchContext.documentAccess,
  )) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const authorizationConditions = await createAiAssistanceAuthorizationConditions(
    principal,
    resolverState,
    resolvedSources,
    input.draft,
  )
  return {
    promptContext,
    citations: resolvedSources.map((source) => source.citation),
    authorizationToken: createAiAssistanceAuthorizationToken({
      state: resolverState.fence,
      sources: resolvedSources.map((source) => source.fence),
    }),
    allowedValues,
    privateMemberIdentifiers: resolverState.privateMemberIdentifiers,
    authorizationConditions,
    ...(triageSourceRouting === undefined ? {} : { triageSourceRouting }),
  }
}

/**
 * Builds source-of-truth conditions for the next AI generation or decision commit.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param state - Directory and authorization state captured for the resolver pass.
 * @param sources - Authorized source snapshots whose revisions were read.
 * @returns Deduplicated persistence rows that must remain unchanged at commit time.
 */
async function createAiAssistanceAuthorizationConditions(
  principal: WorkspacePrincipal,
  state: AiAssistanceResolverState,
  sources: readonly ResolvedAiPromptSource[],
  selectedDraft?: AiAssistanceDraft,
): Promise<AiAssistanceAuthorizationCondition[]> {
  const conditions = createAiAssistancePrincipalAuthorizationConditions(principal)
  conditions.push({
    kind: 'planning',
    tableName: getEnv('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
    key: {
      workspaceId: `FENCE#${principal.directoryId}`,
      recordKey: 'META',
    },
    expectedAttributes: {
      entryType: 'planning-meta',
      schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
      revision: state.searchContext.planningRevision,
    },
    ...(state.searchContext.planningRevision === 0
      ? { allowMissingWhenExpectedZero: true }
      : {}),
  })
  if (state.searchContext.documentAuthorizationRevision !== undefined) {
    conditions.push({
      kind: 'document-authorization',
      tableName: getEnv('DOCUMENTS_TABLE_NAME') ?? 'mukuroji-documents-local',
      key: {
        workspaceId: principal.directoryId,
        recordKey: 'DOCUMENT_AUTHORIZATION_REVISION',
      },
      expectedAttributes: {
        entryType: 'document-authorization-revision',
        revision: state.searchContext.documentAuthorizationRevision,
      },
      ...(state.searchContext.documentAuthorizationRevision === 0
        ? { allowMissingWhenExpectedZero: true }
        : {}),
    })
  }
  const seen = new Set<string>()
  const deduplicated = [
    ...conditions,
    ...sources.flatMap((source) => (source.configurationTeamIds ?? []).flatMap((teamId) => {
      const configurationConditions = state.configurationAuthorizationConditionsByTeamId.get(teamId)
      if (configurationConditions === undefined) {
        throw aiAssistanceAuthorizationChangedError()
      }
      return configurationConditions
    })),
    ...sources.flatMap((source) => [
      source.authorizationCondition,
      ...(source.authorizationConditions ?? []),
    ]),
    ...await createAiAssistanceSelectedDraftAuthorizationConditions(
      principal,
      state,
      sources,
      selectedDraft,
    ),
  ]
    .filter((condition) => {
      const key = `${condition.tableName}:${JSON.stringify(condition.key)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  if (deduplicated.length > AI_ASSISTANCE_MAX_GENERATION_AUTHORIZATION_CONDITIONS) {
    throw new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'AI assistance authorization fences exceed the DynamoDB transaction limit.',
    )
  }
  return deduplicated
}

/**
 * Builds the current actor rows that authorize a member preference write.
 *
 * Preference updates have no source request, so this intentionally fences only
 * the authenticated Workspace membership and Enterprise control rows. The
 * caller must still bind these rows to the actor identity before persistence.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @returns Exact membership and Enterprise control conditions for the actor.
 */
function createAiAssistancePrincipalAuthorizationConditions(
  principal: WorkspacePrincipal,
): AiAssistanceAuthorizationCondition[] {
  const workspaceAccessTableName = getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
    getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
    'mukuroji-workspace-access-local'
  const principalKind = principal.principalKind ?? 'member'
  const enterpriseTableName = getEnv('ENTERPRISE_IDENTITY_TABLE_NAME')?.trim()
  if (
    principalKind === 'service-account' &&
    (principal.enterpriseIdentityControlRevision === undefined || !enterpriseTableName)
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const conditions: AiAssistanceAuthorizationCondition[] = principalKind ===
    'service-account'
    ? []
    : [{
        kind: 'workspace-member',
        tableName: workspaceAccessTableName,
        key: {
          workspaceId: principal.directoryId,
          recordKey: `MEMBER#${normalizeProjectMemberKey(principal.userKey)}`,
        },
        expectedAttributes: {
          entryType: 'workspace-member',
          status: 'active',
          memberKey: normalizeProjectMemberKey(principal.userKey),
          role: principal.workspaceRole,
          version: principal.workspaceMember.version,
        },
      }]
  if (principal.enterpriseIdentityControlRevision !== undefined) {
    if (!enterpriseTableName) return conditions
    conditions.push({
      kind: 'enterprise-control',
      tableName: enterpriseTableName,
      key: {
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: 'CONTROL',
      },
      expectedAttributes: {
        entryType: 'enterprise-identity-control',
        controlRevision: principal.enterpriseIdentityControlRevision,
      },
      ...(principal.enterpriseIdentityControlRevision === 0
        ? { allowMissingWhenExpectedZero: true }
        : {}),
    })
  }
  return conditions
}

/**
 * Re-resolves sources after authentication and compares only authorization fences.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @param input - Stored request and captured authorization token.
 * @param context - Current request context for canonical ACL helpers.
 * @returns Whether disclosure remains authorized and sources remain revision-current.
 */
async function isAiAssistanceAuthorizationCurrent(
  principal: WorkspacePrincipal,
  input: CheckAiAssistanceAuthorizationInput,
  context: Context,
): Promise<AiAssistanceAuthorizationState> {
  try {
    requireAiAssistanceActorMatchesPrincipal(principal, input.actor)
    const current = await resolveAiAssistanceContext(principal, {
      actor: input.actor,
      request: input.request,
      draft: input.draft,
    }, context)
    return current.authorizationToken === input.authorizationToken
      ? {
          current: true,
          ...(current.authorizationConditions === undefined
            ? {}
            : { authorizationConditions: current.authorizationConditions }),
        }
      : { current: false, reason: 'source-changed' }
  } catch (error) {
    if (isAiAssistancePermissionLoss(error)) {
      return { current: false, reason: 'permission-changed' }
    }
    if (
      error instanceof AiAssistanceError &&
      error.code === 'AiAssistanceSourceChanged'
    ) {
      return { current: false, reason: 'source-changed' }
    }
    throw error
  }
}

/**
 * Builds current visible directory, configuration, member, and authorization state.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param includeDocumentAuthorizationRevision - Whether document ACL revision is required.
 * @param task - Workflow used to minimize model-visible directory metadata.
 * @param locale - Locale used for the directory labels included in the prompt.
 * @param triageSourceTeamId - Source Team that bounds triage-entry routing, when applicable.
 * @returns Shared resolver state with bounded output allowlists.
 */
async function createAiAssistanceResolverState(
  principal: WorkspacePrincipal,
  includeDocumentAuthorizationRevision: boolean,
  task: ResolveAiAssistanceContextInput['request']['task'],
  locale: 'ja' | 'en',
  triageSourceTeamId?: string,
): Promise<AiAssistanceResolverState> {
  const searchContext = await createWorkspaceSearchContext(principal, {
    includeDocumentAuthorizationRevision,
    locale,
  })
  const visibleTeams = searchContext.directory.teams
    .filter((team) => searchContext.searchAccess.teamIds.has(team.id))
    .sort((left, right) => left.id.localeCompare(right.id))
  const teamsForConfiguration = triageSourceTeamId === undefined
    ? visibleTeams
    : visibleTeams.filter((team) => team.id === triageSourceTeamId)
  const [activeMembers, configurations] = await Promise.all([
    workspaceDependencies.workspaceAccess.listActiveMembers(principal.directoryId),
    resolveAiAssistanceTeamConfigurations(principal.directoryId, teamsForConfiguration),
  ])
  const teamIds = uniqueAiAllowedValues(
    visibleTeams.map((team) => team.id),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const projectIds = uniqueAiAllowedValues(
    visibleTeams.flatMap((team) => team.projects.flatMap((project) =>
      searchContext.searchAccess.projectIds.has(project.id) ? [project.id] : []
    )),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const currentMembers = activeMembers
    .map((member) => ({
      id: member.memberKey,
      displayName: member.name?.trim() || undefined,
      role: member.role,
      version: member.version,
      updatedAt: member.updatedAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (currentMembers.length > AI_ASSISTANCE_PRIVATE_MEMBER_IDENTIFIER_LIMIT) {
    throw new AiAssistanceError(
      'upstream',
      'InvalidAiAssistanceRequest',
      `The active member directory exceeds the safe AI privacy-alias bound of ${AI_ASSISTANCE_PRIVATE_MEMBER_IDENTIFIER_LIMIT}.`,
    )
  }
  const visibleMembers = (canReadAiAssistanceMemberDirectory(principal)
    ? currentMembers
    : currentMembers.filter((member) => member.id === principal.userKey))
    .slice(0, AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
  const privateMemberIdentifiers = currentMembers.map((member) => ({
    memberId: member.id,
    providerAlias: createAiAssistanceProviderAlias(),
    identifiers: member.displayName === undefined ? [] : [member.displayName],
  }))
  const privateMemberIds = new Set(
    privateMemberIdentifiers.map((member) => member.memberId),
  )
  if (
    new Set(privateMemberIdentifiers.map((member) => member.providerAlias)).size !==
      privateMemberIdentifiers.length ||
    privateMemberIdentifiers.some((member) =>
      privateMemberIds.has(member.providerAlias)
    )
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Unable to create unique request-local member aliases.',
    )
  }
  const privacyAliases = createAiAssistancePrivateTextAliases(
    privateMemberIdentifiers,
  )
  const memberIds = visibleMembers.map((member) => member.id)
  const eligibleMemberIds = visibleMembers
    .filter((member) => member.role !== 'guest')
    .map((member) => member.id)
  const eligibleMemberIdSet = new Set(eligibleMemberIds)
  const routingTeams = triageSourceTeamId === undefined
    ? visibleTeams
    : visibleTeams.filter((team) => team.id === triageSourceTeamId)
  const routingProjects = task === 'triage'
    ? routingTeams.flatMap((team) => team.projects
        .filter((project) => projectIds.includes(project.id))
        .map((project) => ({ teamId: team.id, projectId: project.id })))
    : []
  const projectMemberIdsByProjectRoutingKey = task === 'triage'
    ? await resolveAiAssistanceProjectMemberIds(
        principal.directoryId,
        routingProjects,
        eligibleMemberIdSet,
      )
    : new Map<string, readonly AiAssistanceProjectMembership[]>()
  const allTriageRoutingTuples: AiAssistanceTriageRoutingTuple[] = routingTeams.flatMap((team) => [
    {
      teamId: team.id,
      assigneeUserIds: eligibleMemberIds,
    },
    ...team.projects
      .filter((project) => projectIds.includes(project.id))
      .map((project) => ({
        teamId: team.id,
        projectId: project.id,
        assigneeUserIds: task === 'triage'
          ? projectMemberIdsByProjectRoutingKey.get(
              createAiAssistanceProjectRoutingKey(team.id, project.id),
            )?.map((member) => member.memberId) ?? []
          : eligibleMemberIds,
      })),
  ])
  const triageRoutingTuples = allTriageRoutingTuples.slice(0, AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
  const triageRoutingFence = allTriageRoutingTuples
    .map((tuple) => ({
      teamId: tuple.teamId,
      ...(tuple.projectId === undefined ? {} : { projectId: tuple.projectId }),
      assigneeUserIds: [...tuple.assigneeUserIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.teamId.localeCompare(right.teamId) ||
      (left.projectId ?? '').localeCompare(right.projectId ?? ''))
  const triageTeamIds = uniqueAiAllowedValues(
    triageRoutingTuples.map((tuple) => tuple.teamId),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const triageProjectIds = uniqueAiAllowedValues(
    triageRoutingTuples.flatMap((tuple) =>
      tuple.projectId === undefined ? [] : [tuple.projectId]
    ),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const modelTeamIds = task === 'triage' ? triageTeamIds : teamIds
  const modelProjectIds = task === 'triage' ? triageProjectIds : projectIds
  const workItemTypeWorkflowsByTeamId = new Map<
    string,
    ReadonlyMap<string, WorkItemConfiguration['workflow']>
  >(
    configurations.map(({ team, resolved }): [
      string,
      ReadonlyMap<string, WorkItemConfiguration['workflow']>
    ] => [
      team.id,
      resolveAiWorkItemTypeWorkflows(resolved.configuration),
    ]),
  )
  const workItemTypeIds = uniqueAiAllowedValues(
    task === 'search'
      ? [...workItemTypeWorkflowsByTeamId.entries()].flatMap(([teamId, workflows]) =>
          [...workflows.keys()].map((typeId) => createSearchWorkItemTypeKey(teamId, typeId))
        )
      : [...workItemTypeWorkflowsByTeamId.values()].flatMap((workflows) => [...workflows.keys()]),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const statuses = uniqueAiAllowedValues(
    [...workItemTypeWorkflowsByTeamId.values()].flatMap((workflows) =>
      [...workflows.values()].flatMap((workflow) =>
        workflow.statuses.map((status) => status.id)
      )
    ),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const sensitiveCustomFieldIds = new Set(
    configurations.flatMap(({ resolved }) =>
      resolved.configuration.customFields.flatMap((field) =>
        classifyAiAssistanceSensitivePromptField({
          fieldId: field.id,
          label: field.name,
          fieldType: field.type,
        }) === undefined
          ? []
          : [field.id]
      )
    ),
  )
  const customFieldIdsByTeamId = new Map(configurations.map(({ team, resolved }) => [
    team.id,
    new Set(resolved.configuration.customFields
      .filter((field) => field.type !== 'formula')
      .map((field) => field.id)),
  ]))
  const customFieldDefinitions = configurations.flatMap(({ team, resolved }) =>
    resolved.configuration.customFields.flatMap((field) => {
      if (field.type === 'formula' || sensitiveCustomFieldIds.has(field.id)) return []
      const definition: AiAssistanceCustomFieldDefinition = {
        teamId: team.id,
        fieldId: field.id,
        type: field.type,
        required: field.required,
        ...(field.projectIds === undefined ? {} : { projectIds: [...field.projectIds] }),
        ...(field.options === undefined
          ? {}
          : { optionIds: field.options.map((option) => option.id) }),
        ...(field.validation === undefined ? {} : { validation: field.validation }),
        ...(field.currencyCode === undefined ? {} : { currencyCode: field.currencyCode }),
      }
      return [definition]
    })
  )
  const customFieldDefinitionCounts = new Map<string, number>()
  for (const definition of customFieldDefinitions) {
    customFieldDefinitionCounts.set(
      definition.fieldId,
      (customFieldDefinitionCounts.get(definition.fieldId) ?? 0) + 1,
    )
  }
  const providerCustomFieldDefinitions = task === 'search'
    ? customFieldDefinitions.filter((definition) =>
        customFieldDefinitionCounts.get(definition.fieldId) === 1
      )
    : customFieldDefinitions
  const customFieldIds = uniqueAiAllowedValues(
    providerCustomFieldDefinitions.map((definition) => definition.fieldId),
    AI_ASSISTANCE_ALLOWED_VALUE_LIMIT,
  )
  const allowedValues: AiAssistanceAllowedValues = {
    assigneeUserIds: memberIds,
    creatorUserIds: memberIds,
    teamIds: modelTeamIds,
    projectIds: modelProjectIds,
    workItemTypeIds,
    customFieldIds,
    customFieldDefinitions: providerCustomFieldDefinitions.filter((definition) =>
      customFieldIds.includes(definition.fieldId)
    ),
    relationIds: [],
    statuses,
    workItemEndpoints: [],
    triageRoutingTuples,
  }
  const directoryPrompt = task === 'summary'
    ? undefined
    : boundAiPromptPart({
        ...(task === 'planning'
          ? {}
          : { members: visibleMembers.map((member) => ({ id: member.id })) }),
        teams: configurations
          .filter(({ team }) => modelTeamIds.includes(team.id))
          .map(({ team, resolved }) => {
            const typeWorkflows = workItemTypeWorkflowsByTeamId.get(team.id) ??
              new Map<string, WorkItemConfiguration['workflow']>()
            return {
              id: team.id,
              ...(task === 'planning' ? {} : { name: team.name }),
              ...(task === 'planning'
                ? {}
                : {
                    projects: team.projects.flatMap((project) =>
                      modelProjectIds.includes(project.id)
                        ? [{ id: project.id, name: project.name }]
                        : []
                    ),
                  }),
              workItemTypes: [...typeWorkflows.entries()].map(([typeId, workflow]) => {
                const type = resolveWorkItemType(
                  resolved.configuration,
                  typeId,
                  { allowArchived: true },
                )
                return {
                  id: task === 'search'
                    ? createSearchWorkItemTypeKey(team.id, type.id)
                    : type.id,
                  name: type.name,
                  status: type.status,
                  workflow: {
                    id: workflow.id,
                    name: workflow.name,
                    initialStatusId: workflow.initialStatusId,
                    statuses: workflow.statuses.map((status) => ({
                      id: status.id,
                      name: status.name,
                      category: status.category,
                    })),
                  },
                }
              }),
              ...(task === 'planning'
                ? {}
                : {
                    customFields: resolved.configuration.customFields.flatMap((field) =>
                      field.type === 'formula' || sensitiveCustomFieldIds.has(field.id) ||
                        (task === 'search' && customFieldDefinitionCounts.get(field.id) !== 1)
                        ? []
                        : [{
                            id: field.id,
                            name: field.name,
                            type: field.type,
                            required: field.required,
                            options: field.options?.map((option) => ({
                              id: option.id,
                            })),
                          }]
                    ),
                  }),
            }
          }),
        ...(task === 'search'
          ? {
              supportedEntityTypes: [
                'work-item',
                'project',
                'team',
                'comment',
                'context-item',
                'file',
                'document',
              ],
            }
          : {}),
      }, AI_ASSISTANCE_DIRECTORY_PROMPT_CHARACTER_LIMIT, privacyAliases)
  return {
    searchContext,
    allowedValues,
    directoryPrompt,
    privateMemberIdentifiers,
    privacyAliases,
    eligibleMemberIds,
    sensitiveCustomFieldIds,
    customFieldIdsByTeamId,
    projectMembershipsByRoutingKey: projectMemberIdsByProjectRoutingKey,
    workspaceMemberAuthorizationConditionsByMemberId: new Map(currentMembers.map((member) => [
      member.id,
      createAiAssistanceWorkspaceMemberAuthorizationCondition(principal.directoryId, member),
    ])),
    configurationAuthorizationConditionsByTeamId: new Map(configurations.map(({ team, resolved }) => [
      team.id,
      createAiWorkItemConfigurationAuthorizationConditions(
        principal.directoryId,
        team.id,
        resolved,
      ),
    ])),
    workItemTypeWorkflowsByTeamId,
    triageRoutingFence,
    fence: {
      workspaceId: principal.directoryId,
      memberId: principal.userKey,
      memberVersion: principal.workspaceMember.version,
      planningRevision: searchContext.planningRevision,
      documentAuthorizationRevision: searchContext.documentAuthorizationRevision,
      enterpriseControlRevision: principal.enterpriseIdentityControlRevision,
      teamIds: modelTeamIds,
      projectIds: modelProjectIds,
      directoryLabels: configurations
        .filter(({ team }) => modelTeamIds.includes(team.id))
        .map(({ team }) => ({
          teamId: team.id,
          name: team.name,
          projects: team.projects
            .filter((project) => modelProjectIds.includes(project.id))
            .map((project) => ({ projectId: project.id, name: project.name }))
            .sort((left, right) => left.projectId.localeCompare(right.projectId)),
        })),
      memberIds,
      triageRoutingTuples: triageRoutingFence,
      memberDirectoryRevisions: currentMembers.map((member) => ({
        memberId: member.id,
        version: member.version,
        updatedAt: member.updatedAt,
      })),
      configurations: configurations.map(({ team, resolved }) => {
        const typeWorkflows = workItemTypeWorkflowsByTeamId.get(team.id) ??
          new Map<string, WorkItemConfiguration['workflow']>()
        return {
          teamId: team.id,
          scopeType: resolved.configuration.scopeType,
          scopeId: resolved.configuration.scopeId,
          revision: resolved.configuration.revision,
          workItemTypes: [...typeWorkflows.entries()]
            .map(([typeId, workflow]) => ({
              typeId,
              workflowId: workflow.id,
              initialStatusId: workflow.initialStatusId,
              statusIds: workflow.statuses.map((status) => status.id).sort(),
              transitions: workflow.transitions
                .map((transition) => ({
                  fromStatusId: transition.fromStatusId,
                  toStatusId: transition.toStatusId,
                }))
                .sort((left, right) => left.fromStatusId.localeCompare(right.fromStatusId) ||
                  left.toStatusId.localeCompare(right.toStatusId)),
            }))
            .sort((left, right) => left.typeId.localeCompare(right.typeId)),
          customFieldIds: resolved.configuration.customFields
            .map((field) => field.id)
            .sort(),
        }
      }),
    },
  }
}

/**
 * Creates the exact configuration rows that authorize one resolved Team configuration.
 *
 * A direct Team override is fenced by that row alone. Inherited configurations also fence
 * the Team row's absence and the Workspace row (or its absence), matching the Work Items
 * resolver's inheritance semantics.
 *
 * @param workspaceId - Workspace that owns the configuration table.
 * @param teamId - Team whose effective configuration was resolved.
 * @param resolved - Current effective configuration and inheritance source.
 * @returns Exact configuration rows to check at an AI commit boundary.
 */
function createAiWorkItemConfigurationAuthorizationConditions(
  workspaceId: string,
  teamId: string,
  resolved: ResolvedWorkItemConfiguration,
): AiAssistanceAuthorizationCondition[] {
  const tableName = getWorkItemConfigurationTableName()
  const createCondition = (
    scopeType: 'workspace' | 'team',
    scopeId: string,
    revision: number,
  ): AiAssistanceAuthorizationCondition => ({
    kind: 'work-item-configuration',
    tableName,
    key: {
      scopeKey: createWorkItemConfigurationScopeKey(workspaceId, scopeType, scopeId),
      recordKey: 'CONFIG',
    },
    expectedAttributes: {
      scopeType,
      scopeId,
      schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      revision,
    },
    ...(revision === 0 ? { allowMissingWhenExpectedZero: true } : {}),
  })
  if (!resolved.inheritedFrom && resolved.configuration.scopeType === 'team') {
    return [createCondition('team', teamId, resolved.configuration.revision)]
  }
  return [
    createCondition('team', teamId, 0),
    createCondition(
      'workspace',
      workspaceId,
      resolved.inheritedFrom === 'workspace' ? resolved.configuration.revision : 0,
    ),
  ]
}

/** Creates the exact active Workspace membership row for one selected assignee. */
function createAiAssistanceWorkspaceMemberAuthorizationCondition(
  workspaceId: string,
  member: { id: string; role: string; version: number },
): AiAssistanceAuthorizationCondition {
  const memberKey = normalizeProjectMemberKey(member.id)
  const tableName = getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
    getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
    'mukuroji-workspace-access-local'
  return {
    kind: 'workspace-member',
    tableName,
    key: {
      workspaceId,
      recordKey: `MEMBER#${memberKey}`,
    },
    expectedAttributes: {
      entryType: 'workspace-member',
      status: 'active',
      memberKey,
      role: member.role,
      version: member.version,
    },
  }
}

/** Creates the exact active Project membership row for one selected route. */
function createAiAssistanceProjectMembershipAuthorizationCondition(
  workspaceId: string,
  projectId: string,
  member: AiAssistanceProjectMembership,
): AiAssistanceAuthorizationCondition {
  const memberKey = normalizeProjectMemberKey(member.memberId)
  const tableName = getEnv('MUKUROJI_PROJECT_DIRECTORY_TABLE') ??
    getEnv('PROJECT_DIRECTORY_TABLE_NAME') ??
    'mukuroji-project-directory-local'
  return {
    kind: 'project-membership',
    tableName,
    key: {
      directoryId: workspaceId,
      entryKey: `PROJECT_MEMBER#${projectId}#${memberKey}`,
    },
    expectedAttributes: {
      entryType: 'project-member',
      projectId,
      memberKey,
      role: member.role,
      updatedAt: member.updatedAt,
    },
    expectedAbsentAttributes: ['archivedAt'],
  }
}

/**
 * Adds commit-time fences for identifiers retained by a triage draft.
 *
 * @param principal - Current Workspace principal.
 * @param state - Fresh resolver state containing active member and route rows.
 * @param sources - Sources used to infer the current triage destination.
 * @param draft - Canonical draft being committed, when this is a final check.
 * @returns Selected configuration, member, directory, and Project membership conditions.
 */
async function createAiAssistanceSelectedDraftAuthorizationConditions(
  principal: WorkspacePrincipal,
  state: AiAssistanceResolverState,
  sources: readonly ResolvedAiPromptSource[],
  draft: AiAssistanceDraft | undefined,
): Promise<AiAssistanceAuthorizationCondition[]> {
  if (draft?.kind === 'search') {
    const conditions: AiAssistanceAuthorizationCondition[] = []
    const selectedMemberIds = new Set([
      ...(draft.filters.assigneeUserIds ?? []),
      ...(draft.filters.creatorUserIds ?? []),
    ])
    for (const memberId of selectedMemberIds) {
      const memberCondition = state.workspaceMemberAuthorizationConditionsByMemberId.get(
        memberId,
      )
      if (memberCondition === undefined) {
        throw aiAssistanceAuthorizationChangedError()
      }
      conditions.push(memberCondition)
    }

    const selectedTeamIds = new Set(draft.filters.teamIds ?? [])
    const selectedProjectIds = new Set(draft.filters.projectIds ?? [])
    const projectTeamIds = new Map<string, Set<string>>()
    for (const team of state.searchContext.directory.teams) {
      for (const project of team.projects) {
        if (!selectedProjectIds.has(project.id)) continue
        const teamIds = projectTeamIds.get(project.id) ?? new Set<string>()
        teamIds.add(team.id)
        projectTeamIds.set(project.id, teamIds)
      }
    }
    for (const projectId of selectedProjectIds) {
      if (!projectTeamIds.has(projectId)) {
        throw aiAssistanceAuthorizationChangedError()
      }
    }

    const selectedConfigurationTeamIds = new Set(selectedTeamIds)
    for (const projectId of selectedProjectIds) {
      for (const projectTeamId of projectTeamIds.get(projectId) ?? []) {
        selectedConfigurationTeamIds.add(projectTeamId)
      }
    }
    const selectedStatusIds = new Set(draft.filters.statuses ?? [])
    const selectedWorkItemTypeIdsByTeamId = new Map<string, Set<string>>()
    for (const value of draft.filters.workItemTypeIds ?? []) {
      const keyParts = readSearchWorkItemTypeKey(value)
      const workflows = state.workItemTypeWorkflowsByTeamId.get(keyParts?.teamId ?? '')
      if (!keyParts || !workflows?.has(keyParts.workItemTypeId)) {
        throw aiAssistanceAuthorizationChangedError()
      }
      const selectedTypeIds = selectedWorkItemTypeIdsByTeamId.get(keyParts.teamId) ??
        new Set<string>()
      selectedTypeIds.add(keyParts.workItemTypeId)
      selectedWorkItemTypeIdsByTeamId.set(keyParts.teamId, selectedTypeIds)
      selectedConfigurationTeamIds.add(keyParts.teamId)
    }
    const selectedCustomFieldIds = new Set(
      (draft.filters.customFields ?? []).map((filter) => filter.fieldId),
    )
    for (const [teamId, workflows] of state.workItemTypeWorkflowsByTeamId) {
      const typeMatches = [...workflows.keys()].some((typeId) =>
        selectedWorkItemTypeIdsByTeamId.get(teamId)?.has(typeId) === true
      )
      const statusMatches = [...workflows.values()].some((workflow) =>
        workflow.statuses.some((status) => selectedStatusIds.has(status.id))
      )
      const customFieldMatches = [...selectedCustomFieldIds].some((fieldId) =>
        state.customFieldIdsByTeamId.get(teamId)?.has(fieldId) === true
      )
      if (typeMatches || statusMatches || customFieldMatches) selectedConfigurationTeamIds.add(teamId)
    }
    for (const teamId of selectedConfigurationTeamIds) {
      const configurationConditions = state.configurationAuthorizationConditionsByTeamId.get(
        teamId,
      )
      if (configurationConditions === undefined) {
        throw aiAssistanceAuthorizationChangedError()
      }
      conditions.push(...configurationConditions)
    }
    for (const teamId of selectedTeamIds) {
      conditions.push(...await createAiAssistanceDirectoryReferenceAuthorizationConditions(
        principal.directoryId,
        teamId,
        undefined,
      ))
    }
    for (const [projectId, teamIds] of projectTeamIds) {
      for (const teamId of teamIds) {
        conditions.push(...await createAiAssistanceDirectoryReferenceAuthorizationConditions(
          principal.directoryId,
          teamId,
          projectId,
        ))
      }
    }
    return conditions
  }
  if (draft?.kind !== 'triage') return []
  const sourceRouting = sources.find((source) => source.triageSourceRouting !== undefined)
    ?.triageSourceRouting
  const selectedTeamId = draft.teamId?.value ?? sourceRouting?.teamId
  if (selectedTeamId === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const selectedProjectId = draft.projectId?.value ?? (
    draft.teamId?.value === undefined || draft.teamId.value === sourceRouting?.teamId
      ? sourceRouting?.projectId
      : undefined
  )
  const configurationConditions = state.configurationAuthorizationConditionsByTeamId.get(
    selectedTeamId,
  )
  if (configurationConditions === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const conditions: AiAssistanceAuthorizationCondition[] = [...configurationConditions]
  conditions.push(...await createAiAssistanceDirectoryReferenceAuthorizationConditions(
    principal.directoryId,
    selectedTeamId,
    selectedProjectId,
  ))
  const selectedAssigneeId = draft.assigneeUserId?.value
  if (selectedAssigneeId === undefined) return conditions
  const memberCondition = state.workspaceMemberAuthorizationConditionsByMemberId.get(
    selectedAssigneeId,
  )
  if (memberCondition === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  conditions.push(memberCondition)
  if (selectedProjectId === undefined) return conditions
  const routingKey = createAiAssistanceProjectRoutingKey(selectedTeamId, selectedProjectId)
  const memberships = state.projectMembershipsByRoutingKey.get(routingKey)
  const membership = memberships?.find((candidate) => candidate.memberId === selectedAssigneeId)
  if (membership === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  conditions.push(createAiAssistanceProjectMembershipAuthorizationCondition(
    principal.directoryId,
    selectedProjectId,
    membership,
  ))
  return conditions
}

/**
 * Resolves active Team and Project rows into AI commit-fence conditions.
 *
 * The directory adapter owns the physical sort keys, so this boundary consumes its
 * strongly-read condition checks and binds the semantic identifiers again before the
 * AI generation transaction. This prevents an archive or replacement from winning a
 * race after the final source re-read.
 *
 * @param workspaceId - Workspace that owns the directory rows.
 * @param teamId - Destination Team that must remain active.
 * @param projectId - Optional destination Project that must remain active in the Team.
 * @returns Exact directory-row conditions for the selected destination.
 */
async function createAiAssistanceDirectoryReferenceAuthorizationConditions(
  workspaceId: string,
  teamId: string,
  projectId: string | undefined,
): Promise<AiAssistanceAuthorizationCondition[]> {
  const createChecks = workspaceDependencies.projectDirectory
    .createActiveReferenceConditionChecks
  if (!createChecks) throw aiAssistanceAuthorizationChangedError()
  let checks: NonNullable<TransactWriteCommandInput['TransactItems']>
  try {
    checks = await createChecks.call(
      workspaceDependencies.projectDirectory,
      workspaceId,
      teamId,
      projectId,
    )
  } catch (error) {
    if (error instanceof ProjectDataError) {
      throw aiAssistanceAuthorizationChangedError()
    }
    throw error
  }
  const expectedCheckCount = projectId === undefined ? 1 : 2
  if (checks.length !== expectedCheckCount) {
    throw aiAssistanceAuthorizationChangedError()
  }
  return checks.map((item, index) => {
    const conditionCheck = item.ConditionCheck
    if (conditionCheck === undefined || conditionCheck.TableName === undefined) {
      throw aiAssistanceAuthorizationChangedError()
    }
    const key = Object.fromEntries(
      Object.entries(conditionCheck.Key ?? {}).flatMap(([name, value]) =>
        typeof value === 'string' && value.trim() ? [[name, value]] : []),
    )
    if (
      Object.keys(key).length === 0 ||
      Object.keys(key).length !== Object.keys(conditionCheck.Key ?? {}).length ||
      key.directoryId !== workspaceId ||
      key.entryKey === undefined
    ) {
      throw aiAssistanceAuthorizationChangedError()
    }
    const destinationKind = index === 0 ? 'team' : 'project'
    const expectedAttributes: Record<string, string> = destinationKind === 'team'
      ? { entryType: 'team', teamId }
      : { entryType: 'project', teamId, projectId: projectId ?? '' }
    if (destinationKind === 'project' && !projectId) {
      throw aiAssistanceAuthorizationChangedError()
    }
    const expectedEntryToken = destinationKind === 'team'
      ? `TEAM#${teamId}`
      : `PROJECT#${projectId}`
    if (!key.entryKey.includes(expectedEntryToken)) {
      throw aiAssistanceAuthorizationChangedError()
    }
    return {
      kind: 'directory-reference',
      tableName: conditionCheck.TableName,
      key,
      expectedAttributes,
      expectedAbsentAttributes: ['archivedAt'],
    }
  })
}

/**
 * Keeps only current source-Team custom fields that are globally non-sensitive.
 *
 * Unknown and legacy fields are omitted because their scalar type cannot establish privacy.
 *
 * @param values - Canonical Work Item values resolved after current authorization.
 * @param teamId - Team whose current configuration owns the source Work Item.
 * @param state - Resolver metadata covering every currently visible Team configuration.
 * @returns Prompt-safe custom field values with no sensitive or unknown entries.
 */
function projectAiCustomFieldValuesForPrompt(
  values: Readonly<Record<string, CustomFieldValue>>,
  teamId: string,
  state: AiAssistanceResolverState,
): Record<string, CustomFieldValue> {
  const currentFieldIds = state.customFieldIdsByTeamId.get(teamId)
  if (currentFieldIds === undefined) return {}
  return Object.fromEntries(Object.entries(values).filter(([fieldId]) =>
    currentFieldIds.has(fieldId) && !state.sensitiveCustomFieldIds.has(fieldId)
  ))
}

/**
 * Returns explicit sources from one discriminated generation request.
 *
 * @param request - Strictly validated generation request.
 * @returns Sources in stable caller-selected order.
 */
function getAiAssistanceRequestSources(
  request: ResolveAiAssistanceContextInput['request'],
): AiAssistanceSource[] {
  if (request.task === 'search') return []
  if (request.task === 'summary') return [...request.sources]
  return [request.source]
}

/**
 * Resolves one source through its owning domain's current authorization path.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param source - Validated source reference.
 * @param state - Shared current directory and document authorization state.
 * @param context - Current request context used by canonical authorization helpers.
 * @param citationId - Generation-local server-owned citation identifier.
 * @param documentCommentLimit - Per-document comment bound sized for the commit transaction.
 * @returns Bounded source prompt, citation, and revision fence.
 */
async function resolveAiAssistanceSource(
  principal: WorkspacePrincipal,
  source: AiAssistanceSource,
  state: AiAssistanceResolverState,
  context: Context,
  citationId: string,
  documentCommentLimit: number,
): Promise<ResolvedAiPromptSource> {
  if (source.type === 'triage-entry') {
    return await resolveAiTriageSource(principal, source, state, context, citationId)
  }
  if (source.type === 'request-submission') {
    return await resolveAiRequestSubmissionSource(
      principal,
      source,
      state,
      context,
      citationId,
    )
  }
  if (source.type === 'work-item') {
    return await resolveAiWorkItemSource(principal, source, state, citationId)
  }
  if (source.type === 'document') {
    return await resolveAiDocumentSource(
      principal,
      source,
      state,
      citationId,
      documentCommentLimit,
    )
  }
  return await resolveAiPlanningTargetSource(principal, source, state, citationId)
}

/** Resolves one full-visibility, Project-scoped Triage source. */
async function resolveAiTriageSource(
  principal: WorkspacePrincipal,
  source: Extract<AiAssistanceSource, { type: 'triage-entry' }>,
  state: AiAssistanceResolverState,
  context: Context,
  citationId: string,
): Promise<ResolvedAiPromptSource> {
  const triagePrincipal = await requireTriageTeamAccess(context, source.teamId, 'read')
  if (
    triagePrincipal.workspaceId !== principal.directoryId ||
    triagePrincipal.userId !== principal.userKey
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const entry = await workItemDependencies.triage.getEntry(
    principal.directoryId,
    source.teamId,
    source.triageEntryId,
  )
  if (
    entry.workspaceId !== principal.directoryId ||
    entry.teamId !== source.teamId ||
    entry.id !== source.triageEntryId
  ) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The selected AI source was not found.',
    )
  }
  if (!isTriageEntryVisible(triagePrincipal, entry)) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceDisabled',
      'The selected AI source is not available.',
    )
  }
  const projected = projectTriageEntryForPrincipal(triagePrincipal, entry)
  if (projected.permission.visibility !== 'full') {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceDisabled',
      'AI assistance requires full current source visibility.',
    )
  }
  requireAiAssistanceSourceRevision(projected.revision, source.expectedRevision)
  const currentPrincipal = await requireTriageTeamAccess(context, source.teamId, 'read')
  if (
    currentPrincipal.workspaceId !== principal.directoryId ||
    currentPrincipal.userId !== principal.userKey
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const currentEntry = await workItemDependencies.triage.getEntry(
    principal.directoryId,
    source.teamId,
    source.triageEntryId,
  )
  if (
    currentEntry.workspaceId !== principal.directoryId ||
    currentEntry.teamId !== source.teamId ||
    currentEntry.id !== source.triageEntryId ||
    !isTriageEntryVisible(currentPrincipal, currentEntry) ||
    projectTriageEntryForPrincipal(currentPrincipal, currentEntry).permission.visibility !== 'full'
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  requireAiAssistanceSourceRevision(currentEntry.revision, source.expectedRevision)
  const sourceRouting: AiAssistanceTriageSourceRouting = {
    teamId: projected.teamId,
    ...(projected.projectId === undefined ? {} : { projectId: projected.projectId }),
  }
  const safeOwnerUserId = projected.ownerUserId !== undefined &&
    state.privateMemberIdentifiers.some((member) =>
      member.memberId === projected.ownerUserId)
    ? projected.ownerUserId
    : undefined
  return {
    prompt: boundAiPromptPart({
      sourceType: source.type,
      title: projected.sourcePreview.title,
      body: projected.sourcePreview.body,
      channel: projected.sourcePreview.channelLabel,
      state: projected.state,
      teamId: projected.teamId,
      projectId: projected.projectId,
      ...(safeOwnerUserId === undefined ? {} : { ownerUserId: safeOwnerUserId }),
      receivedAt: projected.receivedAt,
      lastActivityAt: projected.lastActivityAt,
      routing: projected.routing,
      sla: projected.sla,
      events: projected.events.slice(-AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT).map((event) => ({
        type: event.type,
        summary: event.summary,
        createdAt: event.createdAt,
      })),
      sourceCounts: {
        attachments: projected.sourcePreview.attachmentCount,
        comments: projected.sourcePreview.commentCount,
        watchers: projected.sourcePreview.watcherCount,
      },
    }, AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT, state.privacyAliases),
    citation: {
      id: citationId,
      sourceType: source.type,
      label: truncateAiAssistanceText(
        projected.sourcePreview.title,
        500,
        state.privacyAliases,
      ),
      href: `/teams/${encodeURIComponent(source.teamId)}/triage?entryId=${encodeURIComponent(source.triageEntryId)}`,
      ...(projected.sourcePreview.body.trim()
        ? {
            excerpt: truncateAiAssistanceText(
              projected.sourcePreview.body,
              2_000,
              state.privacyAliases,
            ),
          }
        : {}),
      capturedRevision: projected.revision,
    },
    fence: {
      type: source.type,
      teamId: source.teamId,
      sourceId: source.triageEntryId,
      revision: projected.revision,
      projectId: projected.projectId,
      visibility: projected.permission.visibility,
      permissionCheckedAt: projected.permission.checkedAt,
    },
    relationIds: [],
    workItemEndpoints: [],
    workflowStatusIds: [],
    triageSourceRouting: sourceRouting,
    configurationTeamIds: [source.teamId],
    authorizationCondition: {
      kind: 'source',
      tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
      key: {
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: `TRIAGE#${source.triageEntryId}`,
      },
      expectedAttributes: {
        entryType: 'triage-entry',
        revision: projected.revision,
      },
    },
  }
}

/**
 * Creates commit-time conditions for a Document comment window and its retained rows.
 *
 * The window row detects newly inserted comments that do not change the Document revision,
 * while individual rows continue to fence edits or resolution changes for retained comments.
 */
function createAiDocumentCommentAuthorizationConditions(
  workspaceId: string,
  documentId: string,
  commentWindowRevision: number,
  comments: readonly DocumentComment[],
): AiAssistanceAuthorizationCondition[] {
  const tableName = getEnv('DOCUMENTS_TABLE_NAME') ?? 'mukuroji-documents-local'
  const windowCondition: AiAssistanceAuthorizationCondition = {
    kind: 'source',
    tableName,
    key: {
      workspaceId,
      recordKey: `COMMENT_WINDOW#${encodeAiDocumentKeyPart(documentId)}`,
    },
    expectedAttributes: {
      entryType: 'document-comment-window',
      documentId,
      revision: commentWindowRevision,
    },
    ...(commentWindowRevision === 0
      ? { allowMissingWhenExpectedZero: true }
      : {}),
  }
  return [
    windowCondition,
    ...comments.map((comment): AiAssistanceAuthorizationCondition => ({
      kind: 'source',
      tableName,
      key: {
        workspaceId,
        recordKey: `COMMENT#${encodeAiDocumentKeyPart(comment.documentId)}#${comment.createdAt}#${encodeAiDocumentKeyPart(comment.id)}`,
      },
      expectedAttributes: {
        entryType: 'document-comment',
        id: comment.id,
        documentId: comment.documentId,
        resolved: comment.resolved,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      },
    })),
  ]
}

/** Encodes a Document key component using the storage client's canonical base64url format. */
function encodeAiDocumentKeyPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Resolves one Workspace-admin-only Request Intake submission. */
async function resolveAiRequestSubmissionSource(
  principal: WorkspacePrincipal,
  source: Extract<AiAssistanceSource, { type: 'request-submission' }>,
  state: AiAssistanceResolverState,
  context: Context,
  citationId: string,
): Promise<ResolvedAiPromptSource> {
  const adminPrincipal = await requireAiRequestSubmissionAdministration(context)
  if (
    adminPrincipal.directoryId !== principal.directoryId ||
    adminPrincipal.userKey !== principal.userKey
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const submission = await workItemDependencies.requestIntake.getSubmission(
    principal.directoryId,
    source.submissionId,
  )
  if (submission.formId !== source.formId) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The selected AI source was not found.',
    )
  }
  requireAiAssistanceSourceRevision(submission.revision, source.expectedRevision)
  const definition = submission.formSnapshot.snapshot.definition
  const fields = definition.sections.flatMap((section) => section.fields)
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const answers = Object.entries(submission.answers).map(([fieldId, value]) => {
    const field = fieldById.get(fieldId)
    const label = localizeAiRequestText(field?.label, submission.locale)
    return {
      fieldId,
      label,
      type: field?.type,
      value: redactAiAssistancePromptFieldValue({
        fieldId,
        label,
        fieldType: field?.type,
        value,
      }),
    }
  })
  const title = localizeAiRequestText(definition.title, submission.locale) ||
    'Request submission'
  const titleAnswer = submission.answers[submission.workItemMapping.titleFieldId]
  const titleField = fieldById.get(submission.workItemMapping.titleFieldId)
  const titleExcerpt = typeof titleAnswer === 'string'
    ? redactAiAssistancePromptFieldValue({
        fieldId: submission.workItemMapping.titleFieldId,
        label: localizeAiRequestText(titleField?.label, submission.locale),
        fieldType: titleField?.type,
        value: titleAnswer,
      })
    : undefined
  const currentPrincipal = await requireAiRequestSubmissionAdministration(context)
  if (
    currentPrincipal.directoryId !== principal.directoryId ||
    currentPrincipal.userKey !== principal.userKey
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const currentSubmission = await workItemDependencies.requestIntake.getSubmission(
    principal.directoryId,
    source.submissionId,
  )
  if (
    currentSubmission.formId !== source.formId ||
    currentSubmission.revision !== submission.revision
  ) {
    throw new AiAssistanceError(
      'conflict',
      'AiAssistanceSourceChanged',
      'An AI assistance source changed. Reload before generating or reviewing the draft.',
    )
  }
  const { assigneeUserId, ...routingTargetWithoutAssignee } = submission.routingTarget
  const safeRoutingTarget = state.privateMemberIdentifiers.some((member) =>
    member.memberId === assigneeUserId)
    ? submission.routingTarget
    : routingTargetWithoutAssignee
  return {
    prompt: boundAiPromptPart({
      sourceType: source.type,
      formTitle: title,
      status: submission.status,
      locale: submission.locale,
      answers,
      routingTarget: safeRoutingTarget,
      workItemMapping: submission.workItemMapping,
      attachmentCount: submission.attachments.length,
      messages: submission.messages.slice(-AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT).map((message) => ({
        direction: message.direction,
        body: truncateAiAssistanceText(message.body, 800, state.privacyAliases),
        createdAt: message.createdAt,
      })),
      events: submission.events.slice(-AI_ASSISTANCE_SOURCE_TIMELINE_LIMIT).map((event) => ({
        type: event.type,
        summary: event.summary,
        createdAt: event.createdAt,
      })),
    }, AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT, state.privacyAliases),
    citation: {
      id: citationId,
      sourceType: source.type,
      label: truncateAiAssistanceText(title, 500, state.privacyAliases),
      href: `/requests?submissionId=${encodeURIComponent(source.submissionId)}`,
      ...(typeof titleExcerpt === 'string' && titleExcerpt.trim()
        ? {
            excerpt: truncateAiAssistanceText(
              titleExcerpt,
              2_000,
              state.privacyAliases,
            ),
          }
        : {}),
      capturedRevision: submission.revision,
    },
    fence: {
      type: source.type,
      formId: submission.formId,
      formVersion: submission.formVersion,
      sourceId: submission.id,
      revision: submission.revision,
    },
    relationIds: [],
    workItemEndpoints: [],
    workflowStatusIds: [],
    triageSourceRouting: {
      teamId: submission.routingTarget.teamId,
      ...(submission.routingTarget.projectId === undefined
        ? {}
        : { projectId: submission.routingTarget.projectId }),
    },
    configurationTeamIds: [submission.routingTarget.teamId],
    authorizationCondition: {
      kind: 'source',
      tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
      key: {
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: `SUBMISSION#${submission.id}`,
      },
      expectedAttributes: {
        entryType: 'submission',
        revision: submission.revision,
      },
    },
  }
}

/** Resolves one revisioned Work Item with Planning and configuration context. */
async function resolveAiWorkItemSource(
  principal: WorkspacePrincipal,
  source: Extract<AiAssistanceSource, { type: 'work-item' }>,
  state: AiAssistanceResolverState,
  citationId: string,
): Promise<ResolvedAiPromptSource> {
  const { detail } = await loadAuthorizedTeamIssue(
    principal,
    source.teamId,
    source.workItemId,
    'viewer',
    { consistentIssueRead: true, includeEvents: false },
  )
  if (detail.issue.teamId !== source.teamId || detail.issue.id !== source.workItemId) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The selected AI source was not found.',
    )
  }
  requireAiAssistanceSourceRevision(detail.issue.revision, source.expectedRevision)
  const planningState = await readPlanningWorkItemState(principal)
  const planning = filterPlanningSnapshotForPrincipal(
    principal,
    await workItemDependencies.planning.get(principal.directoryId, planningState),
  )
  const sourceKey = createWorkItemDependencyKey({
    teamId: source.teamId,
    workItemId: source.workItemId,
  })
  const relatedDependencies = planning.workItemDependencies.filter((dependency) =>
    createWorkItemDependencyKey(dependency.predecessor) === sourceKey ||
    createWorkItemDependencyKey(dependency.successor) === sourceKey
  )
  const dependencyCandidates = planning.workItems
    .filter((workItem) => createWorkItemDependencyKey({
      teamId: workItem.teamId,
      workItemId: workItem.id,
    }) !== sourceKey)
    .sort((left, right) => {
      const leftRank = rankAiWorkItemCandidate(
        left.teamId,
        left.projectId,
        detail.issue.teamId,
        detail.issue.assignedProjectId,
      )
      const rightRank = rankAiWorkItemCandidate(
        right.teamId,
        right.projectId,
        detail.issue.teamId,
        detail.issue.assignedProjectId,
      )
      return leftRank - rightRank || left.teamId.localeCompare(right.teamId) ||
        left.id.localeCompare(right.id)
    })
    .slice(0, AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT)
  const current = await loadAuthorizedTeamIssue(
    principal,
    source.teamId,
    source.workItemId,
    'viewer',
    { consistentIssueRead: true, includeEvents: false },
  )
  requireAiAssistanceSourceRevision(current.detail.issue.revision, source.expectedRevision)
  if (
    current.detail.issue.assignedProjectId !== detail.issue.assignedProjectId ||
    !await isWorkspaceSearchAuthorizationCurrent(
      principal.directoryId,
      state.searchContext.planningRevision,
      state.searchContext.documentAuthorizationRevision,
      state.searchContext.documentAccess,
    )
  ) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const shownEndpoints = uniqueAiWorkItemEndpoints([
    {
      teamId: detail.issue.teamId,
      workItemId: detail.issue.id,
    },
    ...relatedDependencies.flatMap((dependency) => [
      dependency.predecessor,
      dependency.successor,
    ]),
    ...dependencyCandidates.map((candidate) => ({
      teamId: candidate.teamId,
      workItemId: candidate.id,
    })),
  ])
  const workflow = state.workItemTypeWorkflowsByTeamId
    .get(source.teamId)
    ?.get(detail.issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID)
  const workflowStatusIds = uniqueAiAllowedValues([
    detail.issue.workflowStatusId,
    ...(workflow?.transitions
      .filter((transition) => transition.fromStatusId === detail.issue.workflowStatusId)
      .map((transition) => transition.toStatusId) ?? []),
  ], AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
  const safeAssigneeUserId = detail.issue.assigneeUserId !== undefined &&
    state.privateMemberIdentifiers.some((member) =>
      member.memberId === detail.issue.assigneeUserId)
    ? detail.issue.assigneeUserId
    : undefined
  const prompt = boundAiPromptPart({
    sourceType: source.type,
    workItem: {
      id: detail.issue.id,
      teamId: detail.issue.teamId,
      workItemTypeId: detail.issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
      projectId: detail.issue.assignedProjectId,
      ...(workflow === undefined
        ? {}
        : { workflowStatusIds: workflow.statuses.map((status) => status.id) }),
      title: detail.issue.title,
      priority: detail.issue.priority,
      ...(safeAssigneeUserId === undefined
        ? {}
        : { assigneeUserId: safeAssigneeUserId }),
      workflowStatusId: detail.issue.workflowStatusId,
      statusCategory: detail.issue.statusCategory,
      schedule: detail.issue.schedule,
      createdAt: detail.issue.createdAt,
      updatedAt: detail.issue.updatedAt,
    },
    scheduleDependencies: relatedDependencies,
    dependencyCandidates: dependencyCandidates.map((candidate) => ({
      endpoint: {
        teamId: candidate.teamId,
        workItemId: candidate.id,
      },
      title: candidate.title,
      statusCategory: candidate.statusCategory,
      dueDate: candidate.dueDate,
      schedule: candidate.schedule,
    })),
    description: detail.issue.description,
    customFieldValues: projectAiCustomFieldValuesForPrompt(
      detail.issue.customFieldValues,
      source.teamId,
      state,
    ),
  }, AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT, state.privacyAliases)
  return {
    prompt,
    citation: {
      id: citationId,
      sourceType: source.type,
      label: truncateAiAssistanceText(
        detail.issue.title,
        500,
        state.privacyAliases,
      ),
      href: `/teams/${encodeURIComponent(source.teamId)}/issues?issueId=${encodeURIComponent(source.workItemId)}`,
      ...(detail.issue.description?.trim()
        ? {
            excerpt: truncateAiAssistanceText(
              detail.issue.description,
              2_000,
              state.privacyAliases,
            ),
          }
        : {}),
      capturedRevision: detail.issue.revision,
    },
    fence: {
      type: source.type,
      teamId: source.teamId,
      sourceId: source.workItemId,
      revision: detail.issue.revision,
      projectId: detail.issue.assignedProjectId,
      planningRevision: planning.revision,
    },
    relationIds: detail.issue.relationIds,
    workItemEndpoints: filterAiWorkItemEndpointsVisibleInPrompt(prompt, shownEndpoints),
    existingPlanningDependencies: planning.workItemDependencies.map((dependency) => ({
      predecessor: dependency.predecessor,
      successor: dependency.successor,
    })),
    workflowStatusIds,
    configurationTeamIds: [source.teamId],
    authorizationCondition: {
      kind: 'source',
      tableName: getTeamIssuesTableName(),
      key: {
        directoryTeamId: `${principal.directoryId}#team#${source.teamId}`,
        issueId: source.workItemId,
      },
      expectedAttributes: {
        revision: detail.issue.revision,
      },
    },
  }
}

/** Resolves one Document through its canonical ACL and authorization revisions. */
async function resolveAiDocumentSource(
  principal: WorkspacePrincipal,
  source: Extract<AiAssistanceSource, { type: 'document' }>,
  state: AiAssistanceResolverState,
  citationId: string,
  documentCommentLimit: number,
): Promise<ResolvedAiPromptSource> {
  const documentAuthorizationRevision = state.searchContext.documentAuthorizationRevision
  if (documentAuthorizationRevision === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const [initialDocument, initialCommentPage, initialCommentWindowRevision] =
    await readAiDocumentSnapshot(principal, source.documentId, state.searchContext.documentAccess)
  if (initialDocument.id !== source.documentId) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The selected AI source was not found.',
    )
  }
  if (!await isWorkspaceSearchAuthorizationCurrent(
    principal.directoryId,
    state.searchContext.planningRevision,
    documentAuthorizationRevision,
    state.searchContext.documentAccess,
  )) {
    throw aiAssistanceAuthorizationChangedError()
  }
  requireAiAssistanceSourceRevision(initialDocument.revision, source.expectedRevision)

  // The initial read establishes identity and access; use a second, consistent
  // read immediately before constructing the prompt so edits made during the
  // first read cannot reach the provider as stale document content.
  const [document, commentPage, commentWindowRevision] =
    await readAiDocumentSnapshot(principal, source.documentId, state.searchContext.documentAccess)
  if (document.id !== source.documentId) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The selected AI source was not found.',
    )
  }
  if (!await isWorkspaceSearchAuthorizationCurrent(
    principal.directoryId,
    state.searchContext.planningRevision,
    documentAuthorizationRevision,
    state.searchContext.documentAccess,
  )) {
    throw aiAssistanceAuthorizationChangedError()
  }
  requireAiAssistanceSourceRevision(document.revision, source.expectedRevision)
  if (
    createAiDocumentContentFingerprint(initialDocument) !==
      createAiDocumentContentFingerprint(document) ||
    initialCommentWindowRevision !== commentWindowRevision ||
    createAiDocumentCommentWindowFingerprint(
      initialCommentPage.comments,
      initialCommentPage.nextCursor,
    ) !== createAiDocumentCommentWindowFingerprint(
      commentPage.comments,
      commentPage.nextCursor,
    )
  ) {
    throw new AiAssistanceError(
      'conflict',
      'AiAssistanceSourceChanged',
      'An AI assistance source changed. Reload before generating or reviewing the draft.',
    )
  }
  const body = createDocumentWorkspaceSearchBody(document)
  const promptComments = commentPage.comments
    .slice(0, documentCommentLimit)
    .reverse()
  const commentsTruncated = commentPage.nextCursor !== undefined ||
    commentPage.comments.length > documentCommentLimit
  return {
    prompt: boundAiPromptPart({
      sourceType: source.type,
      document: {
        id: document.id,
        kind: document.kind,
        scope: document.scope,
        title: document.title,
        body,
        updatedAt: document.updatedAt,
      },
      comments: promptComments.map((comment) => ({
          body: truncateAiAssistanceText(
            comment.body,
            800,
            state.privacyAliases,
          ),
          resolved: comment.resolved,
          createdAt: comment.createdAt,
        })),
      commentsTruncated,
    }, AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT, state.privacyAliases),
    citation: {
      id: citationId,
      sourceType: source.type,
      label: truncateAiAssistanceText(document.title, 500, state.privacyAliases),
      href: `/documents/${encodeURIComponent(document.id)}`,
      ...(body.trim()
        ? { excerpt: truncateAiAssistanceText(body, 2_000, state.privacyAliases) }
        : {}),
      capturedRevision: document.revision,
    },
    fence: {
      type: source.type,
      sourceId: document.id,
      revision: document.revision,
      planningRevision: state.searchContext.planningRevision,
      documentAuthorizationRevision,
      commentWindow: {
        revision: commentWindowRevision,
        rows: promptComments.map((comment) => ({
          id: comment.id,
          updatedAt: comment.updatedAt,
          resolved: comment.resolved,
        })),
        nextCursor: commentPage.nextCursor,
        truncated: commentsTruncated,
      },
    },
    relationIds: document.relations.map((relation) => relation.id),
    workItemEndpoints: [],
    workflowStatusIds: [],
    authorizationCondition: {
      kind: 'source',
      tableName: getEnv('DOCUMENTS_TABLE_NAME') ?? 'mukuroji-documents-local',
      key: {
        workspaceId: principal.directoryId,
        recordKey: `DOCUMENT#${document.id}`,
      },
      expectedAttributes: {
        entryType: 'document',
        revision: document.revision,
      },
    },
    authorizationConditions: createAiDocumentCommentAuthorizationConditions(
      principal.directoryId,
      document.id,
      commentWindowRevision,
      promptComments,
    ),
  }
}

/**
 * Reads a Document and its bounded comment window through the canonical access port.
 *
 * @param principal - Authenticated Workspace principal requesting the source.
 * @param documentId - Document identity selected by the caller.
 * @param access - Permission-filtered Document access context.
 * @returns A consistent Document/comment snapshot used for AI prompt construction.
 */
async function readAiDocumentSnapshot(
  principal: WorkspacePrincipal,
  documentId: string,
  access: DocumentAccessContext,
) {
  const getCommentWindowRevision = workItemDependencies.documents
    .getCommentWindowRevision
  if (getCommentWindowRevision === undefined) {
    throw aiAssistanceAuthorizationChangedError()
  }
  return await Promise.all([
    workItemDependencies.documents.get({
      workspaceId: principal.directoryId,
      documentId,
      access,
    }),
    workItemDependencies.documents.listComments({
      workspaceId: principal.directoryId,
      documentId,
      access,
      limit: 40,
    }),
    getCommentWindowRevision.call(workItemDependencies.documents, {
      workspaceId: principal.directoryId,
      documentId,
      access,
    }),
  ])
}

/**
 * Creates a content-only fingerprint for a Document snapshot.
 *
 * @param document - Permission-filtered Document snapshot.
 * @returns Stable fingerprint for fields disclosed to the AI provider.
 */
function createAiDocumentContentFingerprint(document: DocumentDetail): string {
  return JSON.stringify({
    id: document.id,
    kind: document.kind,
    scope: document.scope,
    title: document.title,
    body: createDocumentWorkspaceSearchBody(document),
    revision: document.revision,
    updatedAt: document.updatedAt,
    relationIds: document.relations.map((relation) => relation.id),
  })
}

/**
 * Creates a fingerprint for the bounded Document comment window.
 *
 * @param comments - Permission-filtered comments returned by the current page.
 * @param nextCursor - Opaque cursor indicating another page exists.
 * @returns Stable fingerprint for comment content and disclosure metadata.
 */
function createAiDocumentCommentWindowFingerprint(
  comments: readonly DocumentComment[],
  nextCursor: string | undefined,
): string {
  return JSON.stringify({
    nextCursor: nextCursor ?? null,
    comments: comments.map((comment) => ({
      id: comment.id,
      documentId: comment.documentId,
      parentCommentId: comment.parentCommentId ?? null,
      body: comment.body,
      resolved: comment.resolved,
      resolvedByUserId: comment.resolvedByUserId ?? null,
      resolvedAt: comment.resolvedAt ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
  })
}

/** Resolves one current-scope Project or Initiative Planning target. */
async function resolveAiPlanningTargetSource(
  principal: WorkspacePrincipal,
  source: Extract<AiAssistanceSource, { type: 'planning-target' }>,
  state: AiAssistanceResolverState,
  citationId: string,
): Promise<ResolvedAiPromptSource> {
  const { snapshot } = await readPlanningPublishState(principal, source.target)
  await requirePlanningUpdateTargetPermission(
    principal,
    snapshot,
    source.target,
    'viewer',
  )
  requireAiAssistanceSourceRevision(snapshot.revision, source.expectedRevision)
  const visible = filterPlanningSnapshotForPrincipal(principal, snapshot)
  const target = source.target
  const entity = target.type === 'initiative'
    ? visible.entities.find((candidate) => candidate.id === target.entityId)
    : undefined
  if (target.type === 'initiative' && !entity) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceDisabled',
      'The selected AI source is not available.',
    )
  }
  const scope = target.type === 'project'
    ? { teamId: target.teamId, projectId: target.projectId }
    : { teamId: entity?.teamId, projectId: entity?.projectId }
  const workItems = visible.workItems.filter((workItem) =>
    (scope.teamId === undefined || workItem.teamId === scope.teamId) &&
    (scope.projectId === undefined || workItem.projectId === scope.projectId)
  )
  const endpointKeys = new Set(workItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  const dependencies = visible.workItemDependencies.filter((dependency) =>
    endpointKeys.has(createWorkItemDependencyKey(dependency.predecessor)) &&
    endpointKeys.has(createWorkItemDependencyKey(dependency.successor))
  )
  const updateTarget = visible.updateTargets.find((candidate) =>
    planningUpdateTargetsEqual(candidate.target, target)
  )
  const shownWorkItems = workItems.slice(0, AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT)
  const shownEndpointKeys = new Set(shownWorkItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  const shownDependencies = dependencies
    .filter((dependency) =>
      shownEndpointKeys.has(createWorkItemDependencyKey(dependency.predecessor)) &&
      shownEndpointKeys.has(createWorkItemDependencyKey(dependency.successor))
    )
    .slice(0, AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT)
  if (!await isWorkspaceSearchAuthorizationCurrent(
    principal.directoryId,
    state.searchContext.planningRevision,
    state.searchContext.documentAuthorizationRevision,
    state.searchContext.documentAccess,
  )) {
    throw aiAssistanceAuthorizationChangedError()
  }
  const label = target.type === 'project'
    ? `Project ${target.projectId}`
    : entity?.title ?? 'Planning initiative'
  const prompt = boundAiPromptPart({
    sourceType: source.type,
    target,
    workItems: shownWorkItems,
    workItemDependencies: shownDependencies,
    entity: entity === undefined
      ? undefined
      : {
          id: entity.id,
          type: entity.type,
          title: entity.title,
          description: entity.description,
          teamId: entity.teamId,
          projectId: entity.projectId,
          status: entity.status,
          health: entity.health,
          rollupHealth: entity.rollupHealth,
          risk: entity.risk,
          progress: entity.progress,
          linkedWorkItemCount: entity.linkedWorkItemCount,
          baseline: entity.baseline,
          forecast: entity.forecast,
          updatedAt: entity.updatedAt,
        },
    updateTarget,
    sourceResultTruncated: workItems.length > AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT ||
      dependencies.length > AI_ASSISTANCE_WORK_ITEM_CANDIDATE_LIMIT,
  }, AI_ASSISTANCE_SOURCE_PROMPT_CHARACTER_LIMIT, state.privacyAliases)
  return {
    prompt,
    citation: {
      id: citationId,
      sourceType: source.type,
      label: truncateAiAssistanceText(label, 500, state.privacyAliases),
      href: '/planning/portfolio',
      ...(entity?.description?.trim()
        ? {
            excerpt: truncateAiAssistanceText(
              entity.description,
              2_000,
              state.privacyAliases,
            ),
          }
        : {}),
      capturedRevision: snapshot.revision,
    },
    fence: {
      type: source.type,
      target,
      revision: snapshot.revision,
      scope,
    },
    relationIds: shownDependencies.map((dependency) => dependency.id),
    workItemEndpoints: filterAiWorkItemEndpointsVisibleInPrompt(
      prompt,
      shownWorkItems.map((workItem) => ({
        teamId: workItem.teamId,
        workItemId: workItem.id,
      })),
    ),
    existingPlanningDependencies: visible.workItemDependencies.map((dependency) => ({
      predecessor: dependency.predecessor,
      successor: dependency.successor,
    })),
    workflowStatusIds: [],
    ...(scope.teamId === undefined ? {} : { configurationTeamIds: [scope.teamId] }),
    authorizationCondition: {
      kind: 'source',
      tableName: getEnv('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
      key: {
        workspaceId: `FENCE#${principal.directoryId}`,
        recordKey: 'META',
      },
      expectedAttributes: {
        entryType: 'planning-meta',
        schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
        revision: snapshot.revision,
      },
      ...(snapshot.revision === 0 ? { allowMissingWhenExpectedZero: true } : {}),
    },
  }
}

/**
 * Ranks a visible Work Item candidate so same-Project and same-Team rows appear first.
 *
 * @param teamId - Candidate Team identifier.
 * @param projectId - Candidate Project identifier.
 * @param sourceTeamId - Source Work Item Team identifier.
 * @param sourceProjectId - Source Work Item Project identifier.
 * @returns Stable lower-is-closer ranking bucket.
 */
function rankAiWorkItemCandidate(
  teamId: string,
  projectId: string | undefined,
  sourceTeamId: string,
  sourceProjectId: string | undefined,
): number {
  if (teamId === sourceTeamId && projectId === sourceProjectId) return 0
  if (teamId === sourceTeamId) return 1
  if (projectId !== undefined && projectId === sourceProjectId) return 2
  return 3
}

/**
 * Requires a source revision to match the operator-observed revision.
 *
 * @param currentRevision - Strongly read current source revision.
 * @param expectedRevision - Revision supplied in the validated source reference.
 */
function requireAiAssistanceSourceRevision(
  currentRevision: number,
  expectedRevision: number,
): void {
  if (currentRevision === expectedRevision) return
  throw new AiAssistanceError(
    'conflict',
    'AiAssistanceSourceChanged',
    'An AI assistance source changed. Reload before generating or reviewing the draft.',
  )
}

/**
 * Requires a server-resolved actor to match the fresh transport principal.
 *
 * @param principal - Freshly authenticated principal.
 * @param actor - Actor passed through the application authorization callback.
 */
function requireAiAssistanceActorMatchesPrincipal(
  principal: WorkspacePrincipal,
  actor: AiAssistanceActor,
): void {
  if (
    actor.workspaceId === principal.directoryId &&
    actor.memberId === principal.userKey &&
    actor.actorId === principal.actorId
  ) return
  throw aiAssistanceAuthorizationChangedError()
}

/** Creates the stable authorization-changed error used by resolver races. */
function aiAssistanceAuthorizationChangedError(): AiAssistanceError {
  return new AiAssistanceError(
    'authorization',
    'AiAssistanceAuthorizationChanged',
    'AI assistance authorization changed. Reload and try again.',
  )
}

/**
 * Classifies current-source denials without converting infrastructure failures to access loss.
 *
 * @param error - Error thrown by a canonical authentication or source read.
 * @returns Whether generated content must be withheld as a permission change.
 */
function isAiAssistancePermissionLoss(error: unknown): boolean {
  if (
    error instanceof AiAssistanceError &&
    (
      error.category === 'authentication' ||
      error.category === 'authorization' ||
      error.code === 'AiAssistanceAuthorizationChanged'
    )
  ) return true
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof ProjectDataError ||
    error instanceof TriageError ||
    error instanceof RequestIntakeError ||
    error instanceof DocumentError ||
    error instanceof PlanningError
  ) {
    return error.status === 401 || error.status === 403 || error.status === 404
  }
  return isTeamIssueNotFoundError(error)
}

/**
 * Creates a bounded opaque hash from non-content authorization fences.
 *
 * @param fences - Stable identifiers and revisions only.
 * @returns Versioned SHA-256 authorization token.
 */
function createAiAssistanceAuthorizationToken(fences: unknown): string {
  const serialized = JSON.stringify(normalizeAiPromptValue(fences))
  return `ai-v1:${createHash('sha256').update(serialized).digest('hex')}`
}

/**
 * Serializes prompt context while retaining a valid JSON envelope under the hard limit.
 *
 * @param value - Permission-filtered prompt value.
 * @param aliases - Complete current private-identifier replacements.
 * @returns Valid bounded JSON prompt context.
 */
function serializeBoundedAiPromptContext(
  value: unknown,
  aliases: readonly AiAssistanceTextAlias[],
): string {
  const serialized = JSON.stringify(normalizePrivateAiPromptValue(value, aliases))
  if (serialized.length <= AI_ASSISTANCE_PROMPT_CONTEXT_CHARACTER_LIMIT) {
    return serialized
  }
  return JSON.stringify({
    truncated: true,
    contextExcerpt: serialized.slice(
      0,
      AI_ASSISTANCE_PROMPT_CONTEXT_CHARACTER_LIMIT - 100,
    ),
  })
}

/**
 * Bounds one nested prompt fragment while keeping the outer JSON valid.
 *
 * @param value - Permission-filtered source or directory projection.
 * @param characterLimit - Maximum serialized character count.
 * @param aliases - Complete current private-identifier replacements.
 * @returns Original normalized value or a bounded serialized excerpt.
 */
function boundAiPromptPart(
  value: unknown,
  characterLimit: number,
  aliases: readonly AiAssistanceTextAlias[],
): unknown {
  const normalized = normalizePrivateAiPromptValue(value, aliases)
  const serialized = JSON.stringify(normalized)
  if (serialized.length <= characterLimit) return normalized
  const allIdentifiers = collectAiPromptIdentifiers(normalized)
  let identifiers = allIdentifiers
  while (true) {
    const envelopeLength = JSON.stringify({
      truncated: true,
      ...(identifiers.length === 0 ? {} : { identifiers }),
      contentExcerpt: '',
    }).length
    let excerpt = serialized.slice(
      0,
      Math.max(0, characterLimit - envelopeLength),
    )
    let bounded = {
      truncated: true,
      ...(identifiers.length === 0 ? {} : { identifiers }),
      contentExcerpt: excerpt,
    }
    while (JSON.stringify(bounded).length > characterLimit && excerpt.length > 0) {
      const excess = JSON.stringify(bounded).length - characterLimit
      excerpt = excerpt.slice(0, Math.max(0, excerpt.length - Math.max(excess, 1)))
      bounded = {
        truncated: true,
        ...(identifiers.length === 0 ? {} : { identifiers }),
        contentExcerpt: excerpt,
      }
    }
    if (JSON.stringify(bounded).length <= characterLimit || identifiers.length === 0) {
      return bounded
    }
    identifiers = identifiers.slice(0, -1)
  }
}

/**
 * Collects bounded, provider-safe identifier values from a normalized prompt fragment.
 *
 * Identifier values are emitted as a real JSON array alongside a truncated excerpt so
 * grounding filters can still see them when the excerpt itself is JSON-escaped.
 *
 * @param value - Alias- and redaction-normalized prompt fragment.
 * @returns Unique server-authorized identifiers in stable traversal order.
 */
function collectAiPromptIdentifiers(value: unknown): string[] {
  const identifiers: string[] = []
  const seen = new Set<string>()
  const visit = (candidate: unknown, key: string | undefined, depth: number): void => {
    if (identifiers.length >= AI_ASSISTANCE_ALLOWED_VALUE_LIMIT || depth > 8) return
    if (typeof candidate === 'string') {
      if (!isAiPromptIdentifierKey(key)) return
      const identifier = candidate.trim()
      if (
        identifier.length === 0 ||
        identifier.length > 500 ||
        seen.has(identifier)
      ) return
      seen.add(identifier)
      identifiers.push(identifier)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.slice(0, 200).forEach((entry) => visit(entry, key, depth + 1))
      return
    }
    if (!isRecord(candidate)) return
    Object.entries(candidate)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 200)
      .forEach(([entryKey, entry]) => visit(entry, entryKey, depth + 1))
  }
  visit(value, undefined, 0)
  return identifiers
}

/** Returns whether a prompt object key denotes a stable identifier value. */
function isAiPromptIdentifierKey(key: string | undefined): boolean {
  if (key === undefined) return false
  const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLocaleLowerCase('en-US')
  return normalized === 'id' ||
    normalized.endsWith('id') ||
    normalized.endsWith('ids') ||
    normalized.endsWith('identifier') ||
    normalized.endsWith('identifiers')
}

/**
 * Normalizes trusted typed values into bounded JSON-compatible prompt values.
 *
 * @param value - Typed source projection or fence value.
 * @param depth - Current recursion depth.
 * @returns Bounded JSON-compatible value.
 */
function normalizeAiPromptValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    if (value.length <= 8_000) return value
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'An AI authorization fence string exceeds the safe bound.',
    )
  }
  if (depth >= 8) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'An AI authorization fence exceeds the safe depth.',
    )
  }
  if (Array.isArray(value)) {
    if (value.length > AI_ASSISTANCE_AUTHORIZATION_FENCE_COLLECTION_LIMIT) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'An AI authorization fence collection exceeds the safe bound.',
      )
    }
    return value.map((entry) => normalizeAiPromptValue(entry, depth + 1))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    if (entries.length > AI_ASSISTANCE_AUTHORIZATION_FENCE_COLLECTION_LIMIT) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'An AI authorization fence object exceeds the safe bound.',
      )
    }
    return Object.fromEntries(entries.map(([key, entry]) => [
      key,
      normalizeAiPromptValue(entry, depth + 1),
    ]))
  }
  return String(value)
}

/**
 * Normalizes provider-visible values only after exact aliasing and generic redaction.
 *
 * @param value - Permission-filtered prompt projection.
 * @param aliases - Complete current private-identifier replacements.
 * @param depth - Current recursion depth.
 * @returns Redacted, bounded, JSON-compatible prompt value.
 */
function normalizePrivateAiPromptValue(
  value: unknown,
  aliases: readonly AiAssistanceTextAlias[],
  depth = 0,
): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return truncateAiAssistanceText(value, 8_000, aliases)
  }
  if (depth >= 8) return '[bounded]'
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) =>
      normalizePrivateAiPromptValue(entry, aliases, depth + 1)
    )
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 200)
      .map(([key, entry]) => [
        truncateAiAssistanceText(key, 500, aliases),
        normalizePrivateAiPromptValue(entry, aliases, depth + 1),
      ]))
  }
  return redactAiAssistanceText(
    aliasAiAssistanceTextIdentifiers(String(value), aliases),
  )
}

/**
 * Truncates prose without retaining an invalid half-surrogate at the boundary.
 *
 * @param value - Source or citation prose.
 * @param maximumLength - Maximum UTF-16 character count.
 * @param aliases - Complete current private-identifier replacements.
 * @returns Trimmed bounded text with a truncation marker when needed.
 */
function truncateAiAssistanceText(
  value: string,
  maximumLength: number,
  aliases: readonly AiAssistanceTextAlias[],
): string {
  const privateValue = aliasAiAssistanceTextIdentifiers(value, aliases)
  return truncateBoundedAiText(redactAiAssistanceText(privateValue), maximumLength)
}

/**
 * Trims and bounds already privacy-transformed text.
 *
 * @param value - Text whose privacy transform is already complete.
 * @param maximumLength - Maximum UTF-16 character count.
 * @returns Trimmed bounded text with a truncation marker when needed.
 */
function truncateBoundedAiText(value: string, maximumLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maximumLength) return normalized
  return `${normalized.slice(0, Math.max(0, maximumLength - 1))}…`
}

/**
 * Resolves one localized Request label using the submission locale and stable fallbacks.
 *
 * @param value - Optional localized text.
 * @param locale - Submission locale.
 * @returns Best available localized label or an empty string.
 */
function localizeAiRequestText(
  value: RequestLocalizedText | undefined,
  locale: 'ja' | 'en',
): string {
  return value?.[locale]?.trim() || value?.ja?.trim() || value?.en?.trim() || ''
}

/**
 * Deduplicates and deterministically bounds one string allowlist.
 *
 * @param values - Candidate identifiers.
 * @param limit - Maximum returned identifier count.
 * @returns Sorted unique non-empty identifiers.
 */
function uniqueAiAllowedValues(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort()
    .slice(0, limit)
}

/**
 * Deduplicates an allowlist while retaining explicitly required values before the cap.
 *
 * @param values - Candidate identifiers to normalize and bound.
 * @param limit - Maximum number of identifiers returned.
 * @param preferredValues - Identifiers that must be retained when present.
 * @returns Ordered unique identifiers with preferred values first.
 */
function prioritizedUniqueAiAllowedValues(
  values: readonly string[],
  limit: number,
  preferredValues: readonly string[],
): string[] {
  const uniqueValues = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  const preferred = preferredValues
    .map((value) => value.trim())
    .filter((value, index, candidates) => value.length > 0 && candidates.indexOf(value) === index)
    .filter((value) => uniqueValues.includes(value))
  const remaining = uniqueValues
    .filter((value) => !preferred.includes(value))
    .sort()
  return [...preferred, ...remaining].slice(0, limit)
}

/**
 * Deduplicates visible Work Item endpoints within the structured-output bound.
 *
 * @param endpoints - Current permission-filtered endpoints.
 * @returns Stable unique endpoints.
 */
function uniqueAiWorkItemEndpoints(
  endpoints: readonly WorkItemDependencyEndpoint[],
): WorkItemDependencyEndpoint[] {
  const byKey = new Map<string, WorkItemDependencyEndpoint>()
  for (const endpoint of endpoints) {
    byKey.set(createWorkItemDependencyKey(endpoint), endpoint)
  }
  return [...byKey.values()]
    .sort((left, right) =>
      createWorkItemDependencyKey(left).localeCompare(createWorkItemDependencyKey(right))
    )
    .slice(0, AI_ASSISTANCE_ALLOWED_VALUE_LIMIT)
}

/** Deduplicates persisted Planning edges by their directed endpoint pair. */
function uniqueAiAssistancePlanningDependencies(
  dependencies: readonly AiAssistancePlanningDependency[],
): AiAssistancePlanningDependency[] {
  const byKey = new Map<string, AiAssistancePlanningDependency>()
  for (const dependency of dependencies) {
    const key = `${createWorkItemDependencyKey(dependency.predecessor)}->${createWorkItemDependencyKey(dependency.successor)}`
    byKey.set(key, dependency)
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, dependency]) => dependency)
}

/**
 * Keeps only dependency endpoints whose exact identifiers survived prompt bounding.
 *
 * @param prompt - Final bounded source fragment sent to the model.
 * @param endpoints - Permission-filtered dependency candidates before prompt bounding.
 * @returns Endpoints grounded by identifiers that remain visible in the bounded prompt.
 */
function filterAiWorkItemEndpointsVisibleInPrompt(
  prompt: unknown,
  endpoints: readonly WorkItemDependencyEndpoint[],
): WorkItemDependencyEndpoint[] {
  const serializedPrompt = JSON.stringify(prompt)
  return endpoints.filter((endpoint) =>
    aiPromptContainsSerializedValue(serializedPrompt, endpoint.teamId) &&
    aiPromptContainsSerializedValue(serializedPrompt, endpoint.workItemId)
  )
}

/** Keeps only triage routing tuples whose Team, Project, and assignee values survived prompt bounds. */
function filterAiTriageRoutingTuplesVisibleInPrompt(
  prompt: string,
  tuples: readonly AiAssistanceTriageRoutingTuple[],
  aliases: readonly AiAssistanceTextAlias[] = [],
): AiAssistanceTriageRoutingTuple[] {
  return tuples.flatMap((tuple) => {
    const teamVisible = aiPromptContainsSerializedValue(prompt, tuple.teamId)
    const projectVisible = tuple.projectId === undefined ||
      aiPromptContainsSerializedValue(prompt, tuple.projectId)
    if (!teamVisible || !projectVisible) return []
    const assigneeUserIds = filterAiAllowedValuesVisibleInPrompt(
      prompt,
      tuple.assigneeUserIds,
      aliases,
    )
    return assigneeUserIds.length === 0 && tuple.assigneeUserIds.length > 0
      ? []
      : [{ ...tuple, assigneeUserIds }]
  })
}

/**
 * Keeps only server-authorized identifiers whose exact JSON value survived prompt bounding.
 *
 * @param prompt - Final bounded context sent to the model.
 * @param values - Permission-filtered identifiers before prompt bounding.
 * @param aliases - Optional privacy aliases already applied to member identifiers.
 * @returns Identifiers that remain grounded by the visible model context.
 */
function filterAiAllowedValuesVisibleInPrompt(
  prompt: string,
  values: readonly string[],
  aliases: readonly AiAssistanceTextAlias[] = [],
): string[] {
  const aliasByValue = new Map<string, string>()
  for (const entry of aliases) {
    if (!aliasByValue.has(entry.value)) aliasByValue.set(entry.value, entry.alias)
  }
  return values.filter((value) => {
    const alias = aliasByValue.get(value)
    return alias === undefined
      ? aiPromptContainsSerializedValue(prompt, value)
      : aiPromptContainsExactIdentifier(prompt, alias)
  })
}

/** Keeps Team-scoped custom-field definitions whose identifiers survived prompt bounding. */
function filterAiCustomFieldDefinitionsVisibleInPrompt(
  prompt: string,
  definitions: readonly AiAssistanceCustomFieldDefinition[],
): AiAssistanceCustomFieldDefinition[] {
  return definitions.filter((definition) =>
    aiPromptContainsSerializedValue(prompt, definition.teamId) &&
    aiPromptContainsSerializedValue(prompt, definition.fieldId)
  )
}

/**
 * Finds a JSON string value in both a normal prompt object and a JSON-encoded excerpt.
 *
 * Bounded prompt fragments are stored as strings inside the outer prompt JSON. In that
 * representation the inner quotes are escaped, so checking only the unescaped token can
 * incorrectly discard an identifier that is still visible to the provider.
 *
 * @param prompt - Final serialized prompt context.
 * @param value - Server-authorized identifier to locate.
 * @returns Whether the identifier is present in either JSON representation.
 */
function aiPromptContainsSerializedValue(prompt: string, value: string): boolean {
  const serialized = JSON.stringify(value)
  const escapedSerialized = JSON.stringify(serialized).slice(1, -1)
  return prompt.includes(serialized) || prompt.includes(escapedSerialized)
}

/**
 * Finds one identifier token even when it appears inside provider-visible prose.
 *
 * @param prompt - Final privacy-transformed prompt JSON.
 * @param identifier - Strict server-generated alias to locate.
 * @returns Whether the exact token survived prompt bounding.
 */
function aiPromptContainsExactIdentifier(prompt: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    `(^|[^A-Za-z0-9._%+@-])${escaped}(?=$|[^A-Za-z0-9._%+@-])`,
    'u',
  ).test(prompt)
}

/** Maps source and infrastructure failures into a safe AI route response envelope. */
function toAiAssistanceExternalErrorResponse(
  context: Context,
  error: unknown,
): Response {
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(context, error)
  }
  if (error instanceof TriageError) return toTriageErrorResponse(context, error)
  if (error instanceof RequestIntakeError) {
    return toRequestIntakeErrorResponse(context, error)
  }
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(context, error)
  }
  if (error instanceof PlanningError) return toPlanningErrorResponse(context, error)
  if (error instanceof DocumentError) {
    const status = error.status === 400 || error.status === 401 ||
        error.status === 403 || error.status === 404 || error.status === 409 ||
        error.status === 413 || error.status === 422 || error.status === 503
      ? error.status
      : 502
    return context.json({ code: error.code, message: error.message }, status)
  }
  console.error(error)
  return context.json({
    code: 'AiAssistanceUnavailable',
    message: 'AI assistance is unavailable.',
  }, 503)
}

/**
 * Registers the AI assistance HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAiAssistanceRoutes(routeApp: Hono): void {
  routeApp.route('/', createAiAssistanceRouter<WorkspacePrincipal>({
    service: aiAssistanceService,
    readBearerAccessToken,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    toActor: createAiAssistanceActor,
    getPolicyAuthorizationFence: createAiAssistancePolicyAuthorizationFence,
    resolveContext: resolveAiAssistanceContext,
    isAuthorizationCurrent: isAiAssistanceAuthorizationCurrent,
    getActorAuthorizationConditions: (principal) =>
      createAiAssistancePrincipalAuthorizationConditions(principal),
    readJson,
    mapError: toAiAssistanceExternalErrorResponse,
  }))
}
